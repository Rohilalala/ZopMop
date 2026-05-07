package logger

import "testing"

func TestMaskPhone(t *testing.T) {
	cases := []struct{ in, want string }{
		{"+919876543210", "***3210"},
		{"9876543210", "***3210"},
		{"1234", "***"},
		{"abc", "***"},
		{"", "***"},
	}
	for _, tc := range cases {
		if got := MaskPhone(tc.in); got != tc.want {
			t.Errorf("MaskPhone(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestMaskEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"john@example.com", "j***@example.com"},
		{"a@b.co", "a***@b.co"},
		{"", "***"},
		{"no-at-sign", "***"},
		{"@only", "***"},
		{"@", "***"},
	}
	for _, tc := range cases {
		if got := MaskEmail(tc.in); got != tc.want {
			t.Errorf("MaskEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestMaskVPA(t *testing.T) {
	cases := []struct{ in, want string }{
		{"aditya@okhdfcbank", "***@okhdfcbank"},
		{"x@y", "***@y"},
		{"", "***"},
		{"no-at", "***"},
	}
	for _, tc := range cases {
		if got := MaskVPA(tc.in); got != tc.want {
			t.Errorf("MaskVPA(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestStub(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"abcdefghijklmnop", 8, "abcdefgh..."},
		{"abcdefghijklmnop", 0, "abcdefgh..."}, // default n=8
		{"abc", 8, "abc..."},                   // shorter than n
		{"", 8, "..."},
		{"abcdef", 4, "abcd..."},
		{"abcdef", -1, "abcdef..."}, // negative → default 8
	}
	for _, tc := range cases {
		if got := Stub(tc.in, tc.n); got != tc.want {
			t.Errorf("Stub(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}
