package shift

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/rs/zerolog/log"
)

// Service is the entry point for all Phase-7 shift operations.
// Notification is fed in as a narrow interface so we don't pull the
// full notification package's API surface into this layer.
type Notifier interface {
	PushToPro(ctx context.Context, proID, title, body string, data map[string]string) error
	PushToAdminGroup(ctx context.Context, title, body string, data map[string]string) error
}

// CancelHooks lets the wiring layer plug in the booking-side side
// effects of a pro cancellation (customer push + outbox event) without
// the shift package importing the notification/booking packages. All
// calls are best-effort: a push failure must not roll back the cancel,
// which is already committed to the DB by the time these fire.
//
// Refund orchestration and automatic re-dispatch are intentionally NOT
// wired here — they are a product decision (whether a prepaid customer
// is auto-refunded vs auto-rebooked) and are tracked separately.
type CancelHooks interface {
	NotifyCustomerBookingCancelled(ctx context.Context, customerID, bookingID string) error
}

type Service struct {
	repo        *Repository
	ntf         Notifier
	cancelHooks CancelHooks
}

func NewService(repo *Repository) *Service { return &Service{repo: repo} }

func (s *Service) SetNotifier(n Notifier) { s.ntf = n }

// SetCancelHooks injects the customer-facing cancel side effects.
func (s *Service) SetCancelHooks(h CancelHooks) { s.cancelHooks = h }

// istLocation is the canonical India Standard Time zone — load once.
var istLocation = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		// Fallback: fixed UTC+5:30. Real production deploy will have
		// the tzdata available; this guard exists for stripped CI.
		return time.FixedZone("IST", 5*3600+1800)
	}
	return loc
}()

// IST returns the current time in Asia/Kolkata.
func IST() time.Time { return time.Now().In(istLocation) }

// ─── Commit / Uncommit ────────────────────────────────────────────

// CommitShift validates + inserts a shift. Lock-window rule: a shift
// for tomorrow must be committed before 3:00 AM IST of tomorrow's
// date. Same-day commits land on today's locked window so the only
// pathway is "tomorrow or later".
func (s *Service) CommitShift(ctx context.Context, proID string, req CommitRequest) (*Commitment, error) {
	shiftDate, err := time.ParseInLocation("2006-01-02", req.ShiftDate, istLocation)
	if err != nil {
		return nil, fmt.Errorf("%w: shift_date format", ErrShiftBounds)
	}
	start, err := time.Parse("15:04", req.StartTime)
	if err != nil {
		return nil, fmt.Errorf("%w: start_time format", ErrShiftBounds)
	}
	end, err := time.Parse("15:04", req.EndTime)
	if err != nil {
		return nil, fmt.Errorf("%w: end_time format", ErrShiftBounds)
	}
	if !end.After(start) || end.Sub(start) > 16*time.Hour {
		return nil, ErrShiftBounds
	}

	now := IST()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, istLocation)
	if !shiftDate.After(today) {
		// shift_date must be > today. Today's shift is already locked.
		return nil, ErrShiftDateInPast
	}

	// Same-day-as-shift lock: if shift is for tomorrow AND we're past
	// 3 AM IST of tomorrow (impossible since shift_date is tomorrow
	// and now is < tomorrow 3 AM means we're fine), so this check
	// fires only when shift_date == tomorrow AND now is past tomorrow
	// 03:00. Trivially impossible given the today() guard above —
	// keep the explicit check for the day-of-tomorrow edge.
	tomorrow := today.AddDate(0, 0, 1)
	if shiftDate.Equal(tomorrow) {
		lock := time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 3, 0, 0, 0, istLocation)
		if !now.Before(lock) {
			return nil, ErrShiftAfterLockWindow
		}
	}

	return s.repo.InsertCommitment(ctx, proID, req.ShiftDate, req.StartTime, req.EndTime)
}

