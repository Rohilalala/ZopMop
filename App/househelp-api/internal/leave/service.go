package leave

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

// CRMNotifier is the surface this module needs to fire admin alerts when a
// booking is auto-cancelled because no replacement pro was found. Wire to
// whatever the CRM module exposes (Slack, dashboard inbox, email, etc.) at
// composition time. Returning an error is logged but never blocks the
// declare-leave flow.
type CRMNotifier interface {
	NotifyCoverageGap(ctx context.Context, payload CoverageGapPayload) error
}

// CoverageGapPayload is the alert body sent to CRM when a customer booking
// is cancelled because no replacement pro was available.
type CoverageGapPayload struct {
	BookingID    string    `json:"booking_id"`
	CustomerID   string    `json:"customer_id"`
	CustomerName string    `json:"customer_name"`
	ServiceName  string    `json:"service_name"`
	ScheduledAt  time.Time `json:"scheduled_at"`
	OnLeaveProID string    `json:"on_leave_pro_id"`
}

// CustomerNotifier is the push-notification surface. We satisfy this with the
// existing notification.Service via a thin adapter at wire time.
type CustomerNotifier interface {
	NotifyHelperReassigned(ctx context.Context, customerID, bookingID string) error
	NotifyBookingCancelledNoCoverage(ctx context.Context, customerID, bookingID, when string, alternatives []string) error
}

// Service owns the business rules around leave declaration + reassignment.
type Service struct {
	repo     *Repository
	crm      CRMNotifier
	cust     CustomerNotifier
	webhooks *webhooks.Dispatcher // nil-safe: outbound CRM event fan-out
}

func NewService(repo *Repository, crm CRMNotifier, cust CustomerNotifier) *Service {
	return &Service{repo: repo, crm: crm, cust: cust}
}

// SetWebhooks attaches the outbound webhook dispatcher. nil-safe — leaving it
// unset is the correct default in unit tests where outbound HTTP would block.
func (s *Service) SetWebhooks(d *webhooks.Dispatcher) { s.webhooks = d }

// Public errors surfaced via HTTP.
var (
	ErrAfterCutoff       = errors.New("leave: cutoff passed for tomorrow")
	ErrNotTomorrow       = errors.New("leave: only tomorrow's date is allowed")
	ErrBalanceExhausted  = errors.New("leave: monthly balance exhausted")
)

// ── Balance ────────────────────────────────────────────────────────────────

// Balance reads the pro's current balance, applying the lazy monthly reset
// when reset_at is older than the start of the current IST month. Also
// returns "used" — count of leaves declared since the last reset.
func (s *Service) Balance(ctx context.Context, proID string) (Balance, error) {
	hb, err := s.repo.GetBalance(ctx, proID)
	if err != nil {
		return Balance{}, err
	}

	monthStart := startOfCurrentMonthIST(time.Now())
	if hb.LastResetAt.Before(monthStart) {
		// New month — refill to quota and stamp reset_at.
		if err := s.repo.SetBalanceWithReset(ctx, proID, hb.MonthlyQuota, monthStart); err != nil {
			return Balance{}, err
		}
		hb.Balance = hb.MonthlyQuota
		hb.LastResetAt = monthStart
	}

	used, err := s.repo.CountUsedSince(ctx, proID, monthStart)
	if err != nil {
		return Balance{}, err
	}

	return Balance{
		Balance:   hb.Balance,
		Used:      used,
		Quota:     hb.MonthlyQuota,
		ResetDate: startOfNextMonthIST(time.Now()),
	}, nil
}

// AllocateExtra is the admin path — adds `days` to the helper's current
// balance. Days can be negative.
func (s *Service) AllocateExtra(ctx context.Context, proID string, days int) (int, error) {
	if days == 0 {
		hb, err := s.repo.GetBalance(ctx, proID)
		return hb.Balance, err
	}
	return s.repo.AddBalance(ctx, proID, days)
}

