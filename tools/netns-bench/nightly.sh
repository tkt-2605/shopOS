#!/usr/bin/env bash
# The night's run: the soak and the catch-up, each on a seed nobody chose.
#
# A seed that has passed once proves little; the value is in a new one every
# night. Whatever fails keeps its evidence -- the step log, every till's
# books, the comparison -- in a folder named for the run, and the seed that
# reproduces it is in the summary's first line.
#
#   sudo tools/netns-bench/nightly.sh                   1000 soak steps, 2000 catch-up sales
#   STEPS=3000 SALES=5000 sudo tools/netns-bench/nightly.sh
#
# Writes `summary.txt` into its folder and prints it; exits non-zero when
# either run failed, which is what a scheduler or a CI job reads.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STEPS=${STEPS:-1000}
SALES=${SALES:-2000}
CUTS=${CUTS:-5}
SOAK_SEED=${SOAK_SEED:-$((RANDOM * 32768 + RANDOM))}
CATCHUP_SEED=${CATCHUP_SEED:-$((RANDOM * 32768 + RANDOM))}
runs=${NIGHTLY_DIR:-/var/tmp/shopos-nightly}
night="$runs/$(date -u +%Y-%m-%dT%H%M%SZ)"
mkdir -p "$night"

result() { # result <name> <command...>: run it, keep its output and evidence
  local name=$1; shift
  local started=$SECONDS
  "$@" >"$night/$name.out" 2>&1
  local code=$?
  cp -r /var/tmp/shopos-netns "$night/$name-evidence" 2>/dev/null
  # Kept only when it failed: a passing run's books are not worth the disk.
  [ "$code" -eq 0 ] && rm -rf "$night/$name-evidence"
  printf '%-8s %s in %ss\n' "$name" "$([ "$code" -eq 0 ] && echo passed || echo FAILED)" "$(( SECONDS - started ))"
  return "$code"
}

fail=0
{
  echo "ShopOS nightly $(date -u '+%Y-%m-%d %H:%M UTC'), commit $(git -c safe.directory="*" -C "$here" log -1 --format=%h 2>/dev/null || echo unknown)"
  echo "soak: STEPS=$STEPS SEED=$SOAK_SEED   catch-up: SALES=$SALES CUTS=$CUTS SEED=$CATCHUP_SEED"
  result soak env STEPS="$STEPS" SEED="$SOAK_SEED" "$here/soak.sh" || fail=1
  result catchup env SALES="$SALES" CUTS="$CUTS" SEED="$CATCHUP_SEED" "$here/catchup.sh" || fail=1
  for name in soak catchup; do
    grep -E '^FAIL' "$night/$name.out" | sed "s/^/  $name: /"
  done
  [ "$fail" -eq 0 ] && echo "all passed" || echo "evidence: $night"
} >"$night/summary.txt"
# Not piped through `tee`: a pipe runs the block in a subshell, and `fail`
# set in there never reached the exit code a scheduler reads.
cat "$night/summary.txt"

# Thirty nights are enough to see a pattern; older ones go.
ls -1d "$runs"/*/ 2>/dev/null | sort | head -n -30 | xargs -r rm -rf
exit "$fail"
