#!/usr/bin/env bash
# Three ShopOS windows, each on its own machine as far as the network knows.
#
# The real app -- screens, the Rust listener, discovery -- built for Linux and
# started three times, each copy inside its own network namespace on one
# switch, with its own data folder. On Windows 11 the windows open on the
# desktop through WSLg. You use them as three counters; this script is the
# hand that pulls a cable or the plug.
#
#   sudo tools/netns-bench/windows.sh up          the switch and three windows
#   sudo tools/netns-bench/windows.sh cut 2       pull till 2's cable
#   sudo tools/netns-bench/windows.sh plug 2      put it back
#   sudo tools/netns-bench/windows.sh lossy 2 0.2 drop 20% of its packets
#   sudo tools/netns-bench/windows.sh clean 2     stop dropping them
#   sudo tools/netns-bench/windows.sh power 2     cut its power: every process, at once
#   sudo tools/netns-bench/windows.sh start 2     switch it back on
#   sudo tools/netns-bench/windows.sh status      who is up, and their addresses
#   sudo tools/netns-bench/windows.sh down        close everything; data is kept
#   sudo tools/netns-bench/windows.sh wipe        down, and delete the three tills' data
#
# The Linux build is not the Windows one: WebKitGTK draws the screens rather
# than WebView2, and printing, the firewall prompt and the updater are not
# here. What is here is the sync, between three real copies of the app.
#
# Build first, once, as your own user:
#   cd apps/pos && npx tauri build --no-bundle --config '{"identifier":"com.shopos.pos.netns"}'
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0 $*"; exit 1; }
user=${SUDO_USER:-}
[ -n "$user" ] && [ "$user" != root ] || { echo "Run it with sudo from your own user, so the windows open as you."; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
uid=$(id -u "$user")

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="$repo/target/release/shopos-pos"
data="$home/.shopos-tills"
switch=sb-win

ns_of() { echo "sb-w$1"; }
unit_of() { echo "shopos-till$1"; }
ip_of() { echo "10.77.3.1$1"; }
valid() { [[ "${1:-}" =~ ^[123]$ ]] || { echo "Which till: 1, 2 or 3"; exit 1; }; }

wire() {
  [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ] && echo 0 > /proc/sys/net/bridge/bridge-nf-call-iptables
  if ! ip link show "$switch" >/dev/null 2>&1; then
    ip link add "$switch" type bridge && ip link set "$switch" up || return 1
  fi
  local n ns
  for n in 1 2 3; do
    ns=$(ns_of $n)
    # Safe to run again: a machine already on the switch is left alone.
    ip -n "$ns" link show eth0 >/dev/null 2>&1 && continue
    ip netns list | grep -q "^$ns" || ip netns add "$ns" || return 1
    ip link del "v-w$n" 2>/dev/null
    ip link add "v-w$n" type veth peer name eth0 netns "$ns" || return 1
    ip link set "v-w$n" master "$switch" up
    ip -n "$ns" link set lo up
    ip -n "$ns" addr add "$(ip_of $n)/24" dev eth0
    ip -n "$ns" link set eth0 up
    ip -n "$ns" route add default dev eth0
  done
}

running() { [ -n "$(ip netns pids "$(ns_of "$1")" 2>/dev/null)" ]; }

start() {
  local n=$1 ns; ns=$(ns_of "$n")
  ip netns list | grep -q "^$ns" || { echo "No switch yet: run up first"; return 1; }
  if running "$n"; then echo "till $n is already on"; return 0; fi
  [ -x "$app" ] || { echo "No $app -- build it first (see the top of this file)"; return 1; }
  local dir="$data/till$n"
  runuser -u "$user" -- mkdir -p "$dir/data" "$dir/config" "$dir/cache"
  # Its own data folder is its own machine's disk: database, device id, the
  # lock that keeps one copy per folder, and the webview's cache. X11 rather
  # than Wayland: WSLg's Wayland socket belongs to the first Linux user, and
  # its X socket is open to every user, which is the one that always works.
  #
  # A systemd unit of its own, not a background job. WSL ends whatever a
  # `wsl.exe` command started when that command returns -- a hangup, and the
  # window gone -- so a till started from the panel, one click and done, died
  # a second later. systemd owns it instead, and the unit is also exactly the
  # set of processes a power cut has to take: the app and its webview's.
  #
  # The unit outlives the first process, because the app restarts itself --
  # joining a shop takes a copy of the main and restarts to open it, and so
  # does a restore. Tauri restarts by starting the new copy and then exiting
  # the old one, and a unit whose main process has exited is stopped with
  # everything in it, the new copy too. So the unit's main process is this
  # keeper, which waits until no ShopOS is left in the till's namespace.
  local keep='"$@"
    while ip netns pids "$NS" | while read -r p; do
            [ "$(cat /proc/$p/comm 2>/dev/null)" = shopos-pos ] && echo y; done | grep -q y
    do sleep 1; done'
  systemctl reset-failed "$(unit_of "$n")" 2>/dev/null
  systemd-run --quiet --collect --unit="$(unit_of "$n")" -E NS="$ns" \
    -p StandardOutput="append:$dir/app.log" -p StandardError="append:$dir/app.log" \
    bash -c "$keep" keeper \
    ip netns exec "$ns" runuser -u "$user" -- env -i \
      HOME="$home" USER="$user" PATH=/usr/bin:/bin \
      DISPLAY="${DISPLAY:-:0}" GDK_BACKEND=x11 XDG_RUNTIME_DIR="/run/user/$uid" \
      XDG_DATA_HOME="$dir/data" XDG_CONFIG_HOME="$dir/config" XDG_CACHE_HOME="$dir/cache" \
      WEBKIT_DISABLE_DMABUF_RENDERER=1 \
      "$app" || { echo "till $n would not start"; return 1; }
  echo "till $n on at $(ip_of "$n")  (log: $dir/app.log)"
}

power() {
  # SIGKILL to every process in the unit at once: no clean close, no flush.
  if systemctl is-active --quiet "$(unit_of "$1")"; then
    # WSL's systemd kills the unit's processes and then complains it could
    # not signal "auxiliary" ones, which a unit started this way has none of.
    systemctl kill --signal=KILL "$(unit_of "$1")" 2>/dev/null
    echo "till $1: power cut"
  else
    echo "till $1 was already off"
  fi
  # Anything left in the namespace from before units, or a stray child.
  local pids; pids=$(ip netns pids "$(ns_of "$1")" 2>/dev/null)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}

case "${1:-}" in
  up)
    wire || { echo "Could not build the switch"; exit 1; }
    for n in 1 2 3; do start $n; sleep 1; done
    echo
    echo "Set up till 1 as the shop, then add tills 2 and 3 from it."
    echo "Each is a different machine on the same switch: 10.77.3.11, .12 and .13."
    ;;
  start) valid "${2:-}"; wire && start "$2" ;;
  power) valid "${2:-}"; power "$2" ;;
  cut)   valid "${2:-}"; ip -n "$(ns_of "$2")" link set eth0 down && echo "till $2: cable out" ;;
  plug)  valid "${2:-}"; ip -n "$(ns_of "$2")" link set eth0 up && echo "till $2: cable in" ;;
  lossy)
    valid "${2:-}"; p=${3:-0.2}
    ip netns exec "$(ns_of "$2")" iptables -A INPUT -i eth0 -m statistic --mode random --probability "$p" -j DROP &&
    ip netns exec "$(ns_of "$2")" iptables -A OUTPUT -o eth0 -m statistic --mode random --probability "$p" -j DROP &&
    echo "till $2: dropping $p of its packets each way"
    ;;
  clean) valid "${2:-}"; ip netns exec "$(ns_of "$2")" iptables -F && echo "till $2: network clean" ;;
  status)
    for n in 1 2 3; do
      ns=$(ns_of $n)
      if ! ip netns list | grep -q "^$ns"; then echo "till $n: no switch"; continue; fi
      link=$(ip -n "$ns" -br link show eth0 | awk '{print $2}')
      drops=$(ip netns exec "$ns" iptables -S 2>/dev/null | grep -c statistic)
      printf 'till %s  %-11s  %-7s  cable %-5s%s\n' "$n" "$(ip_of $n)" \
        "$(running $n && echo on || echo off)" "$link" "$( [ "$drops" -gt 0 ] && echo '  lossy')"
    done
    ;;
  down|wipe)
    for n in 1 2 3; do
      power $n >/dev/null 2>&1
      ip link del "v-w$n" 2>/dev/null
      ip netns del "$(ns_of $n)" 2>/dev/null
    done
    ip link del "$switch" 2>/dev/null
    echo "switched off; the switch is gone"
    if [ "$1" = wipe ]; then rm -rf "$data" && echo "deleted $data"; else echo "data kept in $data"; fi
    ;;
  *) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
