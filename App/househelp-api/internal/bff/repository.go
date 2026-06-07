package bff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Errors surfaced by Repository methods.
var (
	ErrNotFound       = errors.New("config not found")
	ErrETagMismatch   = errors.New("etag mismatch")
	ErrInvalidStatus  = errors.New("invalid status transition")
)

// ConfigRecord mirrors one row of sdui_page_configs plus a derived ETag.
type ConfigRecord struct {
	ID            uuid.UUID       `json:"id"`
	PageID        string          `json:"page_id"`
	Version       string          `json:"version"`
	Env           string          `json:"env"`
	Status        string          `json:"status"`
	SchemaVersion int             `json:"schema_version"`
	ConfigJSON    json.RawMessage `json:"config_json"`
	Name          string          `json:"name,omitempty"`
	Description   string          `json:"description,omitempty"`
	ChangeNotes   string          `json:"change_notes,omitempty"`
	ExperimentID  string          `json:"experiment_id,omitempty"`
	CreatedBy     string          `json:"created_by"`
	CreatedAt     time.Time       `json:"created_at"`
	StagedBy      string          `json:"staged_by,omitempty"`
	StagedAt      *time.Time      `json:"staged_at,omitempty"`
	ActivatedBy   string          `json:"activated_by,omitempty"`
	ActivatedAt   *time.Time      `json:"activated_at,omitempty"`
	ArchivedBy    string          `json:"archived_by,omitempty"`
	ArchivedAt    *time.Time      `json:"archived_at,omitempty"`
	ETag          string          `json:"etag"`
}

// ConfigPatch carries the optional fields a draft can be patched with.
type ConfigPatch struct {
	Name         *string
	Description  *string
	ChangeNotes  *string
	ExperimentID *string
	ConfigJSON   json.RawMessage
}

// AuditEntry is one row of sdui_audit_log.
type AuditEntry struct {
	ID        uuid.UUID       `json:"id"`
	PageID    string          `json:"page_id"`
	ConfigID  *uuid.UUID      `json:"config_id,omitempty"`
	Action    string          `json:"action"`
	Actor     string          `json:"actor"`
	Note      string          `json:"note,omitempty"`
	Snapshot  json.RawMessage `json:"snapshot,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

// AllowedActionRecord mirrors sdui_allowed_actions for admin CRUD.
type AllowedActionRecord struct {
	ID        uuid.UUID `json:"id"`
	Endpoint  string    `json:"endpoint"`
	Methods   []string  `json:"methods"`
	IsActive  bool      `json:"is_active"`
	CreatedBy string    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Repository owns DB access for the sdui_* tables.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository binds the pool.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// computeETag returns a stable 16-char hex token derived from
// sha256(config_json || status || version). Used for optimistic locking.
func computeETag(configJSON json.RawMessage, status, version string) string {
	h := sha256.New()
	h.Write([]byte(configJSON))
	h.Write([]byte("|"))
	h.Write([]byte(status))
	h.Write([]byte("|"))
	h.Write([]byte(version))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

const configSelectCols = `id, page_id, version, env, status, schema_version, config_json,
	COALESCE(name,''), COALESCE(description,''), COALESCE(change_notes,''),
	COALESCE(experiment_id,''), created_by, created_at,
	COALESCE(staged_by,''), staged_at,
	COALESCE(activated_by,''), activated_at,
	COALESCE(archived_by,''), archived_at`

func scanConfig(row pgx.Row) (*ConfigRecord, error) {
	var rec ConfigRecord
	err := row.Scan(
		&rec.ID, &rec.PageID, &rec.Version, &rec.Env, &rec.Status, &rec.SchemaVersion, &rec.ConfigJSON,
		&rec.Name, &rec.Description, &rec.ChangeNotes,
		&rec.ExperimentID, &rec.CreatedBy, &rec.CreatedAt,
		&rec.StagedBy, &rec.StagedAt,
		&rec.ActivatedBy, &rec.ActivatedAt,
		&rec.ArchivedBy, &rec.ArchivedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	rec.ETag = computeETag(rec.ConfigJSON, rec.Status, rec.Version)
	return &rec, nil
}

// ListPages returns the distinct page_ids known to the table.
func (r *Repository) ListPages(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx, `SELECT DISTINCT page_id FROM sdui_page_configs ORDER BY page_id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list pages: %w", err)
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scan page: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListConfigs returns all configs for (pageID, env), newest first.
func (r *Repository) ListConfigs(ctx context.Context, pageID, env string) ([]ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND env = $2
		  ORDER BY created_at DESC`,
		pageID, env,
	)
	if err != nil {
		return nil, fmt.Errorf("list configs: %w", err)
	}
	defer rows.Close()

	out := []ConfigRecord{}
	for rows.Next() {
		rec, err := scanConfig(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rec)
	}
	return out, rows.Err()
}

// GetByVersion fetches a single (page_id,version,env) row.
func (r *Repository) GetByVersion(ctx context.Context, pageID, version, env string) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	row := r.db.QueryRow(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND version = $2 AND env = $3`,
		pageID, version, env,
	)
	return scanConfig(row)
}

