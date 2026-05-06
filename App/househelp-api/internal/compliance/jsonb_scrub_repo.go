package compliance

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ScrubAuditLogJSONBForUserTx walks crm_audit_log + audit_log rows
// where target_id matches userID and applies ScrubJSONB to their
// JSONB payload columns:
//
//   - crm_audit_log: before_value, after_value
//   - audit_log    : old_value,    new_value
//
// Per-row roundtrip: SELECT → walk → UPDATE only when content changed.
// This trades a small per-row overhead for clear, evolvable Go logic
// over an opaque recursive-CTE in SQL. At realistic per-user volumes
// (a typical user has <100 audit-target rows) the cost is negligible.
//
// Composes inside the caller's transaction so the scrub + chunk-6
// target_id reassignment commit atomically. The standalone variant
// opens its own short tx.
//
// Returns total rows whose JSONB content actually changed (no-op
// updates are skipped).
//
// Audit C-8 / F2D-1 chunk 12.
func (s *Service) ScrubAuditLogJSONBForUserTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	return execScrubAuditLogJSONBForUser(ctx, tx, userID)
}

// ScrubAuditLogJSONBForUser is the standalone variant — opens its own
// short tx. Use the *Tx variant when running inside SoftDeleteUser.
func (s *Service) ScrubAuditLogJSONBForUser(ctx context.Context, userID string) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("scrub audit-log jsonb begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := execScrubAuditLogJSONBForUser(ctx, tx, userID)
	if err != nil {
		return n, err
	}
	if err := tx.Commit(ctx); err != nil {
		return n, fmt.Errorf("scrub audit-log jsonb commit: %w", err)
	}
	return n, nil
}

func execScrubAuditLogJSONBForUser(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	var total int64

	n, err := scrubJSONBTable(ctx, tx,
		"crm_audit_log", "before_value", "after_value",
		`WHERE target_id = $1::text AND (before_value IS NOT NULL OR after_value IS NOT NULL)`,
		userID,
	)
	if err != nil {
		return total, fmt.Errorf("scrub crm_audit_log: %w", err)
	}
	total += n

	n, err = scrubJSONBTable(ctx, tx,
		"audit_log", "old_value", "new_value",
		`WHERE target_id = $1::text AND (old_value IS NOT NULL OR new_value IS NOT NULL)`,
		userID,
	)
	if err != nil {
		return total, fmt.Errorf("scrub audit_log (legacy): %w", err)
	}
	total += n

	return total, nil
}