// History returns leave history (newest first) for a pro.
func (s *Service) History(ctx context.Context, proID string, limit int) ([]Leave, error) {
	return s.repo.ListByPro(ctx, proID, limit)
}

// AffectedTomorrow returns the bookings the pro currently has on tomorrow IST.
// Used by the UI to preview "what gets reassigned/cancelled" before they tap
// confirm. Read-only — does not change state.
func (s *Service) AffectedTomorrow(ctx context.Context, proID string) ([]AssignedBooking, error) {
	tomorrow := startOfDayIST(time.Now().AddDate(0, 0, 1))
	return s.repo.ListProBookingsOnDate(ctx, proID, tomorrow)
}

// ── Declare ────────────────────────────────────────────────────────────────

// DeclareTomorrow runs the full declare-leave flow:
//   1. validate "before 9pm IST"
//   2. validate "date == tomorrow IST"
//   3. ensure balance triggered the lazy reset
//   4. begin tx → decrement balance → insert leave → commit
//   5. reassign / cancel affected bookings (best-effort, errors logged)
func (s *Service) DeclareTomorrow(ctx context.Context, proID string, date time.Time) ([]ReassignOutcome, error) {
	now := time.Now().In(IST)
	if now.Hour() >= CutoffHour {
		return nil, ErrAfterCutoff
	}

	tomorrow := startOfDayIST(now.AddDate(0, 0, 1))
	if !sameDayIST(date, tomorrow) {
		return nil, ErrNotTomorrow
	}

	// Trigger lazy reset before checking balance.
	if _, err := s.Balance(ctx, proID); err != nil {
		return nil, err
	}

	tx, err := s.repo.Begin(ctx)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if _, err := s.repo.DecrementBalance(ctx, tx, proID); err != nil {
		if errors.Is(err, ErrNoBalance) {
			return nil, ErrBalanceExhausted
		}
		return nil, err
	}

	if _, err := s.repo.CreateLeave(ctx, tx, proID, tomorrow, SourcePro, ""); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true

	// Reassignment pass — best effort. We log per-booking failures and keep
	// going so a single hung query never blocks the declare flow.
	outcomes, err := s.reassignAffected(ctx, proID, tomorrow)
	if err != nil {
		log.Warn().Err(err).Str("pro_id", proID).Msg("leave: reassignment pass failed")
	}

	// Outbound CRM webhook — best-effort, fire-and-forget. Captures the
	// summary so subscribers can update dashboards / kick off ops workflows.
	s.fireDeclaredWebhook(ctx, proID, tomorrow, outcomes)

	return outcomes, nil
}

// fireDeclaredWebhook emits EventLeaveDeclared with summary + per-booking
// outcomes. Nil-safe; does nothing if the dispatcher hasn't been wired.
func (s *Service) fireDeclaredWebhook(ctx context.Context, proID string, leaveDate time.Time, outcomes []ReassignOutcome) {
	if s.webhooks == nil {
		return
	}
	whOutcomes := make([]webhooks.LeaveBookingOutcome, 0, len(outcomes))
	reassigned, cancelled, balanceAfter := 0, 0, 0
	for _, o := range outcomes {
		whOutcomes = append(whOutcomes, webhooks.LeaveBookingOutcome{
			BookingID:    o.BookingID,
			Cancelled:    o.Cancelled,
			NewProID:     o.NewProID,
			CustomerName: o.CustomerName,
			ServiceName:  o.ServiceName,
			ScheduledAt:  o.ScheduledAt,
		})
		if o.Cancelled {
			cancelled++
		} else if o.NewProID != "" {
			reassigned++
		}
	}
	if hb, err := s.repo.GetBalance(ctx, proID); err == nil {
		balanceAfter = hb.Balance
	}
	s.webhooks.Dispatch(ctx, webhooks.EventLeaveDeclared, webhooks.LeaveDeclaredEvent{
		ProID:        proID,
		LeaveDate:    leaveDate.Format("2006-01-02"),
		Reassigned:   reassigned,
		Cancelled:    cancelled,
		Outcomes:     whOutcomes,
		BalanceAfter: balanceAfter,
		OccurredAt:   time.Now().UTC(),
	})
}

