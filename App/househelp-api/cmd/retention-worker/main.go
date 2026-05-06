// Command retention-worker runs on its own schedule (typically every 24h)
// and applies registered RetentionPolicy sweeps over append-only PII
// tables — crm_audit_log, crm_login_attempts, crm_push_messages, etc.
//
// Audit C-8 / F2D-1 / F2D-2 background: the codebase has zero retention
// crons today. This binary is the home for them. As of chunk 1 the
// registry is empty and this worker is a stub that proves the wiring
// works end-to-end without committing to retention windows on any
// specific table — those decisions are made by the user inline as each
// chunk lands.
//
// The worker is meant to run as a sidecar / Kubernetes CronJob — it
// does NOT keep its own scheduler, it does ONE pass and exits. Wrap in
// `cron` / Kubernetes / systemd-timer for periodicity. That keeps the
// binary simple and idempotent.
package main

import (
	"context"
	"errors"
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
	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal().Msg("DATABASE_URL is required")
	}

	// Cancel on SIGINT / SIGTERM so the worker exits cleanly even when
	// it's mid-sweep. Wraps the lifetime of the DB pool too.
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
	_ = svc // chunks 4+ will call svc.RunRetentionPass(ctx) once execution lands.

	if registry.Len() == 0 {
		log.Info().Msg("retention-worker: no policies registered; scaffold — exiting")
	} else {
		// Chunk 2: policies are registered but the per-table sweep loop
		// is intentionally deferred to a later chunk. Log what we'd run
		// so ops can confirm the wiring without yet acting on the data.
		for _, p := range registry.All() {
			log.Info().
				Str("table", p.Table).
				Str("action", string(p.Action)).
				Dur("window", p.Window).
				Str("time_column", p.TimeColumn).
				Str("legal_basis", p.LegalBasis).
				Msg("retention-worker: policy registered")
		}
		log.Info().
			Int("policy_count", registry.Len()).
			Msg("retention-worker: found policies; execution deferred to chunk 4")
	}

	// If we received a shutdown signal during init, surface it as a
	// non-zero exit so cron / k8s can record the cancellation cleanly.
	if err := rootCtx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(os.Stderr, "retention-worker: terminated: %v\n", err)
		os.Exit(1)
	}
}
