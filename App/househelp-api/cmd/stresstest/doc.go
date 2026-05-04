// Package main hosts the stress-test entrypoints. Exactly one of seed,
// verify, or cleanup compiles per build via the matching build tag —
// stress_seed, stress_verify, or stress_cleanup. Without any of those tags,
// this stub compiles instead so `go build ./...` stays clean.
//
//go:build !stress_seed && !stress_verify && !stress_cleanup
// +build !stress_seed,!stress_verify,!stress_cleanup

package main

import "fmt"

func main() {
	fmt.Println("stresstest: rebuild with -tags=stress_seed | stress_verify | stress_cleanup")
}
