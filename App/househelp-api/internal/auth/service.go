package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/adityarohilla/househelp-api/pkg/logger"
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

// CodeGenerator generates referral codes on profile name update.
type CodeGenerator interface {
	GenerateAndSetCode(ctx context.Context, userID, name, phone string) (string, error)
}

// Service handles auth business logic.
type Service struct {
	repo            *Repository
	rdb             *redis.Client
	jwtSecret       string
	jwtSecretID     string
	jwtExpiry       time.Duration
	devOTPEnabled   bool
	postDeleteHooks []func(ctx context.Context, userID string)
	codeGen         CodeGenerator
}

// SetCodeGenerator wires the referral code generator so a code is minted
// (idempotently) whenever a user sets their name for the first time.
func (s *Service) SetCodeGenerator(cg CodeGenerator) { s.codeGen = cg }

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

// SendOTP generates a cryptographically secure 6-digit OTP, stores it in
// Redis with 10-minute expiry, and reports whether the phone belongs to a
// brand-new user. The is-new-user signal is what the client uses to decide
// whether to render the privacy-policy checkbox on the OTP screen.
func (s *Service) SendOTP(ctx context.Context, phone string) (otp string, isNewUser bool, err error) {
	lockKey := fmt.Sprintf("otp:lock:%s", phone)
	locked, err := s.rdb.Exists(ctx, lockKey).Result()
	if err != nil {
		return "", false, fmt.Errorf("failed to check OTP lock: %w", err)
	}
	if locked > 0 {
		return "", false, &ErrOTPLocked{}
	}

	// Per-phone send cooldown: SetNX creates the sentinel only if absent, so
	// any caller (any IP) asking for an OTP for this phone within the cooldown
	// window is rejected with a Retry-After hint. This protects against SMS
	// spam / toll-fraud targeting a single phone even when the global IP
	// limiter (SensitivePublicRateLimit) allows the request.
	cooldownKey := fmt.Sprintf("otp:cooldown:%s", phone)
	ok, err := s.rdb.SetNX(ctx, cooldownKey, "1", otpSendCooldown).Result()
	if err != nil {
		return "", false, fmt.Errorf("failed to set OTP cooldown: %w", err)
	}
	if !ok {
		ttl, ttlErr := s.rdb.TTL(ctx, cooldownKey).Result()
		if ttlErr != nil || ttl <= 0 {
			ttl = otpSendCooldown
		}
		return "", false, &ErrOTPCooldown{RetryAfter: ttl}
	}

	// Look up existing user so the response can tell the client whether this
	// phone is new (→ render T&C checkbox) or returning (→ skip it). Failure
	// here is non-fatal — default to is_new_user=false so we never gate sign-in
	// on the lookup; verify-otp re-checks anyway.
	existing, lookupErr := s.repo.GetUserByPhone(ctx, phone)
	if lookupErr != nil {
		log.Warn().Err(lookupErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("send-otp user lookup failed")
	}
	isNewUser = existing == nil

	otpCode, err := generateSecureOTP()
	if err != nil {
		return "", false, fmt.Errorf("failed to generate OTP: %w", err)
	}

	otpKey := fmt.Sprintf("otp:%s", phone)
	if err := s.rdb.Set(ctx, otpKey, otpCode, otpExpiry).Err(); err != nil {
		return "", false, fmt.Errorf("failed to store OTP: %w", err)
	}

	failKey := fmt.Sprintf("otp:fail:%s", phone)
	if err := s.rdb.Del(ctx, failKey).Err(); err != nil {
		log.Warn().Err(err).Str("phone_mask", logger.MaskPhone(phone)).Msg("failed to reset OTP failure counter")
	}

	// Never log the OTP value itself — logs aggregate to shared systems.
	log.Info().Str("phone_mask", logger.MaskPhone(phone)).Bool("is_new_user", isNewUser).Msg("OTP generated and stored")

	// Only expose the plaintext OTP to the caller in dev mode. In production
	// the SMS gateway is the sole delivery channel.
	if !s.devOTPEnabled {
		return "", isNewUser, nil
	}
	return otpCode, isNewUser, nil
}

// VerifyOTP verifies the OTP, upserts the user, and returns a JWT.
// hasAcceptedPrivacyPolicy is required for new users (the value is persisted
// on the freshly-created user row); for returning users a true value
// idempotently stamps acceptance, false is ignored.
func (s *Service) VerifyOTP(ctx context.Context, phone, code string, hasAcceptedPrivacyPolicy bool) (*LoginResponse, error) {
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
			log.Warn().Str("phone_mask", logger.MaskPhone(phone)).Msg("phone locked due to too many failed OTP attempts")
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
		user, err = s.repo.CreateUser(ctx, phone, "customer", hasAcceptedPrivacyPolicy)
		if err != nil {
			return nil, fmt.Errorf("failed to create user: %w", err)
		}
	} else if hasAcceptedPrivacyPolicy && !user.HasAcceptedPrivacyPolicy {
		// Returning user re-accepting (e.g. after a policy version bump) — stamp
		// idempotently so we have an audit timestamp.
		if err := s.repo.MarkPrivacyAccepted(ctx, user.ID); err != nil {
			log.Warn().Err(err).Str("user_id", user.ID).Msg("failed to persist privacy acceptance")
		} else {
			user.HasAcceptedPrivacyPolicy = true
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

// VerifyFirebaseToken validates a Firebase ID token, upserts the user, and
// returns a JWT. hasAcceptedPrivacyPolicy follows the same semantics as
// VerifyOTP: required for first-time sign-ups, idempotent for returning users.
func (s *Service) VerifyFirebaseToken(ctx context.Context, idToken string, hasAcceptedPrivacyPolicy bool) (*LoginResponse, error) {
	phone, err := VerifyFirebaseToken(ctx, idToken)
	if err != nil {
		return nil, err
	}

	log.Info().Str("phone_mask", logger.MaskPhone(phone)).Msg("[auth] Firebase token phone extracted")
	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(phone)).Msg("[auth] GetUserByPhone failed")
		return nil, fmt.Errorf("failed to look up user: %w", err)
	}
	if user == nil {
		log.Info().Str("phone_mask", logger.MaskPhone(phone)).Msg("[auth] User not found, creating new customer")
		user, err = s.repo.CreateUser(ctx, phone, "customer", hasAcceptedPrivacyPolicy)
		if err != nil {
			log.Error().Err(err).Str("phone_mask", logger.MaskPhone(phone)).Msg("[auth] CreateUser failed")
			return nil, fmt.Errorf("failed to create user: %w", err)
		}
	} else {
		log.Info().Str("user_id", user.ID).Str("role", user.Role).Msg("[auth] User found")
		if hasAcceptedPrivacyPolicy && !user.HasAcceptedPrivacyPolicy {
			if err := s.repo.MarkPrivacyAccepted(ctx, user.ID); err != nil {
				log.Warn().Err(err).Str("user_id", user.ID).Msg("failed to persist privacy acceptance")
			} else {
				user.HasAcceptedPrivacyPolicy = true
			}
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
	user, err := s.repo.UpdateProfile(ctx, userID, req)
	if err != nil {
		return nil, err
	}
	if s.codeGen != nil && req.Name != "" {
		name := req.Name
		if _, cgErr := s.codeGen.GenerateAndSetCode(ctx, userID, name, user.Phone); cgErr != nil {
			log.Warn().Err(cgErr).Str("user_id", userID).Msg("auth: referral code generation failed (non-fatal)")
		}
	}
	return user, nil
}

// OnboardPro records a helper application in 'pending' status. SECURITY: it
// does NOT change users.role and does NOT issue a new JWT — privilege upgrade
// to 'pro' happens only after admin approval flips approval_status='approved'.
// Returns the user record (unchanged role) and a status flag so the client can
// show a "pending approval" screen.
func (s *Service) OnboardPro(ctx context.Context, userID string, req OnboardProRequest) (*OnboardProResponse, error) {
	user, err := s.repo.OnboardPro(ctx, userID, req)
	if err != nil {
		return nil, fmt.Errorf("failed to onboard pro in DB: %w", err)
	}

	return &OnboardProResponse{
		User:           *user,
		ApprovalStatus: "pending",
		Message:        "Application submitted. An admin will review and approve your profile.",
	}, nil
}

// UpdateFCMToken updates the user's FCM push token
func (s *Service) UpdateFCMToken(ctx context.Context, userID, token string) error {
	return s.repo.UpdateFCMToken(ctx, userID, token)
}

// RegisterDevice persists a device-scoped FCM token. role must be the value
// from the auth middleware ("customer" or "pro"); the repository routes the
// row to user_id vs worker_id accordingly.
func (s *Service) RegisterDevice(ctx context.Context, accountID, role, fcmToken, platform, deviceID string) error {
	return s.repo.RegisterDevice(ctx, accountID, role, fcmToken, platform, deviceID)
}

// DeleteAccount soft-deletes the user account. Surfaced as DELETE /me from
// the client to satisfy App Store Guideline 5.1.1(v). Reason is optional and
// comes straight from the user-provided form; the caller should cap its size.
//
// Registered post-delete hooks are fired best-effort after the soft-delete
// succeeds — used by sibling packages (e.g. zop) to wipe user-scoped state.
func (s *Service) DeleteAccount(ctx context.Context, userID, reason string) error {
	if err := s.repo.SoftDeleteUser(ctx, userID, reason); err != nil {
		return err
	}
	for _, hook := range s.postDeleteHooks {
		hook(ctx, userID)
	}
	return nil
}

// RegisterPostDeleteHook registers a callback to fire after successful
// account deletion. Used to break import cycles — sibling packages register
// their cleanup function at wiring time without auth importing them.
func (s *Service) RegisterPostDeleteHook(hook func(ctx context.Context, userID string)) {
	s.postDeleteHooks = append(s.postDeleteHooks, hook)
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
