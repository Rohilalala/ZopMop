// Command jsonb-scrub-backfill is a one-time pass that walks every
// populated row in audit_log + crm_audit_log and applies the chunk-12
// PII denylist scrub (compliance.ScrubJSONB) to each row's JSONB
// payload columns. Audit C-8 / F2D-1 chunk 12.
//
// Why a separate binary: the chunk-12 scrub fires on user deletion via
// SoftDeleteUser (extends chunk-6 audit anonymization), but pre-
// existing rows about users who haven't deleted yet still hold any
// PII that recording modules baked in. This binary fixes the
// existing pollution. Going forward the on-deletion hook keeps it
// clean.
//
// Idempotent: re-running on already-scrubbed rows is a no-op
// (ScrubJSONB returns false → the UPDATE is skipped). Safe to re-run
// after any partial / interrupted pass.
//
// Flags:
//
//	--dry-run     : count what WOULD be scrubbed without writing.
//	--batch-size  : rows per batch (default 500). Each batch commits
//	                in its own short transaction so a large catch-up
//	                pass doesn't hold long locks.
//
// Exit code:
//
//	0 : pass completed (writes happened or dry-run finished cleanly)
//	1 : at least one batch errored — partial work in earlier batches
//	    is already committed, re-run to resume
package main

import (
	"context"
	"flag"
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
	dryRun := flag.Bool("dry-run", false, "count-only mode; no UPDATEs are executed")
	batchSize := flag.Int("batch-size", 500, "rows per batch (default 500)")
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

	svc := compliance.NewService(pool, compliance.NewRegistry())

	log.Info().
		Bool("dry_run", *dryRun).
		Int("batch_size", *batchSize).
		Msg("jsonb-scrub-backfill: starting")

	rep, err := svc.BackfillJSONBScrub(rootCtx, *batchSize, *dryRun)
	if err != nil {
		log.Error().
			Err(err).
			Int64("crm_scanned", rep.CRMAuditScanned).
			Int64("crm_scrubbed", rep.CRMAuditScrubbed).
			Int64("legacy_scanned", rep.LegacyAuditScanned).
			Int64("legacy_scrubbed", rep.LegacyAuditScrubbed).
			Msg("jsonb-scrub-backfill: failed")
		os.Exit(1)
	}

	verb := "scrubbed"
	if *dryRun {
		verb = "would-scrub (dry-run)"
	}
	log.Info().
		Int64("crm_scanned", rep.CRMAuditScanned).
		Int64("crm_scrubbed", rep.CRMAuditScrubbed).
		Int64("legacy_scanned", rep.LegacyAuditScanned).
		Int64("legacy_scrubbed", rep.LegacyAuditScrubbed).
		Bool("dry_run", *dryRun).
		Msgf("jsonb-scrub-backfill: %s", verb)
}
