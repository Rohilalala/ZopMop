// Package audit writes append-only audit log rows for every CRM write action.
// All CRM module handlers MUST call Recorder.Log before returning success.
// Reads are not audited.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// insertAuditLogSQL is shared by Log (best-effort, own connection) and LogTx
// (transactional, caller's tx) so the row shape stays in one place.
const insertAuditLogSQL = `
	INSERT INTO crm_audit_log (
		admin_id, admin_email, action, module,
		target_type, target_id, before_value, after_value,
		ip_address, user_agent, request_id
	)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`

// insertArgs renders the 11 positional args for insertAuditLogSQL.
func (e Entry) insertArgs() []any {
	beforeJSON, _ := marshalJSONB(e.Before)
	afterJSON, _ := marshalJSONB(e.After)
	var ip *net.IP
	if e.IPAddress != "" {
		if parsed := net.ParseIP(e.IPAddress); parsed != nil {
			ip = &parsed
		}
	}
	return []any{
		nilIfEmpty(e.AdminID), nilIfEmpty(e.AdminEmail), e.Action, e.Module,
		nilIfEmpty(e.TargetType), nilIfEmpty(e.TargetID), beforeJSON, afterJSON,
		ipParam(ip), nilIfEmpty(e.UserAgent), nilIfEmpty(e.RequestID),
	}
}

// Entry is the structured payload an audit caller passes in. AdminID/Email/IP/
// UserAgent/RequestID are pulled by the middleware decorator from request
// locals — callers focus on Action/Module/Target/Before/After.
type Entry struct {
	AdminID    string
	AdminEmail string
	Action     string // e.g. "flag.update"
	Module     string // e.g. "flags"
	TargetType string // e.g. "flag"
	TargetID   string // e.g. "feature.scheduled_bookings"
	Before     any    // pre-change value (nil for create)
	After      any    // post-change value (nil for delete)
	IPAddress  string
	UserAgent  string
	RequestID  string
}

// Recorder writes audit entries.
type Recorder struct {
	db *pgxpool.Pool
}

// NewRecorder creates a Recorder bound to the given pool.
func NewRecorder(db *pgxpool.Pool) *Recorder { return &Recorder{db: db} }

// Log writes a single audit row. Failures are logged but never propagated to
// the caller — auditing must not block business logic. Operationally, a
// missing audit row is a P1 incident; we surface that via metrics, not by
// failing the user-facing request.
//
// If you need hard write-audit-or-fail semantics for a specific action,
// promote that branch to a transactional log via LogTx instead.
func (r *Recorder) Log(ctx context.Context, e Entry) {
	if r == nil || r.db == nil {
		return
	}
	if _, err := r.db.Exec(ctx, insertAuditLogSQL, e.insertArgs()...); err != nil {
		log.Error().
			Err(err).
			Str("action", e.Action).
			Str("module", e.Module).
			Str("admin_id", e.AdminID).
			Msg("[crm.audit] failed to write audit row — investigate")
	}
}

// LogTx writes the audit row inside the caller's transaction, so the audit
// record commits atomically with the business write and the error IS
// propagated (unlike Log, which is best-effort). Use this for money / state
// changes where a missing audit row is unacceptable. A nil recorder is a
// no-op (returns nil) so callers needn't branch.
func (r *Recorder) LogTx(ctx context.Context, tx pgx.Tx, e Entry) error {
	if r == nil || r.db == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, insertAuditLogSQL, e.insertArgs()...); err != nil {
		return fmt.Errorf("write audit row (tx): %w", err)
	}
	return nil
}

func marshalJSONB(v any) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal audit value: %w", err)
	}
	return b, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ipParam(ip *net.IP) any {
	if ip == nil {
		return nil
	}
	return ip.String()
}
