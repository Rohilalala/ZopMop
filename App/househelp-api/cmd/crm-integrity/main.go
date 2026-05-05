// Command crm-integrity scans the user-app + CRM database surface and reports
// data-integrity findings as a single JSON document.
//
// It is a *read-only* tool: it never writes. Run it against the same Postgres
// the API uses (connection pool is short-lived and small to avoid contention).
// Intended use: pipe stdout to a file, then diff between sim runs.
//
// Findings are scored per-entity. integrity_score_pct = 100 * (1 - issues / checks).
// "issues" is the number of failing rows on each check; "checks" is the total
// rows examined for that entity. The aggregate score in the trailing object
// averages the per-entity scores.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Report is the top-level JSON envelope.
type Report struct {
	GeneratedAt time.Time      `json:"generated_at"`
	Entities    []EntityReport `json:"entities"`
	Aggregate   Aggregate      `json:"aggregate"`
}

// EntityReport is the per-table summary.
type EntityReport struct {
	Entity            string         `json:"entity"`
	TotalInDB         int64          `json:"total_in_db"`
	Missing           []string       `json:"missing"`
	MismatchedFields  []FieldIssue   `json:"mismatched_fields"`
	DuplicatesFound   int64          `json:"duplicates_found"`
	IntegrityScorePct float64        `json:"integrity_score_pct"`
	Notes             []string       `json:"notes,omitempty"`
}

// FieldIssue describes one failed invariant on a row.
type FieldIssue struct {
	Field    string `json:"field"`
	RowID    string `json:"row_id"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
}

// Aggregate sums per-entity findings.
type Aggregate struct {
	TotalDuplicates    int64   `json:"total_duplicates"`
	TotalMismatches    int64   `json:"total_mismatches"`
	OverallScorePct    float64 `json:"overall_score_pct"`
}

func main() {
	dbURL := flag.String("db-url", os.Getenv("DATABASE_URL"), "Postgres DSN")
	maxIssues := flag.Int("max-issues", 50, "max issues per entity to report (rest summarised)")
	flag.Parse()
	if *dbURL == "" {
		fmt.Fprintln(os.Stderr, "crm-integrity: DATABASE_URL not set and -db-url not provided")
		os.Exit(2)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, *dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "crm-integrity: db connect failed: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	rep := Report{GeneratedAt: time.Now().UTC()}

	rep.Entities = append(rep.Entities,
		checkUsers(ctx, pool, *maxIssues),
		checkBookings(ctx, pool, *maxIssues),
		checkPayments(ctx, pool, *maxIssues),
		checkAnalyticsEvents(ctx, pool, *maxIssues),
	)

	// Aggregate.
	var sum float64
	for _, e := range rep.Entities {
		rep.Aggregate.TotalDuplicates += e.DuplicatesFound
		rep.Aggregate.TotalMismatches += int64(len(e.MismatchedFields))
		sum += e.IntegrityScorePct
	}
	if len(rep.Entities) > 0 {
		rep.Aggregate.OverallScorePct = round2(sum / float64(len(rep.Entities)))
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		fmt.Fprintf(os.Stderr, "crm-integrity: encode failed: %v\n", err)
		os.Exit(1)
	}
}

// ── users ──────────────────────────────────────────────────────────────

func checkUsers(ctx context.Context, pool *pgxpool.Pool, maxIssues int) EntityReport {
	r := EntityReport{Entity: "users"}

	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE deleted_at IS NULL`).Scan(&r.TotalInDB); err != nil {
		r.Notes = append(r.Notes, "count query failed: "+err.Error())
		return r
	}

	// Duplicate phone numbers (active rows only).
	rows, err := pool.Query(ctx, `
		SELECT phone, COUNT(*) FROM users WHERE deleted_at IS NULL
		GROUP BY phone HAVING COUNT(*) > 1
	`)
	if err == nil {
		for rows.Next() {
			var phone string
			var n int64
			if err := rows.Scan(&phone, &n); err == nil {
				r.DuplicatesFound += n - 1
			}
		}
		rows.Close()
	}

	// Lifetime-value reconciliation: SUM(payments.amount_paise) per user
	// should equal SUM(bookings.amount_paise) for completed bookings.
	// Pre-payments-ledger rows have no payment row at all — they're the
	// "missing" set.
	var ltvIssues int64
	const ltvSQL = `
		SELECT u.id::text, COALESCE(p.sum_paise, 0), COALESCE(b.sum_paise, 0)
		FROM users u
		LEFT JOIN (
		  SELECT user_id, SUM(amount_paise) AS sum_paise
		  FROM payments WHERE gateway_status IN ('success','pending') GROUP BY user_id
		) p ON p.user_id = u.id
		LEFT JOIN (
		  SELECT customer_id, SUM(amount_paise) AS sum_paise
		  FROM bookings WHERE status = 'completed' GROUP BY customer_id
		) b ON b.customer_id = u.id
		WHERE u.deleted_at IS NULL AND COALESCE(p.sum_paise, 0) <> COALESCE(b.sum_paise, 0)
		LIMIT $1
	`
	rows2, err := pool.Query(ctx, ltvSQL, maxIssues)
	if err == nil {
		for rows2.Next() {
			var uid string
			var paise, cents int64
			if err := rows2.Scan(&uid, &paise, &cents); err == nil {
				r.MismatchedFields = append(r.MismatchedFields, FieldIssue{
					Field: "lifetime_value", RowID: uid,
					Expected: fmt.Sprintf("%d", cents), Actual: fmt.Sprintf("%d", paise),
				})
				ltvIssues++
			}
		}
		rows2.Close()
	}
	r.IntegrityScorePct = score(r.TotalInDB, r.DuplicatesFound+ltvIssues)
	return r
}