// GetActive fetches the active config for (page_id,env).
func (r *Repository) GetActive(ctx context.Context, pageID, env string) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	row := r.db.QueryRow(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND env = $2 AND status = 'active'
		  LIMIT 1`,
		pageID, env,
	)
	return scanConfig(row)
}

// Preview is a read-only fetch ignoring status — used by the admin preview path.
func (r *Repository) Preview(ctx context.Context, pageID, version, env string) (*ConfigRecord, error) {
	return r.GetByVersion(ctx, pageID, version, env)
}

// CreateDraft inserts a new draft row. Caller fills page_id, version, env,
// config_json, created_by, optional metadata.
func (r *Repository) CreateDraft(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if rec.SchemaVersion == 0 {
		rec.SchemaVersion = 1
	}
	if rec.Env == "" {
		rec.Env = string(EnvProduction)
	}

	row := r.db.QueryRow(ctx,
		`INSERT INTO sdui_page_configs
		    (page_id, version, env, status, schema_version, config_json,
		     name, description, change_notes, experiment_id, created_by)
		 VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10)
		 RETURNING `+configSelectCols,
		rec.PageID, rec.Version, rec.Env, rec.SchemaVersion, rec.ConfigJSON,
		nullableStr(rec.Name), nullableStr(rec.Description),
		nullableStr(rec.ChangeNotes), nullableStr(rec.ExperimentID),
		rec.CreatedBy,
	)
	out, err := scanConfig(row)
	if err != nil {
		return nil, fmt.Errorf("create draft: %w", err)
	}
	log.Info().
		Str("event", "sdui_create_draft").
		Str("page_id", out.PageID).
		Str("version", out.Version).
		Str("actor", out.CreatedBy).
		Msg("sdui draft created")
	return out, nil
}

// UpdateDraft applies a patch to a draft row. Enforces If-Match via ETag.
func (r *Repository) UpdateDraft(ctx context.Context, pageID, version, env, ifMatch string, patch ConfigPatch) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	current, err := r.GetByVersion(ctx, pageID, version, env)
	if err != nil {
		return nil, err
	}
	if current.Status != string(StatusDraft) && current.Status != string(StatusArchived) {
		return nil, ErrInvalidStatus
	}
	if ifMatch != "" && ifMatch != current.ETag {
		return nil, ErrETagMismatch
	}

	sets := []string{}
	args := []any{}
	argN := 1
	add := func(col string, val any) {
		sets = append(sets, fmt.Sprintf("%s = $%d", col, argN))
		args = append(args, val)
		argN++
	}
	if patch.Name != nil {
		add("name", *patch.Name)
	}
	if patch.Description != nil {
		add("description", *patch.Description)
	}
	if patch.ChangeNotes != nil {
		add("change_notes", *patch.ChangeNotes)
	}
	if patch.ExperimentID != nil {
		add("experiment_id", *patch.ExperimentID)
	}
	if len(patch.ConfigJSON) > 0 {
		add("config_json", patch.ConfigJSON)
	}
	if len(sets) == 0 {
		return current, nil
	}
	args = append(args, pageID, version, env)
	q := fmt.Sprintf(
		`UPDATE sdui_page_configs SET %s
		   WHERE page_id = $%d AND version = $%d AND env = $%d AND status IN ('draft', 'archived')
		   RETURNING `+configSelectCols,
		strings.Join(sets, ", "), argN, argN+1, argN+2,
	)
	row := r.db.QueryRow(ctx, q, args...)
	out, err := scanConfig(row)
	if err != nil {
		return nil, fmt.Errorf("update draft: %w", err)
	}
	return out, nil
}

// DeleteDraft removes a draft row. No-op if not draft → ErrInvalidStatus.
func (r *Repository) DeleteDraft(ctx context.Context, pageID, version, env string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tag, err := r.db.Exec(ctx,
		`DELETE FROM sdui_page_configs
		   WHERE page_id = $1 AND version = $2 AND env = $3 AND status IN ('draft', 'archived')`,
		pageID, version, env,
	)
	if err != nil {
		return fmt.Errorf("delete draft: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Either not found or wrong status — disambiguate.
		if rec, err := r.GetByVersion(ctx, pageID, version, env); err == nil && rec.Status != string(StatusDraft) {
			return ErrInvalidStatus
		}
		return ErrNotFound
	}
	return nil
}

// Stage flips a draft to staged. Validation runs in the handler before this.
func (r *Repository) Stage(ctx context.Context, pageID, version, env, actor string) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	row := r.db.QueryRow(ctx,
		`UPDATE sdui_page_configs
		    SET status = 'staged', staged_by = $4, staged_at = now()
		   WHERE page_id = $1 AND version = $2 AND env = $3 AND status IN ('draft', 'archived')
		   RETURNING `+configSelectCols,
		pageID, version, env, actor,
	)
	out, err := scanConfig(row)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// Disambiguate: exists but not re-stageable (active/staged already).
			if rec, gerr := r.GetByVersion(ctx, pageID, version, env); gerr == nil &&
				rec.Status != string(StatusDraft) && rec.Status != string(StatusArchived) {
				return nil, ErrInvalidStatus
			}
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("stage: %w", err)
	}
	_ = r.AppendAuditLog(ctx, pageID, &out.ID, "staged", actor, "", out.ConfigJSON)
	log.Info().
		Str("event", "sdui_stage").
		Str("page_id", pageID).
		Str("version", version).
		Str("actor", actor).
		Msg("sdui config staged")
	return out, nil
}

// Activate moves a staged config to active inside a transaction. Any existing
// active config is archived in the same tx. ifMatch enforces optimistic locking
// against the staged record's ETag.
func (r *Repository) Activate(ctx context.Context, pageID, version, env, actor, ifMatch string) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Load target row inside tx.
	target, err := scanConfig(tx.QueryRow(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND version = $2 AND env = $3 FOR UPDATE`,
		pageID, version, env,
	))
	if err != nil {
		return nil, err
	}
	if target.Status != string(StatusStaged) {
		return nil, ErrInvalidStatus
	}
	if ifMatch != "" && ifMatch != target.ETag {
		return nil, ErrETagMismatch
	}

	// Archive current active (if any).
	_, err = tx.Exec(ctx,
		`UPDATE sdui_page_configs
		    SET status = 'archived', archived_by = $3, archived_at = now()
		  WHERE page_id = $1 AND env = $2 AND status = 'active'`,
		pageID, env, actor,
	)
	if err != nil {
		return nil, fmt.Errorf("archive prev active: %w", err)
	}

	// Promote target.
	row := tx.QueryRow(ctx,
		`UPDATE sdui_page_configs
		    SET status = 'active', activated_by = $4, activated_at = now()
		  WHERE id = $1 AND page_id = $2 AND env = $3
		  RETURNING `+configSelectCols,
		target.ID, pageID, env, actor,
	)
	out, err := scanConfig(row)
	if err != nil {
		return nil, fmt.Errorf("activate: %w", err)
	}

	// Audit row inside the same tx.
	_, err = tx.Exec(ctx,
		`INSERT INTO sdui_audit_log (page_id, config_id, action, actor, snapshot)
		 VALUES ($1, $2, 'activated', $3, $4)`,
		pageID, out.ID, actor, out.ConfigJSON,
	)
	if err != nil {
		return nil, fmt.Errorf("audit activate: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit activate: %w", err)
	}
	log.Info().
		Str("event", "sdui_activate").
		Str("page_id", pageID).
		Str("version", version).
		Str("actor", actor).
		Msg("sdui config activated")
	return out, nil
}

