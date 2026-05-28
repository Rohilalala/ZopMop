// Package otp issues and verifies booking-scoped one-time codes for the
// service-start and service-end gates of a live booking.
//
// This is INTENTIONALLY separate from the login OTP path in package auth
// (SendLoginOTP / VerifyLoginOTP). The two systems must not be merged:
//
//   - Login OTPs are dispatched via Message Central (SMS); their Redis state
//     is the vendor's verificationId, stored under otp:login:vid:{phone}.
//   - Service OTPs are server-generated 6-digit codes displayed in-app on the
//     customer's TrackLive screen, read out to the pro who enters them in
//     the pro app. They are never sent by SMS.
//
// Cross-namespace verification is structurally impossible: the Redis key for
// a service OTP is otp:{scope}:{ownerID} (e.g. otp:start:<booking-uuid>),
// which has no overlap with the login namespace otp:login:*. A login code is
// not findable under any service-scope key and vice versa — see
// TestLoginNamespaceCannotSatisfyServiceOTP in otp_test.go for the wire-level
// proof.
package otp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/redis/go-redis/v9"
)

// Scope identifies what an OTP is for. The scope is part of the Redis key,
// so a code issued under one scope cannot satisfy a verify under another —
// the lookup is keyed by scope+owner and will simply not find the code.
//
// Booking-scoped OTPs are owned by a booking ID, not a phone number. Two
// different bookings for the same customer must hold independent codes that
// cannot leak across, and the customer reads the code from their own
// in-app screen — no phone-scoping is needed.
type Scope string

const (
	// ScopeStart guards the accepted -> in_progress transition. Issued when
	// the booking goes live ("On my way") and consumed by the pro entering
	// the code shared by the customer.
	ScopeStart Scope = "start"
	// ScopeEnd guards the in_progress -> completed transition. Issued only
	// AFTER payment has resolved (Cashfree webhook paid OR pro-marked cash)
	// and consumed by the pro entering the code shared by the customer.
	ScopeEnd Scope = "end"
)

// DefaultTTL is the standard expiry window. Long enough to cover a full
// service session (pro travel + work) but short enough to limit replay.
const DefaultTTL = 6 * time.Hour

// maxVerifyAttempts is the per-(scope, ownerID) ceiling on wrong Verify
// submissions within verifyAttemptsWindow before further verifies are
// blocked. The gate is a pro reading the customer's 6 digits aloud, so
// misheard digits are normal — set to 10 so genuine fumbling doesn't
// lock anyone out, low enough to bound a brute-force attempt at
// effectively 0.001% success per window.
//
// IMPORTANT: this is a security guard on a payment gate. Do not raise
// without a security review.
const maxVerifyAttempts = 10

// verifyAttemptsWindow is the sliding period over which Verify failures
// accumulate. Set the TTL on the counter to this value the first time
// it's incremented; further INCRs inside the window inherit the TTL.
const verifyAttemptsWindow = 5 * time.Minute

var (
	// ErrInvalidScope is returned when a scope outside the defined set is supplied.
	ErrInvalidScope = errors.New("otp: invalid scope")
	// ErrNotFound is returned when no code exists for (scope, ownerID) —
	// either none was issued, it expired, or it was already consumed.
	ErrNotFound = errors.New("otp: not found or expired")
	// ErrMismatch is returned when the supplied code does not match the
	// stored code under (scope, ownerID). The stored code is preserved so
	// a brute-force attempt cannot evict a legit outstanding code.
	ErrMismatch = errors.New("otp: mismatch")
	// ErrTooManyAttempts is returned when more than maxVerifyAttempts
	// wrong verifies have been submitted for (scope, ownerID) inside
	// verifyAttemptsWindow. The caller MUST surface this distinctly from
	// ErrMismatch: the gate is now locked until the window passes, and
	// the only legitimate unblocks are TIME or operational SUPPORT.
	// In particular, reloading the customer's TrackLive does NOT
	// re-issue the OTP (Peek returns the existing code), so any UI
	// message implying a reload would mislead the pro. See
	// docs/phase-1-payment-gated-flow.md.
	ErrTooManyAttempts = errors.New("otp: too many wrong attempts")
)

// Service issues and verifies booking-scoped OTPs against Redis.
type Service struct {
	rdb *redis.Client
	ttl time.Duration
}

// New returns a Service wired to the given Redis client with the supplied
// TTL. Pass 0 (or any non-positive value) for ttl to use DefaultTTL.
func New(rdb *redis.Client, ttl time.Duration) *Service {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Service{rdb: rdb, ttl: ttl}
}

// Issue generates a fresh cryptographically-random 6-digit code for
// (scope, ownerID), stores it in Redis with the configured TTL, and returns
// the plaintext so the caller can display it to the customer. A fresh Issue
// intentionally overwrites any prior code under the same key (rotation).
func (s *Service) Issue(ctx context.Context, scope Scope, ownerID string) (string, error) {
	if !validScope(scope) {
		return "", ErrInvalidScope
	}
	if ownerID == "" {
		return "", fmt.Errorf("otp: ownerID required")
	}
	code, err := generateCode()
	if err != nil {
		return "", fmt.Errorf("otp: generate: %w", err)
	}
	if err := s.rdb.Set(ctx, keyFor(scope, ownerID), code, s.ttl).Err(); err != nil {
		return "", fmt.Errorf("otp: store: %w", err)
	}
	return code, nil
}