// ── bookings ───────────────────────────────────────────────────────────

func checkBookings(ctx context.Context, pool *pgxpool.Pool, maxIssues int) EntityReport {
	r := EntityReport{Entity: "bookings"}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bookings`).Scan(&r.TotalInDB); err != nil {
		r.Notes = append(r.Notes, "count query failed: "+err.Error())
		return r
	}

	// Same (customer_id, service_category_id) within 1 hour = duplicate alert.
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM (
		  SELECT customer_id, service_category_id, date_trunc('hour', created_at) AS h, COUNT(*) AS c
		  FROM bookings WHERE status <> 'cancelled'
		  GROUP BY customer_id, service_category_id, date_trunc('hour', created_at)
		  HAVING COUNT(*) > 1
		) sub
	`).Scan(&r.DuplicatesFound); err != nil {
		r.Notes = append(r.Notes, "dup query failed: "+err.Error())
	}

	// Completed booking should have completed_at.
	rows, err := pool.Query(ctx, `
		SELECT id::text FROM bookings
		WHERE status = 'completed' AND completed_at IS NULL
		LIMIT $1
	`, maxIssues)
	var missingTimestamps int64
	if err == nil {
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			r.MismatchedFields = append(r.MismatchedFields, FieldIssue{
				Field: "completed_at", RowID: id, Expected: "non-null", Actual: "null",
			})
			missingTimestamps++
		}
		rows.Close()
	}

	// Bookings with a 'failed' payment must not be 'completed'.
	rows2, err := pool.Query(ctx, `
		SELECT b.id::text FROM bookings b
		JOIN payments p ON p.booking_id = b.id
		WHERE b.status = 'completed' AND p.gateway_status = 'failed'
		LIMIT $1
	`, maxIssues)
	var paymentConflicts int64
	if err == nil {
		for rows2.Next() {
			var id string
			_ = rows2.Scan(&id)
			r.MismatchedFields = append(r.MismatchedFields, FieldIssue{
				Field: "status", RowID: id,
				Expected: "not completed when payment failed", Actual: "completed",
			})
			paymentConflicts++
		}
		rows2.Close()
	}

	r.IntegrityScorePct = score(r.TotalInDB, r.DuplicatesFound+missingTimestamps+paymentConflicts)
	return r
}

