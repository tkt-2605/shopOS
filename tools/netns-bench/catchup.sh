#!/usr/bin/env bash
# A counter that was cut off for days catches up -- and the main keeps losing
# power while it does.
#
# The soak's syncs are small: a few sales between rounds. This is the other
# shape: a counter unplugged while it rings up a long day's trade, plugged back
# in, and then a catch-up of thousands of rows in rounds of two hundred, with
# the main's power cut at random points in the middle of it, again and again.
# Every round that lands is one transaction and every cursor moves only on an
# answer, so what must come out of it is the same books on both tills, every
# sale on the main once, and no round that took longer than the merge allows.
#
#   sudo tools/netns-bench/catchup.sh                  2000 sales, 5 cuts
#   SALES=5000 CUTS=10 sudo tools/netns-bench/catchup.sh
set -uo pipefail

SALES=${SALES:-2000}
CUTS=${CUTS:-5}
SEED=${SEED:-$((RANDOM * 32768 + RANDOM))}

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
RANDOM=$SEED

if [ "${KEEP:-}" != 1 ]; then trap teardown EXIT; fi
teardown
rm -rf "$work"; mkdir -p "$work"
echo "catch-up: $SALES sales offline, the main cut $CUTS times, SEED=$SEED"

step "a main and a counter"
wire_up || { echo "could not build the network"; exit 1; }
start a1 shop || exit 1
start a2 empty || exit 1
ctl a1 /control/claim-register >/dev/null
code=$(ctl a1 /control/offer | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
ctl a2 /control/pair "{\"url\":\"http://$(ip_of a1):7801\",\"code\":\"$code\"}" >/dev/null
sync_to a2 a1 >/dev/null
ctl a2 /control/claim-register >/dev/null
ctl a1 /control/stock-in "{\"units\":$(( SALES * 2 + 1000 ))}" >/dev/null
for _ in 1 2 3; do sync_to a2 a1 >/dev/null; done
ok "paired, stocked"

step "the counter cut off for a long day"
cable a2 down
started=$SECONDS
r=$(ctl a2 /control/sell "{\"times\":$SALES}")
grep -q "\"sold\":$SALES" <<<"$r" && ok "$SALES sales rung up offline in $(( SECONDS - started ))s" || { bad "selling stopped: $r"; exit 1; }
ctl a1 /control/sell '{"times":25}' >/dev/null   # and the main sold a little meanwhile
cable a2 up

step "catching up, with the main's power cut in the middle"
# The counter asks round after round, as its sync loop would, while the main
# is switched off and on underneath it.
( while :; do
    t0=$(date +%s%N)
    r=$(sync_to a2 a1 2>&1)
    t1=$(date +%s%N)
    echo "$(( (t1 - t0) / 1000000 )) ${r:0:120}" >>"$work/rounds.log"
    grep -q '"ok":true' <<<"$r" && ! grep -q '"more":true' <<<"$r" && [ -f "$work/cuts-done" ] && break
    grep -q '"ok":true' <<<"$r" || sleep 1
  done ) &
asker=$!

for cut in $(seq 1 "$CUTS"); do
  sleep "$(( RANDOM % 4 + 1 )).$(( RANDOM % 10 ))"
  power_cut a1
  echo "     cut $cut after $(wc -l <"$work/rounds.log") rounds"
  sleep 1
  start a1 empty || { bad "the main would not start again after cut $cut"; break; }
  ctl a1 /control/claim-register >/dev/null
done
touch "$work/cuts-done"
wait "$asker"
rounds=$(wc -l <"$work/rounds.log")
refused=$(grep -vc '"ok":true' "$work/rounds.log")
slowest=$(sort -n "$work/rounds.log" | tail -1 | cut -d' ' -f1)
ok "caught up in $rounds rounds ($refused cut off or refused), slowest round ${slowest} ms"
[ "${slowest:-0}" -lt 90000 ] && ok "no round came near the 90 s merge budget" || bad "a round took ${slowest} ms"

step "checks"
for _ in 1 2 3; do sync_to a2 a1 >/dev/null; done
for t in a1 a2; do ctl "$t" /control/dump >"$work/$t.json"; done
if "$tsx" "$repo/tools/virtual-till/src/compare.ts" "$work/a1.json" "$work/a2.json" >"$work/compare.txt" 2>&1; then
  ok "$(cat "$work/compare.txt")"
else
  bad "the two tills differ:"; sed 's/^/     /' "$work/compare.txt"
fi
for t in a1 a2; do
  h=$(ctl "$t" /control/health)
  grep -q '"quarantined":0,' <<<"$h" && grep -q '"unbalancedVouchers":0,' <<<"$h" \
    && grep -q '"stockAdrift":0,' <<<"$h" && grep -q '"missingNumbers":\[\]' <<<"$h" \
    && ok "$t: books balance, stock adds up, no number missing, nothing set aside" || bad "$t: $h"
done
want=$(( SALES + 25 ))
have=$(sed -n 's/.*"bills":\([0-9]*\).*/\1/p' <<<"$(ctl a1 /control/health)")
[ "$have" = "$want" ] && ok "the main holds every sale once: $have" || bad "the main holds $have bills, wanted $want"

echo
if [ "$fail" -eq 0 ]; then echo "catch-up: all checks passed (SEED=$SEED)"; else echo "catch-up: FAILED (SEED=$SEED)"; fi
exit "$fail"