// AdminGrantLeave inserts a leave row for a specific date without touching
// the balance (admin override). Reassignment runs the same way.
func (s *Service) AdminGrantLeave(ctx context.Context, proID string, date time.Time, note string) ([]ReassignOutcome, error) {
	tx, err := s.repo.Begin(ctx)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	if _, err := s.repo.CreateLeave(ctx, tx, proID, startOfDayIST(date), SourceAdmin, note); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	outcomes, err := s.reassignAffected(ctx, proID, startOfDayIST(date))
	if err != nil {
		log.Warn().Err(err).Str("pro_id", proID).Msg("leave: admin reassignment pass failed")
	}
	return outcomes, nil
}

// reassignAffected pulls all of the on-leave pro's bookings for the date and
// returns each one to the assigner (spec §7): unassign → 'pending' with the
// on-leave pro excluded, so the next dispatch tick re-places it on a free pro
// (which then gets the booking_assigned push). The customer is told the helper
// changed up front; the new pro's identity arrives when the assigner places it.
//
// This replaces the old synchronous FindReplacementPro → ReassignBooking force
// pick (and its no-coverage cancel branch): the assigner already evaluates the
// full eligibility matrix (leave, clash, runway, locality, travel), so a manual
// replacement scan here would just duplicate — and diverge from — that logic.
func (s *Service) reassignAffected(ctx context.Context, leavingProID string, date time.Time) ([]ReassignOutcome, error) {
	bookings, err := s.repo.ListProBookingsOnDate(ctx, leavingProID, date)
	if err != nil {
		return nil, err
	}
	out := make([]ReassignOutcome, 0, len(bookings))

	for _, b := range bookings {
		oc := ReassignOutcome{
			BookingID:    b.ID,
			CustomerName: b.CustomerName,
			ServiceName:  b.ServiceName,
			ScheduledAt:  b.ScheduledTime.In(IST).Format("2006-01-02 15:04 MST"),
		}

		if err := s.repo.UnassignBooking(ctx, b.ID, leavingProID); err != nil {
			log.Warn().Err(err).Str("booking_id", b.ID).Msg("leave: unassign failed")
			out = append(out, oc)
			continue
		}

		// Tell the customer their helper changed; the assigner places the new pro
		// on its next tick and that pro receives the booking_assigned push.
		if s.cust != nil {
			if err := s.cust.NotifyHelperReassigned(ctx, b.CustomerID, b.ID); err != nil {
				log.Warn().Err(err).Str("booking_id", b.ID).Msg("leave: customer reassign push failed")
			}
		}
		out = append(out, oc)
	}
	return out, nil
}

// ── Helpers ────────────────────────────────────────────────────────────────

func startOfDayIST(t time.Time) time.Time {
	t = t.In(IST)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, IST)
}

func sameDayIST(a, b time.Time) bool {
	a = a.In(IST)
	b = b.In(IST)
	return a.Year() == b.Year() && a.Month() == b.Month() && a.Day() == b.Day()
}

func startOfCurrentMonthIST(now time.Time) time.Time {
	t := now.In(IST)
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, IST)
}

func startOfNextMonthIST(now time.Time) time.Time {
	t := now.In(IST)
	return time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, IST)
}

// ParseDate accepts "YYYY-MM-DD" and returns a UTC midnight time at IST date.
// Used by the handler to parse body params.
func ParseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	t, err := time.ParseInLocation("2006-01-02", s, IST)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q (want YYYY-MM-DD): %w", s, err)
	}
	return startOfDayIST(t), nil
}

// Avoid unused-import warning when pgx is only referenced via Repository.
var _ = pgx.ErrNoRows
