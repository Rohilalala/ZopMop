//go:build pprof

// Pprof handlers are registered on http.DefaultServeMux only when this
// binary is built with `go build -tags pprof`. Without the tag, the blank
// import below is excluded and /debug/pprof endpoints serve 404 even if
// ENABLE_PPROF=1 starts the localhost listener (audit E3D-2 / NEW-F3-002).
package main

import (
	_ "net/http/pprof"
)
