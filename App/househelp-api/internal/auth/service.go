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

// otpVendor is the OTP gateway contract the service depends on. Implemented
// by *MessageCentralClient (cmd/api wires the concrete type). SendOTP/
// VerifyOTP/DevMode are called by the service today; RetryOTP is part of the
// vendor contract for a future resend route and is intentionally included.
// Do not widen beyond these four.
type otpVendor interface {
	SendOTP(ctx context.Context, phone string) (verificationID string, err error)
	VerifyOTP(ctx context.Context, verificationID, code string) error
	RetryOTP(ctx context.Context, verificationID string) error
	DevMode() bool
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

	// Post-Firebase Message Central OTP wiring. All four MAY be nil
	// during the migration cut-over; the new OTP send/verify paths
	// return an error if any is missing, while the legacy Redis-OTP
	// and Firebase paths keep working without them.
	otp     otpVendor
	tokens  *TokenIssuer
	refresh *RefreshRepo
	rate    *OTPRateLimiter
}

// SetOTPVendor wires the OTP gateway. Required for the SendLoginOTP /
// VerifyLoginOTP paths.
func (s *Service) SetOTPVendor(v otpVendor) { s.otp = v }

// SetTokenIssuer wires the access + refresh token issuer.
func (s *Service) SetTokenIssuer(t *TokenIssuer) { s.tokens = t }

// SetRefreshRepo wires the refresh_tokens repository.
func (s *Service) SetRefreshRepo(r *RefreshRepo) { s.refresh = r }

// SetOTPRateLimiter wires the new sliding-window limiter.
func (s *Service) SetOTPRateLimiter(r *OTPRateLimiter) { s.rate = r }

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

// AccessTTL returns the post-MSG91 access-token lifetime. Falls
// back to JWTExpiry for older binaries that haven't wired the
// TokenIssuer yet.
func (s *Service) AccessTTL() time.Duration {
	if s.tokens != nil {
		return s.tokens.AccessTTL()
	}
	return s.jwtExpiry
}

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

	return &LoginResponse{Token: token, AccessToken: token, User: user.ToView()}, nil
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

// ----------------------------------------------------------------------------
// Message Central + access/refresh JWT flow (replaces Firebase Phone Auth).
// ----------------------------------------------------------------------------

// ErrPhoneNotRegistered is returned when the caller hits the
// pro-side send-otp path with a phone that does not yet exist as a
// pro. Customers auto-register on first verify; pros do not.
var ErrPhoneNotRegistered = errors.New("phone not registered as pro")

