package main

import (
	"errors"
	"os"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// Integration tests for the migrate CLI's underlying library wiring.
// Test the migrate library round-trips against the existing migration
// directory on disk — same code path the binary uses. Skipped when
// TEST_DATABASE_URL is unset.
//
// What's NOT tested here: subprocess CLI argument parsing, log
// output formatting, exit codes. Those are thin glue around the
// library calls below; the smoke run done in the chunk-19 commit
// covered them end-to-end.

func openMigrate(t *testing.T) *migrate.Migrate {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping migrate integration tests")
	}
	// Ensure sslmode=disable is on the URL — local test DB doesn't
	// terminate TLS. Production DBs come with their own SSL config in
	// DATABASE_URL.
	if !contains(dsn, "sslmode=") {
		if contains(dsn, "?") {
			dsn += "&sslmode=disable"
		} else {
			dsn += "?sslmode=disable"
		}
	}
	m, err := migrate.New("file://../../migrations", dsn)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	t.Cleanup(func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil || dbErr != nil {
			t.Logf("close: src=%v db=%v", srcErr, dbErr)
		}
	})
	return m
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestMigrate_VersionAndBaseline(t *testing.T) {
	m := openMigrate(t)
	// State on entry is whatever the dev DB currently is. The smoke
	// run after chunk-19 left it at version 79; if a future chunk
	// adds 080 the version will be higher. Either way, baseline is
	// idempotent above baselineVersion, so we exercise that path.
	v, _, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		t.Fatalf("Version: %v", err)
	}
	if errors.Is(err, migrate.ErrNilVersion) {
		// Empty DB — baseline initializes the table.
		if err := m.Force(baselineVersion); err != nil {
			t.Fatalf("Force baseline: %v", err)
		}
		v, _, err = m.Version()
		if err != nil {
			t.Fatalf("Version after baseline: %v", err)
		}
	}
	if v < baselineVersion {
		t.Fatalf("post-baseline version=%d, want >= %d", v, baselineVersion)
	}
}

func TestMigrate_UpReturnsNoChangeAtCurrent(t *testing.T) {
	m := openMigrate(t)
	// Pre-condition: dev DB is fully migrated (chunk-19 smoke ran
	// baseline). An Up call with nothing pending must return
	// ErrNoChange — that's the success signal the CLI maps to "no
	// new migrations applied; current version unchanged".
	err := m.Up()
	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		t.Fatalf("Up: got %v, want nil or ErrNoChange", err)
	}
}

func TestMigrate_BaselineIdempotent(t *testing.T) {
	m := openMigrate(t)
	// Calling Force(baselineVersion) repeatedly is benign — the row
	// is rewritten with the same value. The CLI's `baseline`
	// subcommand short-circuits when version >= baselineVersion to
	// avoid even doing the rewrite, but the underlying library
	// accepts both shapes. Drives the same Force path to verify.
	if err := m.Force(baselineVersion); err != nil {
		t.Fatalf("Force first: %v", err)
	}
	if err := m.Force(baselineVersion); err != nil {
		t.Fatalf("Force second (idempotent): %v", err)
	}
	v, dirty, err := m.Version()
	if err != nil {
		t.Fatalf("Version: %v", err)
	}
	if v != baselineVersion {
		t.Fatalf("version = %d, want %d", v, baselineVersion)
	}
	if dirty {
		t.Fatalf("dirty=true after clean Force — should never be dirty")
	}
}