// UncommitShift cancels a non-locked commitment.
func (s *Service) UncommitShift(ctx context.Context, proID, commitmentID string) error {
	c, err := s.repo.GetCommitmentForPro(ctx, proID, commitmentID)
	if err != nil {
		return err
	}
	if c.LockedAt != nil {
		return ErrCommitmentLocked
	}
	if c.Status != "committed" {
		return ErrCommitmentLocked
	}
	return s.repo.CancelCommitment(ctx, commitmentID)
}

// ListUpcomingCommitments — next 14 days.
func (s *Service) ListUpcomingCommitments(ctx context.Context, proID string) ([]Commitment, error) {
	return s.repo.ListUpcomingCommitments(ctx, proID)
}

// ─── 3 AM cron ────────────────────────────────────────────────────

// LockShiftsAt3AM stamps locked_at + writes absence rows. Idempotent:
// re-running mid-morning is a no-op for already-locked shifts and
// absences (ON CONFLICT DO NOTHING).
func (s *Service) LockShiftsAt3AM(ctx context.Context) error {
	if err := s.repo.LockShiftsForToday(ctx); err != nil {
		return fmt.Errorf("lock shifts: %w", err)
	}

	missing, err := s.repo.ProsWithoutShiftToday(ctx)
	if err != nil {
		return fmt.Errorf("list missing pros: %w", err)
	}

	fortnightStart := currentFortnightStart(IST()).Format("2006-01-02")

	for _, proID := range missing {
		existed, err := s.repo.AbsenceExistsInFortnight(ctx, proID, fortnightStart)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[shift] absence-exists check failed")
			continue
		}
		firstInFortnight := !existed

		// Leave-balance branch: any non-zero balance trumps the cash
		// deduction. The first-in-fortnight rule is independent — the
		// pro still gets the "1st-time-free" metric flag.
		snap, err := s.repo.HelperFortnight(ctx, proID)
		var leaveDeducted bool
		var cashPaise int
		switch {
		case firstInFortnight:
			leaveDeducted = false
			cashPaise = 0
		case err == nil && snap.LeaveBalance > 0:
			leaveDeducted = true
			cashPaise = 0
		default:
			leaveDeducted = false
			cashPaise = AbsenceCashPenaltyPaise
		}

		inserted, err := s.repo.InsertAbsence(ctx, proID, "no_commit_by_3am", fortnightStart, firstInFortnight, leaveDeducted, cashPaise)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[shift] insert absence failed")
			continue
		}
		if inserted && leaveDeducted {
			_ = s.decrementLeaveBalance(ctx, proID)
		}
	}
	return nil
}

func (s *Service) decrementLeaveBalance(ctx context.Context, proID string) error {
	return s.repo.DecrementLeaveBalance(ctx, proID)
}

// ─── Go Online / Go Offline ───────────────────────────────────────

