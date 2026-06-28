package payroll

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog/log"
)

// AcceptanceTargetRate is the per-cycle acceptance threshold below
// which the cron writes an acceptance_below_threshold flag.
const AcceptanceTargetRate = 0.85

// evaluateFlags computes the prorated hours target and acceptance
// rate for this cycle and writes flag rows for whichever thresholds
// are missed. Idempotent: UpsertFlag uses ON CONFLICT DO NOTHING.
func (s *Service) evaluateFlags(ctx context.Context, proID string, cycle CycleClose, pay PayBreakdown) error {
	effectiveStart, deactivatedAt, err := s.repo.HelperDates(ctx, proID)
	if err != nil {
		return fmt.Errorf("helper dates: %w", err)
	}
	target := ProratedTargetHours(effectiveStart, deactivatedAt, cycle.Start, cycle.End)

	// 1. Hours flag — actual online hours fell short of the prorated
	//    target. target=0 (no days available) → free pass, no flag.
	actualHours := float64(pay.OnlineMinutes) / 60.0
	if target > 0 && actualHours < float64(target) {
		days := daysAvailable(effectiveStart, deactivatedAt, cycle.Start, cycle.End)
		details, _ := json.Marshal(map[string]any{
			"online_minutes":  pay.OnlineMinutes,
			"working_minutes": pay.WorkingMinutes,
			"days_available":  days,
		})
		if _, err := s.repo.UpsertFlag(ctx, proID, cycle, "hours_target_missed",
			actualHours, float64(target), details); err != nil {
			return fmt.Errorf("upsert hours flag: %w", err)
		}
	}

	// 2. Acceptance flag — accepted/dispatched fell below 85%.
	//    Zero-dispatched → N/A, no flag (helper had no offers).
	accepted, dispatched, err := s.repo.AcceptanceRate(ctx, proID, cycle.Start, cycle.End)
	if err != nil {
		return fmt.Errorf("acceptance rate: %w", err)
	}
	if dispatched > 0 {
		rate := float64(accepted) / float64(dispatched)
		if rate < AcceptanceTargetRate {
			details, _ := json.Marshal(map[string]any{
				"accepted":   accepted,
				"dispatched": dispatched,
			})
			if _, err := s.repo.UpsertFlag(ctx, proID, cycle, "acceptance_below_threshold",
				rate, AcceptanceTargetRate, details); err != nil {
				return fmt.Errorf("upsert acceptance flag: %w", err)
			}
		}
	}
	return nil
}

func daysAvailable(effectiveStart, deactivatedAt, cycleStart, cycleEnd time.Time) int {
	start := effectiveStart
	if cycleStart.After(start) {
		start = cycleStart
	}
	end := cycleEnd
	if !deactivatedAt.IsZero() && deactivatedAt.Before(end) {
		end = deactivatedAt
	}
	if end.Before(start) {
		return 0
	}
	return int(end.Sub(start).Hours()/24) + 1
}

// ErrNotCycleClose is returned by RunForToday when the wall-clock
// IST date is not a cycle close date. The cron is defensive — it
// checks at fire time so manual triggers via the admin route can
// pass any valid (start, end) without going through this guard.
var ErrNotCycleClose = errors.New("payroll: today is not a cycle close date")

// Service orchestrates eligible-helper discovery, per-helper
// aggregation, and idempotent payout writes.
type Service struct {
	repo *Repository
}

func NewService(repo *Repository) *Service { return &Service{repo: repo} }

// Repo exposes the underlying repository for handlers that need
// non-orchestration reads (e.g. admin listing endpoints in 3c).
func (s *Service) Repo() *Repository { return s.repo }

// RunResult summarises one cron pass.
type RunResult struct {
	Cycle           CycleClose
	HelpersTotal    int
	PayoutsInserted int
	PayoutsSkipped  int // already existed
	Errors          int // per-helper errors; cron continues past them
}

// RunForToday runs the cycle close for today's date in IST. Returns
// ErrNotCycleClose if today is not the 15th or last-of-month.
func (s *Service) RunForToday(ctx context.Context) (*RunResult, error) {
	cycle, ok := CycleForCloseDate(IST())
	if !ok {
		return nil, ErrNotCycleClose
	}
	return s.RunCycle(ctx, cycle)
}

