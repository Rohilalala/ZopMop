package referral

import (
	"errors"
	"time"
)

var (
	ErrCodeNotFound    = errors.New("referral: code not found")
	ErrAlreadyReferred = errors.New("referral: user already has a referral")
	ErrCapReached      = errors.New("referral: referrer has reached the 3-referral cap")
	ErrSelfReferral    = errors.New("referral: cannot refer yourself")
)

const (
	MaxReferralsPerReferrer = 3
	ReferrerCreditPaise     = int64(20_000) // Rs 200
	RefereeCreditPaise      = int64(10_000) // Rs 100
)

type Referral struct {
	ID                 string     `json:"id"`
	ReferrerID         string     `json:"referrer_id"`
	RefereeID          string     `json:"referee_id"`
	Status             string     `json:"status"`
	RefereeCreditedAt  *time.Time `json:"referee_credited_at,omitempty"`
	ReferrerCreditedAt *time.Time `json:"referrer_credited_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

type ReferralStats struct {
	Code               string `json:"code"`
	Link               string `json:"link"`
	ReferralsUsed      int    `json:"referrals_used"`
	ReferralsRemaining int    `json:"referrals_remaining"`
	TotalEarnedPaise   int64  `json:"total_earned_paise"`
}

type ApplyRequest struct {
	Code string `json:"code" validate:"required,min=3,max=40"`
}
