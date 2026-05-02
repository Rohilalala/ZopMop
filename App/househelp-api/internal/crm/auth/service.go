package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// Sentinel errors returned by Service. Handlers map these to HTTP responses.
var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrAccountLocked      = errors.New("account locked")
	ErrInactive           = errors.New("account inactive")
	ErrInvalidChallenge   = errors.New("invalid challenge")
	ErrInvalidTOTP        = errors.New("invalid totp")
	ErrSessionExpired     = errors.New("session expired")
)

// Config holds runtime knobs the service needs.
type Config struct {
	JWTSecret        string
	JWTSecretID      string
	AccessTokenTTL   time.Duration
	RefreshTokenTTL  time.Duration
	TOTPIssuer       string
	LockoutThreshold int
	LockoutDuration  time.Duration
}

// Service implements the auth flow.
type Service struct {
	repo *Repository
	cfg  Config
}

// NewService constructs the auth Service.
func NewService(repo *Repository, cfg Config) *Service {
	return &Service{repo: repo, cfg: cfg}
}

// LoginResult is what handler returns after step 1 (password).
type LoginResult struct {
	ChallengeToken string
	TOTPEnrolled   bool
	OTPAuthURL     string // populated only when TOTP not yet enrolled
}

// Login validates email + password. On success, returns a 5-min challenge
// token and a flag indicating whether TOTP is already enrolled. If not, a
// fresh TOTP secret is generated and persisted, and otpauth_url is returned
// so the UI can render the QR code for first-time enrolment.
func (s *Service) Login(ctx context.Context, req LoginRequest, ip string) (*LoginResult, error) {
	admin, err := s.repo.GetAdminByEmail(ctx, req.Email)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			s.repo.RecordLoginAttempt(ctx, req.Email, ip, "no_such_admin", false)
			return nil, ErrInvalidCredentials
		}
		return nil, err
	}

	if !admin.IsActive {
		s.repo.RecordLoginAttempt(ctx, req.Email, ip, "inactive", false)
		return nil, ErrInactive
	}
	if admin.LockedUntil != nil && admin.LockedUntil.After(time.Now()) {
		s.repo.RecordLoginAttempt(ctx, req.Email, ip, "locked", false)
		return nil, ErrAccountLocked
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.Password)); err != nil {
		_, _ = s.repo.IncrementFailedLogin(ctx, admin.ID, s.cfg.LockoutThreshold, s.cfg.LockoutDuration)
		s.repo.RecordLoginAttempt(ctx, req.Email, ip, "bad_password", false)
		return nil, ErrInvalidCredentials
	}

	out := &LoginResult{TOTPEnrolled: admin.TOTPSecret != nil && *admin.TOTPSecret != ""}

	// First-login path: generate enrolment secret. We persist it now so the
	// next call's verification works; if the admin abandons the flow the
	// secret stays attached to their account but is still secret.
	if !out.TOTPEnrolled {
		otpauthURL, secret, err := GenerateTOTPSecret(s.cfg.TOTPIssuer, admin.Email)
		if err != nil {
			return nil, err
		}
		if err := s.repo.SetTOTPSecret(ctx, admin.ID, secret); err != nil {
			return nil, err
		}
		out.OTPAuthURL = otpauthURL
	}

	tok, err := IssueChallengeToken(s.cfg.JWTSecret, s.cfg.JWTSecretID, admin.ID)
	if err != nil {
		return nil, err
	}
	out.ChallengeToken = tok
	s.repo.RecordLoginAttempt(ctx, req.Email, ip, "password_ok_pending_totp", true)
	return out, nil
}

// VerifyTOTPResult bundles the issued tokens.
type VerifyTOTPResult struct {
	AccessToken           string
	AccessExpiresAt       time.Time
	RefreshTokenPlaintext string
	RefreshExpiresAt      time.Time
	Admin                 *Admin
	SessionID             string
}

