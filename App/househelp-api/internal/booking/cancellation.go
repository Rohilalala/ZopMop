package booking

import "time"

// FreeCancellationWindow is how far ahead of the scheduled start a customer
// must cancel to avoid a fee. The spec is "more than 30 minutes before".
const FreeCancellationWindow = 30 * time.Minute

// DefaultCancellationFeeCents is the flat fee charged when cancelling inside
// the protected window. Kept as a constant so callers don't need to thread a
// config dependency through; revisit if pricing becomes per-service.
const DefaultCancellationFeeCents = 10000 // ₹100

// CancellationStartTime returns the effective "scheduled start" used to judge
// the cancellation window. For scheduled bookings this is scheduled_time; for
// instant bookings (no scheduled_time) we treat the booking as starting at
// created_at — i.e. it is already past its protected window from creation.
func CancellationStartTime(b *Booking) time.Time {
	if b.ScheduledTime != nil {
		return *b.ScheduledTime
	}
	return b.CreatedAt
}

// FreeCancelDeadline is the latest instant at which the customer can still
// cancel for free.
func FreeCancelDeadline(start time.Time) time.Time {
	return start.Add(-FreeCancellationWindow)
}

// IsFreeCancellation reports whether cancelling at `now` is inside the free
// window for a booking starting at `start`. Free iff now is strictly before
// start - 30m.
func IsFreeCancellation(start, now time.Time) bool {
	return now.Before(FreeCancelDeadline(start))
}
