package compliance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DB-backed integration tests for the retention worker (chunk 10).
// Reuse the openComplianceTestDB helper + shared insert helpers from
// purge_test.go. Skipped when TEST_DATABASE_URL is unset.

// TestRunPolicy_DeletesOldRows seeds rows on both sides of the cutoff
// for one policy and asserts only the old rows go.
func TestRunPolicy_DeletesOldRows(t *testing.T) {
	pool := openComplianceTestDB(t)

	// Use crm_login_attempts — simple shape (no FKs to satisfy beyond
	// nothing), nullable=false time column. Use a custom registry with
	// only this one policy and a tight window so the test is fast.
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "crm_login_attempts",
		Action:     ActionDelete,
		Window:     1 * time.Second, // anything older than 1 second
		TimeColumn: "created_at",
		LegalBasis: "test",
	})
	svc := NewService(pool, r)

	// Seed: 2 old rows (created_at far in the past) + 1 fresh row.
	old1 := uuid.NewString()[:8] + "@old.local"
	old2 := uuid.NewString()[:8] + "@old.local"
	fresh := uuid.NewString()[:8] + "@fresh.local"
	mustExec(t, pool, `
		INSERT INTO crm_login_attempts (email, ip_address, success, reason, created_at) VALUES
		($1, '10.0.0.1'::inet, false, 'old', '2020-01-01T00:00:00Z'),
		($2, '10.0.0.2'::inet, true,  'old', '2020-06-01T00:00:00Z'),
		($3, '10.0.0.3'::inet, true,  'fresh', now())
	`, old1, old2, fresh)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM crm_login_attempts WHERE email IN ($1,$2,$3)`, old1, old2, fresh)
	})

	results := svc.RunRetentionPass(context.Background(), false)
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	got := results[0]
	if got.Err != nil {
		t.Fatalf("policy err: %v", got.Err)
	}
	if got.RowsDeleted < 2 {
		t.Errorf("rows_deleted = %d, want >= 2 (sweep must catch the seeded old rows; other pre-existing old rows in the DB may also be swept)", got.RowsDeleted)
	}

	// Both seeded old rows must be gone; the fresh row must survive.
	for _, em := range []string{old1, old2} {
		var n int
		pool.QueryRow(context.Background(),
			`SELECT COUNT(*) FROM crm_login_attempts WHERE email=$1`, em).Scan(&n)
		if n != 0 {
			t.Errorf("seeded old row %q still present (count=%d)", em, n)
		}
	}
	var freshN int
	pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM crm_login_attempts WHERE email=$1`, fresh).Scan(&freshN)
	if freshN != 1 {
		t.Errorf("fresh row count = %d, want 1 (must not be swept)", freshN)
	}
}

// TestRunPolicy_DryRunDoesNotDelete verifies count-only mode.
func TestRunPolicy_DryRunDoesNotDelete(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "crm_login_attempts",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "test",
	})
	svc := NewService(pool, r)

	em := uuid.NewString()[:8] + "@dry.local"
	mustExec(t, pool, `
		INSERT INTO crm_login_attempts (email, ip_address, success, reason, created_at) VALUES
		($1, '10.0.0.4'::inet, false, 'old', '2020-01-01T00:00:00Z')
	`, em)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM crm_login_attempts WHERE email=$1`, em)
	})

	results := svc.RunRetentionPass(context.Background(), true /*dryRun*/)
	if results[0].Err != nil {
		t.Fatalf("dry-run err: %v", results[0].Err)
	}
	if !results[0].DryRun {
		t.Errorf("DryRun flag not propagated to result")
	}
	if results[0].RowsDeleted < 1 {
		t.Errorf("dry-run RowsDeleted = %d, want at least 1 (the seeded old row)", results[0].RowsDeleted)
	}

	// Row must still exist.
	var n int
	pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM crm_login_attempts WHERE email=$1`, em).Scan(&n)
	if n != 1 {
		t.Errorf("dry-run deleted the row: count=%d, want 1", n)
	}
}

// TestRunPolicy_NullableTimeAnchorSkipsNullRows: bookings.completed_at
// is nullable. A booking with NULL completed_at must NOT be swept even
// when its created_at is ancient — the time anchor is completed_at,
// and NULL means "never reached terminal state".
func TestRunPolicy_NullableTimeAnchorSkipsNullRows(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "bookings",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "completed_at",
		LegalBasis: "test",
	})
	svc := NewService(pool, r)

	customer := makeUser(t, pool, uuid.NewString())
	var sc string
	if err := pool.QueryRow(context.Background(),
		`SELECT id::text FROM service_categories LIMIT 1`).Scan(&sc); err != nil {
		t.Skipf("no service_categories: %v", err)
	}

	// Booking with NULL completed_at — must survive sweep.
	nullID := uuid.NewString()
	mustExec(t, pool, `
		INSERT INTO bookings (id, customer_id, service_category_id, status,
		                      address, lat, lng, amount_paise, completed_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'cancelled',
		        'addr', 12.9, 77.6, 1000, NULL)
	`, nullID, customer, sc)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bookings WHERE id=$1::uuid`, nullID)
	})

	results := svc.RunRetentionPass(context.Background(), false)
	if results[0].Err != nil {
		t.Fatalf("sweep err: %v", results[0].Err)
	}
	var n int
	pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM bookings WHERE id=$1::uuid`, nullID).Scan(&n)
	if n != 1 {
		t.Errorf("nullable-anchor row was swept (count=%d, want 1)", n)
	}
}

