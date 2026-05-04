#!/usr/bin/env bash
# stress.sh — single-shot orchestrator for the stress-test suite.
#
#   1. seed PG + Redis with stress_ users/helpers + JWT CSVs
#   2. run k6 against $BASE_URL
#   3. verify integrity, write JSON report
#   4. prompt before tearing the seed back down
#
# Required env: DATABASE_URL, REDIS_URL, JWT_SECRET. BASE_URL defaults to
# http://localhost:8080. Run from the househelp-api/ directory:
#     ./scripts/stress.sh
#
# Skip cleanup with NO_CLEANUP=1, skip the prompt with AUTO_CLEANUP=1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "stress.sh: \$$name is required" >&2
    exit 2
  fi
}
require_env DATABASE_URL
require_env REDIS_URL
require_env JWT_SECRET

BASE_URL="${BASE_URL:-http://localhost:8080}"
REPORT_DIR="${REPORT_DIR:-loadtest/results}"
REPORT_PATH="${REPORT_PATH:-$REPORT_DIR/stress_report_$(date +%Y%m%d_%H%M%S).json}"
mkdir -p "$REPORT_DIR"

BIN_DIR="${BIN_DIR:-$(mktemp -d -t stresstest-bin-XXXXXX)}"
trap 'rm -rf "$BIN_DIR"' EXIT

step() { printf '\n\033[1;36m[stress]\033[0m %s\n' "$*"; }

step "building tagged binaries → $BIN_DIR"
go build -tags stress_seed    -o "$BIN_DIR/seed"    ./cmd/stresstest
go build -tags stress_verify  -o "$BIN_DIR/verify"  ./cmd/stresstest
go build -tags stress_cleanup -o "$BIN_DIR/cleanup" ./cmd/stresstest

step "seeding 1000 customers + 100 helpers"
"$BIN_DIR/seed"

if ! command -v k6 >/dev/null 2>&1; then
  echo "stress.sh: k6 not found in PATH — install from https://k6.io/docs/get-started/installation/" >&2
  exit 3
fi

step "running k6 stress_full.js against $BASE_URL"
# Run k6 from inside loadtest/ so the SharedArray open() paths resolve.
(
  cd loadtest
  BASE_URL="$BASE_URL" k6 run \
    --summary-export "../$REPORT_DIR/k6_summary_$(date +%Y%m%d_%H%M%S).json" \
    stress_full.js
)

step "verifying integrity → $REPORT_PATH"
verify_status=0
"$BIN_DIR/verify" --out "$REPORT_PATH" || verify_status=$?
if [[ $verify_status -ne 0 ]]; then
  echo "stress.sh: verify reported failures (exit $verify_status). See $REPORT_PATH." >&2
fi

if [[ "${NO_CLEANUP:-0}" == "1" ]]; then
  step "NO_CLEANUP=1 set — leaving seed in place"
  exit "$verify_status"
fi

if [[ "${AUTO_CLEANUP:-0}" == "1" ]]; then
  reply="y"
else
  printf '\nstress.sh: cleanup will permanently delete every stress_ user, helper, booking, and payment plus the matching Redis state.\n'
  read -r -p 'proceed with cleanup? [y/N] ' reply || true
fi

case "$reply" in
  y|Y|yes|YES)
    step "cleaning up"
    "$BIN_DIR/cleanup" --confirm
    ;;
  *)
    step "skipping cleanup. run manually with: go run -tags stress_cleanup ./cmd/stresstest --confirm"
    ;;
esac

exit "$verify_status"
