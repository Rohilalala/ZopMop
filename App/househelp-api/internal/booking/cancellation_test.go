package booking

import (
	"testing"
	"time"
)

// Cancellation is always free per product policy — no fee on any cancel,
// regardless of how close to the (scheduled or instant) start the customer
// cancels. This locks that invariant so a future change can't silently
// reinstate the old 30-minute fee window.
func TestIsFreeCancellation_AlwaysFree(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		start time.Time
	}{
		{"well before start", now.Add(2 * time.Hour)},
		{"inside old 30m window", now.Add(10 * time.Minute)},
		{"already started", now.Add(-1 * time.Hour)},
		{"instant (start == now)", now},
	}
	for _, c := range cases {
		if !IsFreeCancellation(c.start, now) {
			t.Errorf("%s: cancellation must always be free, but fee was applicable", c.name)
		}
	}
}
