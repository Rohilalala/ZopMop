package analytics

import "strings"

var sensitiveKeys = map[string]struct{}{
	"token":          {},
	"authorization":  {},
	"password":       {},
	"jwt":            {},
	"firebase_token": {},
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

// StripSensitiveKeys removes restricted keys recursively from map payloads.
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
				cleanSlice = append(cleanSlice, item)
			}
			clean[key] = cleanSlice
		default:
			clean[key] = value
		}
	}
	return clean
}

// StripSensitiveStringKeys removes restricted keys from string maps.
func StripSensitiveStringKeys(data map[string]string) map[string]string {
	if len(data) == 0 {
		return map[string]string{}
	}
	clean := make(map[string]string, len(data))
	for key, value := range data {
		if isSensitiveKey(key) {
			continue
		}
		clean[key] = value
	}
	return clean
}
