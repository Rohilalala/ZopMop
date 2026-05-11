package referral

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// isUniqueViolation reports whether err is a PostgreSQL 23505 unique constraint violation.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// GetReferralCodeForUser reads users.referral_code (nil → "").
func (r *Repository) GetReferralCodeForUser(ctx context.Context, userID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var code *string
	err := r.db.QueryRow(ctx,
		`SELECT referral_code FROM users WHERE id = $1 AND deleted_at IS NULL`, userID,
	).Scan(&code)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("get referral code: %w", err)
	}
	if code == nil {
		return "", nil
	}
	return *code, nil
}

// SetReferralCodeIfNil writes referral_code only when the column is currently NULL.
// Returns a unique-violation error (isUniqueViolation == true) when another user
// already holds that code value.
func (r *Repository) SetReferralCodeIfNil(ctx context.Context, userID, code string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tag, err := r.db.Exec(ctx,
		`UPDATE users SET referral_code = $1, updated_at = NOW()
		 WHERE id = $2 AND referral_code IS NULL`,
		code, userID,
	)
	if err != nil {
		return err // caller checks isUniqueViolation
	}
	_ = tag // 0 rows = code was already set by concurrent call; fine
	return nil
}

// referrerInfo is returned by GetReferrerByCode.
type referrerInfo struct {
	UserID string
	Name   *string
	Phone  string
}

// GetReferrerByCode resolves users.referral_code to a live, non-deleted user.
func (r *Repository) GetReferrerByCode(ctx context.Context, code string) (*referrerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var info referrerInfo
	err := r.db.QueryRow(ctx,
		`SELECT id, name, phone FROM users
		 WHERE referral_code = $1 AND deleted_at IS NULL`,
		code,
	).Scan(&info.UserID, &info.Name, &info.Phone)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCodeNotFound
		}
		return nil, fmt.Errorf("get referrer by code: %w", err)
	}
	return &info, nil
}

// CountReferralsForReferrer counts total referral rows (any status) for a referrer.
func (r *Repository) CountReferralsForReferrer(ctx context.Context, referrerID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var n int
	if err := r.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, referrerID,
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("count referrals: %w", err)
	}
	return n, nil
}

// HasReferral reports whether refereeID already has a referral row.
func (r *Repository) HasReferral(ctx context.Context, refereeID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var exists bool
	if err := r.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM referrals WHERE referee_id = $1)`, refereeID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("has referral: %w", err)
	}
	return exists, nil
}

// CreateReferralTx inserts a new pending referral inside the supplied tx.
func (r *Repository) CreateReferralTx(ctx context.Context, tx pgx.Tx, referrerID, refereeID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO referrals (referrer_id, referee_id) VALUES ($1, $2)`,
		referrerID, refereeID,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrAlreadyReferred
		}
		return fmt.Errorf("create referral: %w", err)
	}
	return nil
}

// GetPendingReferralForRefereeTx reads the pending referral for a referee inside
// the supplied tx. Returns nil, nil when the user was not referred.
func (r *Repository) GetPendingReferralForRefereeTx(ctx context.Context, tx pgx.Tx, refereeID string) (*Referral, error) {
	var ref Referral
	err := tx.QueryRow(ctx,
		`SELECT id, referrer_id, referee_id, status, created_at
		 FROM referrals WHERE referee_id = $1 AND status = 'pending'`,
		refereeID,
	).Scan(&ref.ID, &ref.ReferrerID, &ref.RefereeID, &ref.Status, &ref.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("get pending referral: %w", err)
	}
	return &ref, nil
}

// CompleteReferralTx stamps both credited_at timestamps and flips status='completed'.
func (r *Repository) CompleteReferralTx(ctx context.Context, tx pgx.Tx, referralID string) error {
	_, err := tx.Exec(ctx,
		`UPDATE referrals
		 SET status = 'completed',
		     referee_credited_at  = NOW(),
		     referrer_credited_at = NOW()
		 WHERE id = $1`,
		referralID,
	)
	if err != nil {
		return fmt.Errorf("complete referral: %w", err)
	}
	return nil
}

// GetStatsForUser returns referral stats for the Refer & Earn screen.
func (r *Repository) GetStatsForUser(ctx context.Context, userID string) (code string, used int, earnedPaise int64, err error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var codePtr *string
	if scanErr := r.db.QueryRow(ctx,
		`SELECT referral_code FROM users WHERE id = $1 AND deleted_at IS NULL`, userID,
	).Scan(&codePtr); scanErr != nil {
		return "", 0, 0, fmt.Errorf("get user code: %w", scanErr)
	}
	if codePtr != nil {
		code = *codePtr
	}

	if scanErr := r.db.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(SUM(CASE WHEN status='completed' THEN 20000 ELSE 0 END), 0)
		 FROM referrals WHERE referrer_id = $1`, userID,
	).Scan(&used, &earnedPaise); scanErr != nil {
		return "", 0, 0, fmt.Errorf("get referral stats: %w", scanErr)
	}
	return code, used, earnedPaise, nil
}
