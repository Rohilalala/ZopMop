package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Repository handles all database operations for the auth module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new auth repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

const userSelectFields = `id, phone, name, role, is_suspended, created_at, updated_at`

func scanUser(row pgx.Row, user *User) error {
	return row.Scan(
		&user.ID, &user.Phone, &user.Name,
		&user.Role, &user.IsSuspended, &user.CreatedAt, &user.UpdatedAt,
	)
}

// CreateUser inserts a new user and returns the created user.
func (r *Repository) CreateUser(ctx context.Context, phone, role string) (*User, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	user := &User{}
	err := scanUser(r.db.QueryRow(queryCtx,
		`INSERT INTO users (phone, role)
		 VALUES ($1, $2)
		 RETURNING `+userSelectFields,
		phone, role,
	), user)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	log.Info().Str("user_id", user.ID).Str("role", role).Msg("user created")
	return user, nil
}

// GetUserByPhone retrieves a user by phone number. Returns nil, nil if not found.
func (r *Repository) GetUserByPhone(ctx context.Context, phone string) (*User, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	user := &User{}
	err := scanUser(r.db.QueryRow(queryCtx,
		`SELECT `+userSelectFields+` FROM users WHERE phone = $1 AND deleted_at IS NULL`,
		phone,
	), user)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get user by phone: %w", err)
	}

	return user, nil
}

// GetUserByID retrieves a user by their ID. Returns nil, nil if not found.
func (r *Repository) GetUserByID(ctx context.Context, userID string) (*User, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	user := &User{}
	err := scanUser(r.db.QueryRow(queryCtx,
		`SELECT `+userSelectFields+` FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	), user)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get user by ID: %w", err)
	}

	return user, nil
}

// UpdateProfile updates a user's name.
func (r *Repository) UpdateProfile(ctx context.Context, userID string, req UpdateProfileRequest) (*User, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	user := &User{}
	err := scanUser(r.db.QueryRow(queryCtx,
		`UPDATE users
		 SET name       = CASE WHEN $2 <> '' THEN $2 ELSE name END,
		     updated_at = now()
		 WHERE id = $1
		 RETURNING `+userSelectFields,
		userID, req.Name,
	), user)
	if err != nil {
		return nil, fmt.Errorf("failed to update profile: %w", err)
	}

	return user, nil
}

// UpdateUser updates a user's name (kept for backwards compatibility).
func (r *Repository) UpdateUser(ctx context.Context, userID, name string) (*User, error) {
	return r.UpdateProfile(ctx, userID, UpdateProfileRequest{Name: name})
}

// OnboardPro inserts the caller into the helpers table with approval_status='pending'.
// SECURITY: it does NOT change users.role — privilege escalation to 'pro' is gated
// on admin approval (a separate flow flips approval_status to 'approved' and updates
// users.role). Returning the unchanged User is intentional so the caller cannot
// self-issue a pro JWT.
// TODO: gate helper-only routes on approval_status='approved' once the admin
// approval endpoint exists.
func (r *Repository) OnboardPro(ctx context.Context, userID string, req OnboardProRequest) (*User, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Read current user row WITHOUT changing role.
	user := &User{}
	err = scanUser(tx.QueryRow(ctx,
		`SELECT `+userSelectFields+` FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	), user)
	if err != nil {
		return nil, fmt.Errorf("failed to load user: %w", err)
	}

	// Insert into helpers table ensuring idempotency. Always reset approval to
	// 'pending' on re-submission so admins re-review any updated profile.
	_, err = tx.Exec(ctx,
		`INSERT INTO helpers (id, current_lat, current_lng, location, is_available, services, availability, address, approval_status)
		 VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, false, $6, $7, $8, 'pending')
		 ON CONFLICT (id) DO UPDATE SET
		   current_lat     = EXCLUDED.current_lat,
		   current_lng     = EXCLUDED.current_lng,
		   location        = EXCLUDED.location,
		   services        = EXCLUDED.services,
		   availability    = EXCLUDED.availability,
		   address         = EXCLUDED.address,
		   approval_status = 'pending'`,
		userID, req.Lat, req.Lng, req.Lng, req.Lat, req.Services, req.Availability, req.Address,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to insert helper record: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit tx: %w", err)
	}

	return user, nil
}

// SoftDeleteUser marks a user account as deleted and scrubs the PII fields
// that are not required for audit/legal retention. The row is kept so that
// foreign-key references (bookings, roomies ledgers, audit logs) remain valid.
//
//   - phone is replaced with a deterministic anonymised value so uniqueness
//     holds and the original number is no longer retrievable. The deleted
//     user can re-register with the same phone because the original phone
//     is freed.
//   - name is cleared.
//   - fcm_token is cleared (suppress push).
//   - role is forced to 'customer' and is_suspended=true so any lingering
//     JWT cannot resurrect helper/admin privileges.
//   - deleted_at is stamped; a nightly job can hard-purge after the grace
//     window defined in product policy (~30 days).
func (r *Repository) SoftDeleteUser(ctx context.Context, userID, reason string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := r.db.BeginTx(queryCtx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// Anonymise phone to free it for re-registration while keeping UNIQUE.
	res, err := tx.Exec(queryCtx,
		`UPDATE users
		   SET phone           = 'del:' || substr(id::text, 25, 12),
		       name            = NULL,
		       fcm_token       = NULL,
		       role            = 'customer',
		       is_suspended    = true,
		       deleted_at      = now(),
		       deletion_reason = NULLIF($2, ''),
		       updated_at      = now()
		 WHERE id = $1
		   AND deleted_at IS NULL`,
		userID, reason,
	)
	if err != nil {
		return fmt.Errorf("failed to soft-delete user: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrUserNotFound
	}

	// Drop helper row so the user no longer appears in matching.
	if _, err := tx.Exec(queryCtx, `DELETE FROM helpers WHERE id = $1`, userID); err != nil {
		return fmt.Errorf("failed to remove helper row: %w", err)
	}

	if err := tx.Commit(queryCtx); err != nil {
		return fmt.Errorf("failed to commit tx: %w", err)
	}

	log.Info().Str("user_id", userID).Msg("user account soft-deleted")
	return nil
}

// UpdateFCMToken updates the FCM token for a user.
func (r *Repository) UpdateFCMToken(ctx context.Context, userID, token string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	res, err := r.db.Exec(queryCtx,
		`UPDATE users SET fcm_token = $1, updated_at = now() WHERE id = $2`,
		token, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update FCM token: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("user not found or token unchanged")
	}
	return nil
}
