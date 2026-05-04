#!/usr/bin/env bash
# pprof capture script — captures CPU, heap, goroutine, allocs profiles
# while a wrk run is hammering the api.
#
# REQUIRES: pprof endpoint mounted in cmd/api/main.go. See PERF_AUDIT below.
# Add this in main.go (top of main, behind env gate):
#
#   import _ "net/http/pprof"
#   import "net/http"
#   if os.Getenv("ENABLE_PPROF") == "1" {
#       go func() { http.ListenAndServe("127.0.0.1:6060", nil) }()
#   }
#
# Usage:
#   ENABLE_PPROF=1 ./api &              # start server with pprof
#   ./wrk_bench.sh &                    # generate load
#   ./pprof_capture.sh                  # capture all profiles
#
# Outputs interactive svg + text reports.

set -euo pipefail

PPROF_HOST="${PPROF_HOST:-http://localhost:6060}"
DUR="${DUR:-30}"
OUT="$(dirname "$0")/pprof-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "Capturing ${DUR}s pprof profiles from $PPROF_HOST → $OUT"

# 1. CPU profile (blocks DUR seconds)
echo "→ CPU (${DUR}s)…"
curl -s "$PPROF_HOST/debug/pprof/profile?seconds=$DUR" -o "$OUT/cpu.pprof"

# 2. Heap snapshot (instant)
echo "→ heap…"
curl -s "$PPROF_HOST/debug/pprof/heap" -o "$OUT/heap.pprof"

# 3. Allocations since process start
echo "→ allocs…"
curl -s "$PPROF_HOST/debug/pprof/allocs" -o "$OUT/allocs.pprof"

# 4. Goroutine dump (count + stacks)
echo "→ goroutines…"
curl -s "$PPROF_HOST/debug/pprof/goroutine?debug=1" -o "$OUT/goroutines.txt"
GROUTINE_COUNT=$(grep -c "^goroutine " "$OUT/goroutines.txt" || true)
echo "   goroutine count: $GROUTINE_COUNT  (alert if > 10000)"

# 5. Block profile (only useful if runtime.SetBlockProfileRate(1) called)
echo "→ block (best-effort)…"
curl -s "$PPROF_HOST/debug/pprof/block" -o "$OUT/block.pprof" || true

# 6. Mutex profile (only if runtime.SetMutexProfileFraction(1) called)
echo "→ mutex (best-effort)…"
curl -s "$PPROF_HOST/debug/pprof/mutex" -o "$OUT/mutex.pprof" || true

# Render text summaries
echo
echo "── CPU top 20 ─────────────────────"
go tool pprof -top -cum -nodecount=20 "$OUT/cpu.pprof" | tee "$OUT/cpu_top.txt"

echo
echo "── HEAP top 20 (inuse_space) ──────"
go tool pprof -top -cum -nodecount=20 -sample_index=inuse_space "$OUT/heap.pprof" | tee "$OUT/heap_top.txt"

echo
echo "── ALLOCS top 20 (alloc_objects) ──"
go tool pprof -top -cum -nodecount=20 -sample_index=alloc_objects "$OUT/allocs.pprof" | tee "$OUT/allocs_top.txt"

# SVG flamegraphs (open in browser)
if command -v dot >/dev/null 2>&1; then
  go tool pprof -svg -output "$OUT/cpu.svg" "$OUT/cpu.pprof" 2>/dev/null || true
  go tool pprof -svg -output "$OUT/heap.svg" "$OUT/heap.pprof" 2>/dev/null || true
  echo "SVGs: $OUT/cpu.svg  $OUT/heap.svg"
fi

echo
echo "Done. Files in $OUT"
echo "Interactive: go tool pprof -http=:8081 $OUT/cpu.pprof"
