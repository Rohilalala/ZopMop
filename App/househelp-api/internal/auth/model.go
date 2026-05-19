package auth

import (
	"errors"
	"time"
)

// ErrUserNotFound is returned when a user ID does not exist in the database.
var ErrUserNotFound = errors.New("user not found")

// ErrActiveBooking is returned when a soft-delete is attempted while the
// helper still holds a booking in pending, accepted, or in_progress state.
var ErrActiveBooking = errors.New("user has active bookings")

// User represents a registered user in the system.
type User struct {
	ID                       string    `json:"id"`
	Phone                    string    `json:"phone"`
	Name                     *string   `json:"name,omitempty"`
	Role                     string    `json:"role"`
	IsSuspended              bool      `json:"-"` // Never expose in JSON responses.
	HasAcceptedPrivacyPolicy bool      `json:"has_accepted_privacy_policy"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

// OTPRequest is the input for sending an OTP.
type OTPRequest struct {
	Phone string `json:"phone" validate:"required,phone"`
}

// OTPVerifyRequest is the input for verifying an OTP. HasAcceptedPrivacyPolicy
// is required for first-time sign-ups; returning users may omit it (the
// existing acceptance flag on the user row is preserved).
type OTPVerifyRequest struct {
	Phone                    string `json:"phone" validate:"required,phone"`
	Code                     string `json:"otp" validate:"required,min=4,max=8"`
	HasAcceptedPrivacyPolicy bool   `json:"has_accepted_privacy_policy"`
}

// LoginResponse is returned after successful OTP verification. The
// MSG91 flow returns access_token + refresh_token + a UserView whose
// `type` field is the JWT typ ("customer" | "pro"). The legacy
// `token` field is retained for backwards-compatibility with older
// clients during the cut-over — populated with the same value as
// access_token. is_new_user signals whether the verify_otp call
// produced a freshly-created customer row.
type LoginResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token,omitempty"`
	Token        string   `json:"token"` // legacy mirror of access_token
	User         UserView `json:"user"`
	IsNewUser    bool     `json:"is_new_user"`
}

// UserView is the post-MSG91 user payload returned by /verify-otp,
// /refresh and /me. `type` is the JWT typ claim — clients use it to
// pick the customer vs pro nav stack. `role` mirrors users.role for
// back-compat with the legacy app, which still gates nav on
// user.role === 'pro' | 'helper'. Once all clients move to `type`
// we can drop `role` from the public payload.
type UserView struct {
	ID                       string  `json:"id"`
	Phone                    string  `json:"phone"`
	Name                     *string `json:"name,omitempty"`
	Type                     string  `json:"type"`
	Role                     string  `json:"role"`
	HasAcceptedPrivacyPolicy bool    `json:"has_accepted_privacy_policy"`
}

// ToView returns the public projection of a user row with `type`
// derived from `role` per UserTypeFromRole. Phone is stripped down
// to its 10-digit Indian-mobile form on the way out — the DB keeps
// the canonical E.164 (+91XXXXXXXXXX) but the app surface only
// renders the 10 digits a user typed in.
func (u *User) ToView() UserView {
	return UserView{
		ID:                       u.ID,
		Phone:                    phoneTo10Digits(u.Phone),
		Name:                     u.Name,
		Type:                     UserTypeFromRole(u.Role),
		Role:                     u.Role,
		HasAcceptedPrivacyPolicy: u.HasAcceptedPrivacyPolicy,
	}
}

// phoneTo10Digits strips a stored E.164 phone down to the 10-digit
// mobile form. Accepts "+91XXXXXXXXXX", "91XXXXXXXXXX", or already
// 10-digit input and returns the trailing 10 digits. Returns the
// input unchanged if it doesn't look like an Indian mobile.
func phoneTo10Digits(stored string) string {
	digits := make([]byte, 0, len(stored))
	for i := 0; i < len(stored); i++ {
		if stored[i] >= '0' && stored[i] <= '9' {
			digits = append(digits, stored[i])
		}
	}
	if len(digits) >= 10 {
		return string(digits[len(digits)-10:])
	}
	return stored
}

// RefreshRequest is the body for POST /auth/refresh. The plaintext
// refresh token is sent in the JSON body so it stays out of URL logs
// and HTTP referer headers.
type RefreshRequest struct {
	RefreshToken string `json:"refresh_token" validate:"required"`
}

// LogoutRequest is the body for POST /auth/logout. Same rationale as
// RefreshRequest — keep the token off the URL.
type LogoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// OTPSendResponse is returned by POST /auth/send-otp. IsNewUser is the signal
// the client uses to decide whether to render the privacy-policy checkbox on
// the OTP screen — true when no users.row currently exists for the phone, so
// verify-otp would create a fresh account.
type OTPSendResponse struct {
	Message   string `json:"message"`
	IsNewUser bool   `json:"is_new_user"`
	OTP       string `json:"otp,omitempty"`
	Note      string `json:"note,omitempty"`
}

// JWTClaims represents the custom claims embedded in the JWT token.
type JWTClaims struct {
	UserID      string `json:"user_id"`
	Role        string `json:"role"`
	IsSuspended bool   `json:"is_suspended"`
}

// UpdateProfileRequest is the input for PUT /me — only name is collected.
type UpdateProfileRequest struct {
	Name string `json:"name" validate:"omitempty,max=100"`
}

// OnboardProResponse is returned by POST /me/onboard-pro. The role on User is
// intentionally unchanged — admin approval is required before the user becomes
// a pro. Clients should render a "pending approval" screen when ApprovalStatus
// is "pending".
type OnboardProResponse struct {
	User           User   `json:"user"`
	ApprovalStatus string `json:"approval_status"`
	Message        string `json:"message"`
}

// OnboardProRequest is the input for POST /me/onboard-pro.
type OnboardProRequest struct {
	Lat          float64  `json:"lat"          validate:"required,min=-90,max=90"`
	Lng          float64  `json:"lng"          validate:"required,min=-180,max=180"`
	Services     []string `json:"services"`
	Availability []string `json:"availability"`
	Address      string   `json:"address"      validate:"max=500"`
}

// UpdateFCMTokenRequest is the input for PUT /me/fcm-token
type UpdateFCMTokenRequest struct {
	Token string `json:"fcm_token" validate:"required"`
}

// RegisterDeviceRequest is the input for POST /devices/register. The trio
// (fcm_token, platform, device_id) gets upserted into device_tokens so the
// same account can receive push on multiple physical devices.
type RegisterDeviceRequest struct {
	FCMToken string `json:"fcm_token" validate:"required"`
	Platform string `json:"platform"  validate:"required,oneof=ios android web"`
	DeviceID string `json:"device_id" validate:"required"`
}

// DeleteAccountRequest is the input for DELETE /me. The reason field is
// optional free-text collected by the client-side delete confirmation sheet
// for product analytics; it is stored once and never surfaced back.
type DeleteAccountRequest struct {
	Reason string `json:"reason" validate:"omitempty,max=200"`
}
