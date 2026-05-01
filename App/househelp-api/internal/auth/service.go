package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
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
	otpSendCooldown   = 60 * time.Second
	maxFailedAttempts = 5
)

// ErrOTPCooldown is returned when a phone has requested an OTP too recently.
type ErrOTPCooldown struct {
	RetryAfter time.Duration
}

func (e *ErrOTPCooldown) Error() string {
	return fmt.Sprintf("please wait %d seconds before requesting another OTP", int(e.RetryAfter.Seconds()))
}

// Custom error types for type-safe error handling.
type ErrOTPLocked struct{}

func (e *ErrOTPLocked) Error() string {
	return "too many failed attempts, try again later"
}

type ErrAccountSuspended struct{}

func (e *ErrAccountSuspended) Error() string {
	return "account suspended"
}

var (
	ErrInvalidOTP           = errors.New("invalid OTP")
	ErrOTPExpiredOrNotFound = errors.New("OTP expired or not found")
)

// Service handles auth business logic.
type Service struct {
	repo          *Repository
	rdb           *redis.Client
	jwtSecret     string
	jwtSecretID   string
	jwtExpiry     time.Duration
	devOTPEnabled bool
}

// NewService creates a new auth service.
// devOTPEnabled controls whether SendOTP returns the plaintext OTP alongside the
// success response. This MUST be false in production — it exists only so local
// dev/integration tests can complete the phone flow without a real SMS gateway.
func NewService(repo *Repository, rdb *redis.Client, jwtSecret, jwtSecretID string, jwtExpiryHours int, devOTPEnabled bool) *Service {
	return &Service{
		repo:          repo,
		rdb:           rdb,
		jwtSecret:     jwtSecret,
		jwtSecretID:   jwtSecretID,
		jwtExpiry:     time.Duration(jwtExpiryHours) * time.Hour,
		devOTPEnabled: devOTPEnabled,
	}
}

// DevOTPEnabled reports whether the service may echo OTPs in responses.
func (s *Service) DevOTPEnabled() bool { return s.devOTPEnabled }

// JWTExpiry returns the JWT token TTL. Exposed so the auth handler can set a
// matching Max-Age on the httpOnly auth cookie.
func (s *Service) JWTExpiry() time.Duration { return s.jwtExpiry }

// SendOTP generates a cryptographically secure 6-digit OTP,
// stores it in Redis with 10-minute expiry.
func (s *Service) SendOTP(ctx context.Context, phone string) (string, error) {
	lockKey := fmt.Sprintf("otp:lock:%s", phone)
	locked, err := s.rdb.Exists(ctx, lockKey).Result()
	if err != nil {
		return "", fmt.Errorf("failed to check OTP lock: %w", err)
	}
	if locked > 0 {
		return "", &ErrOTPLocked{}
	}

	// Per-phone send cooldown: SetNX creates the sentinel only if absent, so
	// any caller (any IP) asking for an OTP for this phone within the cooldown
	// window is rejected with a Retry-After hint. This protects against SMS
	// spam / toll-fraud targeting a single phone even when the global IP
	// limiter (SensitivePublicRateLimit) allows the request.
	cooldownKey := fmt.Sprintf("otp:cooldown:%s", phone)
	ok, err := s.rdb.SetNX(ctx, cooldownKey, "1", otpSendCooldown).Result()
	if err != nil {
		return "", fmt.Errorf("failed to set OTP cooldown: %w", err)
	}
	if !ok {
		ttl, ttlErr := s.rdb.TTL(ctx, cooldownKey).Result()
		if ttlErr != nil || ttl <= 0 {
			ttl = otpSendCooldown
		}
		return "", &ErrOTPCooldown{RetryAfter: ttl}
	}

	otp, err := generateSecureOTP()
	if err != nil {
		return "", fmt.Errorf("failed to generate OTP: %w", err)
	}

	otpKey := fmt.Sprintf("otp:%s", phone)
	if err := s.rdb.Set(ctx, otpKey, otp, otpExpiry).Err(); err != nil {
		return "", fmt.Errorf("failed to store OTP: %w", err)
	}

	failKey := fmt.Sprintf("otp:fail:%s", phone)
	if err := s.rdb.Del(ctx, failKey).Err(); err != nil {
		log.Warn().Err(err).Str("phone", phone).Msg("failed to reset OTP failure counter")
	}

	// Never log the OTP value itself — logs aggregate to shared systems.
	log.Info().Str("phone", phone).Msg("OTP generated and stored")

	// Only expose the plaintext OTP to the caller in dev mode. In production
	// the SMS gateway is the sole delivery channel.
	if !s.devOTPEnabled {
		return "", nil
	}
	return otp, nil
}

