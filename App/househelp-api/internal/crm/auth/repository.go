package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a row lookup yields no result.
var ErrNotFound = errors.New("not found")

// ErrSessionAlreadyRotated signals that the CAS in Rotate observed
// RowsAffected == 0 — i.e. another goroutine rotated the same active-leg
// session row between our read and our UPDATE. Service.Refresh maps this
// to ErrSessionExpired (fail-soft for the loser) rather than killing the
// family, because the winning rotation is itself legitimate.
var ErrSessionAlreadyRotated = errors.New("session already rotated")

// Repository encapsulates DB access for auth.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// GetAdminByEmail returns the admin by email. ErrNotFound if missing.
func (r *Repository) GetAdminByEmail(ctx context.Context, email string) (*Admin, error) {
	const q = `
		SELECT id, email, password_hash, display_name, avatar_url, role,
		       permissions, totp_secret, totp_enrolled_at,
		       failed_login_count, locked_until, last_login_at,
		       is_active, created_at, updated_at
		FROM crm_admins WHERE email = $1
	`
	var a Admin
	err := r.db.QueryRow(ctx, q, email).Scan(
		&a.ID, &a.Email, &a.PasswordHash, &a.DisplayName, &a.AvatarURL, &a.Role,
		&a.Permissions, &a.TOTPSecret, &a.TOTPEnrolledAt,
		&a.FailedLoginCount, &a.LockedUntil, &a.LastLoginAt,
		&a.IsActive, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get admin by email: %w", err)
	}
	return &a, nil
}

// GetAdminByID returns the admin by ID. ErrNotFound if missing.
func (r *Repository) GetAdminByID(ctx context.Context, id string) (*Admin, error) {
	const q = `
		SELECT id, email, password_hash, display_name, avatar_url, role,
		       permissions, totp_secret, totp_enrolled_at,
		       failed_login_count, locked_until, last_login_at,
		       is_active, created_at, updated_at
		FROM crm_admins WHERE id = $1
	`
	var a Admin
	err := r.db.QueryRow(ctx, q, id).Scan(
		&a.ID, &a.Email, &a.PasswordHash, &a.DisplayName, &a.AvatarURL, &a.Role,
		&a.Permissions, &a.TOTPSecret, &a.TOTPEnrolledAt,
		&a.FailedLoginCount, &a.LockedUntil, &a.LastLoginAt,
		&a.IsActive, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get admin by id: %w", err)
	}
	return &a, nil
}

// IncrementFailedLogin bumps the failure count and sets locked_until once the
// threshold is hit. Returns the new (post-update) failure count.
func (r *Repository) IncrementFailedLogin(ctx context.Context, adminID string, threshold int, lockoutDur time.Duration) (int, error) {
	const q = `
		UPDATE crm_admins
		SET failed_login_count = failed_login_count + 1,
		    locked_until = CASE
		      WHEN failed_login_count + 1 >= $2 THEN now() + $3::interval
		      ELSE locked_until
		    END,
		    updated_at = now()
		WHERE id = $1
		RETURNING failed_login_count
	`
	var count int
	err := r.db.QueryRow(ctx, q, adminID, threshold, fmt.Sprintf("%d seconds", int(lockoutDur.Seconds()))).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("increment failed login: %w", err)
	}
	return count, nil
}

// ResetFailedLogin clears the failure counter on successful login.
func (r *Repository) ResetFailedLogin(ctx context.Context, adminID string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admins
		SET failed_login_count = 0, locked_until = NULL,
		    last_login_at = now(), updated_at = now()
		WHERE id = $1
	`, adminID)
	if err != nil {
		return fmt.Errorf("reset failed login: %w", err)
	}
	return nil
}

// SetTOTPSecret persists a freshly-generated TOTP secret for the admin.
// Does NOT mark the admin enrolled — enrolment is only confirmed once the
// admin proves possession via a successful verify (see MarkTOTPEnrolled).
// Persisting totp_enrolled_at here previously bricked accounts that abandoned
// the first-login QR step: the secret existed, so enrolled looked complete,
// so otpauth_url was never shown again.
func (r *Repository) SetTOTPSecret(ctx context.Context, adminID, secret string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admins
		SET totp_secret = $2, updated_at = now()
		WHERE id = $1
	`, adminID, secret)
	if err != nil {
		return fmt.Errorf("set totp secret: %w", err)
	}
	return nil
}