// SendLoginOTP triggers an OTP via the OTP vendor for the given phone.
// Returns (devOTP, isNewUser, error). devOTP is the hardcoded
// "999999" sentinel in dev mode (so a tester can complete the flow
// without SMS) and empty in production. isNewUser tells the client
// whether to render the privacy-policy checkbox.
//
// Behaviour:
//   - Rate-limited: 3 sends per 15min per phone, 5 per 15min per IP.
//     Limits trip BEFORE the vendor call so we don't spend SMS credit.
//   - Looks up users by phone. If found AND role='pro' AND
//     is_suspended → return ErrAccountSuspended (caller maps 403).
//   - Otherwise hand off to the OTP vendor (or dev-mode short-circuit).
func (s *Service) SendLoginOTP(ctx context.Context, phone, ip string) (devOTP string, isNewUser bool, err error) {
	if s.otp == nil || s.rate == nil {
		return "", false, errors.New("otp path not wired")
	}

	if rlErr := s.rate.CheckSend(ctx, phone, ip); rlErr != nil {
		return "", false, rlErr
	}

	existing, lookupErr := s.repo.GetUserByPhone(ctx, phone)
	if lookupErr != nil {
		log.Warn().Err(lookupErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("send-otp user lookup failed")
	}
	isNewUser = existing == nil
	if existing != nil && existing.Role == "pro" && existing.IsSuspended {
		return "", false, &ErrAccountSuspended{}
	}

	vid, sendErr := s.otp.SendOTP(ctx, phone)
	if sendErr != nil {
		log.Error().Err(sendErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("OTP send failed")
		return "", false, sendErr
	}

	// Message Central is stateful: VerifyOTP needs this verificationId.
	// A fresh send intentionally overwrites any prior id — only the most
	// recent OTP is verifiable (mirrors MSG91; documented in the spec).
	vidKey := fmt.Sprintf("otp:vid:%s", phone)
	if err := s.rdb.Set(ctx, vidKey, vid, otpExpiry).Err(); err != nil {
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(phone)).
			Msg("OTP dispatched but failed to store verification id — user cannot verify")
		return "", false, fmt.Errorf("store verification id: %w", err)
	}

	log.Info().Str("phone_mask", logger.MaskPhone(phone)).Bool("is_new_user", isNewUser).Msg("OTP dispatched")

	if s.otp.DevMode() {
		return devModeOTPVal, isNewUser, nil
	}
	return "", isNewUser, nil
}

// VerifyLoginOTP verifies the user-supplied OTP with the OTP vendor,
// upserts a customer row when no users row exists, mints access +
// refresh tokens, and persists the refresh-token hash. Returns the
// full LoginResponse with both tokens + the UserView.
func (s *Service) VerifyLoginOTP(ctx context.Context, phone, code string, hasAcceptedPrivacyPolicy bool) (*LoginResponse, error) {
	if s.otp == nil || s.tokens == nil || s.refresh == nil || s.rate == nil {
		return nil, errors.New("otp path not wired")
	}

	if rlErr := s.rate.CheckVerify(ctx, phone); rlErr != nil {
		return nil, rlErr
	}

	vidKey := fmt.Sprintf("otp:vid:%s", phone)
	vid, gerr := s.rdb.Get(ctx, vidKey).Result()
	if gerr == redis.Nil {
		// Preserve the current mobile contract: an expired/missing OTP
		// today returns 401 INVALID_OTP (the MSG91 path never surfaced
		// OTP_EXPIRED). OTP_EXPIRED improvement is in the phase-12 backlog.
		return nil, ErrInvalidOTP
	}
	if gerr != nil {
		return nil, fmt.Errorf("load verification id: %w", gerr)
	}

	if verr := s.otp.VerifyOTP(ctx, vid, code); verr != nil {
		if errors.Is(verr, ErrOTPInvalid) {
			return nil, ErrInvalidOTP
		}
		log.Error().Err(verr).Str("phone_mask", logger.MaskPhone(phone)).Msg("OTP verify failed")
		return nil, verr
	}

	// One-time use: drop the id on success so a replayed code can't re-verify.
	if delErr := s.rdb.Del(ctx, vidKey).Err(); delErr != nil {
		log.Warn().Err(delErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("failed to delete used verification id")
	}

	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		return nil, fmt.Errorf("look up user: %w", err)
	}
	isNewUser := user == nil
	if isNewUser {
		// Pros are admin-registered only — first verify always lands
		// the caller in the customers bucket (role='customer').
		user, err = s.repo.CreateUser(ctx, phone, "customer", hasAcceptedPrivacyPolicy)
		if err != nil {
			return nil, fmt.Errorf("create user: %w", err)
		}
	} else if hasAcceptedPrivacyPolicy && !user.HasAcceptedPrivacyPolicy {
		if mperr := s.repo.MarkPrivacyAccepted(ctx, user.ID); mperr != nil {
			log.Warn().Err(mperr).Str("user_id", user.ID).Msg("failed to persist privacy acceptance")
		} else {
			user.HasAcceptedPrivacyPolicy = true
		}
	}
	if user.IsSuspended {
		return nil, &ErrAccountSuspended{}
	}

	if mperr := s.repo.MarkPhoneVerified(ctx, user.ID); mperr != nil {
		log.Warn().Err(mperr).Str("user_id", user.ID).Msg("failed to stamp phone_verified_at")
	}

	// Reset the verify-attempts counter so the next session starts
	// fresh.
	s.rate.ResetVerify(ctx, phone)

	access, refreshPlaintext, err := s.issueTokenPair(ctx, user)
	if err != nil {
		return nil, err
	}

	return &LoginResponse{
		AccessToken:  access,
		RefreshToken: refreshPlaintext,
		Token:        access, // legacy mirror
		User:         user.ToView(),
		IsNewUser:    isNewUser,
	}, nil
}

// Refresh validates a refresh-token plaintext, rotates it (revokes
// the old row + inserts a new one), and mints a fresh access + new
// refresh pair. Returns ErrRefreshTokenInvalid for any failure that
// could leak whether a particular hash exists.
func (s *Service) Refresh(ctx context.Context, plaintext string) (*LoginResponse, error) {
	if s.tokens == nil || s.refresh == nil {
		return nil, errors.New("refresh path not wired")
	}
	hash := HashRefreshToken(plaintext)
	row, err := s.refresh.FindActive(ctx, hash)
	if err != nil {
		return nil, err
	}

	user, err := s.repo.GetUserByID(ctx, row.UserID)
	if err != nil {
		return nil, fmt.Errorf("load user for refresh: %w", err)
	}
	if user == nil || user.IsSuspended {
		// Belt-and-braces: middleware also runs IsSuspended on every
		// call, but a stale row could be rotated through here. Treat
		// suspension as invalidation of the entire session set.
		_ = s.refresh.RevokeAllForUser(ctx, row.UserID)
		return nil, ErrRefreshTokenInvalid
	}

	// Rotate: revoke the just-used row, then issue the new pair.
	if rerr := s.refresh.RevokeByID(ctx, row.ID); rerr != nil {
		return nil, rerr
	}

	access, newPlaintext, err := s.issueTokenPair(ctx, user)
	if err != nil {
		return nil, err
	}

	return &LoginResponse{
		AccessToken:  access,
		RefreshToken: newPlaintext,
		Token:        access,
		User:         user.ToView(),
	}, nil
}

// RevokeRefresh marks the supplied refresh token as revoked. Safe
// to call with an unknown/expired/already-revoked token — the
// UPDATE matches zero rows in that case. Used by POST /auth/logout.
func (s *Service) RevokeRefresh(ctx context.Context, plaintext string) error {
	if s.refresh == nil {
		return errors.New("refresh path not wired")
	}
	if plaintext == "" {
		return nil
	}
	return s.refresh.Revoke(ctx, HashRefreshToken(plaintext))
}

// issueTokenPair generates a fresh access + refresh token and
// persists the refresh hash. The plaintext refresh token is
// returned alongside the access JWT.
func (s *Service) issueTokenPair(ctx context.Context, user *User) (access, refreshPlaintext string, err error) {
	access, err = s.tokens.IssueAccessToken(user.ID, user.Role, user.Phone, user.IsSuspended)
	if err != nil {
		return "", "", err
	}
	plaintext, hash, expiresAt, err := s.tokens.IssueRefreshToken()
	if err != nil {
		return "", "", err
	}
	if rerr := s.refresh.Insert(ctx, user.ID, UserTypeFromRole(user.Role), hash, expiresAt); rerr != nil {
		return "", "", rerr
	}
	return access, plaintext, nil
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
