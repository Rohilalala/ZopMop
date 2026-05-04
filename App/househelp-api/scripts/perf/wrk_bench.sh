#!/usr/bin/env bash
# wrk benchmark suite for househelp-api
#
# Usage: ./wrk_bench.sh [host]
#   default host = http://localhost:8080
#
# Requires: wrk (brew install wrk), running api with $TOKEN env if hitting auth routes
#
# Targets (per AGENTS.md perf spec):
#   Requests/sec: > 5000
#   Latency p99:  < 500ms
#   Error rate:   < 0.1%

set -euo pipefail

HOST="${1:-http://localhost:8080}"
DURATION="${DURATION:-30s}"
THREADS="${THREADS:-12}"
CONNS="${CONNS:-400}"
OUT_DIR="$(dirname "$0")/results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

echo "host=$HOST  duration=$DURATION  threads=$THREADS  conns=$CONNS  out=$OUT_DIR"

run() {
  local name="$1" url="$2" extra="${3:-}"
  echo
  echo "── $name ─────────────────────────────────────"
  # shellcheck disable=SC2086
  wrk -t"$THREADS" -c"$CONNS" -d"$DURATION" --latency $extra "$url" \
    | tee "$OUT_DIR/$name.txt"
}

# 1. Health (no auth, no DB) — latency floor
run health "$HOST/health"

# 2. Readiness (DB + Redis ping each request)
run ready "$HOST/ready"

# 3. Public services catalog (DB-backed, cached)
run services_list "$HOST/api/v1/services"

# 4. Insights (Redis GEOSEARCH + DB) — geo hot path, target endpoint
run insights "$HOST/api/v1/insights/nearby?lat=28.6&lng=77.2"

# 5. SDUI home page — biggest hydration fan-out
run sdui_home "$HOST/api/v1/sdui/page/home?lat=28.6&lon=77.2"

# 6. Authenticated route (set TOKEN env first)
if [[ -n "${TOKEN:-}" ]]; then
  HEADER_LUA="$(mktemp)"
  cat > "$HEADER_LUA" <<EOF
wrk.method  = "GET"
wrk.headers["Authorization"] = "Bearer $TOKEN"
EOF
  run me_bookings "$HOST/api/v1/bookings" "-s $HEADER_LUA"
  rm -f "$HEADER_LUA"
else
  echo "(skipping authed routes — set TOKEN env to enable)"
fi

echo
echo "results in: $OUT_DIR"
echo
echo "Targets: rps>5000  p99<500ms  errors<0.1%"
echo "Grep summaries:"
grep -E "Requests/sec|Latency|Non-2xx" "$OUT_DIR"/*.txt || true
