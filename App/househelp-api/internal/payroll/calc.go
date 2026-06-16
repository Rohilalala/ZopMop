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

// CycleForCloseDate returns the cycle that ENDED the day before `t`,
// plus true if `t` is in fact a payroll run day (the 16th, closing
// the 1st–15th cycle, or the 1st, closing the previous month's
// 16th–last cycle). Otherwise it returns (zero, false).
//
// The run fires the day AFTER cycle_end so the close day's full
// activity exists before aggregation. Firing ON the close day (the
// old behaviour) aggregated at 01:00 before any of that day's work
// happened, and UpsertPayout's ON CONFLICT DO NOTHING made the loss
// permanent — every 15th and last-of-month was silently unpaid.
//
// Cycle 1: 1st .. 15th. Cycle 2: 16th .. last-of-month. Leap-year
// safe — the last day is computed via the standard Go trick of
// constructing day 0 of the next month.
func CycleForCloseDate(t time.Time) (CycleClose, bool) {
	t = t.In(istLocation)
	y, m, d := t.Year(), t.Month(), t.Day()

	switch d {
	case 16:
		return CycleClose{
			Start: midnightIST(y, m, 1),
			End:   midnightIST(y, m, 15),
		}, true
	case 1:
		prev := t.AddDate(0, 0, -1) // last day of the previous month, IST
		py, pm := prev.Year(), prev.Month()
		return CycleClose{
			Start: midnightIST(py, pm, 16),
			End:   midnightIST(py, pm, lastDayOfMonth(py, pm)),
		}, true
	}
	return CycleClose{}, false
}

// IsCycleCloseDate reports whether `t` (in IST) is a payroll run day —
// the 1st or the 16th, i.e. the day after a cycle close.
func IsCycleCloseDate(t time.Time) bool {
	_, ok := CycleForCloseDate(t)
	return ok
}

// PayBreakdown is the computed pay for one (pro, cycle) row. All
// amounts are in paise. Working ⊆ online by the caller's contract;
// ComputePay enforces it.
type PayBreakdown struct {
	OnlineMinutes   int
	WorkingMinutes  int
	BasePayPaise    int64 // online_minutes × ₹80/hr
	BonusPayPaise   int64 // working_minutes × ₹80/hr
	GrossPayPaise   int64 // base + bonus
	DeductionsPaise int64 // sum of non-reversed admin_pro_deductions for the cycle
	NetPayPaise     int64 // gross − deductions (clamped at 0)
}

// applyDeductions subtracts admin deductions from gross, clamping net at
// zero so a pro is never marked as owing money. Returns a copy.
func (p PayBreakdown) applyDeductions(deductionsPaise int64) PayBreakdown {
	if deductionsPaise < 0 {
		deductionsPaise = 0
	}
	p.DeductionsPaise = deductionsPaise
	net := p.GrossPayPaise - deductionsPaise
	if net < 0 {
		net = 0
	}
	p.NetPayPaise = net
	return p
}

// ComputePay applies the pay formula. Integer-only:
//
//	pay_paise = minutes * 8000 / 60
//
// We multiply first to keep precision; truncation happens once at
// the end. Both calls are bounded — at 24h × 14d = 20160 min,
// 20160 * 8000 fits comfortably in int64.
func ComputePay(onlineMinutes, workingMinutes int) (PayBreakdown, error) {
	// Working ⊆ online by contract. If the aggregate reports more working
	// than online (multi-session edges, or booked-minute crediting that
	// outran the pro's online time), CAP working at online rather than
	// erroring — the pro is still paid, just never for working-minutes
	// beyond the time they were actually online. Pay model: ₹80/hr online +
	// ₹80/hr working, so a working hour pays ₹160.
	if workingMinutes > onlineMinutes {
		workingMinutes = onlineMinutes
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

// NextCloseAfter returns the next payroll-run instant strictly after
// `t`, anchored at 01:00 IST of the run day — the 1st or the 16th,
// i.e. the day after a cycle close, so the close day's activity is
// fully recorded before aggregation. Used by the cron scheduler to
// compute the next wake-up.
func NextCloseAfter(t time.Time) time.Time {
	t = t.In(istLocation)
	for offset := range 62 {
		cand := t.AddDate(0, 0, offset)
		y, m, d := cand.Year(), cand.Month(), cand.Day()
		if d != 1 && d != 16 {
			continue
		}
		fire := time.Date(y, m, d, 1, 0, 0, 0, istLocation)
		if fire.After(t) {
			return fire
		}
	}
	// Unreachable: every 31-day window contains at least one run
	// date.
	return t.AddDate(0, 1, 0)
}
