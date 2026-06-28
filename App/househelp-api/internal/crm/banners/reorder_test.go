package banners

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func openTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed banners tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// TestReorder_ExactSetValidation proves the reorder fix: a list that is not
// exactly the current banner set (missing, extra, or duplicate ids) is
// rejected with ErrReorderMismatch instead of corrupting display_order by
// leaving un-listed rows at their old order.
func TestReorder_ExactSetValidation(t *testing.T) {
	pool := openTestDB(t)
	ctx := context.Background()
	repo := NewRepository(pool, pool)

	mk := func(title string) string {
		b, err := repo.Create(ctx, CreateRequest{Title: title, ImageURL: "https://x/y.png", Audience: "all"}, "")
		if err != nil {
			t.Fatalf("create banner: %v", err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM banners WHERE id=$1::uuid`, b.ID) })
		return b.ID
	}
	a, b := mk("reorder-test-A"), mk("reorder-test-B")

	// Current full set of banner ids (robust to any pre-existing banners).
	var all []string
	rows, err := pool.Query(ctx, `SELECT id::text FROM banners`)
	if err != nil {
		t.Fatalf("list ids: %v", err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		all = append(all, id)
	}
	rows.Close()

	// Full set (any order) is valid.
	if err := repo.Reorder(ctx, all); err != nil {
		t.Fatalf("reorder of full set should succeed, got %v", err)
	}

	// Partial list (drop one) — must be rejected, not silently applied.
	if err := repo.Reorder(ctx, all[:len(all)-1]); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("partial reorder: want ErrReorderMismatch, got %v", err)
	}

	// Extra/unknown id — rejected.
	if err := repo.Reorder(ctx, append(append([]string{}, all...), uuid.NewString())); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("reorder with unknown id: want ErrReorderMismatch, got %v", err)
	}

	// Duplicate id (same count, wrong membership) — rejected.
	dup := append([]string{}, all...)
	dup[len(dup)-1] = a // now 'a' appears twice, one real id missing
	_ = b
	if err := repo.Reorder(ctx, dup); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("reorder with duplicate id: want ErrReorderMismatch, got %v", err)
	}
}
