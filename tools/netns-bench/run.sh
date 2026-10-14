#!/usr/bin/env bash
# A shop with three counters and one main, each counter its own machine on its
# own wire, on one Linux box (WSL is enough). Layer 2 without Docker.
#
# Each till is a network namespace: its own interface, address and loopback,
# joined to the others by a bridge, which is the shop's switch. Inside each run
# the same two halves a Layer 2 container runs -- the Node till that holds the
# database, and `shopos-net` answering the network for it -- so nothing here is
# a second implementation of anything.
#
# What a namespace gives that one Windows machine cannot: a broadcast that
# stays on its own wire, a cable that can be pulled (`ip link set down`), a
# network that loses packets (`iptables -m statistic`), and a machine that
# loses power mid-merge (every process in the namespace killed at once). What
# it does not: a clock of its own, so a till's clock is moved with
# `--clock-offset` instead, and the Windows app itself, its screens, firewall
# and printers. WSL's kernel is built without `netem`, so there is no added
# delay -- only the delay that lost packets cause, which is TCP's own.
#
#   sudo tools/netns-bench/run.sh          everything, then tear it down
#   KEEP=1 sudo tools/netns-bench/run.sh   leave the shop standing afterwards
#
# Needs: root, `ip` and `tc`, `npm ci` run in this checkout on Linux, and
# `cargo build --release --manifest-path crates/shopos-net/Cargo.toml`.
set -uo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

declare -A next_no=([a1]=0 [a2]=0 [a3]=0 [b1]=0)
# bill <till> <how many>
bill() {
  local name=$1 n=$2 i
  for i in $(seq 1 "$n"); do
    next_no[$name]=$(( ${next_no[$name]} + 1 ))
    ctl "$name" /control/bill "{\"docNo\":\"$(counter_of "$name")/2627/$(printf %05d "${next_no[$name]}")\"}" >/dev/null
  done
}

# Each counter asks the main, round after round, until all three hold the same
# bills or the rounds run out. Spokes dial; the main answers.
converge() {
  local want=$1 rounds=${2:-6} r s
  for r in $(seq 1 "$rounds"); do
    for s in a2 a3; do sync_to "$s" a1 >/dev/null; done
    local c1 c2 c3; c1=$(bills a1) c2=$(bills a2) c3=$(bills a3)
    if [ "$c1" = "$want" ] && [ "$c2" = "$want" ] && [ "$c3" = "$want" ]; then
      echo "     $want bills on every till after $r round(s)"; return 0
    fi
  done
  echo "     a1=$c1 a2=$c2 a3=$c3, wanted $want"; return 1
}

# --- the run ----------------------------------------------------------------

if [ "${KEEP:-}" != 1 ]; then trap teardown EXIT; fi
teardown
rm -rf "$work"; mkdir -p "$work"

step "the wire: shop A's three tills on one switch, shop B on another"
wire_up || { echo "could not build the network"; exit 1; }
for name in a1 a2 a3; do start "$name" "$( [ $name = a1 ] && echo shop || echo empty)" || exit 1; done
start b1 shop || exit 1
ok "four tills answering (logs in $work)"

step "discovery"
found=$(ip netns exec sb-a1 "$net_bin" look-around --timeout 3000 --device "$(device_of a1)")
for name in a2 a3; do
  grep -q "$(device_of $name)" <<<"$found" && ok "a1 hears $name" || bad "a1 does not hear $name"
done
grep -q "$(device_of b1)" <<<"$found" && bad "a1 hears b1, which is another shop on another wire" || ok "a1 does not hear shop B"

