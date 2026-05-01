package middleware

import (
	"runtime/debug"

	"github.com/rs/zerolog/log"
)

// SafeGo runs fn in a goroutine with panic recovery.
func SafeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error().
					Str("goroutine", name).
					Interface("panic", r).
					Bytes("stack", debug.Stack()).
					Msg("goroutine panic recovered")
			}
		}()
		fn()
	}()
}
