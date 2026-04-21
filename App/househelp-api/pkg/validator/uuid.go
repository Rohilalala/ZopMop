package validator

import "github.com/google/uuid"

// IsUUID returns true if value is a valid RFC4122 UUID string.
func IsUUID(value string) bool {
	_, err := uuid.Parse(value)
	return err == nil
}
