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
// Called once at initial enrolment, not for re-validation.
func (r *Repository) SetTOTPSecret(ctx context.Context, adminID, secret string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admins
		SET totp_secret = $2, totp_enrolled_at = now(), updated_at = now()
		WHERE id = $1
	`, adminID, secret)
	if err != nil {
		return fmt.Errorf("set totp secret: %w", err)
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

// GetSessionByHash looks up an active (not revoked, not expired) session.
func (r *Repository) GetSessionByHash(ctx context.Context, hash string) (*Session, error) {
	const q = `
		SELECT id, admin_id, refresh_token_hash, user_agent,
		       host(ip_address)::text, issued_at, last_used_at,
		       expires_at, revoked_at
		FROM crm_admin_sessions
		WHERE refresh_token_hash = $1
		  AND revoked_at IS NULL
		  AND expires_at > now()
	`
	var s Session
	err := r.db.QueryRow(ctx, q, hash).Scan(
		&s.ID, &s.AdminID, &s.RefreshTokenHash, &s.UserAgent,
		&s.IPAddress, &s.IssuedAt, &s.LastUsedAt,
		&s.ExpiresAt, &s.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
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

// RotateSession replaces the refresh-token hash in place (atomic rotation on refresh).
func (r *Repository) RotateSession(ctx context.Context, sessionID, newHash string, newExpires time.Time) error {
	_, err := r.db.Exec(ctx, `
		UPDATE crm_admin_sessions
		SET refresh_token_hash = $2, last_used_at = now(), expires_at = $3
		WHERE id = $1 AND revoked_at IS NULL
	`, sessionID, newHash, newExpires)
	if err != nil {
		return fmt.Errorf("rotate session: %w", err)
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

// ListSessions lists active (not revoked, not expired) sessions for an admin.
func (r *Repository) ListSessions(ctx context.Context, adminID string) ([]Session, error) {
	const q = `
		SELECT id, admin_id, refresh_token_hash, user_agent,
		       host(ip_address)::text, issued_at, last_used_at,
		       expires_at, revoked_at
		FROM crm_admin_sessions
		WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
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