// scrubJSONBTable selects rows from `table` matching `whereClause` and
// applies ScrubJSONB to the two JSONB columns. Updates only when the
// content actually changed. Generic over both crm_audit_log
// (before/after) and audit_log (old/new) by parameterising the column
// names. Identifiers are formatted into SQL but every caller passes
// in-tree literals — never user input.
func scrubJSONBTable(ctx context.Context, tx pgx.Tx, table, beforeCol, afterCol, whereClause string, args ...any) (int64, error) {
	selectSQL := fmt.Sprintf(`SELECT id, %s, %s FROM %s %s`, beforeCol, afterCol, table, whereClause)
	rows, err := tx.Query(ctx, selectSQL, args...)
	if err != nil {
		return 0, fmt.Errorf("select %s: %w", table, err)
	}

	type pendingUpdate struct {
		id        []byte
		newBefore []byte
		newAfter  []byte
	}
	var updates []pendingUpdate

	for rows.Next() {
		var id []byte
		var beforeRaw, afterRaw []byte
		if err := rows.Scan(&id, &beforeRaw, &afterRaw); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan %s row: %w", table, err)
		}
		newBefore, beforeChanged, err := scrubRawJSONB(beforeRaw)
		if err != nil {
			rows.Close()
			return 0, fmt.Errorf("scrub %s.%s: %w", table, beforeCol, err)
		}
		newAfter, afterChanged, err := scrubRawJSONB(afterRaw)
		if err != nil {
			rows.Close()
			return 0, fmt.Errorf("scrub %s.%s: %w", table, afterCol, err)
		}
		if !beforeChanged && !afterChanged {
			continue
		}
		updates = append(updates, pendingUpdate{
			id:        append([]byte(nil), id...),
			newBefore: newBefore,
			newAfter:  newAfter,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("iterate %s: %w", table, err)
	}
	rows.Close()

	updateSQL := fmt.Sprintf(`UPDATE %s SET %s = $1, %s = $2 WHERE id = $3`, table, beforeCol, afterCol)
	for _, u := range updates {
		if _, err := tx.Exec(ctx, updateSQL, u.newBefore, u.newAfter, u.id); err != nil {
			return 0, fmt.Errorf("update %s: %w", table, err)
		}
	}
	return int64(len(updates)), nil
}

// scrubRawJSONB parses a raw JSONB byte slice (or nil), runs ScrubJSONB,
// and returns the re-marshaled bytes plus whether the content changed.
// Nil/empty input returns (nil, false, nil) — nothing to do.
func scrubRawJSONB(raw []byte) ([]byte, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw, false, fmt.Errorf("parse jsonb: %w", err)
	}
	if !ScrubJSONB(v) {
		return raw, false, nil
	}
	out, err := json.Marshal(v)
	if err != nil {
		return raw, false, fmt.Errorf("marshal scrubbed jsonb: %w", err)
	}
	return out, true, nil
}

// ScrubUserFromCampaignTargetsTx removes a deleted user's UUID from
// every campaign-targeting list ZopMop holds:
//
//   - crm_push_messages.target_filter (JSONB, key "user_ids")
//   - promotions.audience_user_ids    (UUID[] top-level column)
//
// For target_filter the user is removed from the user_ids array in
// place; jsonb_set on the same key keeps the rest of the JSONB shape
// intact. For audience_user_ids array_remove handles the array column
// directly. Both UPDATEs are filtered to only touch rows that
// reference this user, so re-running on a non-targeted user is a
// no-op.
//
// Closes the chunk-8 deferral (target_filter JSONB scrubbing) plus
// the additional promotions.audience_user_ids surface discovered in
// chunk-12 Phase A.
//
// Returns total rows updated across both tables.
func (s *Service) ScrubUserFromCampaignTargetsTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	return execScrubUserFromCampaignTargets(ctx, txAdapter{tx: tx}, userID)
}

// ScrubUserFromCampaignTargets is the standalone variant — opens its
// own short tx so both UPDATEs commit atomically.
func (s *Service) ScrubUserFromCampaignTargets(ctx context.Context, userID string) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("scrub campaign targets begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := execScrubUserFromCampaignTargets(ctx, txAdapter{tx: tx}, userID)
	if err != nil {
		return n, err
	}
	if err := tx.Commit(ctx); err != nil {
		return n, fmt.Errorf("scrub campaign targets commit: %w", err)
	}
	return n, nil
}

// BackfillReport summarizes the outcome of a one-time JSONB-scrub
// backfill pass across audit_log + crm_audit_log. Returned to the CLI
// for log emission. CRMAuditScanned counts how many rows the loop
// inspected (rows with non-null JSONB blobs); CRMAuditScrubbed counts
// the subset whose content actually changed (no-op rows skip the
// UPDATE). Same shape for the legacy table.
type BackfillReport struct {
	CRMAuditScanned     int64
	CRMAuditScrubbed    int64
	LegacyAuditScanned  int64
	LegacyAuditScrubbed int64
}

