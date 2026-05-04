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
	Code                     string `json:"otp" validate:"required,len=6"`
	HasAcceptedPrivacyPolicy bool   `json:"has_accepted_privacy_policy"`
}

// LoginResponse is returned after successful OTP verification.
type LoginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

// FirebaseAuthRequest is the input for Firebase token exchange.
// HasAcceptedPrivacyPolicy is required for first-time sign-ups; returning
// users may omit it.
type FirebaseAuthRequest struct {
	FirebaseToken            string `json:"firebase_token"`
	HasAcceptedPrivacyPolicy bool   `json:"has_accepted_privacy_policy"`
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