// ── payments ───────────────────────────────────────────────────────────

func checkPayments(ctx context.Context, pool *pgxpool.Pool, maxIssues int) EntityReport {
	r := EntityReport{Entity: "payments"}

	// Table may not exist yet on a partially migrated DB. Be graceful.
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM payments`).Scan(&r.TotalInDB); err != nil {
		r.Notes = append(r.Notes, "payments table missing or unreadable: "+err.Error())
		r.IntegrityScorePct = 0
		return r
	}

	// Duplicate gateway_ref (the column is UNIQUE so this should be 0; we
	// still query to make the report self-evident for ops).
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM (
		  SELECT gateway_ref FROM payments WHERE gateway_ref IS NOT NULL
		  GROUP BY gateway_ref HAVING COUNT(*) > 1
		) sub
	`).Scan(&r.DuplicatesFound)

	// Payments referencing a booking that no longer exists. (FK is ON DELETE
	// CASCADE so this should also be 0; check anyway in case the FK is dropped
	// in some env.)
	rows, err := pool.Query(ctx, `
		SELECT p.id::text FROM payments p
		LEFT JOIN bookings b ON b.id = p.booking_id
		WHERE b.id IS NULL LIMIT $1
	`, maxIssues)
	var orphans int64
	if err == nil {
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			r.MismatchedFields = append(r.MismatchedFields, FieldIssue{
				Field: "booking_id", RowID: id, Expected: "existing booking", Actual: "missing",
			})
			orphans++
		}
		rows.Close()
	}

	r.IntegrityScorePct = score(r.TotalInDB, r.DuplicatesFound+orphans)
	return r
}

// ── analytics_events ──────────────────────────────────────────────────

func checkAnalyticsEvents(ctx context.Context, pool *pgxpool.Pool, maxIssues int) EntityReport {
	r := EntityReport{Entity: "analytics_events"}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM analytics_events`).Scan(&r.TotalInDB); err != nil {
		r.Notes = append(r.Notes, "count query failed: "+err.Error())
		return r
	}

	// Funnel sanity: booking.created count >= booking_flow.started count.
	// (Reverse direction is fine — not every started flow becomes a booking.)
	var created, flowStarted int64
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM analytics_events WHERE event_name = 'booking.created'`).Scan(&created)
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM analytics_events WHERE event_name = 'booking_flow.started'`).Scan(&flowStarted)
	var funnelIssue int64
	if created > flowStarted && flowStarted > 0 {
		// Strictly fine — but the spec wanted booking_started >= booking_confirmed.
		// Treat as a warning only.
		r.Notes = append(r.Notes, fmt.Sprintf("booking.created (%d) > booking_flow.started (%d) — phantom confirmations?", created, flowStarted))
		funnelIssue = created - flowStarted
	}

	// Null user_id or null created_at on non-system events.
	var nullRows int64
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM analytics_events
		WHERE created_at IS NULL OR (user_id IS NULL AND event_name NOT LIKE 'system.%')
	`).Scan(&nullRows)

	r.MismatchedFields = nil // surfaced via Notes for this entity
	r.DuplicatesFound = 0
	r.IntegrityScorePct = score(r.TotalInDB, nullRows+funnelIssue)
	if nullRows > 0 {
		r.Notes = append(r.Notes, fmt.Sprintf("%d events with null user_id or null created_at", nullRows))
	}
	_ = maxIssues
	return r
}

// ── helpers ────────────────────────────────────────────────────────────

func score(total, issues int64) float64 {
	if total == 0 {
		return 100
	}
	pct := 100.0 * (1.0 - float64(issues)/float64(total))
	if pct < 0 {
		pct = 0
	}
	return round2(pct)
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}