// VerifyOTP verifies the OTP, upserts the user, and returns a JWT.
func (s *Service) VerifyOTP(ctx context.Context, phone, code string) (*LoginResponse, error) {
	lockKey := fmt.Sprintf("otp:lock:%s", phone)
	locked, err := s.rdb.Exists(ctx, lockKey).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to check OTP lock: %w", err)
	}
	if locked > 0 {
		return nil, &ErrOTPLocked{}
	}

	otpKey := fmt.Sprintf("otp:%s", phone)
	storedOTP, err := s.rdb.Get(ctx, otpKey).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, ErrOTPExpiredOrNotFound
		}
		return nil, fmt.Errorf("failed to retrieve OTP: %w", err)
	}

	if subtle.ConstantTimeCompare([]byte(storedOTP), []byte(code)) != 1 {
		failKey := fmt.Sprintf("otp:fail:%s", phone)
		failCount, incrErr := s.rdb.Incr(ctx, failKey).Result()
		if incrErr != nil {
			log.Error().Err(incrErr).Msg("failed to increment OTP failure counter")
		}
		if expErr := s.rdb.Expire(ctx, failKey, otpExpiry).Err(); expErr != nil {
			log.Error().Err(expErr).Msg("failed to set OTP failure counter expiry")
		}
		if failCount >= int64(maxFailedAttempts) {
			if lockErr := s.rdb.Set(ctx, lockKey, "locked", otpLockDuration).Err(); lockErr != nil {
				log.Error().Err(lockErr).Msg("failed to set OTP lock")
			}
			log.Warn().Str("phone", phone).Msg("phone locked due to too many failed OTP attempts")
			return nil, &ErrOTPLocked{}
		}
		return nil, ErrInvalidOTP
	}

	if delErr := s.rdb.Del(ctx, otpKey).Err(); delErr != nil {
		log.Error().Err(delErr).Msg("failed to delete used OTP")
	}
	failKey := fmt.Sprintf("otp:fail:%s", phone)
	if delErr := s.rdb.Del(ctx, failKey).Err(); delErr != nil {
		log.Warn().Err(delErr).Msg("failed to delete OTP failure counter")
	}

	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}
	if user == nil {
		user, err = s.repo.CreateUser(ctx, phone, "customer")
		if err != nil {
			return nil, fmt.Errorf("failed to create user: %w", err)
		}
	}
	if user.IsSuspended {
		return nil, &ErrAccountSuspended{}
	}

	token, err := s.generateJWT(user)
	if err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}

	return &LoginResponse{Token: token, User: *user}, nil
}

// VerifyFirebaseToken validates a Firebase ID token, upserts the user, and returns a JWT.
func (s *Service) VerifyFirebaseToken(ctx context.Context, idToken string) (*LoginResponse, error) {
	phone, err := VerifyFirebaseToken(ctx, idToken)
	if err != nil {
		return nil, err
	}

	log.Info().Str("phone_from_firebase", phone).Msg("[auth] Firebase token phone extracted")
	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		log.Error().Err(err).Str("phone", phone).Msg("[auth] GetUserByPhone failed")
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}
	if user == nil {
		log.Info().Str("phone", phone).Msg("[auth] User not found, creating new customer")
		user, err = s.repo.CreateUser(ctx, phone, "customer")
		if err != nil {
			log.Error().Err(err).Str("phone", phone).Msg("[auth] CreateUser failed")
			return nil, fmt.Errorf("failed to create user: %w", err)
		}
	} else {
		log.Info().Str("user_id", user.ID).Str("role", user.Role).Msg("[auth] User found")
	}
	if user.IsSuspended {
		return nil, &ErrAccountSuspended{}
	}

	token, err := s.generateJWT(user)
	if err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}

	return &LoginResponse{Token: token, User: *user}, nil
}

// GetMe returns the current user's profile.
func (s *Service) GetMe(ctx context.Context, userID string) (*User, error) {
	user, err := s.repo.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return nil, ErrUserNotFound
	}
	return user, nil
}

// UpdateProfile updates name and/or email for the current user.
func (s *Service) UpdateProfile(ctx context.Context, userID string, req UpdateProfileRequest) (*User, error) {
	return s.repo.UpdateProfile(ctx, userID, req)
}

// OnboardPro updates user role to pro, inserts into helpers table, and issues a new JWT.
func (s *Service) OnboardPro(ctx context.Context, userID string, req OnboardProRequest) (*LoginResponse, error) {
	user, err := s.repo.OnboardPro(ctx, userID, req)
	if err != nil {
		return nil, fmt.Errorf("failed to onboard pro in DB: %w", err)
	}

	token, err := s.generateJWT(user)
	if err != nil {
		return nil, fmt.Errorf("failed to generate new token: %w", err)
	}

	return &LoginResponse{Token: token, User: *user}, nil
}

// UpdateFCMToken updates the user's FCM push token
func (s *Service) UpdateFCMToken(ctx context.Context, userID, token string) error {
	return s.repo.UpdateFCMToken(ctx, userID, token)
}

// DeleteAccount soft-deletes the user account. Surfaced as DELETE /me from
// the client to satisfy App Store Guideline 5.1.1(v). Reason is optional and
// comes straight from the user-provided form; the caller should cap its size.
func (s *Service) DeleteAccount(ctx context.Context, userID, reason string) error {
	return s.repo.SoftDeleteUser(ctx, userID, reason)
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
	if s.jwtSecretID != "" {
		token.Header["kid"] = s.jwtSecretID
	}
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
	return fmt.Sprintf("%06d", n.Int64()), nil
}
