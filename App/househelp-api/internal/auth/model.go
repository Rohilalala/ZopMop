package auth

import "time"

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

// JWTClaims represents the custom claims embedded in the JWT token.
type JWTClaims struct {
	UserID      string `json:"user_id"`
	Role        string `json:"role"`
	IsSuspended bool   `json:"is_suspended"`
}
