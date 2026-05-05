package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/bcrypt"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
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

// defaultRefreshGraceWindow absorbs genuine network-flake retries where the
// same refresh request lands twice within a few seconds. Outside this
// window, a second presentation of an already-rotated hash is treated as
// replay and kills the family.
const defaultRefreshGraceWindow = 5 * time.Second

// Config holds runtime knobs the service needs.
type Config struct {
	JWTSecret           string
	JWTSecretID         string
	AccessTokenTTL      time.Duration
	RefreshTokenTTL     time.Duration
	TOTPIssuer          string
	LockoutThreshold    int
	LockoutDuration     time.Duration
	RefreshGraceWindow  time.Duration
}

// Service implements the auth flow.
type Service struct {
	repo     *Repository
	cfg      Config
	recorder *audit.Recorder
}

// NewService constructs the auth Service.
func NewService(repo *Repository, cfg Config) *Service {
	if cfg.RefreshGraceWindow <= 0 {
		cfg.RefreshGraceWindow = defaultRefreshGraceWindow
	}
	return &Service{repo: repo, cfg: cfg}
}

// SetRecorder wires the audit recorder so replay-detection events can be
// written. Optional — the Service degrades gracefully (logs only) if no
// recorder is attached.
func (s *Service) SetRecorder(r *audit.Recorder) { s.recorder = r }

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

// Refresh validates a refresh-token plaintext and rotates it. Implements
// RFC 6819 §5.2.2 replay detection: if the presented hash matches a row
// whose rotated_at is set (i.e. someone already rotated this token),
// the entire session family is revoked and an audit row is written —
// unless we're inside cfg.RefreshGraceWindow, in which case we treat it
// as a benign retry of a network-flake.
//
// userAgent / ip / requestID are propagated from the HTTP layer so the
// replay-detection audit row carries the same forensic fields as other
// CRM audit entries (admin_id, IP, UA, request_id).
func (s *Service) Refresh(ctx context.Context, plaintext, userAgent, ip, requestID string) (*RefreshResult, error) {
	hash := HashRefreshToken(plaintext)

	// Lookup includes rotated/revoked rows so we can detect replay.
	sess, err := s.repo.GetSessionByHashIncludingRotated(ctx, hash)
	if err != nil {
		return nil, ErrSessionExpired
	}

	// Already revoked (logout, prior replay-kill, or expired-cleanup) —
	// always reject. No new audit row; this is a reuse of a dead token.
	if sess.RevokedAt != nil {
		return nil, ErrSessionExpired
	}

	if sess.RotatedAt != nil {
		// Hash was rotated. Either:
		//   - Inside grace window  → benign retry (same client retried; new
		//     successor cookie was just sent). Fail soft, no family kill.
		//   - Outside grace window → replay attempt (RFC 6819 §5.2.2).
		//     Revoke the entire family and audit-log the event.
		if time.Since(*sess.RotatedAt) < s.cfg.RefreshGraceWindow {
			return nil, ErrSessionExpired
		}
		s.handleReplay(ctx, sess, userAgent, ip, requestID)
		return nil, ErrSessionExpired
	}

	if sess.ExpiresAt.Before(time.Now()) {
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
	newSessionID := uuid.NewString()
	newExp := time.Now().Add(s.cfg.RefreshTokenTTL)

	var uaPtr, ipPtr *string
	if userAgent != "" {
		uaPtr = &userAgent
	}
	if ip != "" {
		ipPtr = &ip
	}

	if err := s.repo.Rotate(ctx, sess.ID, newSessionID, newHash, newExp, uaPtr, ipPtr); err != nil {
		// CAS lost to a concurrent rotator. The winner is legitimate too
		// (someone else just rotated this same active-leg row). Fail soft —
		// neither caller should think they're the survivor. Client retries
		// with the new cookie when the winner's response lands; if both
		// callers were the same client (true network flake), the second
		// response was the loser anyway.
		if errors.Is(err, ErrSessionAlreadyRotated) {
			return nil, ErrSessionExpired
		}
		return nil, err
	}

	access, accessExp, err := IssueAccessToken(
		s.cfg.JWTSecret, s.cfg.JWTSecretID,
		admin.ID, admin.Email, admin.Role, newSessionID, s.cfg.AccessTokenTTL,
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
		SessionID:             newSessionID,
	}, nil
}

// handleReplay is invoked when a refresh request presents a hash whose
// row is already rotated (and outside the grace window). Revokes the
// family and writes an audit row. Errors are logged, never returned —
// the caller already knows it's returning ErrSessionExpired regardless.
func (s *Service) handleReplay(ctx context.Context, sess *Session, userAgent, ip, requestID string) {
	if err := s.repo.RevokeFamily(ctx, sess.FamilyID); err != nil {
		log.Error().
			Err(err).
			Str("family_id", sess.FamilyID).
			Str("admin_id", sess.AdminID).
			Msg("[crm.auth] failed to revoke family on replay detection")
	}
	if s.recorder == nil {
		log.Warn().
			Str("family_id", sess.FamilyID).
			Str("admin_id", sess.AdminID).
			Msg("[crm.auth] session replay detected (no audit recorder wired)")
		return
	}
	adminEmail := ""
	if a, err := s.repo.GetAdminByID(ctx, sess.AdminID); err == nil && a != nil {
		adminEmail = a.Email
	}
	s.recorder.Log(ctx, audit.Entry{
		AdminID:    sess.AdminID,
		AdminEmail: adminEmail,
		Action:     "auth.session_replay_detected",
		Module:     "auth",
		TargetType: "session_family",
		TargetID:   sess.FamilyID,
		IPAddress:  ip,
		UserAgent:  userAgent,
		RequestID:  requestID,
		Before: map[string]any{
			"session_id": sess.ID,
			"rotated_at": sess.RotatedAt,
			"rotated_to": sess.RotatedTo,
		},
		After: map[string]any{
			"family_revoked":     true,
			"replay_detected_at": time.Now().UTC(),
		},
	})
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
