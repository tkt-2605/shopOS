#!/usr/bin/env bash
# Layer 2: the claims that only a real network can settle.
#
#   1. A till finds the other till on its own wire.
#   2. It does not find the till on the other shop's wire.
#   3. A host-initiated sync works across two network namespaces.
#
# Never a required check — see `.github/workflows/bench-layer2.yml` for why.
# Run it here, nightly, or when something about discovery changes.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "$here/compose.yml")

A1=1111aaaa-1111-4111-8111-111111111111
A2=2222bbbb-2222-4222-8222-222222222222
B1=3333cccc-3333-4333-8333-333333333333

cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Each till's control port, which is the stand-in for a person pressing the same
# buttons on two screens. `tr -d` because Docker Desktop on Windows can hand
# back CRLF, and a carriage return inside a JSON string is a control character
# that fails the parse thirty-seven characters in — which is not a clue.
ctl() {
  local service="$1" path="$2" body="${3:-}"
  [ -n "$body" ] || body='{}'
  "${compose[@]}" exec -T "$service" \
    curl -sS -X POST "http://127.0.0.1:7804$path" -d "$body" | tr -d '\r'
}

echo "== building and starting three tills =="
"${compose[@]}" up -d --build || exit 1

# Wait for each till to be answering rather than sleeping a fixed amount: a
# container that is slow to build better-sqlite3 must not read as a failure.
for service in till-a1 till-a2 till-b1; do
  for _ in $(seq 1 60); do
    if "${compose[@]}" exec -T "$service" \
       bash -c '(echo > /dev/tcp/127.0.0.1/7801) 2>/dev/null'; then
      break
    fi
    sleep 2
  done
done

fail=0

echo
echo "== look-around from till-a1 =="
found="$("${compose[@]}" exec -T till-a1 \
  shopos-net look-around --timeout 3000 --device "$A1" | tr -d '\r')"
echo "$found"
echo

if grep -q "$A2" <<<"$found"; then
  echo "ok   till-a1 found till-a2 on its own network"
else
  echo "FAIL till-a1 did not find till-a2"
  fail=1
fi

if grep -q "$B1" <<<"$found"; then
  echo "FAIL till-a1 found till-b1, which is a different shop on a different network"
  fail=1
else
  echo "ok   till-a1 did not find the other shop"
fi

# A till never offers itself. The responder cannot recognise the asker — they
# are different sockets — so the filtering is done by whoever knows what machine
# this is: the webview in the app, `--device` here.
if grep -q "$A1" <<<"$found"; then
  echo "FAIL till-a1 found itself"
  fail=1
else
  echo "ok   till-a1 did not find itself"
fi

echo
echo "== a sync across the real network =="

offered="$(ctl till-a1 /control/offer)"
code="$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' <<<"$offered")"

if [ -z "$code" ]; then
  # Printing what came back. "would not offer a code" on its own sends whoever
  # reads it looking in the wrong place.
  echo "FAIL till-a1 would not offer a pairing code: $offered"
  fail=1
else
  echo "     code       $code"

  # Every answer is shown. Swallowing them cost an hour the first time round:
  # pairing was failing inside the container and the only thing on screen was
  # the bill count at the end, which is the least informative end of the chain.
  echo "     pair       $(ctl till-a2 /control/pair "{\"url\":\"http://till-a1:7801\",\"code\":\"$code\"}")"
  echo "     a2 syncs   $(ctl till-a2 /control/sync "{\"deviceId\":\"$A1\"}")"
  echo "     a2 counter $(ctl till-a2 /control/claim-register)"
  echo "     a2 bills   $(ctl till-a2 /control/bill '{"docNo":"BBC/2627/00001"}')"

  # The bill exists only on till-a2. Now the *host* goes and gets it, which is
  # the direction the 1d bug broke. Layer 1 proves the logic on loopback; this
  # proves it still holds across two network namespaces with a hostname in
  # between and a Rust process carrying the bytes at each end.
  echo "     a1 fetches $(ctl till-a1 /control/sync "{\"deviceId\":\"$A2\"}")"

  held="$(ctl till-a1 /control/count '{"table":"bills"}')"
  if grep -q '"count":1' <<<"$held"; then
    echo "ok   host-initiated sync across containers ($held)"
  else
    echo "FAIL host-initiated sync across containers ($held)"
    fail=1
  fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "Layer 2: all checks passed"; else echo "Layer 2: FAILED"; fi
exit "$fail"