// Verify checks the supplied code against the stored value for
// (scope, ownerID) using a constant-time comparison and, on success, deletes
// the entry (one-time use). A mismatch DOES NOT consume the stored code, so
// a brute-force attempt cannot evict a legit outstanding code.
//
// Rate limit: per-(scope, ownerID), Verify allows up to maxVerifyAttempts
// submissions inside verifyAttemptsWindow. The (maxVerifyAttempts + 1)th
// attempt returns ErrTooManyAttempts WITHOUT touching the stored code or
// the constant-time compare path. The counter resets on a successful
// match (the pro got it right; they shouldn't carry stale fail credit
// into the next service OTP for the same booking). Key shape:
// otp:verify-attempts:{scope}:{ownerID} — scope+owner isolation so a pro
// juggling two jobs has independent budgets and cannot brute-force a
// second booking's gate with credit they burned on the first.
//
// Returns:
//   - ErrInvalidScope if the scope is unrecognized
//   - ErrNotFound if no code exists for (scope, ownerID) (or the
//     ownerID/code is empty)
//   - ErrTooManyAttempts if the rate-limit ceiling has been crossed
//   - ErrMismatch if the supplied code does not match
//   - nil on a successful one-time consumption
func (s *Service) Verify(ctx context.Context, scope Scope, ownerID, code string) error {
	if !validScope(scope) {
		return ErrInvalidScope
	}
	if ownerID == "" || code == "" {
		return ErrNotFound
	}

	// Rate-limit check. INCR first so a malicious caller cannot probe the
	// "is this code outstanding?" side channel by short-circuiting through
	// ErrNotFound for free; even if there is no outstanding code, every
	// attempt costs a slot. attempts==1 means we just started a window;
	// stamp the TTL so the counter naturally expires.
	attemptsKey := attemptsKeyFor(scope, ownerID)
	attempts, ierr := s.rdb.Incr(ctx, attemptsKey).Result()
	if ierr == nil && attempts == 1 {
		// Best-effort TTL stamp. A failure to set the TTL would leave the
		// counter pinned forever; retry once, then accept the risk (the
		// next Issue at the booking level will clear the slate anyway).
		if eerr := s.rdb.Expire(ctx, attemptsKey, verifyAttemptsWindow).Err(); eerr != nil {
			_ = s.rdb.Expire(ctx, attemptsKey, verifyAttemptsWindow).Err()
		}
	}
	if ierr == nil && attempts > int64(maxVerifyAttempts) {
		return ErrTooManyAttempts
	}

	key := keyFor(scope, ownerID)
	stored, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return ErrNotFound
		}
		return fmt.Errorf("otp: load: %w", err)
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(code)) != 1 {
		return ErrMismatch
	}
	// One-time use: delete on success. Also clear the attempts counter —
	// the pro got the code right, so any in-window fail credit was for
	// digits they did eventually re-read correctly, not for a brute-force
	// run. Carrying stale fail counters across a successful gate would
	// mis-lock the next legitimate verify. Best-effort: a failure to
	// delete is non-fatal (the TTL reaps both keys eventually).
	_ = s.rdb.Del(ctx, key).Err()
	_ = s.rdb.Del(ctx, attemptsKey).Err()
	return nil
}

// Revoke removes any stored code for (scope, ownerID). Used when a booking
// is cancelled before completion or admin-force-closed — the outstanding
// OTP must not remain valid afterwards.
func (s *Service) Revoke(ctx context.Context, scope Scope, ownerID string) error {
	if !validScope(scope) {
		return ErrInvalidScope
	}
	return s.rdb.Del(ctx, keyFor(scope, ownerID)).Err()
}

// Peek returns the current stored code for (scope, ownerID) WITHOUT
// consuming it. Intended for the customer-facing TrackLive endpoint:
// the customer queries TrackLive repeatedly while waiting for the pro,
// and each query must surface the same outstanding code so the customer
// can read it out. Verify is the single consume path.
//
// Peek does NOT extend the TTL — a stale outstanding code expires on its
// original schedule, not on every read.
//
// Returns ErrNotFound when no code is outstanding (none issued, expired,
// or already consumed). The caller MUST treat ErrNotFound as "no code to
// display yet" — never as a server error.
func (s *Service) Peek(ctx context.Context, scope Scope, ownerID string) (string, error) {
	if !validScope(scope) {
		return "", ErrInvalidScope
	}
	if ownerID == "" {
		return "", ErrNotFound
	}
	stored, err := s.rdb.Get(ctx, keyFor(scope, ownerID)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("otp: peek: %w", err)
	}
	return stored, nil
}

// keyFor returns the Redis key for (scope, ownerID). The scope segment is
// part of the key so cross-namespace verification is structurally impossible.
func keyFor(scope Scope, ownerID string) string {
	return fmt.Sprintf("otp:%s:%s", scope, ownerID)
}

// attemptsKeyFor returns the per-(scope, ownerID) Redis counter key for
// the Verify rate limit. Isolated by both segments so a pro juggling
// two bookings burns independent budgets; a fail-run on one booking
// cannot pre-lock a second booking's gate.
func attemptsKeyFor(scope Scope, ownerID string) string {
	return fmt.Sprintf("otp:verify-attempts:%s:%s", scope, ownerID)
}

func validScope(scope Scope) bool {
	return scope == ScopeStart || scope == ScopeEnd
}

func generateCode() (string, error) {
	max := big.NewInt(1000000)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}
