// Package experts implements the customer-curated "Your Experts" list —
// a small (max 5) set of preferred helpers that get first crack at the
// scheduled-booking invite chain.
package experts

import "time"

// Expert is one row of the customer's preferred-helpers list, enriched
// with the helper's profile + relationship metrics so the app can render
// the list without follow-up calls.
type Expert struct {
	HelperID                string    `json:"helper_id"`
	Name                    string    `json:"name"`
	PhotoURL                *string   `json:"photo_url,omitempty"`
	AverageRating           *float64  `json:"average_rating,omitempty"`
	CompletedJobsWithUser   int       `json:"completed_jobs_with_user"`
	AddedAt                 time.Time `json:"added_at"`
}

// MaxExpertsPerUser caps the list size. Enforced in the service layer so
// admins can override with direct SQL when needed.
const MaxExpertsPerUser = 5
