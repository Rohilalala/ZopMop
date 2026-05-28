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
// Returns:
//   - ErrInvalidScope if the scope is unrecognized
//   - ErrNotFound if no code exists for (scope, ownerID)
//   - ErrMismatch if the supplied code does not match
//   - nil on a successful one-time consumption
func (s *Service) Verify(ctx context.Context, scope Scope, ownerID, code string) error {
	if !validScope(scope) {
		return ErrInvalidScope
	}
	if ownerID == "" || code == "" {
		return ErrNotFound
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
	// One-time use: delete on success. Best-effort — a failure to delete is
	// non-fatal (the TTL will reap the key) but should not invalidate the
	// successful verify.
	_ = s.rdb.Del(ctx, key).Err()
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

// keyFor returns the Redis key for (scope, ownerID). The scope segment is
// part of the key so cross-namespace verification is structurally impossible.
func keyFor(scope Scope, ownerID string) string {
	return fmt.Sprintf("otp:%s:%s", scope, ownerID)
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
