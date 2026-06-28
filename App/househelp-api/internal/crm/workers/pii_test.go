package workers

import (
	"strings"
	"testing"
)

// TestMaskTail covers the C7 PII mask used by the worker-detail handler: raw
// Aadhaar / bank numbers must never ship; only the last 4 chars survive.
func TestMaskTail(t *testing.T) {
	ptr := func(v string) *string { return &v }

	t.Run("nil stays nil", func(t *testing.T) {
		if got := maskTail(nil); got != nil {
			t.Fatalf("maskTail(nil) = %v, want nil", got)
		}
	})

	t.Run("empty stays empty", func(t *testing.T) {
		if got := maskTail(ptr("")); got == nil || *got != "" {
			t.Fatalf("maskTail(\"\") = %v, want empty string", got)
		}
	})

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"12-digit aadhaar", "123456789012", strings.Repeat("•", 8) + "9012"},
		{"bank account", "00112233445566", strings.Repeat("•", 10) + "5566"},
		{"len 5", "12345", "•2345"},
		{"len exactly 4 fully masked", "1234", "••••"},
		{"len 3 fully masked", "123", "••••"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := maskTail(ptr(tc.in))
			if got == nil || *got != tc.want {
				t.Fatalf("maskTail(%q) = %v, want %q", tc.in, got, tc.want)
			}
			// The full value must never leak through the mask.
			if got != nil && *got == tc.in && len(tc.in) > 4 {
				t.Fatalf("maskTail(%q) returned the raw value", tc.in)
			}
		})
	}
}