// GoOnline verifies the pro is in the right time window + zone, then
// opens a session. Outside-zone path returns LocationOK=false +
// RequiresManualApproval=true unless an approval is already on file
// for this commitment.
func (s *Service) GoOnline(ctx context.Context, proID, commitmentID string, lat, lng float64) (*GoOnlineResult, error) {
	c, err := s.repo.GetCommitmentForPro(ctx, proID, commitmentID)
	if err != nil {
		return nil, err
	}

	now := IST()

	// Verify time window: locked_at non-nil OR shift is for today
	// (in case cron lagged). Allow Go Online from start_time - 0
	// (no early gate per spec; UC also doesn't enforce one) up to
	// shift end.
	shiftStart, shiftEnd, err := commitmentWindow(c)
	if err != nil {
		return nil, err
	}
	if now.Before(shiftStart.Add(-OnTimeGraceMinutes * time.Minute)) {
		// Too early — beyond the "30 min before start" early window.
		return nil, ErrShiftNotActive
	}
	if now.After(shiftEnd) {
		return nil, ErrShiftNotActive
	}

	// Already online?
	existing, _, err := s.repo.CurrentSessionForPro(ctx, proID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrAlreadyOnline
	}

	// Approval bypass: if admin has approved for this commitment,
	// skip the radius check entirely.
	approved, adminID, err := s.repo.ApprovedApprovalForCommitment(ctx, commitmentID)
	if err != nil {
		return nil, err
	}

	locationOK := false
	var distance float64
	if !approved {
		_, zLat, zLng, shiftRadiusKm, zErr := s.repo.CurrentZoneAssignment(ctx, proID)
		if zErr != nil {
			// A missing zone assignment is a precondition failure the
			// app must handle distinctly (412) — not a radius miss that
			// dumps the pro into the selfie flow with "0m away". Any
			// other lookup error (DB blip/timeout) is a genuine 500, not
			// a silent manual-approval.
			if errors.Is(zErr, ErrNoZoneAssigned) {
				return nil, ErrNoZoneAssigned
			}
			return nil, fmt.Errorf("zone assignment lookup: %w", zErr)
		}
		distance = haversineMeters(lat, lng, zLat, zLng)
		// Per-zone Go-Online verification radius — distinct
		// from service_zones.radius_km (the customer-facing
		// service area). Ops can tune per-zone; default is
		// 1.0 km (the spec's original number).
		locationOK = distance <= shiftRadiusKm*1000
	}

	if !approved && !locationOK {
		// Surface the manual-approval pathway. If a pending request
		// already exists, signal that so the app routes the pro to the
		// "waiting for approval" state instead of asking for another
		// selfie (a resubmit would 409 ErrApprovalPending).
		_, hasPending, _ := s.repo.PendingApprovalForCommitment(ctx, commitmentID)
		return &GoOnlineResult{
			LocationOK:             false,
			RequiresManualApproval: true,
			DistanceMeters:         distance,
			ApprovalPending:        hasPending,
		}, nil
	}

	// Late grace handling — past start + 30 min flags late_show.
	if now.After(shiftStart.Add(OnTimeGraceMinutes * time.Minute)) {
		_ = s.repo.MarkLateShow(ctx, commitmentID)
	}

	sessID, err := s.repo.OpenSession(ctx, commitmentID, proID, lat, lng, approved || locationOK, approved, adminID)
	if err != nil {
		return nil, err
	}
	_ = s.repo.MarkActive(ctx, commitmentID)

	return &GoOnlineResult{
		SessionID:              sessID,
		LocationOK:             true,
		RequiresManualApproval: false,
		DistanceMeters:         distance,
	}, nil
}

// GoOffline closes the session unless bookings are still pending.
func (s *Service) GoOffline(ctx context.Context, proID, sessionID string) error {
	pending, err := s.repo.PendingBookingsCountForPro(ctx, proID)
	if err != nil {
		return err
	}
	if pending > 0 {
		return ErrBookingsPending
	}
	minutes, err := s.repo.CloseSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if err := s.repo.BumpHelperOnlineMinutes(ctx, proID, minutes); err != nil {
		log.Warn().Err(err).Msg("[shift] bump online minutes failed")
	}
	return nil
}

// ─── Manual approval ──────────────────────────────────────────────

// RequestManualApproval files a pending zone_approval_requests row.
// The app uploads the selfie via a separate file-upload pipeline and
// passes the resulting URL here.
func (s *Service) RequestManualApproval(ctx context.Context, proID, commitmentID string, lat, lng float64, photoURL string) (string, error) {
	if _, exists, err := s.repo.PendingApprovalForCommitment(ctx, commitmentID); err != nil {
		return "", err
	} else if exists {
		return "", ErrApprovalPending
	}
	id, err := s.repo.InsertZoneApproval(ctx, proID, commitmentID, lat, lng, photoURL)
	if err != nil {
		return "", err
	}
	if s.ntf != nil {
		go func() {
			ctxBG, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			name := s.repo.NameForPro(ctxBG, proID)
			s.PushZoneApprovalPending(ctxBG, id, proID, name)
		}()
	}
	return id, nil
}

