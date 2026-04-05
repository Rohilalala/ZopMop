package matching

import (
	"math"
	"sort"
)

// ── Scoring weights ───────────────────────────────────────────────────────────
//
// ZopMop is a scheduled home-services marketplace, NOT a real-time ride app.
// The customer chooses a time slot hours (or days) in advance, so raw ETA
// matters far less than it does for Uber.  Quality and reliability (rating,
// experience) therefore carry a larger combined weight.
//
//	Proximity   35% — still important; a helper 50 m away is strongly preferred
//	            over one 8 km away who will be stressed and late.
//	Rating      35% — customers trust a known-good helper over a stranger.
//	Experience  20% — log-scaled; levels off after ~100 jobs so veterans
//	            don't completely crowd out competent newcomers.
//	Availability 10% — penalises helpers already running at full capacity.
const (
	wProximity    = 0.35
	wRating       = 0.35
	wExperience   = 0.20
	wAvailability = 0.10

	// A helper with this many completed jobs reaches the maximum experience score.
	experienceCap = 100.0
)

// ScoreCandidate computes a composite [0, 1] match score for one helper.
// It writes the result into c.Score and returns it.
//
// All sub-scores are mapped to [0, 1] before weighting so that no single
// dimension can dominate due to unit differences.
func ScoreCandidate(c *HelperCandidate) float64 {
	// ── Proximity ──────────────────────────────────────────────────────────────
	// Exponential decay: score = e^(-d / λ), λ = 5 km.
	// At  0.0 km → 1.000
	// At  1.0 km → 0.819
	// At  3.0 km → 0.549
	// At  5.0 km → 0.368
	// At 10.0 km → 0.135
	proximity := math.Exp(-c.DistanceKm / 5.0)

	// ── Rating ─────────────────────────────────────────────────────────────────
	// Platform min rating to appear is configurable (default 3.0).
	// We normalise from [1, 5] → [0, 1] so a 5-star helper scores 1.0.
	rating := math.Max(0, (c.Rating-1.0)/4.0)

	// ── Experience ─────────────────────────────────────────────────────────────
	// Log-scaled growth — a jump from 0→10 jobs is a bigger signal than 90→100.
	// log(1+jobs) / log(1+cap) maps 0→0, cap→1.
	experience := math.Min(1.0,
		math.Log1p(float64(c.TotalJobs))/math.Log1p(experienceCap))

	// ── Availability ──────────────────────────────────────────────────────────
	// Inverse square-root decay so the penalty grows slowly:
	//   0 active → 1.000
	//   1 active → 0.707
	//   2 active → 0.577
	//   3 active → 0.500  (typically the max allowed)
	availability := 1.0 / math.Sqrt(float64(c.ActiveBookings+1))

	score := wProximity*proximity +
		wRating*rating +
		wExperience*experience +
		wAvailability*availability

	// Clamp to [0, 1] for defensive correctness.
	score = math.Min(1.0, math.Max(0.0, score))
	c.Score = score
	return score
}

// RankCandidates sorts the slice in-place, highest score first.
func RankCandidates(cs []HelperCandidate) {
	sort.Slice(cs, func(i, j int) bool {
		return cs[i].Score > cs[j].Score
	})
}

// ToHelperMatches converts a ranked candidate slice into the public HelperMatch
// type.  Callers pass `limit` to cap the output (0 = no cap).
func ToHelperMatches(cs []HelperCandidate, limit int) []HelperMatch {
	if limit > 0 && len(cs) > limit {
		cs = cs[:limit]
	}
	out := make([]HelperMatch, len(cs))
	for i, c := range cs {
		out[i] = HelperMatch{
			HelperID:       c.HelperID,
			DistanceKm:     c.DistanceKm,
			Rating:         c.Rating,
			TotalJobs:      c.TotalJobs,
			ActiveBookings: c.ActiveBookings,
			Score:          c.Score,
		}
	}
	return out
}

// GreedyAssign implements a greedy bipartite assignment for the batch case.
//
// Given a set of open bookings and a pool of candidates scored against each
// booking, it assigns at most one booking per helper (per batch window) to
// prevent over-notification.  This is O(B × H) which is fast enough when
// batches are small (< 20 bookings, < 50 helpers in a cell neighbourhood).
//
// Returns a map of bookingID → []HelperMatch (ordered, best first) so the
// caller can notify the top-N helpers per booking.
func GreedyAssign(
	bookings []BatchEntry,
	// candidatesByBooking maps bookingID → scored+ranked candidates
	candidatesByBooking map[string][]HelperCandidate,
	maxPerBooking int,
) map[string][]HelperMatch {
	// Track which helpers have already been assigned in this batch window.
	// A helper can only be in one assignment per window to avoid flooding them
	// with simultaneous notifications.
	assigned := make(map[string]bool)

	result := make(map[string][]HelperMatch, len(bookings))

	for _, b := range bookings {
		candidates := candidatesByBooking[b.BookingID]
		var picks []HelperCandidate
		for _, c := range candidates {
			if assigned[c.HelperID] {
				continue
			}
			picks = append(picks, c)
			assigned[c.HelperID] = true
			if len(picks) >= maxPerBooking {
				break
			}
		}
		if len(picks) > 0 {
			result[b.BookingID] = ToHelperMatches(picks, maxPerBooking)
		}
	}
	return result
}
