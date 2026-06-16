package appversion

import "testing"

// Pure-function unit tests for the version-policy helpers. No DB/network, so
// these always run (unlike the DB-backed CRM suites that skip without
// TEST_DATABASE_URL). compareVersions is the algorithmically risky one —
// dotted numeric ordering, not lexical ("1.2.0" < "1.10.0").

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.2.0", 0},
		{"1.2.0", "1.2.1", -1},
		{"1.3.0", "1.2.9", 1},
		{"1.2.0", "1.10.0", -1}, // numeric, not lexical
		{"1.10.0", "1.9.0", 1},
		{"2.0.0", "1.9.9", 1},
		{"1.2", "1.2.0", 0},   // missing trailing segment == 0
		{"1.2.0", "1.2", 0},   // order-independent
		{"1.2.0-beta", "1.2.0", 0},   // pre-release suffix ignored
		{"1.2.0+build7", "1.2.0", 0}, // build suffix ignored
		{"1.x.0", "1.0.0", 0},        // non-numeric segment -> 0
		{"", "0.0.0", 0},             // empty -> all zeros
		{"1.0.0", "", 1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestNormPlatform(t *testing.T) {
	cases := map[string]string{
		"ios":         "ios",
		"iOS":         "ios",
		"  Android  ": "android",
		"ANDROID":     "android",
		"web":         "any",
		"":            "any",
		"windows":     "any",
	}
	for in, want := range cases {
		if got := normPlatform(in); got != want {
			t.Errorf("normPlatform(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStoreURLFor(t *testing.T) {
	both := policy{iosStoreURL: "https://apps.apple.com/x", androidURL: "https://play.google.com/y"}
	if got := storeURLFor("ios", both); got != both.iosStoreURL {
		t.Errorf("ios store url = %q, want %q", got, both.iosStoreURL)
	}
	if got := storeURLFor("android", both); got != both.androidURL {
		t.Errorf("android store url = %q, want %q", got, both.androidURL)
	}
	// Unknown platform prefers android when both are set.
	if got := storeURLFor("any", both); got != both.androidURL {
		t.Errorf("any store url = %q, want android %q", got, both.androidURL)
	}
	// Falls back to ios when android is missing.
	iosOnly := policy{iosStoreURL: "https://apps.apple.com/x"}
	if got := storeURLFor("any", iosOnly); got != iosOnly.iosStoreURL {
		t.Errorf("any (ios-only) store url = %q, want %q", got, iosOnly.iosStoreURL)
	}
}
