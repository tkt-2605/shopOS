#!/usr/bin/env bash
# Starts the two halves of one till and keeps them together: if either dies the
# container dies, because a till answering the shout with nothing behind it is
# the exact state the product must never be in, and a container that half-works
# makes Layer 2 report a green run over a broken till.
set -euo pipefail

DEVICE="${TILL_DEVICE:?TILL_DEVICE is required}"
LABEL="${TILL_LABEL:-$DEVICE}"
REGISTER="${TILL_REGISTER:?TILL_REGISTER is required}"
SEED="${TILL_SEED:-empty}"
SHOP="${TILL_SHOP:-Bench Shop}"
SHOP_ID="${TILL_SHOP_ID:-}"
DATA="${TILL_DATA:-/data}"

mkdir -p "$DATA"

node_modules/.bin/tsx tools/virtual-till/src/cli.ts serve \
  --data "$DATA" --device "$DEVICE" --label "$LABEL" \
  --register "$REGISTER" --port 7803 --seed "$SEED" --control 7804   --advertise 7801 &
till=$!

# Wait for the till to be listening rather than sleeping and hoping: the CLI
# prints one JSON line when it is up.
for _ in $(seq 1 60); do
  if (echo > /dev/tcp/127.0.0.1/7803) 2>/dev/null; then break; fi
  sleep 0.5
done

shopos-net answer \
  --port 7801 --sync-port 7803 --device "$DEVICE" --label "$LABEL" \
  --shop "$SHOP" ${SHOP_ID:+--shop-id "$SHOP_ID"} &
net=$!

trap 'kill "$till" "$net" 2>/dev/null || true' INT TERM
wait -n "$till" "$net"
exit $?
