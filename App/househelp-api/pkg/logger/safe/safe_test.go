package safe

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// captureLog redirects the global zerolog logger to a bytes.Buffer for the
// duration of fn, then returns the captured output as a string.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Logger
	log.Logger = zerolog.New(&buf)
	defer func() { log.Logger = prev }()
	fn()
	return buf.String()
}

func TestEvent_IDs(t *testing.T) {
	out := captureLog(t, func() {
		Info().UserID("u1").HelperID("h1").BookingID("b1").Msg("ids")
	})
	for _, want := range []string{`"user_id":"u1"`, `"helper_id":"h1"`, `"booking_id":"b1"`, `"message":"ids"`} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

func TestEvent_Operational(t *testing.T) {
	out := captureLog(t, func() {
		Warn().Action("login").Status("failed").Code("INVALID_OTP").Msg("op")
	})
	for _, want := range []string{`"action":"login"`, `"status":"failed"`, `"code":"INVALID_OTP"`, `"level":"warn"`} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

func TestEvent_Numeric(t *testing.T) {
	out := captureLog(t, func() {
		Info().Count(5).Attempt(2).DurationMs(123).Msg("n")
	})
	for _, want := range []string{`"count":5`, `"attempt":2`, `"duration_ms":123`} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

func TestEvent_Financial(t *testing.T) {
	out := captureLog(t, func() {
		Info().AmountPaise(99900).Msg("f")
	})
	if !strings.Contains(out, `"amount_paise":99900`) {
		t.Errorf("output missing amount_paise: %s", out)
	}
}

func TestEvent_MaskedPII(t *testing.T) {
	out := captureLog(t, func() {
		Error().
			PhoneMasked("***3210").
			EmailMasked("j***@example.com").
			VPAMasked("***@okhdfcbank").
			TokenStub("abcdefgh...").
			Msg("pii")
	})
	for _, want := range []string{
		`"phone_mask":"***3210"`,
		`"email_mask":"j***@example.com"`,
		`"vpa_mask":"***@okhdfcbank"`,
		`"token_stub":"abcdefgh..."`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

func TestEvent_Err(t *testing.T) {
	out := captureLog(t, func() {
		Error().Err(errSentinel).Msg("e")
	})
	if !strings.Contains(out, `"error":"sentinel"`) {
		t.Errorf("output missing error: %s", out)
	}
}

type stringErr string

func (e stringErr) Error() string { return string(e) }

var errSentinel error = stringErr("sentinel")