// VerifyTOTPAndIssue validates challenge + code, creates a session row, and
// returns the access JWT + refresh-token plaintext.
func (s *Service) VerifyTOTPAndIssue(ctx context.Context, req TOTPVerifyRequest, userAgent, ip string) (*VerifyTOTPResult, error) {
	cc, err := ParseChallengeToken(req.ChallengeToken, s.cfg.JWTSecret)
	if err != nil {
		return nil, ErrInvalidChallenge
	}

	admin, err := s.repo.GetAdminByID(ctx, cc.AdminID)
	if err != nil {
		return nil, ErrInvalidChallenge
	}
	if !admin.IsActive {
		return nil, ErrInactive
	}
	if admin.TOTPSecret == nil || *admin.TOTPSecret == "" {
		return nil, ErrInvalidTOTP
	}

	if !VerifyTOTP(req.Code, *admin.TOTPSecret) {
		_, _ = s.repo.IncrementFailedLogin(ctx, admin.ID, s.cfg.LockoutThreshold, s.cfg.LockoutDuration)
		s.repo.RecordLoginAttempt(ctx, admin.Email, ip, "bad_totp", false)
		return nil, ErrInvalidTOTP
	}

	if err := s.repo.ResetFailedLogin(ctx, admin.ID); err != nil {
		return nil, err
	}

	plaintext, hash, err := GenerateRefreshToken()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	sess := &Session{
		ID:               uuid.NewString(),
		AdminID:          admin.ID,
		RefreshTokenHash: hash,
		IssuedAt:         now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(s.cfg.RefreshTokenTTL),
	}
	if userAgent != "" {
		sess.UserAgent = &userAgent
	}
	if ip != "" {
		sess.IPAddress = &ip
	}

	if err := s.repo.CreateSession(ctx, sess); err != nil {
		return nil, err
	}

	access, accessExp, err := IssueAccessToken(
		s.cfg.JWTSecret, s.cfg.JWTSecretID,
		admin.ID, admin.Email, admin.Role, sess.ID, s.cfg.AccessTokenTTL,
	)
	if err != nil {
		return nil, err
	}

	s.repo.RecordLoginAttempt(ctx, admin.Email, ip, "ok", true)
	return &VerifyTOTPResult{
		AccessToken:           access,
		AccessExpiresAt:       accessExp,
		RefreshTokenPlaintext: plaintext,
		RefreshExpiresAt:      sess.ExpiresAt,
		Admin:                 admin,
		SessionID:             sess.ID,
	}, nil
}

// Refresh rotates an existing session's refresh token and issues a new
// access token. Old refresh-token plaintext becomes invalid immediately
// (atomic UPDATE in repo).
type RefreshResult struct {
	AccessToken           string
	AccessExpiresAt       time.Time
	RefreshTokenPlaintext string
	RefreshExpiresAt      time.Time
	Admin                 *Admin
	SessionID             string
}

// Refresh validates a refresh-token plaintext and rotates it.
func (s *Service) Refresh(ctx context.Context, plaintext string) (*RefreshResult, error) {
	hash := HashRefreshToken(plaintext)
	sess, err := s.repo.GetSessionByHash(ctx, hash)
	if err != nil {
		return nil, ErrSessionExpired
	}

	admin, err := s.repo.GetAdminByID(ctx, sess.AdminID)
	if err != nil || !admin.IsActive {
		return nil, ErrSessionExpired
	}

	newPlaintext, newHash, err := GenerateRefreshToken()
	if err != nil {
		return nil, err
	}
	newExp := time.Now().Add(s.cfg.RefreshTokenTTL)
	if err := s.repo.RotateSession(ctx, sess.ID, newHash, newExp); err != nil {
		return nil, err
	}

	access, accessExp, err := IssueAccessToken(
		s.cfg.JWTSecret, s.cfg.JWTSecretID,
		admin.ID, admin.Email, admin.Role, sess.ID, s.cfg.AccessTokenTTL,
	)
	if err != nil {
		return nil, err
	}

	return &RefreshResult{
		AccessToken:           access,
		AccessExpiresAt:       accessExp,
		RefreshTokenPlaintext: newPlaintext,
		RefreshExpiresAt:      newExp,
		Admin:                 admin,
		SessionID:             sess.ID,
	}, nil
}

// Logout revokes the session bound to a given refresh-token plaintext.
func (s *Service) Logout(ctx context.Context, plaintext string) error {
	if plaintext == "" {
		return nil
	}
	hash := HashRefreshToken(plaintext)
	sess, err := s.repo.GetSessionByHash(ctx, hash)
	if err != nil {
		return nil // already gone, treat as success
	}
	return s.repo.RevokeSession(ctx, sess.ID)
}

// ListSessions returns active sessions for the given admin. The current
// session ID (from the access token) is marked is_current=true in the response.
func (s *Service) ListSessions(ctx context.Context, adminID, currentSessionID string) ([]PublicSession, error) {
	rows, err := s.repo.ListSessions(ctx, adminID)
	if err != nil {
		return nil, err
	}
	out := make([]PublicSession, 0, len(rows))
	for _, r := range rows {
		out = append(out, PublicSession{
			ID:         r.ID,
			UserAgent:  r.UserAgent,
			IPAddress:  r.IPAddress,
			IssuedAt:   r.IssuedAt,
			LastUsedAt: r.LastUsedAt,
			ExpiresAt:  r.ExpiresAt,
			IsCurrent:  r.ID == currentSessionID,
		})
	}
	return out, nil
}

// RevokeSession revokes a session by ID, but only if it belongs to the caller.
func (s *Service) RevokeSession(ctx context.Context, adminID, sessionID string) error {
	rows, err := s.repo.ListSessions(ctx, adminID)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.ID == sessionID {
			return s.repo.RevokeSession(ctx, sessionID)
		}
	}
	return fmt.Errorf("session not found")
}

// GetAdmin loads an admin by ID. Used by the JWT-validating middleware to
// confirm the account is still active and not locked.
func (s *Service) GetAdmin(ctx context.Context, id string) (*Admin, error) {
	return s.repo.GetAdminByID(ctx, id)
}
