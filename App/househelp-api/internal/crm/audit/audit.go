// Package audit writes append-only audit log rows for every CRM write action.
// All CRM module handlers MUST call Recorder.Log before returning success.
// Reads are not audited.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Entry is the structured payload an audit caller passes in. AdminID/Email/IP/
// UserAgent/RequestID are pulled by the middleware decorator from request
// locals — callers focus on Action/Module/Target/Before/After.
type Entry struct {
	AdminID     string
	AdminEmail  string
	Action      string      // e.g. "flag.update"
	Module      string      // e.g. "flags"
	TargetType  string      // e.g. "flag"
	TargetID    string      // e.g. "feature.scheduled_bookings"
	Before      any // pre-change value (nil for create)
	After       any // post-change value (nil for delete)
	IPAddress   string
	UserAgent   string
	RequestID   string
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
	beforeJSON, _ := marshalJSONB(e.Before)
	afterJSON, _ := marshalJSONB(e.After)

	var ip *net.IP
	if e.IPAddress != "" {
		parsed := net.ParseIP(e.IPAddress)
		if parsed != nil {
			ip = &parsed
		}
	}

	_, err := r.db.Exec(ctx, `
		INSERT INTO crm_audit_log (
			admin_id, admin_email, action, module,
			target_type, target_id, before_value, after_value,
			ip_address, user_agent, request_id
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`,
		nilIfEmpty(e.AdminID),
		nilIfEmpty(e.AdminEmail),
		e.Action,
		e.Module,
		nilIfEmpty(e.TargetType),
		nilIfEmpty(e.TargetID),
		beforeJSON,
		afterJSON,
		ipParam(ip),
		nilIfEmpty(e.UserAgent),
		nilIfEmpty(e.RequestID),
	)
	if err != nil {
		log.Error().
			Err(err).
			Str("action", e.Action).
			Str("module", e.Module).
			Str("admin_id", e.AdminID).
			Msg("[crm.audit] failed to write audit row — investigate")
	}
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
