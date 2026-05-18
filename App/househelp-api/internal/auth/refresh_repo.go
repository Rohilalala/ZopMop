package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistence layer for `refresh_tokens` (migration 097). The
// plaintext refresh token is NEVER stored — the client holds it,
// we hold sha256-hex(plaintext) and look up by that. Every row
// records the typ at issuance so /refresh can re-mint without an
// extra users join.

// ErrRefreshTokenInvalid is returned for any reason the supplied
// refresh token cannot be used: not found, revoked, or expired.
// Callers translate this to 401 — never leak which of the three
// it was (would let an attacker probe for valid hashes).
var ErrRefreshTokenInvalid = errors.New("refresh token invalid")

// RefreshTokenRow is the in-memory mirror of a refresh_tokens row.
type RefreshTokenRow struct {
	ID        string
	UserID    string
	UserType  string
	ExpiresAt time.Time
	RevokedAt *time.Time
}

// RefreshRepo handles refresh_tokens persistence.
type RefreshRepo struct {
	db *pgxpool.Pool
}

// NewRefreshRepo constructs a repo bound to the supplied pool.
func NewRefreshRepo(db *pgxpool.Pool) *RefreshRepo {
	return &RefreshRepo{db: db}
}

// Insert persists a freshly-issued refresh token. The plaintext is
// passed pre-hashed by the caller so this layer never sees the raw
// value.
func (r *RefreshRepo) Insert(ctx context.Context, userID, userType, hash string, expiresAt time.Time) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
		INSERT INTO refresh_tokens (user_id, user_type, token_hash, expires_at)
		VALUES ($1, $2, $3, $4)
	`, userID, userType, hash, expiresAt)
	if err != nil {
		return fmt.Errorf("insert refresh token: %w", err)
	}
	return nil
}

// FindActive returns the row for a hash IFF it exists, has not been
// revoked, and has not expired. Returns ErrRefreshTokenInvalid for
// any failure mode so the caller cannot distinguish them.
func (r *RefreshRepo) FindActive(ctx context.Context, hash string) (*RefreshTokenRow, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	row := &RefreshTokenRow{}
	err := r.db.QueryRow(queryCtx, `
		SELECT id, user_id, user_type, expires_at, revoked_at
		FROM refresh_tokens
		WHERE token_hash = $1
	`, hash).Scan(&row.ID, &row.UserID, &row.UserType, &row.ExpiresAt, &row.RevokedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrRefreshTokenInvalid
		}
		return nil, fmt.Errorf("lookup refresh token: %w", err)
	}
	if row.RevokedAt != nil {
		return nil, ErrRefreshTokenInvalid
	}
	if row.ExpiresAt.Before(time.Now()) {
		return nil, ErrRefreshTokenInvalid
	}

	// Best-effort last_used_at update — the row stays valid even if
	// the UPDATE fails.
	_, _ = r.db.Exec(queryCtx, `UPDATE refresh_tokens SET last_used_at = now() WHERE id = $1`, row.ID)

	return row, nil
}

// Revoke stamps revoked_at on the row matching the given hash IFF
// it's not already revoked. Idempotent — a second /logout call is a
// no-op.
func (r *RefreshRepo) Revoke(ctx context.Context, hash string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
		UPDATE refresh_tokens
		   SET revoked_at = now()
		 WHERE token_hash = $1
		   AND revoked_at IS NULL
	`, hash)
	if err != nil {
		return fmt.Errorf("revoke refresh token: %w", err)
	}
	return nil
}

// RevokeByID is the rotation counterpart to FindActive — revoke the
// just-used row inside the same transaction as the new-row insert
// so the swap is atomic.
func (r *RefreshRepo) RevokeByID(ctx context.Context, id string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
		UPDATE refresh_tokens
		   SET revoked_at = now()
		 WHERE id = $1
		   AND revoked_at IS NULL
	`, id)
	if err != nil {
		return fmt.Errorf("revoke refresh token by id: %w", err)
	}
	return nil
}

// RevokeAllForUser is used by account-deletion and admin-suspend
// paths to invalidate every outstanding session at once.
func (r *RefreshRepo) RevokeAllForUser(ctx context.Context, userID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
		UPDATE refresh_tokens
		   SET revoked_at = now()
		 WHERE user_id = $1
		   AND revoked_at IS NULL
	`, userID)
	if err != nil {
		return fmt.Errorf("revoke all refresh tokens: %w", err)
	}
	return nil
}
