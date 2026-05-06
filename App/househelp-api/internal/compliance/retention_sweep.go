package compliance

import (
	"context"
	"fmt"
	"regexp"
	"time"
)

// sweepBatchSize caps a single DELETE batch to keep lock duration short.
// 1000 rows per batch; the loop iterates until the predicate returns
// zero matches.
const sweepBatchSize = 1000

// maxBatchIterations is a hard safety cap on how many batches the loop
// will run for one policy. 10000 batches × 1000 rows = 10M rows per
// invocation per table; well above any realistic single-night sweep
// but bounded so a runaway predicate cannot loop forever.
const maxBatchIterations = 10_000

// nullableTimeColumns lists the tables whose RetentionPolicy.TimeColumn
// is NULLABLE in the schema. The sweep predicate must add `IS NOT NULL`
// for these so NULL rows aren't compared (which would be NULL, treated
// as FALSE, harmless for correctness but adds an unnecessary index seek
// on every iteration). For chunks 4 and 7 the NULL-anchor rows are also
// the ones that should NOT be swept by this worker — they're handled
// at user-erasure time by AnonymizeBookingsAsCustomer / AnonymizeRefundsAsUser
// (hard-deleted there); only the survivors with a real timestamp reach
// the time-based sweep.
var nullableTimeColumns = map[string]bool{
	"bookings":        true, // completed_at
	"pending_refunds": true, // processed_at
}

// safeIdentRE allows only lowercase letters / digits / underscores in
// table and column names. Every policy is registered from in-tree code,
// so attacker-controlled values can't reach here, but the validation
// is cheap defense in depth: prevents an accidentally-mistyped table
// name (e.g. "users; DROP TABLE …") from ever being formatted into SQL.
var safeIdentRE = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// PolicyResult captures the outcome of running one RetentionPolicy
// through RunRetentionPass. Fields:
//   - Table        : policy's table name (echo of input for log keying)
//   - RowsDeleted  : count actually deleted (or "would delete" in dry run)
//   - Duration     : wall-clock time the sweep took
//   - DryRun       : true when count-only mode was active
//   - Err          : non-nil if the sweep failed mid-way; partial work
//                    in earlier batches IS already committed (per-batch
//                    transactions are intentional)
type PolicyResult struct {
	Table       string
	RowsDeleted int64
	Duration    time.Duration
	DryRun      bool
	Err         error
}

// RunRetentionPass iterates every registered RetentionPolicy and applies
// it. Per-policy errors don't abort the pass — the worker continues to
// the next policy. The caller (cmd/retention-worker) reports per-policy
// outcomes and exits non-zero if any returned a non-nil Err.
//
// dryRun=true replaces DELETE with SELECT COUNT(*) — no writes occur.
// Useful for first-deployment sanity checks.
func (s *Service) RunRetentionPass(ctx context.Context, dryRun bool) []PolicyResult {
	policies := s.policies.All()
	out := make([]PolicyResult, 0, len(policies))
	for _, p := range policies {
		out = append(out, s.runPolicy(ctx, p, dryRun))
	}
	return out
}

// runPolicy executes one RetentionPolicy. Validates inputs, computes
// the cutoff, then either count-queries (dry-run) or loops batched
// DELETEs until the predicate returns zero. Each batch runs in its own
// short transaction so lock duration stays bounded — large catch-up
// sweeps don't block writers.
func (s *Service) runPolicy(ctx context.Context, p RetentionPolicy, dryRun bool) PolicyResult {
	start := time.Now()
	result := PolicyResult{Table: p.Table, DryRun: dryRun}

	if p.Action != ActionDelete {
		result.Err = fmt.Errorf("retention sweep: unsupported action %q for table %s (only ActionDelete)", p.Action, p.Table)
		result.Duration = time.Since(start)
		return result
	}
	if p.Window <= 0 {
		result.Err = fmt.Errorf("retention sweep: zero/negative window for table %s", p.Table)
		result.Duration = time.Since(start)
		return result
	}
	if !safeIdentRE.MatchString(p.Table) {
		result.Err = fmt.Errorf("retention sweep: unsafe table identifier %q", p.Table)
		result.Duration = time.Since(start)
		return result
	}
	if !safeIdentRE.MatchString(p.TimeColumn) {
		result.Err = fmt.Errorf("retention sweep: unsafe time-column identifier %q", p.TimeColumn)
		result.Duration = time.Since(start)
		return result
	}

	cutoff := time.Now().Add(-p.Window)

	nullClause := ""
	if nullableTimeColumns[p.Table] {
		nullClause = p.TimeColumn + ` IS NOT NULL AND `
	}

	if dryRun {
		var n int64
		countSQL := fmt.Sprintf(
			`SELECT COUNT(*) FROM %s WHERE %s%s < $1`,
			p.Table, nullClause, p.TimeColumn,
		)
		err := s.db.QueryRow(ctx, countSQL, cutoff).Scan(&n)
		if err != nil {
			result.Err = fmt.Errorf("dry-run count for %s: %w", p.Table, err)
		}
		result.RowsDeleted = n
		result.Duration = time.Since(start)
		return result
	}

	// id-IN-subselect with FOR UPDATE SKIP LOCKED: bounded lock window
	// per batch. Skip-locked lets concurrent writers proceed against
	// rows the sweep would have caught (they'll be picked up next pass).
	deleteSQL := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id IN (
			SELECT id FROM %s
			WHERE %s%s < $1
			ORDER BY %s
			LIMIT %d
			FOR UPDATE SKIP LOCKED
		)`,
		p.Table, p.Table, nullClause, p.TimeColumn, p.TimeColumn, sweepBatchSize,
	)

	var totalDeleted int64
	for i := 0; i < maxBatchIterations; i++ {
		if err := ctx.Err(); err != nil {
			result.Err = fmt.Errorf("retention sweep cancelled mid-batch (table=%s, rows_so_far=%d): %w", p.Table, totalDeleted, err)
			break
		}

		tx, err := s.db.Begin(ctx)
		if err != nil {
			result.Err = fmt.Errorf("begin batch tx for %s: %w", p.Table, err)
			break
		}
		tag, err := tx.Exec(ctx, deleteSQL, cutoff)
		if err != nil {
			_ = tx.Rollback(ctx)
			result.Err = fmt.Errorf("delete batch for %s: %w", p.Table, err)
			break
		}
		if err := tx.Commit(ctx); err != nil {
			result.Err = fmt.Errorf("commit batch for %s: %w", p.Table, err)
			break
		}

		n := tag.RowsAffected()
		totalDeleted += n
		if n == 0 {
			// No more matching rows; sweep complete.
			break
		}
	}

	result.RowsDeleted = totalDeleted
	result.Duration = time.Since(start)
	return result
}

// AnyFailed returns true if any of the per-policy results in `results`
// carries a non-nil Err. The cmd/retention-worker uses this to decide
// the process exit code.
func AnyFailed(results []PolicyResult) bool {
	for _, r := range results {
		if r.Err != nil {
			return true
		}
	}
	return false
}

