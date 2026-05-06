// Command retention-worker runs on its own schedule (typically every 24h)
// and applies registered RetentionPolicy sweeps over append-only PII
// tables — crm_audit_log, crm_login_attempts, crm_push_messages, etc.
//
// Audit C-8 / F2D-1 / F2D-2 background: the codebase had zero retention
// crons before this worker was wired up. This binary is the home for
// them. The worker is single-pass-and-exit by design — wrap in `cron`,
// Kubernetes CronJob, or systemd-timer for periodicity. That keeps
// the binary stateless and idempotent.
//
// Flags:
//
//	--dry-run    : count-only mode. Logs "would delete N rows" per
//	               table. No DELETE statements run. Useful for first-
//	               deployment sanity checks.
//
// Exit code:
//
//	0  : every registered policy ran cleanly (or dry-run completed)
//	1  : at least one policy returned an error, OR the process was
//	     cancelled via SIGINT / SIGTERM mid-sweep
//
// Per-policy work runs in its own short transaction with batched
// DELETE (LIMIT 1000 per batch via id-IN-subselect) so a large catch-up
// sweep doesn't block concurrent writers.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/compliance"
)

func main() {
	dryRun := flag.Bool("dry-run", false, "count-only mode; no DELETEs are executed")
	flag.Parse()

	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal().Msg("DATABASE_URL is required")
	}

	rootCtx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := pgxpool.New(rootCtx, dsn)
	if err != nil {
		log.Fatal().Err(err).Msg("connect db")
	}
	defer pool.Close()

	registry := compliance.NewRegistry()
	compliance.RegisterDefaultPolicies(registry)
	svc := compliance.NewService(pool, registry)

	if registry.Len() == 0 {
		log.Info().Msg("retention-worker: no policies registered; nothing to do — exiting")
		return
	}

	log.Info().
		Int("policy_count", registry.Len()).
		Bool("dry_run", *dryRun).
		Msg("retention-worker: starting")

	results := svc.RunRetentionPass(rootCtx, *dryRun)

	var (
		successes  int
		failures   int
		totalRows  int64
		totalDur   time.Duration
	)
	for _, r := range results {
		totalDur += r.Duration
		if r.Err != nil {
			failures++
			log.Error().
				Err(r.Err).
				Str("table", r.Table).
				Int64("rows_so_far", r.RowsDeleted).
				Dur("duration", r.Duration).
				Bool("dry_run", r.DryRun).
				Msg("retention-worker: sweep failed")
			continue
		}
		successes++
		totalRows += r.RowsDeleted

		verb := "swept"
		if r.DryRun {
			verb = "would-delete (dry-run)"
		}
		log.Info().
			Str("table", r.Table).
			Int64("rows_deleted", r.RowsDeleted).
			Dur("duration", r.Duration).
			Bool("dry_run", r.DryRun).
			Msgf("retention-worker: %s", verb)
	}

	log.Info().
		Int("successes", successes).
		Int("failures", failures).
		Int64("total_rows", totalRows).
		Dur("total_duration", totalDur).
		Bool("dry_run", *dryRun).
		Msg("retention-worker: complete")

	// Exit non-zero if any policy errored or if the root ctx was
	// cancelled (signal handler caught SIGINT/SIGTERM mid-pass).
	if compliance.AnyFailed(results) {
		os.Exit(1)
	}
	if err := rootCtx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(os.Stderr, "retention-worker: terminated: %v\n", err)
		os.Exit(1)
	}
}
