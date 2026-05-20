// Package payroll computes per-pro pay for each half-month cycle and
// writes one payouts row per (pro, cycle). It is the engine behind
// the ₹80/hr online + ₹80/hr working-bonus pay model.
//
// Cycles:
//   - 1st .. 15th of month   → paid at 01:00 IST on the 15th
//   - 16th .. last-of-month  → paid at 01:00 IST on the last day
//
// Targets (80 online hours, 85% acceptance) and proration ship in a
// follow-up PR; this package only computes pay.
package payroll

import "time"

// Pay constants. Held in code (not DB) so a rate change does not
// require a migration. Both rates are equal in the current model;
// they're separate fields so the breakdown stays inspectable when
// the bonus rate drifts away from base in the future.
const (
	// BaseRatePaisePerHour is the per-hour online rate in paise
	// (₹80 = 8000 paise).
	BaseRatePaisePerHour int64 = 8000

	// BonusRatePaisePerHour is the per-hour working-time bonus in
	// paise. Pay formula: online_hours*base + working_hours*bonus.
	BonusRatePaisePerHour int64 = 8000
)

// IST is the canonical India Standard Time zone — loaded once.
var istLocation = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		// Fallback used by stripped CI images that lack tzdata.
		return time.FixedZone("IST", 5*3600+1800)
	}
	return loc
}()

// IST returns now in Asia/Kolkata.
func IST() time.Time { return time.Now().In(istLocation) }

// Location returns the canonical IST zone for callers that need to
// construct cycle anchors themselves (e.g. tests).
func Location() *time.Location { return istLocation }
