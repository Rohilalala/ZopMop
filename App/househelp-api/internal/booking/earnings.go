// Per-booking pro earnings computation. Snapshotted onto
// `bookings.pro_earnings_paise` at completion time so that fortnight
// aggregation has auditable line items and future rate changes don't
// retroactively shift past bookings.
//
// Formula (Phase 10):
//   base_job_pay   = actual_duration_minutes * 8000 / 60 paise (integer)
//   peak_surcharge = +₹50/hr proportional to actual_duration_minutes
//                    when completed_at falls in IST peak windows
//                    08:00–11:00 or 17:00–20:00
//   weekend_bonus  = +₹100 flat when completed_at falls on Sat/Sun IST
//
// Customer-rating bonuses are paid at fortnight close based on the
// pro's average rating, not per-booking — deferred to that aggregator.

package booking

import (
	"time"
)

const (
	baseRatePaisePerHour     = 8000  // ₹80/hr — must mirror shift.BaseRatePaisePerHour
	peakSurchargePaisePerHr  = 5000  // ₹50/hr added during peak windows
	weekendFlatBonusPaise    = 10000 // ₹100 flat on Sat/Sun
)

// EarningsBreakdown is the explainable split of pro_earnings_paise.
// Returned alongside the total so handlers (and admin tools) can show
// "you earned ₹X = base ₹A + peak ₹B + weekend ₹C".
type EarningsBreakdown struct {
	BasePaise           int64 `json:"base_paise"`
	PeakSurchargePaise  int64 `json:"peak_surcharge_paise"`
	WeekendBonusPaise   int64 `json:"weekend_bonus_paise"`
	TotalPaise          int64 `json:"total_paise"`
}

// ComputeBookingEarnings returns the breakdown for a finished booking.
// `completedAt` should be the wall-clock completion timestamp; the
// function converts to IST internally for peak/weekend bucketing.
func ComputeBookingEarnings(actualMinutes int, completedAt time.Time) EarningsBreakdown {
	if actualMinutes <= 0 {
		return EarningsBreakdown{}
	}
	ist := completedAt.In(indiaLocation())

	// Integer-only, multiply-first / truncate-once — identical to
	// payroll.ComputePay (calc.go:107) so the per-job snapshot ties to
	// the paisa with the fortnight/payroll math (no float, no round).
	base := int64(actualMinutes) * baseRatePaisePerHour / 60

	var peak int64
	if isPeakHour(ist) {
		peak = int64(actualMinutes) * peakSurchargePaisePerHr / 60
	}

	var weekend int64
	if wd := ist.Weekday(); wd == time.Saturday || wd == time.Sunday {
		weekend = weekendFlatBonusPaise
	}

	return EarningsBreakdown{
		BasePaise:          base,
		PeakSurchargePaise: peak,
		WeekendBonusPaise:  weekend,
		TotalPaise:         base + peak + weekend,
	}
}

func isPeakHour(istTime time.Time) bool {
	h := istTime.Hour()
	return (h >= 8 && h < 11) || (h >= 17 && h < 20)
}
