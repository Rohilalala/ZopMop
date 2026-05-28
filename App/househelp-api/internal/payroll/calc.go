// Package payroll computes the salaried pro pay for one half-month cycle
// as a pure function of online + working minutes. It MUST stay decoupled
// from customer-payment state and from the cash-collection / settlement
// ledger. The pro is paid identically regardless of whether or how the
// customer paid. See docs/phase-1-payment-gated-flow.md for the
// rationale; decoupling_test.go in this package enforces the rule via a
// grep over package source files.
package payroll

import (
	"errors"
	"time"
)

// ErrInvalidActivity fires when a pro has more working minutes than
// online minutes — impossible by construction (working ⊆ online).
// The cron treats this as a data-integrity bug; the row is skipped
// and the caller logs.
var ErrInvalidActivity = errors.New("payroll: working minutes exceed online minutes")

// CycleClose describes one half-month pay cycle.
type CycleClose struct {
	Start time.Time // IST midnight on cycle_start (00:00:00)
	End   time.Time // IST midnight on cycle_end   (00:00:00)
}

// StartDate returns cycle_start as a YYYY-MM-DD string.
func (c CycleClose) StartDate() string { return c.Start.Format("2006-01-02") }

// EndDate returns cycle_end as a YYYY-MM-DD string.
func (c CycleClose) EndDate() string { return c.End.Format("2006-01-02") }

// CycleForCloseDate returns the cycle whose close date is `t`, plus
// true if `t` is in fact a cycle close (the 15th or the last day of
// its month in IST). Otherwise it returns (zero, false).
//
// Cycle 1: 1st .. 15th. Cycle 2: 16th .. last-of-month. Leap-year
// safe — the last day is computed via the standard Go trick of
// constructing day 0 of the next month.
func CycleForCloseDate(t time.Time) (CycleClose, bool) {
	t = t.In(istLocation)
	y, m, d := t.Year(), t.Month(), t.Day()
	lastDay := lastDayOfMonth(y, m)

	switch d {
	case 15:
		return CycleClose{
			Start: midnightIST(y, m, 1),
			End:   midnightIST(y, m, 15),
		}, true
	case lastDay:
		return CycleClose{
			Start: midnightIST(y, m, 16),
			End:   midnightIST(y, m, lastDay),
		}, true
	}
	return CycleClose{}, false
}

// IsCycleCloseDate reports whether `t` (in IST) is the 15th or the
// last day of its calendar month.
func IsCycleCloseDate(t time.Time) bool {
	_, ok := CycleForCloseDate(t)
	return ok
}

// PayBreakdown is the computed pay for one (pro, cycle) row. All
// amounts are in paise. Working ⊆ online by the caller's contract;
// ComputePay enforces it.
type PayBreakdown struct {
	OnlineMinutes  int
	WorkingMinutes int
	BasePayPaise   int64 // online_minutes × ₹80/hr
	BonusPayPaise  int64 // working_minutes × ₹80/hr
	GrossPayPaise  int64 // base + bonus
	NetPayPaise    int64 // gross − deductions (deductions = 0 in v1)
}

// ComputePay applies the pay formula. Integer-only:
//
//	pay_paise = minutes * 8000 / 60
//
// We multiply first to keep precision; truncation happens once at
// the end. Both calls are bounded — at 24h × 14d = 20160 min,
// 20160 * 8000 fits comfortably in int64.
func ComputePay(onlineMinutes, workingMinutes int) (PayBreakdown, error) {
	if workingMinutes > onlineMinutes {
		return PayBreakdown{}, ErrInvalidActivity
	}
	base := int64(onlineMinutes) * BaseRatePaisePerHour / 60
	bonus := int64(workingMinutes) * BonusRatePaisePerHour / 60
	gross := base + bonus
	return PayBreakdown{
		OnlineMinutes:  onlineMinutes,
		WorkingMinutes: workingMinutes,
		BasePayPaise:   base,
		BonusPayPaise:  bonus,
		GrossPayPaise:  gross,
		NetPayPaise:    gross, // deductions are zero in v1
	}, nil
}

// midnightIST returns 00:00:00 IST on the given calendar date.
func midnightIST(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, istLocation)
}

// lastDayOfMonth returns 28..31 for the given calendar month using
// the standard "day 0 of next month" trick so leap years and the
// 30/31-day variance are handled by stdlib date math.
func lastDayOfMonth(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 0, 0, 0, 0, istLocation).Day()
}

// ComputeEffectiveStartDate applies the onboarding rule: a helper
// who signs up before today's 03:00 IST cutoff can still commit
// for today; after 03:00, today's shift bus has left and they
// start tomorrow.
//
//	now  < 03:00 IST → today (IST date)
//	now >= 03:00 IST → tomorrow (IST date)
//
// Returned as a YYYY-MM-DD string in IST so callers feed the
// helpers.effective_start_date DATE column without timezone
// ambiguity. The function is pure — pass a frozen `now` to test.
func ComputeEffectiveStartDate(now time.Time) string {
	ist := now.In(istLocation)
	threeAM := time.Date(ist.Year(), ist.Month(), ist.Day(), 3, 0, 0, 0, istLocation)
	d := ist
	if !ist.Before(threeAM) {
		d = ist.AddDate(0, 0, 1)
	}
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, istLocation).Format("2006-01-02")
}

// ProratedTargetHours computes the fortnight hours target for a
// helper who may have joined or left mid-cycle. Returns 0 when
// the helper had no overlap with the cycle (free pass).
//
//	days_available = days in (max(effective_start, cycle_start) ..
//	                          min(deactivated_or_cycle_end, cycle_end))
//	target_hours   = ceil(80/14 * days_available)
//
// All inputs are IST calendar dates at 00:00. `deactivatedAt` is
// optional — pass the zero time.Time when the helper is still
// active.
func ProratedTargetHours(effectiveStart, deactivatedAt, cycleStart, cycleEnd time.Time) int {
	start := maxDate(effectiveStart, cycleStart)
	end := cycleEnd
	if !deactivatedAt.IsZero() && deactivatedAt.Before(end) {
		end = deactivatedAt
	}
	if end.Before(start) {
		return 0
	}
	days := int(end.Sub(start).Hours()/24) + 1
	if days <= 0 {
		return 0
	}
	// ceil(80/14 * days) using integer math.
	num := 80 * days
	target := num / 14
	if num%14 != 0 {
		target++
	}
	return target
}

func maxDate(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// NextCloseAfter returns the next cycle-close instant strictly after
// `t`, anchored at 01:00 IST of the close date. Used by the cron
// scheduler to compute the next wake-up.
func NextCloseAfter(t time.Time) time.Time {
	t = t.In(istLocation)
	for offset := range 62 {
		cand := t.AddDate(0, 0, offset)
		y, m, d := cand.Year(), cand.Month(), cand.Day()
		if d != 15 && d != lastDayOfMonth(y, m) {
			continue
		}
		fire := time.Date(y, m, d, 1, 0, 0, 0, istLocation)
		if fire.After(t) {
			return fire
		}
	}
	// Unreachable: every 31-day window contains at least one close
	// date.
	return t.AddDate(0, 1, 0)
}