// ComputeForHelper aggregates activity for a single pro across a
// cycle and returns the pay breakdown. It does NOT write — the
// caller decides whether to upsert (RunCycle) or update-in-place
// (CRM recompute). Used by the CRM admin recompute path so the
// computation rule stays in one place.
func (s *Service) ComputeForHelper(ctx context.Context, proID string, cycle CycleClose) (PayBreakdown, error) {
	if closed, err := s.repo.CloseStaleSessionsForCycle(ctx, proID, cycle.Start, cycle.End); err != nil {
		log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] close stale sessions failed")
	} else if closed > 0 {
		log.Info().Str("pro_id", proID).Int64("closed", closed).Msg("[payroll] auto-closed stale sessions")
	}
	onlineMin, workingMin, err := s.repo.AggregateActivity(ctx, proID, cycle.Start, cycle.End)
	if err != nil {
		return PayBreakdown{}, fmt.Errorf("aggregate activity: %w", err)
	}
	// ComputePay caps working at online — a working>online aggregate no
	// longer errors out the recompute; the pro is paid the capped amount.
	pay, err := ComputePay(onlineMin, workingMin)
	if err != nil {
		return PayBreakdown{}, err
	}
	deductions, err := s.repo.SumDeductionsForCycle(ctx, proID, cycle.Start, cycle.End)
	if err != nil {
		return PayBreakdown{}, fmt.Errorf("sum deductions: %w", err)
	}
	return pay.applyDeductions(deductions), nil
}

// RunCycle is the manual-trigger entry point. It writes one payout
// row per eligible pro for the given cycle. Idempotent — already-
// written rows are left untouched.
func (s *Service) RunCycle(ctx context.Context, cycle CycleClose) (*RunResult, error) {
	if cycle.End.Before(cycle.Start) {
		return nil, fmt.Errorf("payroll: cycle_end before cycle_start")
	}
	if !IsCanonicalCycle(cycle) {
		return nil, fmt.Errorf("payroll: %s..%s is not a canonical pay cycle (1st–15th or 16th–end-of-month); refusing to avoid overlapping double-pay", cycle.StartDate(), cycle.EndDate())
	}

	ids, err := s.repo.EligibleHelpers(ctx, cycle.End)
	if err != nil {
		return nil, fmt.Errorf("list eligible helpers: %w", err)
	}

	out := &RunResult{Cycle: cycle, HelpersTotal: len(ids)}

	for _, proID := range ids {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		if closed, cErr := s.repo.CloseStaleSessionsForCycle(ctx, proID, cycle.Start, cycle.End); cErr != nil {
			log.Warn().Err(cErr).Str("pro_id", proID).Msg("[payroll] close stale sessions failed")
		} else if closed > 0 {
			log.Info().Str("pro_id", proID).Int64("closed", closed).Msg("[payroll] auto-closed stale sessions")
		}
		onlineMin, workingMin, err := s.repo.AggregateActivity(ctx, proID, cycle.Start, cycle.End)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] aggregate activity failed")
			out.Errors++
			continue
		}

		// Working > online: ComputePay caps working at online — the pro is
		// still paid (online + capped working), never skipped. Warn for
		// visibility since it can signal a session-tracking edge.
		if workingMin > onlineMin {
			log.Warn().
				Str("pro_id", proID).
				Int("online_min", onlineMin).
				Int("working_min", workingMin).
				Msg("[payroll] working minutes exceed online — capping working at online")
		}

		pay, err := ComputePay(onlineMin, workingMin)
		if err != nil {
			log.Error().Err(err).Str("pro_id", proID).Msg("[payroll] compute pay failed")
			out.Errors++
			continue
		}

		deductions, err := s.repo.SumDeductionsForCycle(ctx, proID, cycle.Start, cycle.End)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] sum deductions failed")
			out.Errors++
			continue
		}
		pay = pay.applyDeductions(deductions)

		inserted, err := s.repo.UpsertPayout(ctx, proID, cycle, pay)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] upsert payout failed")
			out.Errors++
			continue
		}
		if inserted {
			out.PayoutsInserted++
		} else {
			out.PayoutsSkipped++
		}

		// Performance flags. Failures are non-fatal — flag generation
		// is observability, not core financial correctness, so we
		// don't roll back the payout row if the flag insert errors.
		if err := s.evaluateFlags(ctx, proID, cycle, pay); err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] flag evaluation failed")
		}
	}

	log.Info().
		Str("cycle_start", cycle.StartDate()).
		Str("cycle_end", cycle.EndDate()).
		Int("helpers", out.HelpersTotal).
		Int("inserted", out.PayoutsInserted).
		Int("skipped", out.PayoutsSkipped).
		Int("errors", out.Errors).
		Msg("[payroll] cycle close complete")

	return out, nil
}
