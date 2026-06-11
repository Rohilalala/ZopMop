package auth

import (
	"fmt"
	"net/url"

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

// BuildTOTPURL reconstructs the otpauth:// URL for an already-persisted
// secret, so a pre-enrolment admin who re-attempts first login gets the same
// QR/secret they may have already scanned. Mirrors GenerateTOTPSecret's
// parameters (SHA1, 6 digits, 30s period).
func BuildTOTPURL(issuer, accountName, secret string) (string, error) {
	key, err := otp.NewKeyFromURL(fmt.Sprintf(
		"otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
		url.PathEscape(issuer), url.PathEscape(accountName),
		secret, url.QueryEscape(issuer),
	))
	if err != nil {
		return "", fmt.Errorf("build totp url: %w", err)
	}
	return key.URL(), nil
}

// VerifyTOTP validates a 6-digit code against the stored secret. Allows ±1
// period of clock skew (default behaviour of totp.Validate).
func VerifyTOTP(code, secret string) bool {
	if code == "" || secret == "" {
		return false
	}
	return totp.Validate(code, secret)
}
