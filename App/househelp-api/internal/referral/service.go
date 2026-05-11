package referral

import (
	"context"
	"fmt"
	"strings"

	"github.com/adityarohilla/househelp-api/internal/wallet"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

const referralBaseURL = "https://zopmop.com/r/"

// WalletCrediter is the wallet.Service interface slice that referral needs.
type WalletCrediter interface {
	CreditTx(ctx context.Context, tx pgx.Tx, userID string, amountPaise int64, kind wallet.Kind, paymentID, bookingID *string, note string) (*wallet.ApplyResult, error)
}

type Service struct {
	repo   *Repository
	wallet WalletCrediter
	db     *pgxpool.Pool
}

func NewService(repo *Repository, db *pgxpool.Pool, w WalletCrediter) *Service {
	return &Service{repo: repo, db: db, wallet: w}
}

// GenerateAndSetCode generates a name-based referral code for userID and writes
// it to users.referral_code. Idempotent: returns existing code if already set.
func (s *Service) GenerateAndSetCode(ctx context.Context, userID, name, phone string) (string, error) {
	existing, err := s.repo.GetReferralCodeForUser(ctx, userID)
	if err != nil {
		return "", err
	}
	if existing != "" {
		return existing, nil
	}

	prefix := firstNamePrefix(name)
	if prefix == "" {
		code := "USER" + phoneSuffix(phone)
		if err := s.repo.SetReferralCodeIfNil(ctx, userID, code); err != nil && !isUniqueViolation(err) {
			return "", fmt.Errorf("set fallback code: %w", err)
		}
		return s.repo.GetReferralCodeForUser(ctx, userID)
	}

	for tier := 0; tier < 8; tier++ {
		for attempt := 0; attempt < 10; attempt++ {
			candidate := generateCandidate(prefix, tier)
			err := s.repo.SetReferralCodeIfNil(ctx, userID, candidate)
			if err == nil {
				code, rerr := s.repo.GetReferralCodeForUser(ctx, userID)
				if rerr != nil {
					return "", rerr
				}
				if code != "" {
					return code, nil
				}
				continue
			}
			if !isUniqueViolation(err) {
				return "", fmt.Errorf("set referral code: %w", err)
			}
		}
	}

	// Extreme fallback: prefix + 8-char UUID hex segment.
	fallback := strings.ToUpper(prefix + strings.ReplaceAll(uuid.New().String(), "-", "")[:8])
	if err := s.repo.SetReferralCodeIfNil(ctx, userID, fallback); err != nil {
		return "", fmt.Errorf("set uuid-fallback code: %w", err)
	}
	return s.repo.GetReferralCodeForUser(ctx, userID)
}

// GetStats returns referral stats for GET /me/referral. Lazy-generates code if nil.
func (s *Service) GetStats(ctx context.Context, userID, name, phone string) (*ReferralStats, error) {
	code, used, earnedPaise, err := s.repo.GetStatsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if code == "" {
		code, err = s.GenerateAndSetCode(ctx, userID, name, phone)
		if err != nil {
			return nil, err
		}
	}
	remaining := MaxReferralsPerReferrer - used
	if remaining < 0 {
		remaining = 0
	}
	return &ReferralStats{
		Code:               code,
		Link:               referralBaseURL + code,
		ReferralsUsed:      used,
		ReferralsRemaining: remaining,
		TotalEarnedPaise:   earnedPaise,
	}, nil
}

// Apply validates and creates a pending referral row. No wallet credit here.
func (s *Service) Apply(ctx context.Context, refereeID, code string) error {
	referrer, err := s.repo.GetReferrerByCode(ctx, code)
	if err != nil {
		return err
	}
	if referrer.UserID == refereeID {
		return ErrSelfReferral
	}

	has, err := s.repo.HasReferral(ctx, refereeID)
	if err != nil {
		return err
	}
	if has {
		return ErrAlreadyReferred
	}

	count, err := s.repo.CountReferralsForReferrer(ctx, referrer.UserID)
	if err != nil {
		return err
	}
	if count >= MaxReferralsPerReferrer {
		return ErrCapReached
	}

	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		return s.repo.CreateReferralTx(ctx, tx, referrer.UserID, refereeID)
	})
}

// MaybeCompleteOnBookingTx is called inside the booking completion transaction.
// Credits referee (Rs 100) and referrer (Rs 200) when referee's first post-referral
// booking completes. All writes are inside the supplied tx.
func (s *Service) MaybeCompleteOnBookingTx(ctx context.Context, tx pgx.Tx, customerID string) error {
	ref, err := s.repo.GetPendingReferralForRefereeTx(ctx, tx, customerID)
	if err != nil {
		return err
	}
	if ref == nil {
		return nil
	}

	// Count completed bookings for this customer completed after the referral was accepted.
	// The current booking is already marked completed in this tx, so COUNT = 1 on first trigger.
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM bookings
		 WHERE customer_id = $1 AND status = 'completed' AND completed_at > $2`,
		customerID, ref.CreatedAt,
	).Scan(&count); err != nil {
		return fmt.Errorf("count post-referral bookings: %w", err)
	}
	if count != 1 {
		return nil
	}

	if _, err := s.wallet.CreditTx(ctx, tx, customerID, RefereeCreditPaise,
		wallet.KindReferralCredit, nil, nil,
		"referral credit: first booking bonus"); err != nil {
		return fmt.Errorf("credit referee: %w", err)
	}

	var referrerActive bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_suspended = FALSE)`,
		ref.ReferrerID,
	).Scan(&referrerActive); err == nil && referrerActive {
		if _, cerr := s.wallet.CreditTx(ctx, tx, ref.ReferrerID, ReferrerCreditPaise,
			wallet.KindReferralCredit, nil, nil,
			fmt.Sprintf("referral bonus: referee %s completed first booking", customerID)); cerr != nil {
			log.Warn().Err(cerr).Str("referrer_id", ref.ReferrerID).Msg("referral: could not credit referrer")
		}
	}

	return s.repo.CompleteReferralTx(ctx, tx, ref.ID)
}