// TestRunPolicy_BatchSizeRespected: seed > sweepBatchSize rows and
// verify the loop iterates rather than chokes on a single big DELETE.
func TestRunPolicy_BatchSizeRespected(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "crm_login_attempts",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "test",
	})
	svc := NewService(pool, r)

	// 1500 old rows = 2 batches at sweepBatchSize=1000.
	const total = 1500
	emPrefix := "batch-" + uuid.NewString()[:8] + "-"
	rows := make([][]any, 0, total)
	for i := 0; i < total; i++ {
		rows = append(rows, []any{
			emPrefix + uuid.NewString()[:8] + "@x.local",
			"10.0.0.1",
			false,
			"old",
		})
	}
	// Bulk insert with COPY-like loop (one INSERT per row is fine for
	// 1500 in a test).
	for _, row := range rows {
		_, err := pool.Exec(context.Background(), `
			INSERT INTO crm_login_attempts (email, ip_address, success, reason, created_at)
			VALUES ($1, $2::inet, $3, $4, '2020-01-01T00:00:00Z')
		`, row...)
		if err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM crm_login_attempts WHERE email LIKE $1`, emPrefix+"%")
	})

	results := svc.RunRetentionPass(context.Background(), false)
	if results[0].Err != nil {
		t.Fatalf("sweep err: %v", results[0].Err)
	}
	if results[0].RowsDeleted < total {
		t.Errorf("rows_deleted = %d, want >= %d", results[0].RowsDeleted, total)
	}

	var leftover int
	pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM crm_login_attempts WHERE email LIKE $1`, emPrefix+"%").Scan(&leftover)
	if leftover != 0 {
		t.Errorf("leftover seeded rows = %d, want 0", leftover)
	}
}

// TestRunPolicy_PerPolicyTransactionIsolation: a contrived bad policy
// (nonexistent table) must error without aborting the rest of the pass.
func TestRunPolicy_PerPolicyTransactionIsolation(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "this_table_does_not_exist",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "test-bad",
	})
	r.Register(RetentionPolicy{
		Table:      "crm_login_attempts",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "test-good",
	})
	svc := NewService(pool, r)

	results := svc.RunRetentionPass(context.Background(), true /*dryRun*/)
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}

	var bad, good *PolicyResult
	for i := range results {
		switch results[i].Table {
		case "this_table_does_not_exist":
			bad = &results[i]
		case "crm_login_attempts":
			good = &results[i]
		}
	}
	if bad == nil || good == nil {
		t.Fatalf("missing per-policy result: %+v", results)
	}
	if bad.Err == nil {
		t.Errorf("bad policy must surface error")
	}
	if good.Err != nil {
		t.Errorf("good policy must NOT have errored despite bad policy: %v", good.Err)
	}
	if !AnyFailed(results) {
		t.Errorf("AnyFailed must return true when bad policy errored")
	}
}

// TestRunPolicy_RejectsUnsafeIdentifiers: defense-in-depth check that
// the regex validator catches a non-allowlisted table name.
func TestRunPolicy_RejectsUnsafeIdentifiers(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "users; DROP TABLE users; --",
		Action:     ActionDelete,
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "evil",
	})
	svc := NewService(pool, r)

	results := svc.RunRetentionPass(context.Background(), true)
	if results[0].Err == nil {
		t.Fatalf("unsafe table identifier must be rejected")
	}
	if !strings.Contains(results[0].Err.Error(), "unsafe table identifier") {
		t.Errorf("unexpected error shape: %v", results[0].Err)
	}
}

// TestRunPolicy_RejectsNonDeleteAction: action != ActionDelete should
// surface an error rather than silently no-op (avoids policy drift).
func TestRunPolicy_RejectsNonDeleteAction(t *testing.T) {
	pool := openComplianceTestDB(t)
	r := NewRegistry()
	r.Register(RetentionPolicy{
		Table:      "crm_login_attempts",
		Action:     ActionAnonymize, // not yet supported by the worker
		Window:     1 * time.Second,
		TimeColumn: "created_at",
		LegalBasis: "test",
	})
	svc := NewService(pool, r)

	results := svc.RunRetentionPass(context.Background(), true)
	if results[0].Err == nil {
		t.Fatalf("non-Delete action must be rejected")
	}
	if !errors.Is(results[0].Err, results[0].Err) || // sentinel-Is-self is true; just exercise
		!strings.Contains(results[0].Err.Error(), "unsupported action") {
		t.Errorf("unexpected error: %v", results[0].Err)
	}
}