// ListPendingZoneApprovals exposes the admin queue read path for CRM
// consumers that don't sit on top of the shift package directly.
func (s *Service) ListPendingZoneApprovals(ctx context.Context) ([]ZoneApprovalRequest, error) {
	return s.repo.ListPendingZoneApprovals(ctx)
}

// ApproveZoneRequest is the admin path. status='approved'.
func (s *Service) ApproveZoneRequest(ctx context.Context, requestID, adminID string) error {
	if err := s.repo.DecideZoneApproval(ctx, requestID, "approved", adminID, ""); err != nil {
		return err
	}
	if s.ntf != nil {
		go func() {
			ctxBG, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			proID, commitmentID, _, err := s.repo.ZoneApprovalByID(ctxBG, requestID)
			if err != nil || proID == "" {
				log.Warn().Err(err).Str("request_id", requestID).Msg("[shift] fetch pro_id for approval push failed")
				return
			}
			s.PushZoneApprovalGranted(ctxBG, proID, requestID, commitmentID)
		}()
	}
	return nil
}

// RejectZoneRequest is the admin path. status='rejected'.
func (s *Service) RejectZoneRequest(ctx context.Context, requestID, adminID, notes string) error {
	if err := s.repo.DecideZoneApproval(ctx, requestID, "rejected", adminID, notes); err != nil {
		// ErrAlreadyReviewed (or any error) → no push. Caller maps to 409.
		return err
	}
	if s.ntf != nil {
		go func() {
			ctxBG, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			proID, _, _, err := s.repo.ZoneApprovalByID(ctxBG, requestID)
			if err != nil || proID == "" {
				log.Warn().Err(err).Str("request_id", requestID).Msg("[shift] fetch pro_id for rejection push failed")
				return
			}
			// Push failure must not roll back the rejection — DB is the
			// source of truth. PushZoneApprovalRejected swallows + logs.
			s.PushZoneApprovalRejected(ctxBG, proID, requestID, notes)
		}()
	}
	return nil
}

// ─── Cancellations ────────────────────────────────────────────────

// CancelBooking applies the 5-strike rule. customer_was_notified is
// inferred from booking status: anything past 'pending' counts.
func (s *Service) CancelBooking(ctx context.Context, proID, bookingID string) (*CancelBookingResult, error) {
	owner, _, err := s.repo.BookingOwnerAndStatus(ctx, bookingID)
	if err != nil {
		return nil, err
	}
	if owner != proID {
		return nil, ErrBookingNotOwnedByPro
	}

	prior, err := s.repo.CountCancellations30d(ctx, proID)
	if err != nil {
		return nil, err
	}
	index := prior + 1
	estMinutes := s.repo.BookingMinutesEstimate(ctx, bookingID)

	// A cancellable booking is always in 'accepted' state, so the
	// customer has already been notified a pro is on the way.
	customerNotified := true
	penaltyPaise := 0
	if index >= StrikeThreshold {
		penaltyPaise = (BaseRatePaisePerHour * estMinutes) / 60
	}

	// Re-dispatch instead of dead-ending (spec §7): a future booking returns to
	// the assigner with this pro excluded so it isn't immediately re-offered to
	// them. Once the slot has passed there's nothing to re-dispatch, so keep the
	// old terminal cancel path. scheduled_time read failure also falls back to
	// cancel — never leave the booking stuck assigned to a pro who quit it.
	scheduledTime, stErr := s.repo.BookingScheduledTime(ctx, bookingID)
	reDispatch := stErr == nil && time.Now().Before(scheduledTime)
	var customerID string
	if reDispatch {
		// Returns the booking to the assigner; no customer-facing cancel,
		// so customerID stays empty and the notify block below is skipped.
		if err := s.repo.UnassignBooking(ctx, bookingID, proID); err != nil {
			return nil, err
		}
	} else {
		// Status guard + idempotency: the conditional UPDATE flips ONLY an
		// 'accepted' booking still owned by this pro to 'cancelled'. A
		// double-tap, a timeout-retry, or an already-completed/cancelled
		// booking matches 0 rows → ErrBookingNotCancellable (409) and we
		// never stack a second strike or flip a finished job. Returns the
		// customer_id so we can notify the waiting prepaid customer.
		var err error
		customerID, err = s.repo.MarkBookingCancelled(ctx, bookingID, proID)
		if err != nil {
			return nil, err
		}
	}
	if err := s.repo.InsertCancellation(ctx, proID, bookingID, customerNotified, estMinutes, penaltyPaise, index); err != nil {
		return nil, err
	}
	_ = s.repo.BumpCancellationCount30d(ctx, proID)

	// Customer-facing side effect: push + outbox so the prepaid customer
	// learns their pro cancelled (previously silent — the customer kept
	// waiting). Best-effort; the cancel is already committed.
	if s.cancelHooks != nil && customerID != "" {
		if nerr := s.cancelHooks.NotifyCustomerBookingCancelled(ctx, customerID, bookingID); nerr != nil {
			log.Warn().Err(nerr).Str("booking_id", bookingID).Msg("[shift] notify customer of pro cancellation failed")
		}
	}

	return &CancelBookingResult{
		CancellationIndex30d: index,
		PenaltyApplied:       penaltyPaise > 0,
		PenaltyAmountPaise:   penaltyPaise,
	}, nil
}

