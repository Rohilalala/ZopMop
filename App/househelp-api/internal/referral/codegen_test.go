package referral

import (
	"testing"
)

func TestFirstNamePrefix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Aditya Rohilla", "ADITYA"},
		{"john", "JOHN"},
		{"李伟", ""},
		{"O'Brien", "OBRIEN"},
		{"", ""},
		{"  spaces  ", "SPACES"},
	}
	for _, c := range cases {
		got := firstNamePrefix(c.in)
		if got != c.want {
			t.Errorf("firstNamePrefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPhoneSuffix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"+91 98765 43210", "3210"},
		{"1234", "1234"},
		{"12", "12"},
	}
	for _, c := range cases {
		got := phoneSuffix(c.in)
		if got != c.want {
			t.Errorf("phoneSuffix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestGenerateCandidateLength(t *testing.T) {
	// tier 0 → 2-digit suffix; tier 1 → 3-digit suffix
	for tier := 0; tier < 3; tier++ {
		code := generateCandidate("ADITYA", tier)
		expectedLen := len("ADITYA") + tier + 2
		if len(code) != expectedLen {
			t.Errorf("tier %d: got len %d, want %d (code=%q)", tier, len(code), expectedLen, code)
		}
	}
}
