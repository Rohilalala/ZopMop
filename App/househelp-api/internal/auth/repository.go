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
		`SELECT `+userSelectFields+` FROM users WHERE phone = $1`,
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
		`SELECT `+userSelectFields+` FROM users WHERE id = $1`,
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