// ─── Fortnight progress ───────────────────────────────────────────

// FortnightProgress aggregates the data points the Money tab renders.
func (s *Service) FortnightProgress(ctx context.Context, proID string) (*FortnightProgress, error) {
	snap, err := s.repo.HelperFortnight(ctx, proID)
	if err != nil {
		return nil, err
	}
	// Anchor on the canonical payroll cycle (1–15 / 16–EOM), NOT the
	// frozen helpers.fortnight_start_date. That column was backfilled
	// once at migration 098 and never advanced, so the old read anchor
	// disagreed with the rolling-Monday write anchor (absence deductions
	// vanished) and never reset (projected pay grew for life).
	now := IST()
	fortnightStart := currentFortnightStart(now)
	fortnightEnd := currentFortnightEnd(now)

	targetMinutes := snap.WeeklyHoursTarget * 60
	// Online minutes from shift_sessions within the cycle window — the
	// same source payroll aggregates — so the figure zeroes each cycle
	// and matches the eventual payout rather than the unbounded
	// helpers.current_fortnight_online_min counter.
	onlineMin, err := s.repo.FortnightOnlineMinutes(ctx, proID, fortnightStart, fortnightEnd)
	if err != nil {
		return nil, err
	}
	overtimeMin := onlineMin - targetMinutes
	if overtimeMin < 0 {
		overtimeMin = 0
	}

	// Pay formula MUST match payroll.ComputePay: base on ALL online
	// minutes + bonus on job minutes, both at BaseRatePaisePerHour, with
	// no separate overtime tier. The overtime split below is informational
	// only (rendered as a line) — it is not paid at a different rate, and
	// is no longer added on top, which is what made the Money tab promise
	// a number the payroll engine never paid.
	onlinePay := (BaseRatePaisePerHour * onlineMin) / 60
	overtimePay := 0 // overtime not a separate pay tier in payroll v1

	jobMin, err := s.repo.FortnightJobMinutes(ctx, proID, fortnightStart, fortnightEnd)
	if err != nil {
		return nil, err
	}
	jobPay := (BaseRatePaisePerHour * jobMin) / 60

	absenceDeductions, cancellationDeductions, err := s.repo.FortnightDeductionsSplit(ctx, proID, fortnightStart, fortnightEnd)
	if err != nil {
		return nil, err
	}
	totalDeductions := absenceDeductions + cancellationDeductions
	projected := onlinePay + overtimePay + jobPay - totalDeductions
	if projected < 0 {
		projected = 0
	}

	return &FortnightProgress{
		FortnightStart:              fortnightStart.Format("2006-01-02"),
		FortnightEnd:                fortnightEnd.Format("2006-01-02"),
		OnlineMinutes:               onlineMin,
		TargetMinutes:               targetMinutes,
		OvertimeMinutes:             overtimeMin,
		JobMinutes:                  jobMin,
		OnlinePayPaise:              onlinePay,
		OvertimePayPaise:            overtimePay,
		JobPayPaise:                 jobPay,
		AbsenceDeductionsPaise:      absenceDeductions,
		CancellationDeductionsPaise: cancellationDeductions,
		DeductionsPaise:             totalDeductions,
		TotalDeductionsPaise:        totalDeductions,
		ProjectedPayPaise:           projected,
		CancellationCount30d:        snap.CancellationCount30d,
		LeaveBalance:                snap.LeaveBalance,
	}, nil
}

