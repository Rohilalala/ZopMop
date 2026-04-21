package auth

import (
	"errors"
	"time"
)

// ErrUserNotFound is returned when a user ID does not exist in the database.
var ErrUserNotFound = errors.New("user not found")

// User represents a registered user in the system.
type User struct {
	ID          string    `json:"id"`
	Phone       string    `json:"phone"`
	Name        *string   `json:"name,omitempty"`
	Role        string    `json:"role"`
	IsSuspended bool      `json:"-"` // Never expose in JSON responses.
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// OTPRequest is the input for sending an OTP.
type OTPRequest struct {
	Phone string `json:"phone" validate:"required,phone"`
}

// OTPVerifyRequest is the input for verifying an OTP.
type OTPVerifyRequest struct {
	Phone string `json:"phone" validate:"required,phone"`
	Code  string `json:"otp" validate:"required,len=6"`
}

// LoginResponse is returned after successful OTP verification.
type LoginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

// FirebaseAuthRequest is the input for Firebase token exchange.
type FirebaseAuthRequest struct {
	FirebaseToken string `json:"firebase_token"`
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

// DeleteAccountRequest is the input for DELETE /me. The reason field is
// optional free-text collected by the client-side delete confirmation sheet
// for product analytics; it is stored once and never surfaced back.
type DeleteAccountRequest struct {
	Reason string `json:"reason" validate:"omitempty,max=200"`
}