// Rollback archives the current active and re-activates the most recent
// previously-archived config for the same (page_id,env).
func (r *Repository) Rollback(ctx context.Context, pageID, env, actor string) (*ConfigRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Current active (lock).
	current, err := scanConfig(tx.QueryRow(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND env = $2 AND status = 'active'
		  FOR UPDATE`,
		pageID, env,
	))
	if err != nil {
		return nil, err
	}

	// Most recent previously archived.
	prev, err := scanConfig(tx.QueryRow(ctx,
		`SELECT `+configSelectCols+`
		   FROM sdui_page_configs
		  WHERE page_id = $1 AND env = $2 AND status = 'archived'
		  ORDER BY archived_at DESC NULLS LAST, created_at DESC
		  LIMIT 1
		  FOR UPDATE`,
		pageID, env,
	))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, fmt.Errorf("no archived config to roll back to: %w", ErrNotFound)
		}
		return nil, err
	}

	// Archive current.
	if _, err := tx.Exec(ctx,
		`UPDATE sdui_page_configs
		    SET status = 'archived', archived_by = $2, archived_at = now()
		  WHERE id = $1`,
		current.ID, actor,
	); err != nil {
		return nil, fmt.Errorf("archive current: %w", err)
	}

	// Re-activate previous.
	row := tx.QueryRow(ctx,
		`UPDATE sdui_page_configs
		    SET status = 'active', activated_by = $2, activated_at = now(),
		        archived_by = NULL, archived_at = NULL
		  WHERE id = $1
		  RETURNING `+configSelectCols,
		prev.ID, actor,
	)
	out, err := scanConfig(row)
	if err != nil {
		return nil, fmt.Errorf("re-activate: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO sdui_audit_log (page_id, config_id, action, actor, snapshot)
		 VALUES ($1, $2, 'rolled_back', $3, $4)`,
		pageID, out.ID, actor, out.ConfigJSON,
	); err != nil {
		return nil, fmt.Errorf("audit rollback: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit rollback: %w", err)
	}
	log.Warn().
		Str("event", "sdui_rollback").
		Str("page_id", pageID).
		Str("from_version", current.Version).
		Str("to_version", out.Version).
		Str("actor", actor).
		Msg("sdui config rolled back")
	return out, nil
}

// AppendAuditLog inserts one audit_log row.
func (r *Repository) AppendAuditLog(ctx context.Context, pageID string, configID *uuid.UUID, action, actor, note string, snapshot json.RawMessage) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := r.db.Exec(ctx,
		`INSERT INTO sdui_audit_log (page_id, config_id, action, actor, note, snapshot)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		pageID, configID, action, actor, nullableStr(note), nullableJSON(snapshot),
	)
	if err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return nil
}

// ListAuditLog returns recent audit entries for a page.
func (r *Repository) ListAuditLog(ctx context.Context, pageID string, limit int) ([]AuditEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := r.db.Query(ctx,
		`SELECT id, page_id, config_id, action, actor, COALESCE(note,''), snapshot, created_at
		   FROM sdui_audit_log
		  WHERE page_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2`,
		pageID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()

	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var cfgID *uuid.UUID
		var snap []byte
		if err := rows.Scan(&e.ID, &e.PageID, &cfgID, &e.Action, &e.Actor, &e.Note, &snap, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan audit: %w", err)
		}
		e.ConfigID = cfgID
		if len(snap) > 0 {
			e.Snapshot = json.RawMessage(snap)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListAllowedActions returns every row of sdui_allowed_actions.
func (r *Repository) ListAllowedActions(ctx context.Context) ([]AllowedActionRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, endpoint, methods, is_active, COALESCE(created_by,''), created_at
		   FROM sdui_allowed_actions
		  ORDER BY endpoint ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list allowed actions: %w", err)
	}
	defer rows.Close()

	out := []AllowedActionRecord{}
	for rows.Next() {
		var a AllowedActionRecord
		if err := rows.Scan(&a.ID, &a.Endpoint, &a.Methods, &a.IsActive, &a.CreatedBy, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan allowed action: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// InsertAllowedAction adds a new whitelist row.
func (r *Repository) InsertAllowedAction(ctx context.Context, endpoint string, methods []string, actor string) (*AllowedActionRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	row := r.db.QueryRow(ctx,
		`INSERT INTO sdui_allowed_actions (endpoint, methods, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id, endpoint, methods, is_active, COALESCE(created_by,''), created_at`,
		endpoint, methods, actor,
	)
	var a AllowedActionRecord
	if err := row.Scan(&a.ID, &a.Endpoint, &a.Methods, &a.IsActive, &a.CreatedBy, &a.CreatedAt); err != nil {
		return nil, fmt.Errorf("insert allowed action: %w", err)
	}
	return &a, nil
}

// DeleteAllowedAction removes a whitelist row by id.
func (r *Repository) DeleteAllowedAction(ctx context.Context, id uuid.UUID) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tag, err := r.db.Exec(ctx, `DELETE FROM sdui_allowed_actions WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete allowed action: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return []byte(b)
}
