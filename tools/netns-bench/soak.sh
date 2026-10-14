#!/usr/bin/env bash
# A shop left running while the building misbehaves, then checked to the row.
#
# Three counters and a main, each its own machine (see run.sh), selling real
# bills -- numbered from the counter's series, stock out through the stock
# ledger, money through the general ledger -- while at random a cable is
# pulled, a link starts losing packets, or a machine loses power: the main
# while a counter is mid-sync with it, a counter mid-sale. Machines come back
# sooner or later. At the end everything is healed and left to sync, and then:
#
#   * every till holds the same books, row for row (`virtual-till/compare.ts`);
#   * no counter's series has a hole in it;
#   * every voucher's ledger balances and stock on hand is what the stock
#     ledger adds up to, on every till;
#   * nothing was set aside by a merge;
#   * every sale a counter said it made is in the main's books.
#
#   sudo tools/netns-bench/soak.sh                 300 steps, a random seed
#   STEPS=2000 SEED=42 sudo tools/netns-bench/soak.sh
#
# The seed is printed first: a failure is replayed by running the same seed,
# and the step log in /tmp/shopos-netns/soak.log says what happened when.
set -uo pipefail

STEPS=${STEPS:-300}
SEED=${SEED:-$((RANDOM * 32768 + RANDOM))}

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RANDOM=$SEED
SHOP_TILLS=(a1 a2 a3)
COUNTERS=(a2 a3)
log="$work/soak.log"

declare -A up=([a1]=0 [a2]=0 [a3]=0) wired=([a1]=1 [a2]=1 [a3]=1) dropping=([a1]=0 [a2]=0 [a3]=0)
declare -A back_at=()
declare -A tally=()
note() { echo "step $step: $*" >>"$log"; }
count() { tally[$1]=$(( ${tally[$1]:-0} + 1 )); }
pick() { local a=("$@"); echo "${a[$((RANDOM % ${#a[@]}))]}"; }
ups() { local t; for t in "$@"; do [ "${up[$t]}" = 1 ] && echo "$t"; done; }

switch_on() {
  local t=$1 seed=empty
  [ -d "$work/$t" ] || { [ "$t" = a1 ] && seed=shop; }
  start "$t" "$seed" || { bad "till $t would not start"; return 1; }
  up[$t]=1
  ctl "$t" /control/claim-register >/dev/null
}

off_for() { # off_for <till> <steps>: power cut, back on after that many steps
  power_cut "$1"; up[$1]=0; back_at[$1]=$(( step + $2 ))
}

# --- a shop to start from -----------------------------------------------------

if [ "${KEEP:-}" != 1 ]; then trap teardown EXIT; fi
teardown
rm -rf "$work"; mkdir -p "$work"
: >"$log"; : >"$work/sold.txt"

