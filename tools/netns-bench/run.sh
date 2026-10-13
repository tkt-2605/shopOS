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

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0"; exit 1; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tsx="$repo/node_modules/.bin/tsx"
net_bin="$repo/target/release/shopos-net"
work=/tmp/shopos-netns
[ -x "$tsx" ] || { echo "No $tsx -- run npm ci in $repo first"; exit 1; }
[ -x "$net_bin" ] || { echo "No $net_bin -- build shopos-net first"; exit 1; }

# name  namespace  address       switch   device id                              counter  seed
TILLS=(
  "a1 sb-a1 10.77.1.11 sb-shopa 1111aaaa-1111-4111-8111-111111111111 FR shop"
  "a2 sb-a2 10.77.1.12 sb-shopa 2222bbbb-2222-4222-8222-222222222222 BC empty"
  "a3 sb-a3 10.77.1.13 sb-shopa 3333cccc-3333-4333-8333-333333333333 SD empty"
  "b1 sb-b1 10.77.2.11 sb-shopb 4444dddd-4444-4444-8444-444444444444 OS shop"
  # A fourth machine, started only to knock on a door that is not the main's.
  "a4 sb-a4 10.77.1.14 sb-shopa 5555eeee-5555-4555-8555-555555555555 NW empty"
)
SWITCHES=(sb-shopa sb-shopb)

field() { # field <till> <column, counting from 0>
  local row cols
  for row in "${TILLS[@]}"; do
    read -ra cols <<<"$row"
    if [ "${cols[0]}" = "$1" ]; then echo "${cols[$2]}"; return; fi
  done
}
ns_of()     { field "$1" 1; }
ip_of()     { field "$1" 2; }
device_of() { field "$1" 4; }
counter_of(){ field "$1" 5; }

fail=0
ok()   { echo "ok   $*"; }
bad()  { echo "FAIL $*"; fail=1; }
step() { echo; echo "== $* =="; }

# --- the wire ---------------------------------------------------------------

teardown() {
  local row name ns
  for row in "${TILLS[@]}"; do
    set -- $row; ns=$2
    ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null
    ip netns del "$ns" 2>/dev/null
  done
  for sw in "${SWITCHES[@]}"; do ip link del "$sw" 2>/dev/null; done
}

wire_up() {
  # Bridged frames are not the host's to filter. Docker turns this on, and with
  # it on a host firewall can silently eat the broadcast this bench is about.
  [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ] && echo 0 > /proc/sys/net/bridge/bridge-nf-call-iptables
  for sw in "${SWITCHES[@]}"; do
    ip link add "$sw" type bridge && ip link set "$sw" up || return 1
  done
  local row name ns addr sw
  for row in "${TILLS[@]}"; do
    set -- $row; name=$1 ns=$2 addr=$3 sw=$4
    ip netns add "$ns" || return 1
    ip link add "v-$name" type veth peer name eth0 netns "$ns" || return 1
    ip link set "v-$name" master "$sw" up
    ip -n "$ns" link set lo up
    ip -n "$ns" addr add "$addr/24" dev eth0
    ip -n "$ns" link set eth0 up
    # A route for 255.255.255.255, which is where the shout goes.
    ip -n "$ns" route add default dev eth0
  done
}

cable() { ip -n "$(ns_of "$1")" link set eth0 "$2"; }   # cable a3 down|up

# lossy <till> <probability>: that share of packets dropped, each way.
lossy() {
  local ns; ns=$(ns_of "$1")
  ip netns exec "$ns" iptables -A INPUT -i eth0 -m statistic --mode random --probability "$2" -j DROP &&
  ip netns exec "$ns" iptables -A OUTPUT -o eth0 -m statistic --mode random --probability "$2" -j DROP
}
clean() { ip netns exec "$(ns_of "$1")" iptables -F; }

# --- a till -----------------------------------------------------------------

# start <till> <seed> [extra flags...]
start() {
  local name=$1 seed=$2; shift 2
  local ns; ns=$(ns_of "$name")
  local dev; dev=$(device_of "$name")
  mkdir -p "$work/$name"
  # In a subshell, so the script holds no job for it: a power cut is meant to
  # kill it, and bash reporting each kill would bury the results.
  ( ip netns exec "$ns" "$tsx" "$repo/tools/virtual-till/src/cli.ts" serve \
    --data "$work/$name" --device "$dev" --label "Till $name" \
    --register "$(counter_of "$name")" --seed "$seed" --star \
    --port 7803 --control 7804 --advertise 7801 "$@" >>"$work/$name.log" 2>&1 & )
  local up=""
  for _ in $(seq 1 120); do
    if ip netns exec "$ns" bash -c '(echo > /dev/tcp/127.0.0.1/7804) 2>/dev/null'; then up=1; break; fi
    sleep 0.25
  done
  [ -n "$up" ] || { echo "till $name did not start; see $work/$name.log"; tail -5 "$work/$name.log"; return 1; }
  local shop_args=()
  [ "${name:0:1}" = b ] && shop_args=(--shop "Shop B") || shop_args=(--shop "Shop A")
  ( ip netns exec "$ns" "$net_bin" answer --port 7801 --sync-port 7803 \
    --device "$dev" --label "Till $name" "${shop_args[@]}" >>"$work/$name.net.log" 2>&1 & )
  for _ in $(seq 1 40); do
    ip netns exec "$ns" bash -c '(echo > /dev/tcp/127.0.0.1/7801) 2>/dev/null' && return 0
    sleep 0.25
  done
  echo "shopos-net on $name did not start; see $work/$name.net.log"; return 1
}

# Every process on the machine, at once: a power cut, not a shutdown.
power_cut() { ip netns pids "$(ns_of "$1")" | xargs -r kill -9; sleep 0.5; }
# A clean close, so the next start is not a WAL recovery.
shut_down() { ip netns pids "$(ns_of "$1")" | xargs -r kill -TERM; sleep 1.5; }

# ctl <till> <path> [json]
ctl() {
  local body=${3:-}
  [ -n "$body" ] || body='{}'
  ip netns exec "$(ns_of "$1")" curl -sS -m 120 -X POST "http://127.0.0.1:7804$2" -d "$body"
}
bills()  { ctl "$1" /control/count '{"table":"bills"}' | sed -n 's/.*"count":\([0-9]*\).*/\1/p'; }
sync_to(){ ctl "$1" /control/sync "{\"deviceId\":\"$(device_of "$2")\"}"; }

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