// BackfillJSONBScrub walks every populated row in audit_log +
// crm_audit_log (regardless of target_id) and applies ScrubJSONB to
// the JSONB payload columns. Idempotent: re-running on already-
// scrubbed rows returns no-op (ScrubJSONB returns false → UPDATE
// skipped).
//
// Batched with keyset pagination by id so a large catch-up pass
// doesn't hold a long-running transaction. Each batch commits
// independently; on partial failure the scrubbed-so-far rows stay
// scrubbed and a re-run picks up where this one left off.
//
// dryRun=true counts what WOULD be scrubbed without writing. Useful
// for first-deployment sanity checks.
//
// batchSize defaults to 500 if <=0. Audit C-8 / F2D-1 chunk 12.
func (s *Service) BackfillJSONBScrub(ctx context.Context, batchSize int, dryRun bool) (BackfillReport, error) {
	if batchSize <= 0 {
		batchSize = 500
	}
	var rep BackfillReport

	// crm_audit_log — id is BIGINT, cursor is int64.
	var crmCursor int64
	for {
		scanned, scrubbed, nextCursor, more, err := s.backfillCRMAuditBatch(ctx, crmCursor, batchSize, dryRun)
		if err != nil {
			return rep, fmt.Errorf("backfill crm_audit_log: %w", err)
		}
		rep.CRMAuditScanned += scanned
		rep.CRMAuditScrubbed += scrubbed
		if !more {
			break
		}
		crmCursor = nextCursor
	}

	// audit_log (legacy) — id is UUID, cursor is string in canonical
	// form. Empty cursor on first iteration uses the all-zeros UUID
	// as the lower bound (any real UUID sorts strictly above it).
	legacyCursor := "00000000-0000-0000-0000-000000000000"
	for {
		scanned, scrubbed, nextCursor, more, err := s.backfillLegacyAuditBatch(ctx, legacyCursor, batchSize, dryRun)
		if err != nil {
			return rep, fmt.Errorf("backfill audit_log: %w", err)
		}
		rep.LegacyAuditScanned += scanned
		rep.LegacyAuditScrubbed += scrubbed
		if !more {
			break
		}
		legacyCursor = nextCursor
	}

	return rep, nil
}

