package analytics

import (
	"fmt"
	"regexp"
	"strings"
)

var sensitiveKeys = map[string]struct{}{
	"token":          {},
	"authorization":  {},
	"password":       {},
	"jwt":            {},
	"firebase_token": {},
	"secret":         {},
	"api_key":        {},
	"access_token":   {},
	"refresh_token":  {},
	"session":        {},
	"ssn":            {},
	"aadhaar":        {},
	"pan":            {},
	"phone":          {},
	"email":          {},
	"otp":            {},
	"card":           {},
	"cvv":            {},
	"pin":            {},
}

// cardLikeRegex matches bare 12-19 digit runs that look like a card / Aadhaar
// number. Used by the sanitizer to redact such values regardless of key name.
var cardLikeRegex = regexp.MustCompile(`\b\d{12,19}\b`)

// redactCardLike replaces card-like numeric runs in a string with "[REDACTED]".
func redactCardLike(s string) string {
	return cardLikeRegex.ReplaceAllString(s, "[REDACTED]")
}

// redactCardLikeValue walks an arbitrary value and redacts any string that
// contains a card-like numeric run.
func redactCardLikeValue(v interface{}) interface{} {
	switch typed := v.(type) {
	case string:
		return redactCardLike(typed)
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for k, nested := range typed {
			out[k] = redactCardLikeValue(nested)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, nested := range typed {
			out[i] = redactCardLikeValue(nested)
		}
		return out
	default:
		// Numeric / bool / nil: stringify and check for cardlike length only on
		// integers to avoid mutating non-string scalars.
		if n, ok := v.(float64); ok {
			s := fmt.Sprintf("%.0f", n)
			if cardLikeRegex.MatchString(s) {
				return "[REDACTED]"
			}
		}
		return v
	}
}

func normalizeKey(key string) string {
	k := strings.ToLower(strings.TrimSpace(key))
	k = strings.ReplaceAll(k, "-", "_")
	return k
}

func isSensitiveKey(key string) bool {
	_, ok := sensitiveKeys[normalizeKey(key)]
	return ok
}

func containsSensitiveAny(v interface{}) bool {
	switch typed := v.(type) {
	case map[string]interface{}:
		for key, nested := range typed {
			if isSensitiveKey(key) || containsSensitiveAny(nested) {
				return true
			}
		}
	case []interface{}:
		for _, nested := range typed {
			if containsSensitiveAny(nested) {
				return true
			}
		}
	}
	return false
}

// ContainsSensitiveKeys returns true if payload contains any restricted keys.
func ContainsSensitiveKeys(data map[string]interface{}) bool {
	if len(data) == 0 {
		return false
	}
	return containsSensitiveAny(data)
}

// ContainsSensitiveStringKeys returns true if payload contains any restricted keys.
func ContainsSensitiveStringKeys(data map[string]string) bool {
	for key := range data {
		if isSensitiveKey(key) {
			return true
		}
	}
	return false
}

// StripSensitiveKeys removes restricted keys recursively from map payloads
// and redacts card-like numeric runs from any remaining string values.
func StripSensitiveKeys(data map[string]interface{}) map[string]interface{} {
	if len(data) == 0 {
		return map[string]interface{}{}
	}
	clean := make(map[string]interface{}, len(data))
	for key, value := range data {
		if isSensitiveKey(key) {
			continue
		}
		switch nested := value.(type) {
		case map[string]interface{}:
			clean[key] = StripSensitiveKeys(nested)
		case []interface{}:
			cleanSlice := make([]interface{}, 0, len(nested))
			for _, item := range nested {
				if nestedMap, ok := item.(map[string]interface{}); ok {
					cleanSlice = append(cleanSlice, StripSensitiveKeys(nestedMap))
					continue
				}
				cleanSlice = append(cleanSlice, redactCardLikeValue(item))
			}
			clean[key] = cleanSlice
		case string:
			clean[key] = redactCardLike(nested)
		default:
			clean[key] = redactCardLikeValue(value)
		}
	}
	return clean
}

// StripSensitiveStringKeys removes restricted keys from string maps and
// redacts card-like numeric runs from remaining values.
func StripSensitiveStringKeys(data map[string]string) map[string]string {
	if len(data) == 0 {
		return map[string]string{}
	}
	clean := make(map[string]string, len(data))
	for key, value := range data {
		if isSensitiveKey(key) {
			continue
		}
		clean[key] = redactCardLike(value)
	}
	return clean
}