echo "soak: $STEPS steps, SEED=$SEED"
step=0
wire_up || { echo "could not build the network"; exit 1; }
for t in "${SHOP_TILLS[@]}"; do switch_on "$t" || exit 1; done
for t in "${COUNTERS[@]}"; do
  code=$(ctl a1 /control/offer | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
  ctl "$t" /control/pair "{\"url\":\"http://$(ip_of a1):7801\",\"code\":\"$code\"}" >/dev/null
  sync_to "$t" a1 >/dev/null
  # Its own counter, made now it has the shop.
  ctl "$t" /control/claim-register >/dev/null
done
ctl a1 /control/stock-in '{"units":100000}' >/dev/null
for _ in 1 2 3; do for t in "${COUNTERS[@]}"; do sync_to "$t" a1 >/dev/null; done; done
started=$SECONDS

# --- the day ------------------------------------------------------------------

for step in $(seq 1 "$STEPS"); do
  for t in "${!back_at[@]}"; do
    if [ "${back_at[$t]}" -le "$step" ]; then
      unset "back_at[$t]"; switch_on "$t" && note "$t back on"
    fi
  done
  (( step % 50 == 0 )) && echo "  step $step/$STEPS  $(( SECONDS - started ))s"

  roll=$(( RANDOM % 100 ))
  live=($(ups "${SHOP_TILLS[@]}"))
  [ "${#live[@]}" -gt 0 ] || continue

  if (( roll < 45 )); then
    t=$(pick "${live[@]}")
    r=$(ctl "$t" /control/sell "{\"units\":$(( RANDOM % 3 + 1 ))}")
    if grep -q '"ok":true' <<<"$r"; then
      count sold; sed -n 's/.*"docNo":"\([^"]*\)".*/\1/p' <<<"$r" >>"$work/sold.txt"
    else
      count refused; note "sale on $t refused: $r"
    fi

  elif (( roll < 65 )); then
    spokes=($(ups "${COUNTERS[@]}"))
    [ "${#spokes[@]}" -gt 0 ] && [ "${up[a1]}" = 1 ] || continue
    t=$(pick "${spokes[@]}")
    r=$(sync_to "$t" a1)
    if grep -q '"ok":true' <<<"$r"; then count synced; else count unsynced; note "$t sync: ${r:0:160}"; fi

  elif (( roll < 69 )); then
    t=$(pick "${live[@]}")
    r=$(ctl "$t" /control/cancel)
    grep -q '"ok":true' <<<"$r" && count cancelled
    note "cancel on $t: ${r:0:160}"

  elif (( roll < 76 )); then
    t=$(pick a1 "${COUNTERS[@]}" "${COUNTERS[@]}")
    if [ "${wired[$t]}" = 1 ]; then cable "$t" down; wired[$t]=0; count unplugged; note "$t cable out"
    else cable "$t" up; wired[$t]=1; note "$t cable in"; fi

  elif (( roll < 83 )); then
    t=$(pick "${SHOP_TILLS[@]}")
    if [ "${dropping[$t]}" = 0 ]; then lossy "$t" 0.2; dropping[$t]=1; count lossy; note "$t losing 20%"
    else clean "$t"; dropping[$t]=0; note "$t network clean"; fi

  elif (( roll < 91 )); then
    t=$(pick "${live[@]}")
    if [ "$t" = a1 ]; then
      # The main, while a counter is mid-round with it.
      spokes=($(ups "${COUNTERS[@]}"))
      if [ "${#spokes[@]}" -gt 0 ]; then
        s=$(pick "${spokes[@]}")
        sync_to "$s" a1 >"$work/inflight.json" 2>&1 &
        sleep "0.$(( RANDOM % 6 ))"
      fi
    else
      # A counter, mid-sale.
      ctl "$t" /control/sell '{"units":1}' >"$work/inflight.json" 2>&1 &
      sleep "0.0$(( RANDOM % 10 ))"
    fi
    off_for "$t" $(( RANDOM % 15 ))
    wait 2>/dev/null
    count "power cut"; note "$t power cut; in flight: $(head -c 160 "$work/inflight.json" 2>/dev/null)"
    # A sale cut off may have committed or not; only one that answered is counted.

  else
    [ "${up[a1]}" = 1 ] || continue
    ctl a1 /control/stock-in '{"units":500}' >/dev/null && count "stock in"
  fi
done

# --- everything back, and left to settle --------------------------------------

step "healing: every machine on, every cable in, every link clean"
for t in "${SHOP_TILLS[@]}"; do
  [ "${up[$t]}" = 1 ] || switch_on "$t"
  cable "$t" up; wired[$t]=1
  clean "$t"; dropping[$t]=0
done

same=""
for round in $(seq 1 30); do
  for t in "${COUNTERS[@]}"; do sync_to "$t" a1 >/dev/null; done
  # Twice more each, so what one counter handed the main reaches the other.
  for t in "${COUNTERS[@]}"; do sync_to "$t" a1 >/dev/null; done
  for t in "${SHOP_TILLS[@]}"; do ctl "$t" /control/dump >"$work/$t.json"; done
  if "$tsx" "$repo/tools/virtual-till/src/compare.ts" "$work"/a1.json "$work"/a2.json "$work"/a3.json >"$work/compare.txt" 2>&1; then
    same=$round; break
  fi
done

step "checks"
if [ -n "$same" ]; then ok "$(cat "$work/compare.txt") after $same settling round(s)"
else bad "the tills never agreed:"; sed 's/^/     /' "$work/compare.txt"; fi

for t in "${SHOP_TILLS[@]}"; do
  h=$(ctl "$t" /control/health)
  echo "     $t: $h" >>"$log"
  grep -q '"quarantined":0,' <<<"$h" && grep -q '"unbalancedVouchers":0,' <<<"$h" \
    && grep -q '"stockAdrift":0,' <<<"$h" && grep -q '"missingNumbers":\[\]' <<<"$h" \
    && ok "$t: books balance, stock adds up, no number missing, nothing set aside" \
    || bad "$t: $h"
done

missing=$(node -e '
  const fs = require("fs")
  const held = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const have = new Set(Object.values(held.bills ?? {}).map((b) => b.doc_no))
  const sold = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)
  console.log(sold.filter((n) => !have.has(n)).join(" "))
' "$work/a1.json" "$work/sold.txt")
[ -z "$missing" ] && ok "every sale a counter reported is in the main's books ($(wc -l <"$work/sold.txt"))" \
  || bad "sales reported but not in the main's books: $missing"

echo
summary=""
for k in "${!tally[@]}"; do summary+="$k ${tally[$k]}, "; done
echo "$STEPS steps in $(( SECONDS - started ))s: ${summary%, }"
echo "step log: $log"
if [ "$fail" -eq 0 ]; then echo "soak: all checks passed (SEED=$SEED)"; else echo "soak: FAILED (SEED=$SEED)"; fi
exit "$fail"
