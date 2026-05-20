package payroll

import (
	"context"
	"errors"
	"fmt"

	"github.com/rs/zerolog/log"
)

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

// RunCycle is the manual-trigger entry point. It writes one payout
// row per eligible pro for the given cycle. Idempotent — already-
// written rows are left untouched.
func (s *Service) RunCycle(ctx context.Context, cycle CycleClose) (*RunResult, error) {
	if cycle.End.Before(cycle.Start) {
		return nil, fmt.Errorf("payroll: cycle_end before cycle_start")
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
		onlineMin, workingMin, err := s.repo.AggregateActivity(ctx, proID, cycle.Start, cycle.End)
		if err != nil {
			log.Warn().Err(err).Str("pro_id", proID).Msg("[payroll] aggregate activity failed")
			out.Errors++
			continue
		}

		// Working > online violates the working⊆online invariant. Log
		// loudly and skip rather than write nonsense pay.
		if workingMin > onlineMin {
			log.Error().
				Str("pro_id", proID).
				Int("online_min", onlineMin).
				Int("working_min", workingMin).
				Msg("[payroll] working minutes exceed online minutes — data integrity bug, skipping pro")
			out.Errors++
			continue
		}

		pay, err := ComputePay(onlineMin, workingMin)
		if err != nil {
			log.Error().Err(err).Str("pro_id", proID).Msg("[payroll] compute pay failed")
			out.Errors++
			continue
		}

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