// ─── Helpers ──────────────────────────────────────────────────────

// commitmentWindow parses shift_date + start_time + end_time into IST
// time.Time bounds.
func commitmentWindow(c *Commitment) (start, end time.Time, err error) {
	d, err := time.ParseInLocation("2006-01-02", c.ShiftDate, istLocation)
	if err != nil {
		return
	}
	st, err := time.Parse("15:04", c.StartTime)
	if err != nil {
		return
	}
	et, err := time.Parse("15:04", c.EndTime)
	if err != nil {
		return
	}
	start = time.Date(d.Year(), d.Month(), d.Day(), st.Hour(), st.Minute(), 0, 0, istLocation)
	end = time.Date(d.Year(), d.Month(), d.Day(), et.Hour(), et.Minute(), 0, 0, istLocation)
	if !end.After(start) {
		err = errors.New("end before start")
	}
	return
}

// currentFortnightStart returns the canonical pay-cycle anchor for the
// IST date `t`: the 1st (for days 1–15) or the 16th (for days 16–EOM).
// This MUST match payroll.CycleForCloseDate's half-month boundaries —
// the Money tab read anchor and the 3 AM absence write key both key off
// this, and payroll closes on those same cycles. The old rolling-Monday
// anchor (a) never reset cleanly, (b) disagreed with the frozen
// helpers.fortnight_start_date the deduction reads used, and (c) was a
// third, divergent pay window on top of payroll's.
func currentFortnightStart(t time.Time) time.Time {
	d := t.In(istLocation)
	if d.Day() >= 16 {
		return time.Date(d.Year(), d.Month(), 16, 0, 0, 0, 0, istLocation)
	}
	return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, istLocation)
}

// currentFortnightEnd returns the inclusive last IST date of the pay
// cycle containing `t`: the 15th (for the 1st–15th cycle) or the last
// day of the month (for the 16th–EOM cycle).
func currentFortnightEnd(t time.Time) time.Time {
	d := t.In(istLocation)
	if d.Day() >= 16 {
		// Day 0 of next month = last day of this month (leap-safe).
		return time.Date(d.Year(), d.Month()+1, 0, 0, 0, 0, 0, istLocation)
	}
	return time.Date(d.Year(), d.Month(), 15, 0, 0, 0, 0, istLocation)
}

// haversineMeters returns the great-circle distance between two
// lat/lng pairs in metres.
func haversineMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	φ1 := lat1 * math.Pi / 180
	φ2 := lat2 * math.Pi / 180
	Δφ := (lat2 - lat1) * math.Pi / 180
	Δλ := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(Δφ/2)*math.Sin(Δφ/2) +
		math.Cos(φ1)*math.Cos(φ2)*math.Sin(Δλ/2)*math.Sin(Δλ/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return r * c
}