func (s *Service) backfillCRMAuditBatch(ctx context.Context, cursor int64, batchSize int, dryRun bool) (scanned, scrubbed int64, nextCursor int64, more bool, err error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, before_value, after_value
		FROM crm_audit_log
		WHERE id > $1
		  AND (before_value IS NOT NULL OR after_value IS NOT NULL)
		ORDER BY id
		LIMIT $2
	`, cursor, batchSize)
	if err != nil {
		return 0, 0, 0, false, err
	}
	type pending struct {
		id        int64
		newBefore []byte
		newAfter  []byte
	}
	var updates []pending
	var lastID int64
	for rows.Next() {
		var id int64
		var beforeRaw, afterRaw []byte
		if err := rows.Scan(&id, &beforeRaw, &afterRaw); err != nil {
			rows.Close()
			return scanned, scrubbed, 0, false, err
		}
		scanned++
		lastID = id
		newBefore, beforeChanged, errB := scrubRawJSONB(beforeRaw)
		if errB != nil {
			rows.Close()
			return scanned, scrubbed, 0, false, errB
		}
		newAfter, afterChanged, errA := scrubRawJSONB(afterRaw)
		if errA != nil {
			rows.Close()
			return scanned, scrubbed, 0, false, errA
		}
		if !beforeChanged && !afterChanged {
			continue
		}
		updates = append(updates, pending{id: id, newBefore: newBefore, newAfter: newAfter})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return scanned, scrubbed, 0, false, err
	}
	rows.Close()

	if !dryRun && len(updates) > 0 {
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return scanned, scrubbed, 0, false, err
		}
		for _, u := range updates {
			if _, err := tx.Exec(ctx,
				`UPDATE crm_audit_log SET before_value = $1, after_value = $2 WHERE id = $3`,
				u.newBefore, u.newAfter, u.id,
			); err != nil {
				_ = tx.Rollback(ctx)
				return scanned, scrubbed, 0, false, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return scanned, scrubbed, 0, false, err
		}
	}
	scrubbed = int64(len(updates))

	more = scanned == int64(batchSize)
	return scanned, scrubbed, lastID, more, nil
}

func (s *Service) backfillLegacyAuditBatch(ctx context.Context, cursor string, batchSize int, dryRun bool) (scanned, scrubbed int64, nextCursor string, more bool, err error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, old_value, new_value
		FROM audit_log
		WHERE id > $1::uuid
		  AND (old_value IS NOT NULL OR new_value IS NOT NULL)
		ORDER BY id
		LIMIT $2
	`, cursor, batchSize)
	if err != nil {
		return 0, 0, "", false, err
	}
	type pending struct {
		id        string
		newBefore []byte
		newAfter  []byte
	}
	var updates []pending
	var lastID string
	for rows.Next() {
		var id string
		var oldRaw, newRaw []byte
		if err := rows.Scan(&id, &oldRaw, &newRaw); err != nil {
			rows.Close()
			return scanned, scrubbed, "", false, err
		}
		scanned++
		lastID = id
		newOld, oldChanged, errO := scrubRawJSONB(oldRaw)
		if errO != nil {
			rows.Close()
			return scanned, scrubbed, "", false, errO
		}
		newNew, newChanged, errN := scrubRawJSONB(newRaw)
		if errN != nil {
			rows.Close()
			return scanned, scrubbed, "", false, errN
		}
		if !oldChanged && !newChanged {
			continue
		}
		updates = append(updates, pending{id: id, newBefore: newOld, newAfter: newNew})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return scanned, scrubbed, "", false, err
	}
	rows.Close()

	if !dryRun && len(updates) > 0 {
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return scanned, scrubbed, "", false, err
		}
		for _, u := range updates {
			if _, err := tx.Exec(ctx,
				`UPDATE audit_log SET old_value = $1, new_value = $2 WHERE id = $3::uuid`,
				u.newBefore, u.newAfter, u.id,
			); err != nil {
				_ = tx.Rollback(ctx)
				return scanned, scrubbed, "", false, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return scanned, scrubbed, "", false, err
		}
	}
	scrubbed = int64(len(updates))

	more = scanned == int64(batchSize)
	return scanned, scrubbed, lastID, more, nil
}

func execScrubUserFromCampaignTargets(ctx context.Context, q txQuerier, userID string) (int64, error) {
	var total int64

	// crm_push_messages.target_filter: rebuild user_ids without the
	// deleted user. `?` operator on JSONB checks whether the key holds
	// the given string element. array_agg returns NULL when the
	// filtered array is empty; to_jsonb(NULL) → JSONB null, which
	// preserves the {"user_ids": null} shape already common in the
	// table.
	res, err := q.Exec(ctx, `
		UPDATE crm_push_messages
		SET target_filter = jsonb_set(
			target_filter,
			'{user_ids}',
			COALESCE(
				(SELECT to_jsonb(array_agg(elem))
				   FROM jsonb_array_elements_text(target_filter->'user_ids') AS elem
				  WHERE elem <> $1::text),
				'null'::jsonb
			)
		)
		WHERE target_filter ? 'user_ids'
		  AND jsonb_typeof(target_filter->'user_ids') = 'array'
		  AND target_filter->'user_ids' ? $1::text
	`, userID)
	if err != nil {
		return total, fmt.Errorf("scrub crm_push_messages.target_filter: %w", err)
	}
	total += res.RowsAffected()

	// promotions.audience_user_ids: top-level UUID[] column.
	res, err = q.Exec(ctx, `
		UPDATE promotions
		SET audience_user_ids = array_remove(audience_user_ids, $1::uuid)
		WHERE $1::uuid = ANY(audience_user_ids)
	`, userID)
	if err != nil {
		return total, fmt.Errorf("scrub promotions.audience_user_ids: %w", err)
	}
	total += res.RowsAffected()

	return total, nil
}
