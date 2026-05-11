package referral

import (
	"testing"
)

func TestFirstNamePrefixEdgeCases(t *testing.T) {
	if firstNamePrefix("李伟") != "" {
		t.Fatal("expected empty for non-latin name")
	}
	if firstNamePrefix("A") != "A" {
		t.Fatal("expected A")
	}
}

func TestGenerateCandidateTiers(t *testing.T) {
	for i := 0; i < 20; i++ {
		c := generateCandidate("ADITYA", 0)
		if len(c) != 8 {
			t.Fatalf("tier 0: want len 8, got %d (%q)", len(c), c)
		}
	}
	for i := 0; i < 20; i++ {
		c := generateCandidate("ADITYA", 1)
		if len(c) != 9 {
			t.Fatalf("tier 1: want len 9, got %d (%q)", len(c), c)
		}
	}
}
