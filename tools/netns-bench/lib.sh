# Shared by run.sh and soak.sh: the shop's wire and the tills on it.
#
# Sourced, not run. Each till is a network namespace on a bridge, running the
# Node till and `shopos-net` the way a Layer 2 container does; see run.sh for
# what a namespace can and cannot stand in for.

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0"; exit 1; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tsx="$repo/node_modules/.bin/tsx"
net_bin="$repo/target/release/shopos-net"
work=/var/tmp/shopos-netns   # not /tmp: WSL clears it when it restarts, and the evidence goes with it
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
    set -- $row; name=$1 ns=$2
    ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null
    # The cable first: a namespace's end of it goes with the namespace, but
    # only a moment later, and a run started in that moment finds it there.
    ip link del "v-$name" 2>/dev/null
    ip netns del "$ns" 2>/dev/null
  done
  for sw in "${SWITCHES[@]}"; do ip link del "$sw" 2>/dev/null; done
}

wire_up() {
  # Bridged frames are not the host's to filter. Docker turns this on, and with
  # it on a host firewall can silently eat the broadcast this bench is about.
  [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ] && echo 0 > /proc/sys/net/bridge/bridge-nf-call-iptables
  for sw in "${SWITCHES[@]}"; do
    ip link del "$sw" 2>/dev/null
    ip link add "$sw" type bridge && ip link set "$sw" up || return 1
  done
  local row name ns addr sw
  for row in "${TILLS[@]}"; do
    set -- $row; name=$1 ns=$2 addr=$3 sw=$4
    ip netns add "$ns" || return 1
    ip link del "v-$name" 2>/dev/null
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
  # Longer than the 150 s a till waits on another (`ASK_DEADLINE`), so a slow
  # round is reported by the till that asked, not cut off here first.
  ip netns exec "$(ns_of "$1")" curl -sS -m 200 -X POST "http://127.0.0.1:7804$2" -d "$body"
}
bills()  { ctl "$1" /control/count '{"table":"bills"}' | sed -n 's/.*"count":\([0-9]*\).*/\1/p'; }
sync_to(){ ctl "$1" /control/sync "{\"deviceId\":\"$(device_of "$2")\"}"; }
