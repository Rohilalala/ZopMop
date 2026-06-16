package booking

import (
	"errors"
	"testing"
	"time"

	// Embed the IANA tz database so time.LoadLocation("Asia/Kolkata") works on
	// any host (CI runners may have no system zoneinfo).
	_ "time/tzdata"
)

// Pure unit tests for validateSlotTime — the three regular-slot lead-time rules
// (spec §3.1, §3.3): past → ErrSlotInPast, < now+45m → ErrSlotTooSoon,
// > 2 days → ErrSlotTooFar, otherwise nil. No DB: a zero-value Service has a
// nil configSvc, so LoadDispatchConfig falls back to MinSlotLeadMin=45.
func TestValidateSlotTime_LeadRules(t *testing.T) {
	t.Parallel()

	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatalf("load IST: %v", err)
	}
	s := &Service{} // nil configSvc → default knobs (MinSlotLeadMin=45)
	now := time.Now().In(loc)

	rfc := func(t time.Time) string { return t.Format(time.RFC3339) }

	cases := []struct {
		name    string
		at      string
		wantErr error
	}{
		{"past", rfc(now.Add(-10 * time.Minute)), ErrSlotInPast},
		{"too_soon_30m", rfc(now.Add(30 * time.Minute)), ErrSlotTooSoon},
		{"too_soon_44m", rfc(now.Add(44 * time.Minute)), ErrSlotTooSoon},
		{"ok_90m", rfc(now.Add(90 * time.Minute)), nil},
		{"ok_tomorrow", rfc(now.Add(24 * time.Hour)), nil},
		{"too_far_3d", rfc(now.Add(3*24*time.Hour + time.Hour)), ErrSlotTooFar},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := s.validateSlotTime(tc.at)
			if tc.wantErr == nil {
				if got != nil {
					t.Fatalf("validateSlotTime(%s) = %v, want nil", tc.at, got)
				}
				return
			}
			if !errors.Is(got, tc.wantErr) {
				t.Fatalf("validateSlotTime(%s) = %v, want %v", tc.at, got, tc.wantErr)
			}
		})
	}
}

// A malformed timestamp is a 400-class input error, not one of the sentinels.
func TestValidateSlotTime_BadInput(t *testing.T) {
	t.Parallel()
	s := &Service{}
	err := s.validateSlotTime("not-a-timestamp")
	if err == nil {
		t.Fatal("expected error for malformed timestamp, got nil")
	}
	if errors.Is(err, ErrSlotInPast) || errors.Is(err, ErrSlotTooSoon) || errors.Is(err, ErrSlotTooFar) {
		t.Fatalf("malformed timestamp should not match a slot sentinel, got %v", err)
	}
}
