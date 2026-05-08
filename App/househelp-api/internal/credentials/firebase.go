// Package credentials centralises Firebase credential loading for the
// auth and notification services. Supports two formats from the same
// FIREBASE_CREDENTIALS_JSON env var:
//   - File path: existing local-dev pattern (./secrets/key.json)
//   - Raw JSON:  the entire JSON blob as the env var value, used by
//     cloud platforms (Railway, Fly, K8s secrets) that can't mount a
//     credentials file. Detected by "{" as the first non-whitespace
//     char.
package credentials

import (
	"strings"

	"google.golang.org/api/option"
)

// FirebaseOption returns the appropriate option.ClientOption for the
// supplied env value. Empty input returns nil so callers can fall back
// to Application Default Credentials.
func FirebaseOption(envValue string) option.ClientOption {
	if envValue == "" {
		return nil
	}
	if strings.HasPrefix(strings.TrimSpace(envValue), "{") {
		return option.WithCredentialsJSON([]byte(envValue))
	}
	return option.WithCredentialsFile(envValue)
}
