package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	otpExpiry         = 10 * time.Minute
	otpLockDuration   = 15 * time.Minute
	maxFailedAttempts = 5
)

// Custom error types for type-safe error handling.
type ErrOTPLocked struct{}

func (e *ErrOTPLocked) Error() string {
	return "too many failed attempts, try again later"
}

type ErrAccountSuspended struct{}

func (e *ErrAccountSuspended) Error() string {
	return "account suspended"
}

// Service handles auth business logic.
type Service struct {
	repo      *Repository
	rdb       *redis.Client
	jwtSecret string
	jwtExpiry time.Duration
}

// NewService creates a new auth service.
func NewService(repo *Repository, rdb *redis.Client, jwtSecret string, jwtExpiryHours int) *Service {
	return &Service{
		repo:      repo,
		rdb:       rdb,
		jwtSecret: jwtSecret,
		jwtExpiry: time.Duration(jwtExpiryHours) * time.Hour,
	}
}

// SendOTP generates a cryptographically secure 6-digit OTP,
// stores it in Redis with 10-minute expiry.
// Returns the OTP (in production, this would be sent via SMS, not returned).
func (s *Service) SendOTP(ctx context.Context, phone string) (string, error) {
	// Check if the phone is locked due to failed attempts.
	lockKey := fmt.Sprintf("otp:lock:%s", phone)
	locked, err := s.rdb.Exists(ctx, lockKey).Result()
	if err != nil {
		return "", fmt.Errorf("failed to check OTP lock: %w", err)
	}
	if locked > 0 {
		return "", &ErrOTPLocked{}
	}

	// Generate 6-digit OTP using crypto/rand.
	otp, err := generateSecureOTP()
	if err != nil {
		return "", fmt.Errorf("failed to generate OTP: %w", err)
	}

	// Store OTP in Redis with 10-minute expiry.
	otpKey := fmt.Sprintf("otp:%s", phone)
	if err := s.rdb.Set(ctx, otpKey, otp, otpExpiry).Err(); err != nil {
		return "", fmt.Errorf("failed to store OTP: %w", err)
	}

	// Reset failed attempts counter on new OTP request.
	failKey := fmt.Sprintf("otp:fail:%s", phone)
	if err := s.rdb.Del(ctx, failKey).Err(); err != nil {
		log.Warn().Err(err).Str("phone", phone).Msg("failed to reset OTP failure counter")
	}

	log.Info().Str("phone", phone).Msg("OTP generated and stored")

	// In production, send via SMS provider here.
	// For development, return the OTP directly.
	return otp, nil
}

// VerifyOTP verifies the OTP using constant-time comparison.
// After 5 failed attempts, locks the phone for 15 minutes.
// On success, creates user if new, and returns a JWT token.
func (s *Service) VerifyOTP(ctx context.Context, phone, code string) (*LoginResponse, error) {
	// Check lock.
	lockKey := fmt.Sprintf("otp:lock:%s", phone)
	locked, err := s.rdb.Exists(ctx, lockKey).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to check OTP lock: %w", err)
	}
	if locked > 0 {
		return nil, &ErrOTPLocked{}
	}

	// Retrieve stored OTP.
	otpKey := fmt.Sprintf("otp:%s", phone)
	storedOTP, err := s.rdb.Get(ctx, otpKey).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, fmt.Errorf("OTP expired or not found")
		}
		return nil, fmt.Errorf("failed to retrieve OTP: %w", err)
	}

	// Constant-time comparison to prevent timing attacks.
	if subtle.ConstantTimeCompare([]byte(storedOTP), []byte(code)) != 1 {
		// Increment failure counter.
		failKey := fmt.Sprintf("otp:fail:%s", phone)
		failCount, incrErr := s.rdb.Incr(ctx, failKey).Result()
		if incrErr != nil {
			log.Error().Err(incrErr).Msg("failed to increment OTP failure counter")
		}

		// Set expiry on failure counter.
		if expErr := s.rdb.Expire(ctx, failKey, otpExpiry).Err(); expErr != nil {
			log.Error().Err(expErr).Msg("failed to set OTP failure counter expiry")
		}

		// Lock after max failed attempts.
		if failCount >= int64(maxFailedAttempts) {
			if lockErr := s.rdb.Set(ctx, lockKey, "locked", otpLockDuration).Err(); lockErr != nil {
				log.Error().Err(lockErr).Msg("failed to set OTP lock")
			}
			log.Warn().Str("phone", phone).Msg("phone locked due to too many failed OTP attempts")
			return nil, &ErrOTPLocked{}
		}

		return nil, fmt.Errorf("invalid OTP")
	}

	// OTP is valid — delete it so it can't be reused.
	if delErr := s.rdb.Del(ctx, otpKey).Err(); delErr != nil {
		log.Error().Err(delErr).Msg("failed to delete used OTP")
	}

	// Clean up failure counter.
	failKey := fmt.Sprintf("otp:fail:%s", phone)
	if delErr := s.rdb.Del(ctx, failKey).Err(); delErr != nil {
		log.Warn().Err(delErr).Msg("failed to delete OTP failure counter")
	}

	// Find or create user.
	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}

	if user == nil {
		// New user — create with "customer" role by default.
		user, err = s.repo.CreateUser(ctx, phone, "customer")
		if err != nil {
			return nil, fmt.Errorf("failed to create user: %w", err)
		}
	}

	// Check if user is suspended.
	if user.IsSuspended {
		return nil, &ErrAccountSuspended{}
	}

	// Generate JWT token.
	token, err := s.generateJWT(user)
	if err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}

	return &LoginResponse{
		Token: token,
		User:  *user,
	}, nil
}

// generateJWT creates a signed JWT token with userID, role, issuer, iat, exp claims.
func (s *Service) generateJWT(user *User) (string, error) {
	now := time.Now()

	claims := jwt.MapClaims{
		"user_id":      user.ID,
		"role":         user.Role,
		"is_suspended": user.IsSuspended,
		"iss":          "househelp-api",
		"iat":          now.Unix(),
		"exp":          now.Add(s.jwtExpiry).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedToken, err := token.SignedString([]byte(s.jwtSecret))
	if err != nil {
		return "", fmt.Errorf("failed to sign JWT: %w", err)
	}

	return signedToken, nil
}

// generateSecureOTP creates a cryptographically secure 6-digit OTP.
func generateSecureOTP() (string, error) {
	max := big.NewInt(999999)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	// Pad to 6 digits.
	return fmt.Sprintf("%06d", n.Int64()), nil
}
