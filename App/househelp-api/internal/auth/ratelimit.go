package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis-backed sliding-window counters for the MSG91 OTP flow.
//
// Three independent limits per the spec:
//
//   - send/phone: 3 send-otp calls per 2 min for the same phone
//     (prevents draining a single victim's SMS quota).
//   - send/ip:    5 send-otp calls per 2 min from the same IP
//     (prevents one attacker fanning out across phones).
//   - verify/phone: 5 verify-otp attempts per 10 min for the same
//     phone (brute-force throttle since MSG91 enforces nothing
//     server-side beyond OTP validity).
//
// Counters are simple INCR + EXPIRE: the very first increment in a
// window stamps the TTL; subsequent increments inside the window
// inherit it. When Redis is unreachable we fail OPEN (return nil so
// the request proceeds) — these limits sit BEHIND the existing IP
// rate limiter (SensitivePublicRateLimit, 20/min) which fails closed,
// so a Redis outage degrades to "IP-only" protection rather than
// fully unguarded.

const (
	otpSendPhoneMax    = 3
	otpSendPhoneWindow = 2 * time.Minute

	otpSendIPMax    = 5
	otpSendIPWindow = 2 * time.Minute

	otpVerifyPhoneMax    = 5
	otpVerifyPhoneWindow = 10 * time.Minute
)

// ErrOTPRateLimited is returned when any of the three windowed
// counters trips. The RetryAfter field carries the remaining TTL of
// the offending key so the handler can set a Retry-After header.
type ErrOTPRateLimited struct {
	RetryAfter time.Duration
	Scope      string // "send/phone" | "send/ip" | "verify/phone"
}

func (e *ErrOTPRateLimited) Error() string {
	return fmt.Sprintf("rate limited (%s); retry in %ds", e.Scope, int(e.RetryAfter.Seconds()))
}

// OTPRateLimiter holds the redis client. Nil-safe — a nil receiver
// disables all checks (used in tests and for older binaries that
// don't yet have Redis wired).
type OTPRateLimiter struct {
	rdb *redis.Client
}

// NewOTPRateLimiter constructs a limiter. Accepts a nil client for
// no-op behaviour.
func NewOTPRateLimiter(rdb *redis.Client) *OTPRateLimiter {
	return &OTPRateLimiter{rdb: rdb}
}

// CheckSend enforces both send/phone and send/ip in one call. Phone
// is required; ip may be empty (skip the IP check). Returns
// *ErrOTPRateLimited when either limit trips; nil otherwise.
func (l *OTPRateLimiter) CheckSend(ctx context.Context, phone, ip string) error {
	if l == nil || l.rdb == nil {
		return nil
	}
	if err := l.bump(ctx, "otp:login:send:phone:"+phone, otpSendPhoneMax, otpSendPhoneWindow, "send/phone"); err != nil {
		return err
	}
	if ip != "" {
		if err := l.bump(ctx, "otp:login:send:ip:"+ip, otpSendIPMax, otpSendIPWindow, "send/ip"); err != nil {
			return err
		}
	}
	return nil
}

// CheckVerify enforces the verify/phone counter. Call before the
// MSG91 verify request so bad-actor brute forcing trips locally.
func (l *OTPRateLimiter) CheckVerify(ctx context.Context, phone string) error {
	if l == nil || l.rdb == nil {
		return nil
	}
	return l.bump(ctx, "otp:login:verify:phone:"+phone, otpVerifyPhoneMax, otpVerifyPhoneWindow, "verify/phone")
}

// ResetVerify clears the verify counter after a successful verify so
// the next session's attempts start fresh.
func (l *OTPRateLimiter) ResetVerify(ctx context.Context, phone string) {
	if l == nil || l.rdb == nil {
		return
	}
	_ = l.rdb.Del(ctx, "otp:login:verify:phone:"+phone).Err()
}

// bump is the shared INCR + EXPIRE-on-first-hit primitive.
func (l *OTPRateLimiter) bump(ctx context.Context, key string, max int, window time.Duration, scope string) error {
	rctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()

	n, err := l.rdb.Incr(rctx, key).Result()
	if err != nil {
		// Fail open — see file header for rationale.
		return nil
	}
	if n == 1 {
		if expErr := l.rdb.Expire(rctx, key, window).Err(); expErr != nil {
			// Loss of TTL would pin the counter forever; best-effort
			// recovery: try once more, then give up.
			_ = l.rdb.Expire(rctx, key, window).Err()
		}
	}
	if int(n) <= max {
		return nil
	}

	ttl, terr := l.rdb.TTL(rctx, key).Result()
	if terr != nil || ttl <= 0 {
		ttl = window
	}
	return &ErrOTPRateLimited{RetryAfter: ttl, Scope: scope}
}

// IsRateLimited unwraps to the typed error so callers can branch on
// scope / retry-after without a manual errors.As.
func IsRateLimited(err error) (*ErrOTPRateLimited, bool) {
	var target *ErrOTPRateLimited
	if errors.As(err, &target) {
		return target, true
	}
	return nil, false
}
