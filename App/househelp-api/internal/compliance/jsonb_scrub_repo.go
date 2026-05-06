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
