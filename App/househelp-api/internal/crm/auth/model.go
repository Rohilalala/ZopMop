package auth

import (
	"encoding/json"
	"time"
)

// Admin is the row representation of crm_admins.
type Admin struct {
	ID               string          `json:"id"`
	Email            string          `json:"email"`
	PasswordHash     string          `json:"-"`
	DisplayName      string          `json:"display_name"`
	AvatarURL        *string         `json:"avatar_url,omitempty"`
	Role             string          `json:"role"`
	Permissions      json.RawMessage `json:"permissions"`
	TOTPSecret       *string         `json:"-"`
	TOTPEnrolledAt   *time.Time      `json:"totp_enrolled_at,omitempty"`
	FailedLoginCount int             `json:"-"`
	LockedUntil      *time.Time      `json:"-"`
	LastLoginAt      *time.Time      `json:"last_login_at,omitempty"`
	IsActive         bool            `json:"is_active"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// Session is the row representation of crm_admin_sessions.
//
// FamilyID groups every refresh-token row that originated from the same
// login: the session created at TOTP-verify time has FamilyID == ID, and
// every rotation inserts a new row that inherits that FamilyID. RotatedAt
// + RotatedTo mark the row as superseded once a successor exists; a
// non-nil RotatedAt observed at refresh time is what signals replay (see
// migration 072 + Service.Refresh). ReplayDetectedAt is set on every row
// in a family when the family is killed by replay detection — distinguishes
// "logged out" from "compromised + force-relogin".
type Session struct {
	ID                 string     `json:"id"`
	FamilyID           string     `json:"-"`
	AdminID            string     `json:"admin_id"`
	RefreshTokenHash   string     `json:"-"`
	UserAgent          *string    `json:"user_agent,omitempty"`
	IPAddress          *string    `json:"ip_address,omitempty"`
	IssuedAt           time.Time  `json:"issued_at"`
	LastUsedAt         time.Time  `json:"last_used_at"`
	ExpiresAt          time.Time  `json:"expires_at"`
	RevokedAt          *time.Time `json:"revoked_at,omitempty"`
	RotatedAt          *time.Time `json:"-"`
	RotatedTo          *string    `json:"-"`
	ReplayDetectedAt   *time.Time `json:"-"`
}

// PublicSession is the response shape for sessions list — never leaks token hashes.
type PublicSession struct {
	ID         string     `json:"id"`
	UserAgent  *string    `json:"user_agent,omitempty"`
	IPAddress  *string    `json:"ip_address,omitempty"`
	IssuedAt   time.Time  `json:"issued_at"`
	LastUsedAt time.Time  `json:"last_used_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	IsCurrent  bool       `json:"is_current"`
}

// LoginRequest is POST /admin/auth/login body.
type LoginRequest struct {
	Email    string `json:"email"    validate:"required,email"`
	Password string `json:"password" validate:"required,min=8,max=128"`
}

// LoginResponse signals next step. If TOTP is enrolled, the client must
// complete /totp/verify with the returned challenge_token before any access
// token is issued. If TOTP is not yet enrolled, the response carries the
// enrolment URI (otpauth://...) and the same challenge token; the next call
// must verify the freshly-set code.
type LoginResponse struct {
	ChallengeToken string `json:"challenge_token"`
	TOTPEnrolled   bool   `json:"totp_enrolled"`
	OTPAuthURL     string `json:"otpauth_url,omitempty"` // only when !TOTPEnrolled
}

// TOTPVerifyRequest is POST /admin/auth/totp/verify body.
type TOTPVerifyRequest struct {
	ChallengeToken string `json:"challenge_token" validate:"required"`
	Code           string `json:"code"            validate:"required,len=6,numeric"`
}

// AuthSuccessResponse is returned after successful TOTP verification.
type AuthSuccessResponse struct {
	AccessToken    string     `json:"access_token"`
	ExpiresAt      time.Time  `json:"expires_at"`
	Admin          PublicAdmin `json:"admin"`
}

// PublicAdmin is the safe-to-return shape of an admin user.
type PublicAdmin struct {
	ID          string          `json:"id"`
	Email       string          `json:"email"`
	DisplayName string          `json:"display_name"`
	AvatarURL   *string         `json:"avatar_url,omitempty"`
	Role        string          `json:"role"`
	Permissions json.RawMessage `json:"permissions"`
}

// ToPublic converts an Admin to its safe public shape.
func (a *Admin) ToPublic() PublicAdmin {
	return PublicAdmin{
		ID:          a.ID,
		Email:       a.Email,
		DisplayName: a.DisplayName,
		AvatarURL:   a.AvatarURL,
		Role:        a.Role,
		Permissions: a.Permissions,
	}
}
