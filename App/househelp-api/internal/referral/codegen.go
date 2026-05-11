package referral

import (
	"fmt"
	"math/rand"
	"regexp"
	"strings"
)

var (
	nonAlpha  = regexp.MustCompile(`[^A-Z]`)
	digitOnly = regexp.MustCompile(`\d`)
)

// firstNamePrefix extracts and uppercases the first word, strips non-alpha.
// Returns empty string for non-latin or empty names.
func firstNamePrefix(name string) string {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return ""
	}
	return nonAlpha.ReplaceAllString(strings.ToUpper(parts[0]), "")
}

// phoneSuffix returns the last 4 digits of phone. Fewer than 4: returns all.
func phoneSuffix(phone string) string {
	digits := digitOnly.FindAllString(phone, -1)
	if len(digits) < 4 {
		return strings.Join(digits, "")
	}
	return strings.Join(digits[len(digits)-4:], "")
}

// generateCandidate returns a code candidate for a given prefix and tier.
// tier 0 → 2-digit suffix (00-99), tier 1 → 3-digit (100-999), etc.
func generateCandidate(prefix string, tier int) string {
	digits := tier + 2
	max := 1
	for i := 0; i < digits; i++ {
		max *= 10
	}
	suffix := rand.Intn(max)
	return fmt.Sprintf("%s%0*d", prefix, digits, suffix)
}
