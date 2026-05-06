// Command migrate is the deployment-step CLI for applying ZopMop's
// SQL schema migrations. Wraps golang-migrate/migrate/v4 with three
// subcommands ZopMop's deploy flow needs: up (apply pending), version
// (read current state), baseline (one-shot mark-all-applied for DBs
// that pre-date the runner). Plus an emergency `force --version N`
// for "I know what I'm doing, the schema_migrations row is wrong" .
//
// Forward-only by policy: there are no .down.sql files. To undo a
// migration, write a new corrective migration. Down migrations rot
// fast — the data has changed by the time you need to roll back.
//
// CLI-only execution. No boot-time auto-migrate from cmd/api or
// cmd/crm-api. Migrations run as a deliberate deploy step so the
// "two API instances race the lock" / "long migration trips
// readiness probe" failure modes can't happen.
//
// Audit C-8 / B5-D7 chunk 19.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// baselineVersion is the highest pre-runner migration number. The
// `baseline` subcommand forces schema_migrations.version to this
// value, marking everything up to and including it as applied
// without running anything. Bump alongside any new migration whose
// number exceeds it (extremely rare; only matters for fresh DBs
// that bypass the runner).
const baselineVersion = 79

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL not set")
	}

	migrationsPath := "file://./migrations"
	if env := os.Getenv("MIGRATIONS_PATH"); env != "" {
		migrationsPath = "file://" + env
	}

	m, err := migrate.New(migrationsPath, dbURL)
	if err != nil {
		log.Fatalf("init migrate: %v", err)
	}
	defer func() {
		if srcErr, dbErr := m.Close(); srcErr != nil || dbErr != nil {
			log.Printf("close: src=%v db=%v", srcErr, dbErr)
		}
	}()

	switch os.Args[1] {
	case "up":
		fs := flag.NewFlagSet("up", flag.ExitOnError)
		steps := fs.Int("steps", 0, "apply N pending migrations (0 = all)")
		_ = fs.Parse(os.Args[2:])
		if *steps > 0 {
			err = m.Steps(*steps)
		} else {
			err = m.Up()
		}
		if err != nil && !errors.Is(err, migrate.ErrNoChange) {
			log.Fatalf("migrate up: %v", err)
		}
		printVersion(m)

	case "version":
		printVersion(m)

	case "baseline":
		// Idempotent: if version already >= baselineVersion (and not
		// dirty), no-op. Lets the deploy script call this on every
		// rollout without thinking about whether it's the first one.
		v, dirty, vErr := m.Version()
		if vErr != nil && !errors.Is(vErr, migrate.ErrNilVersion) {
			log.Fatalf("read version: %v", vErr)
		}
		if vErr == nil && v >= baselineVersion && !dirty {
			log.Printf("baseline: already at version %d (no-op)", v)
			return
		}
		log.Printf("baseline: forcing version to %d", baselineVersion)
		if err := m.Force(baselineVersion); err != nil {
			log.Fatalf("baseline force: %v", err)
		}
		log.Printf("baseline: done (version=%d)", baselineVersion)

	case "force":
		fs := flag.NewFlagSet("force", flag.ExitOnError)
		version := fs.Int("version", -1, "version to force")
		_ = fs.Parse(os.Args[2:])
		if *version < 0 {
			log.Fatal("force requires --version N")
		}
		log.Printf("WARNING: forcing version to %d (emergency recovery only)", *version)
		if err := m.Force(*version); err != nil {
			log.Fatalf("force: %v", err)
		}
		log.Printf("force: done (version=%d)", *version)

	default:
		usage()
		os.Exit(2)
	}
}

func printVersion(m *migrate.Migrate) {
	v, dirty, err := m.Version()
	if errors.Is(err, migrate.ErrNilVersion) {
		log.Println("version: no migrations applied (schema_migrations not initialized)")
		return
	}
	if err != nil {
		log.Fatalf("read version: %v", err)
	}
	if dirty {
		log.Printf("version: %d (DIRTY — manual intervention required)", v)
	} else {
		log.Printf("version: %d", v)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: migrate [up [--steps N] | version | baseline | force --version N]")
}