step "pairing: a1 lets a2 and a3 in and becomes the main"
for name in a2 a3; do
  code=$(ctl a1 /control/offer | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
  [ -n "$code" ] || { bad "a1 would not offer a code"; continue; }
  echo "     $name pairs: $(ctl "$name" /control/pair "{\"url\":\"http://$(ip_of a1):7801\",\"code\":\"$code\"}")"
  sync_to "$name" a1 >/dev/null
  echo "     $name counter: $(ctl "$name" /control/claim-register)"
done
for name in a1 a2 a3; do echo "     $name: $(ctl $name /control/role)"; done
ctl a1 /control/role | grep -q "\"main\":\"$(device_of a1)\"" && ok "a1 is the main" || bad "a1 is not the main"
for name in a2 a3; do
  ctl "$name" /control/role | grep -q "\"main\":\"$(device_of a1)\"" && ok "$name knows a1 is the main" || bad "$name does not know a1 is the main"
done
# A counter can show a code -- the door is checked when somebody comes through
# it (`mayLetIn`), and it names the main so the newcomer knows where to go.
code=$(ctl a2 /control/offer | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
start a4 empty || exit 1
refused=$(ctl a4 /control/pair "{\"url\":\"http://$(ip_of a2):7801\",\"code\":\"${code:-none}\"}")
echo "     a4 tries to join through a2: $refused"
grep -q 'NOT_THE_MAIN' <<<"$refused" && ok "a2 turns a new till away: it is not the main" || bad "a2 did not refuse with NOT_THE_MAIN"
shut_down a4

step "a normal day: every counter bills, everything meets at the main"
bill a1 5; bill a2 5; bill a3 5
converge 15 && ok "15 bills everywhere" || bad "the shop did not converge"

step "a pulled cable: a3 bills offline, then comes back"
cable a3 down
bill a1 3; bill a2 3; bill a3 3
r=$(sync_to a3 a1); echo "     a3 asks while unplugged: $r"
grep -q '"ok":true' <<<"$r" && bad "a3 synced with no cable" || ok "a3 cannot reach the main and keeps billing"
cable a3 up
converge 24 && ok "a3 caught up and handed its bills over" || bad "a3 did not catch up"

step "a bad network: a2 losing 15% of its packets each way"
bill a2 40
lossy a2 0.15 || bad "could not make a2's link lossy"
started=$SECONDS
converge 64 15 && ok "converged through a lossy link ($((SECONDS - started)) s)" || bad "did not converge through a lossy link"
clean a2

step "the main loses power mid-merge"
# The cut has to land inside a round, not between two. A lossy link stretches
# a round out with retransmits; each try cuts sooner until one is caught.
want=64 caught=""
for delay in 0.6 0.3 0.15 0.05; do
  bill a2 150; want=$((want + 150))
  lossy a1 0.3
  sync_to a2 a1 >"$work/interrupted.json" 2>&1 &
  syncing=$!
  sleep "$delay"
  power_cut a1; clean a1
  wait "$syncing" 2>/dev/null
  round=$(head -c 200 "$work/interrupted.json")
  start a1 empty || { bad "a1 would not start again after the power cut"; break; }
  ctl a1 /control/claim-register >/dev/null
  if ! grep -q '"ok":true' <<<"$round"; then
    caught=1; echo "     cut after ${delay}s, mid-round: $round"; break
  fi
  echo "     cut after ${delay}s landed after the round ended; again, sooner"
done
[ -n "$caught" ] && ok "the power went while a round was in flight" || bad "never caught a round in flight"
echo "     a1 back: $(ctl a1 /control/role)"
converge "$want" 8 && ok "nothing lost and nothing doubled after the power cut" || bad "the books differ after the power cut"

step "clocks: a3 three minutes fast, then ten"
shut_down a3; start a3 empty --clock-offset 3 && ctl a3 /control/claim-register >/dev/null
bill a3 2
converge $((want + 2)) && ok "three minutes out still syncs" || bad "three minutes out did not sync"
shut_down a3; start a3 empty --clock-offset 10 && ctl a3 /control/claim-register >/dev/null
r=$(sync_to a3 a1); echo "     a3 ten minutes fast: $r"
grep -q '"ok":true' <<<"$r" && bad "a till ten minutes out was let through" || ok "ten minutes out is refused"
shut_down a3; start a3 empty && ctl a3 /control/claim-register >/dev/null
converge $((want + 2)) && ok "a3 syncs again once its clock is right" || bad "a3 did not recover from its clock"

step "the shop next door"
[ "$(bills b1)" = 0 ] && ok "shop B holds none of shop A's bills" || bad "shop B holds $(bills b1) bills"

echo
if [ "$fail" -eq 0 ]; then echo "netns bench: all checks passed"; else echo "netns bench: FAILED"; fi
[ "${KEEP:-}" = 1 ] && echo "Left standing. Tear down with: sudo ip -all netns delete; sudo ip link del sb-shopa; sudo ip link del sb-shopb"
exit "$fail"
