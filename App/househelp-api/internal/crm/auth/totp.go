package auth

import (
	"fmt"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// GenerateTOTPSecret creates a fresh TOTP key for a new admin enrolment.
// Returns the otpauth:// URL (rendered as a QR code in the UI) and the
// raw secret (persisted to crm_admins.totp_secret).
func GenerateTOTPSecret(issuer, accountName string) (otpauthURL, secret string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: accountName,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1, // matches Google Authenticator default
	})
	if err != nil {
		return "", "", fmt.Errorf("generate totp: %w", err)
	}
	return key.URL(), key.Secret(), nil
}

// VerifyTOTP validates a 6-digit code against the stored secret. Allows ±1
// period of clock skew (default behaviour of totp.Validate).
func VerifyTOTP(code, secret string) bool {
	if code == "" || secret == "" {
		return false
	}
	return totp.Validate(code, secret)
}