// MarkTOTPEnrolled stamps totp_enrolled_at on the first successful TOTP
// verification, completing enrolment. Idempotent: only sets it once.
func (r *Repository) MarkTOTPEnrolled(ctx context.Context, adminID string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admins
		SET totp_enrolled_at = now(), updated_at = now()
		WHERE id = $1 AND totp_enrolled_at IS NULL
	`, adminID)
	if err != nil {
		return fmt.Errorf("mark totp enrolled: %w", err)
	}
	return nil
}

// CreateSession inserts a refresh-token session row.
func (r *Repository) CreateSession(ctx context.Context, s *Session) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO crm_admin_sessions (
			id, admin_id, refresh_token_hash, user_agent, ip_address,
			issued_at, last_used_at, expires_at
		)
		VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8)
	`,
		s.ID, s.AdminID, s.RefreshTokenHash,
		s.UserAgent, ipTextPtr(s.IPAddress),
		s.IssuedAt, s.LastUsedAt, s.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

// ConsumeChallenge records a TOTP challenge jti as used. Returns true if this
// call consumed it (fresh), false if it was already used (replay). The
// INSERT ... ON CONFLICT DO NOTHING is atomic, so two concurrent replays of
// the same challenge yield exactly one fresh==true.
func (r *Repository) ConsumeChallenge(ctx context.Context, jti, adminID string, expiresAt time.Time) (bool, error) {
	tag, err := r.db.Exec(ctx, `
		INSERT INTO crm_used_challenges (jti, admin_id, expires_at)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (jti) DO NOTHING
	`, jti, adminID, expiresAt)
	if err != nil {
		return false, fmt.Errorf("consume challenge: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// GetSessionByHash looks up an active-leg session (not revoked, not
// expired, not yet rotated). Used by Logout — a logout against a stale
// (rotated) hash should be a no-op.
func (r *Repository) GetSessionByHash(ctx context.Context, hash string) (*Session, error) {
	const q = `
		SELECT id, family_id, admin_id, refresh_token_hash, user_agent,
		       host(ip_address)::text, issued_at, last_used_at,
		       expires_at, revoked_at, rotated_at, rotated_to::text,
		       replay_detected_at
		FROM crm_admin_sessions
		WHERE refresh_token_hash = $1
		  AND revoked_at IS NULL
		  AND rotated_at IS NULL
		  AND expires_at > now()
	`
	var s Session
	err := r.db.QueryRow(ctx, q, hash).Scan(
		&s.ID, &s.FamilyID, &s.AdminID, &s.RefreshTokenHash, &s.UserAgent,
		&s.IPAddress, &s.IssuedAt, &s.LastUsedAt,
		&s.ExpiresAt, &s.RevokedAt, &s.RotatedAt, &s.RotatedTo,
		&s.ReplayDetectedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &s, nil
}

// GetSessionByHashIncludingRotated looks up a session row by hash without
// the rotated_at filter. Used by Service.Refresh to detect replay: a hash
// presented for refresh whose row already has rotated_at set is the very
// signal we need (RFC 6819 §5.2.2). Revoked rows still match too — that
// way we can distinguish "you logged out, hash gone" (returns ErrNotFound,
// row simply isn't there because never rotated) from "you tried to use a
// refresh token whose family has been killed" (returns the row + caller
// inspects RevokedAt + ReplayDetectedAt).
func (r *Repository) GetSessionByHashIncludingRotated(ctx context.Context, hash string) (*Session, error) {
	const q = `
		SELECT id, family_id, admin_id, refresh_token_hash, user_agent,
		       host(ip_address)::text, issued_at, last_used_at,
		       expires_at, revoked_at, rotated_at, rotated_to::text,
		       replay_detected_at
		FROM crm_admin_sessions
		WHERE refresh_token_hash = $1
	`
	var s Session
	err := r.db.QueryRow(ctx, q, hash).Scan(
		&s.ID, &s.FamilyID, &s.AdminID, &s.RefreshTokenHash, &s.UserAgent,
		&s.IPAddress, &s.IssuedAt, &s.LastUsedAt,
		&s.ExpiresAt, &s.RevokedAt, &s.RotatedAt, &s.RotatedTo,
		&s.ReplayDetectedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get session by hash (incl rotated): %w", err)
	}
	return &s, nil
}

// TouchSession bumps last_used_at on a session.
func (r *Repository) TouchSession(ctx context.Context, sessionID string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admin_sessions SET last_used_at = now() WHERE id = $1
	`, sessionID)
	if err != nil {
		return fmt.Errorf("touch session: %w", err)
	}
	return nil
}

// Rotate atomically retires an active-leg session row and inserts its
// successor in the same family. The old row is stamped rotated_at +
// rotated_to. The new row inherits family_id from the old row.
//
// The CAS is the WHERE rotated_at IS NULL clause on the UPDATE. If two
// concurrent rotators race against the same active-leg row, exactly one
// flips rotated_at; the other observes RowsAffected == 0 and we return
// ErrSessionAlreadyRotated. Service.Refresh maps that to fail-soft —
// it is NOT replay (the winner is legitimate too); the loser just gives
// up its rotation and the user retries.
//
// Wrapped in a transaction so the UPDATE + INSERT either both commit or
// neither does. A partial commit (old row marked rotated but new row not
// inserted) would brick the session.
func (r *Repository) Rotate(
	ctx context.Context,
	oldSessionID, newSessionID, newHash string,
	newExpiresAt time.Time,
	userAgent, ipAddress *string,
) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("rotate begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Insert the successor first. crm_admin_sessions.rotated_to has a FK
	// reference to crm_admin_sessions(id) which is checked per-statement
	// (NOT DEFERRED), so the successor row must exist before we can
	// reference it from the old row's rotated_to. The INSERT is "safe" to
	// race against — if the CAS UPDATE below loses, the whole transaction
	// (including this insert) rolls back, leaving no orphan row behind.
	_, err = tx.Exec(ctx, `
		INSERT INTO crm_admin_sessions (
			id, family_id, admin_id, refresh_token_hash, user_agent, ip_address,
			issued_at, last_used_at, expires_at
		)
		SELECT $1::uuid, family_id, admin_id, $2, $3, $4::inet,
		       now(), now(), $5
		FROM crm_admin_sessions
		WHERE id = $6::uuid
	`,
		newSessionID, newHash, ipTextPtr(userAgent), ipTextPtr(ipAddress),
		newExpiresAt, oldSessionID,
	)
	if err != nil {
		return fmt.Errorf("rotate: insert successor: %w", err)
	}

	// CAS retire of the old row. Concurrent rotators race here — exactly
	// one flips rotated_at; the rest observe RowsAffected == 0 and roll
	// back via ErrSessionAlreadyRotated.
	res, err := tx.Exec(ctx, `
		UPDATE crm_admin_sessions
		SET rotated_at = now(),
		    rotated_to = $2::uuid
		WHERE id = $1::uuid
		  AND rotated_at IS NULL
		  AND revoked_at IS NULL
	`, oldSessionID, newSessionID)
	if err != nil {
		return fmt.Errorf("rotate: retire old: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrSessionAlreadyRotated
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("rotate commit: %w", err)
	}
	return nil
}

// RevokeFamily marks every live row in a session family as revoked +
// replay-detected. Called when a rotated hash is presented outside the
// grace window (replay). Only touches rows that aren't already revoked
// so a second replay of the same family is a no-op.
func (r *Repository) RevokeFamily(ctx context.Context, familyID string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admin_sessions
		SET revoked_at = now(), replay_detected_at = now()
		WHERE family_id = $1::uuid AND revoked_at IS NULL
	`, familyID)
	if err != nil {
		return fmt.Errorf("revoke family: %w", err)
	}
	return nil
}

// RevokeSession marks the session revoked.
func (r *Repository) RevokeSession(ctx context.Context, sessionID string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admin_sessions SET revoked_at = now()
		WHERE id = $1 AND revoked_at IS NULL
	`, sessionID)
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

// ListSessions lists active (not revoked, not expired, not rotated) sessions
// for an admin. Rotated legs (rotated_at IS NOT NULL) are superseded refresh
// tokens — listing them floods the page with dead duplicates and makes the
// "Revoke" control useless (revoking a rotated leg is a no-op against the
// device's live leg), so they are excluded.
func (r *Repository) ListSessions(ctx context.Context, adminID string) ([]Session, error) {
	const q = `
		SELECT id, admin_id, refresh_token_hash, user_agent,
		       host(ip_address)::text, issued_at, last_used_at,
		       expires_at, revoked_at
		FROM crm_admin_sessions
		WHERE admin_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()
		ORDER BY last_used_at DESC
	`
	rows, err := r.db.Query(ctx, q, adminID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	var out []Session
	for rows.Next() {
		var s Session
		if err := rows.Scan(
			&s.ID, &s.AdminID, &s.RefreshTokenHash, &s.UserAgent,
			&s.IPAddress, &s.IssuedAt, &s.LastUsedAt,
			&s.ExpiresAt, &s.RevokedAt,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// RecordLoginAttempt logs a row to crm_login_attempts. Best-effort.
func (r *Repository) RecordLoginAttempt(ctx context.Context, email, ip, reason string, success bool) {
	_, _ = r.db.Exec(ctx, `
		INSERT INTO crm_login_attempts (email, ip_address, success, reason)
		VALUES ($1, $2::inet, $3, $4)
	`, email, ipText(ip), success, reason)
}

func ipText(ip string) any {
	if ip == "" {
		return nil
	}
	return ip
}

func ipTextPtr(ip *string) any {
	if ip == nil || *ip == "" {
		return nil
	}
	return *ip
}
