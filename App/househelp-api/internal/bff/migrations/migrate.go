// Package migrations applies in-memory schema migrations to a stored
// sdui_page_configs.config_json blob. Migrations are pure functions that
// transform one schema_version to the next; they never touch the DB.
//
// A broken migration must NEVER crash the server. Each Apply runs inside a
// recover-safe wrapper; on failure, Migrate returns the original blob, the
// original version, and the error so the caller can fall back to the safe
// layout or last-good response.
package migrations

import (
	"encoding/json"
	"fmt"

	"github.com/rs/zerolog/log"
)

// ConfigMigration is one step in the chain. Apply receives the raw config_json
// at version From and must return the same shape upgraded to To.
type ConfigMigration struct {
	From  int
	To    int
	Apply func(json.RawMessage) (json.RawMessage, error)
}

// Migrations is the ordered chain. Empty for now — append a ConfigMigration
// here when bumping the on-disk schema version.
var Migrations = []ConfigMigration{}

// Migrate walks Migrations in order, applying each whose From == currentVersion
// until target is reached or the chain is exhausted. Returns the upgraded raw
// + final version + any error encountered.
//
// Idempotent: if currentVersion >= target, returns the input unchanged.
// Fallback-safe: if any step errors or panics, returns (raw, currentVersion, err).
func Migrate(raw json.RawMessage, currentVersion int, target int) (json.RawMessage, int, error) {
	if currentVersion >= target {
		return raw, currentVersion, nil
	}

	cur := currentVersion
	out := raw

	for cur < target {
		next, ok := findMigration(cur)
		if !ok {
			// No migration defined for this step — stop where we are.
			log.Warn().
				Str("event", "sdui_migrate_gap").
				Int("from", cur).
				Int("target", target).
				Msg("no migration registered for current version")
			return out, cur, nil
		}

		applied, err := safeApply(next, out)
		if err != nil {
			log.Error().
				Err(err).
				Str("event", "sdui_migrate_failed").
				Int("from", next.From).
				Int("to", next.To).
				Msg("migration apply failed; returning original")
			return raw, currentVersion, err
		}

		log.Info().
			Str("event", "sdui_migrate_step").
			Int("from", next.From).
			Int("to", next.To).
			Msg("applied sdui config migration")

		out = applied
		cur = next.To
	}

	return out, cur, nil
}

// findMigration looks up the migration whose From == cur. Returns false if
// none registered (the chain has a gap).
func findMigration(cur int) (ConfigMigration, bool) {
	for _, m := range Migrations {
		if m.From == cur {
			return m, true
		}
	}
	return ConfigMigration{}, false
}

// safeApply runs m.Apply with a panic recovery wrapper so a broken migration
// can never crash the server.
func safeApply(m ConfigMigration, raw json.RawMessage) (out json.RawMessage, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("migration %d→%d panicked: %v", m.From, m.To, rec)
		}
	}()
	if m.Apply == nil {
		return nil, fmt.Errorf("migration %d→%d: nil apply func", m.From, m.To)
	}
	return m.Apply(raw)
}
