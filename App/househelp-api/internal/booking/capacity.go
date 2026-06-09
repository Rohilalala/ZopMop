package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/adityarohilla/househelp-api/internal/slots"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// PilotLocality is the single society the slot-capacity pilot runs in.
// resolveGateLocality falls back to it whenever an address can't be mapped to
// a seeded locality, so the gate still applies instead of failing open.
//
// PILOT-ONLY SHORTCUT: defaulting every unresolved address to one hardcoded
// society is correct only while the pilot is single-society. A multi-society
// rollout MUST replace the fallback in resolveGateLocality with real
// address→locality resolution (geocode or explicit society selection) —
// otherwise capacity from unrelated societies would be pooled together.
const PilotLocality = "Orchid Island Gurugram"

// committedStatusList is the SQL tuple of booking statuses that hold (commit)
// a helper for their scheduled window. Terminal states (completed, cancelled)
// and pending_customer_action are excluded — a cancelled booking frees its
// capacity automatically by dropping out of this set. Kept in sync with the
// partial index in migration 111_slot_capacity_gating.
const committedStatusList = `('pending', 'searching', 'accepted', 'arrived', 'in_progress')`

// rowQuerier is the read surface shared by *pgxpool.Pool and pgx.Tx, so the
// capacity helpers can run either on the connection pool (availability reads)
// or inside the booking-creation transaction (the gated re-count).
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// countActiveRosterHelpers returns the gross helper capacity for a locality:
// approved, non-suspended, non-banned, non-deleted helpers rostered there.
// This is the roster size before leave and committed bookings are subtracted.
// Predicate mirrors crm/workers List's "active" filter (repository.go).
func (r *Repository) countActiveRosterHelpers(ctx context.Context, q rowQuerier, locality string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM helpers h
		JOIN users u ON u.id = h.id
		WHERE h.locality = $1
		  AND h.approval_status = 'approved'
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
		  AND u.deleted_at IS NULL
	`, locality).Scan(&n)
	return n, err
}

// countHelpersOnLeave returns how many of the locality's roster helpers have
// an approved (full-day) leave on the given IST calendar date. Only roster
// helpers are counted, so a leave row for someone outside the roster never
// reduces capacity. date is "YYYY-MM-DD".
func (r *Repository) countHelpersOnLeave(ctx context.Context, q rowQuerier, locality, date string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM helpers h
		JOIN users u ON u.id = h.id
		JOIN pro_leaves pl ON pl.pro_id = h.id
		WHERE h.locality = $1
		  AND h.approval_status = 'approved'
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
		  AND u.deleted_at IS NULL
		  AND pl.date = $2::date
		  AND pl.status = 'approved'
	`, locality, date).Scan(&n)
	return n, err
}

// committedCountForSlot returns the number of committed bookings in the
// locality whose [scheduled_time, scheduled_time + total_duration_minutes)
// window overlaps the slot's [start, end) window. Each such booking holds one
// helper for the slot. Overlap is the standard half-open test
// (a.start < b.end AND a.end > b.start); all slot/booking arithmetic is
// anchored in Asia/Kolkata. A 60-minute job at 09:00 therefore also counts
// against the 09:30 slot.
func (r *Repository) committedCountForSlot(ctx context.Context, q rowQuerier, locality, slotID string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM bookings b, time_slots ts
		WHERE ts.id = $2
		  AND b.locality = $1
		  AND b.status IN `+committedStatusList+`
		  AND b.scheduled_time IS NOT NULL
		  AND b.total_duration_minutes IS NOT NULL
		  AND b.scheduled_time
		        < ((ts.slot_date + ts.end_time)   AT TIME ZONE 'Asia/Kolkata')
		  AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes))
		        > ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata')
	`, locality, slotID).Scan(&n)
	return n, err
}

// committedCountForSlotJob is committedCountForSlot for a job that may be LONGER
// than the slot: it counts committed bookings overlapping
// [slot.start, slot.start + durationMin) instead of the slot's own
// [start, end). The availability endpoint uses this with the customer's cart
// duration so a slot isn't shown bookable when a job placed there would overrun
// into committed time and then be rejected by the gate (availableForWindow).
// With durationMin equal to the slot length it equals committedCountForSlot.
func (r *Repository) committedCountForSlotJob(ctx context.Context, q rowQuerier, locality, slotID string, durationMin int) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM bookings b, time_slots ts
		WHERE ts.id = $2
		  AND b.locality = $1
		  AND b.status IN `+committedStatusList+`
		  AND b.scheduled_time IS NOT NULL
		  AND b.total_duration_minutes IS NOT NULL
		  AND b.scheduled_time
		        < ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata' + make_interval(mins => $3))
		  AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes))
		        > ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata')
	`, locality, slotID, durationMin).Scan(&n)
	return n, err
}

// availableForSlot is the live capacity for a single slot:
//
//	roster(locality) − onLeave(locality, date) − committed(locality, slot)
//
// clamped at zero. A slot is bookable iff this is > 0. Runs every read; there
// is no stored counter. Pass a tx as q to compute under the advisory lock.
func (r *Repository) availableForSlot(ctx context.Context, q rowQuerier, locality, slotID, date string) (int, error) {
	roster, err := r.countActiveRosterHelpers(ctx, q, locality)
	if err != nil {
		return 0, fmt.Errorf("roster count: %w", err)
	}
	onLeave, err := r.countHelpersOnLeave(ctx, q, locality, date)
	if err != nil {
		return 0, fmt.Errorf("leave count: %w", err)
	}
	committed, err := r.committedCountForSlot(ctx, q, locality, slotID)
	if err != nil {
		return 0, fmt.Errorf("committed count: %w", err)
	}
	avail := roster - onLeave - committed
	if avail < 0 {
		avail = 0
	}
	return avail, nil
}

// committedCountForWindow returns the number of committed bookings in the
// locality whose [scheduled_time, scheduled_time + total_duration_minutes)
// window overlaps an arbitrary [start, start + durationMin) window. Same
// half-open overlap test as committedCountForSlot, but bounded by an explicit
// job window rather than a time_slots row. The booking gate uses this with the
// NEW booking's own window: a job can be longer than its slot (a 60-min job in
// a 30-min slot), so counting overlaps against the slot window alone would miss
// commitments that overlap the job but not the slot, and let the helper be
// double-booked. start is an RFC3339 timestamp (the booking's scheduled_time).
func (r *Repository) committedCountForWindow(ctx context.Context, q rowQuerier, locality, start string, durationMin int) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM bookings b
		WHERE b.locality = $1
		  AND b.status IN `+committedStatusList+`
		  AND b.scheduled_time IS NOT NULL
		  AND b.total_duration_minutes IS NOT NULL
		  AND b.scheduled_time < ($2::timestamptz + make_interval(mins => $3))
		  AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes))
		        > $2::timestamptz
	`, locality, start, durationMin).Scan(&n)
	return n, err
}

// availableForWindow is the live capacity over an arbitrary job window:
//
//	roster(locality) − onLeave(locality, date) − committed(locality, window)
//
// clamped at zero. This is the form the booking gate must use — it measures
// the new booking's actual [scheduled_time, +durationMin) window so a job that
// outruns its slot still contends for helpers across its whole duration. date
// is the IST calendar date ("YYYY-MM-DD") the job starts on. Pass a tx as q to
// compute under the advisory lock.
func (r *Repository) availableForWindow(ctx context.Context, q rowQuerier, locality, date, start string, durationMin int) (int, error) {
	roster, err := r.countActiveRosterHelpers(ctx, q, locality)
	if err != nil {
		return 0, fmt.Errorf("roster count: %w", err)
	}
	onLeave, err := r.countHelpersOnLeave(ctx, q, locality, date)
	if err != nil {
		return 0, fmt.Errorf("leave count: %w", err)
	}
	committed, err := r.committedCountForWindow(ctx, q, locality, start, durationMin)
	if err != nil {
		return 0, fmt.Errorf("committed window count: %w", err)
	}
	avail := roster - onLeave - committed
	if avail < 0 {
		avail = 0
	}
	return avail, nil
}

// resolveGateLocality maps an address to the locality used for capacity
// gating. It reuses resolveLocality's fuzzy match and, on a miss or error,
// defaults to PilotLocality so the gate always applies during the pilot.
//
// PILOT-ONLY: see PilotLocality — the unconditional default is safe only while
// the pilot is single-society.
func (s *Service) resolveGateLocality(ctx context.Context, addressID string) (string, error) {
	loc, err := s.resolveLocality(ctx, addressID)
	if err != nil {
		log.Warn().Err(err).Str("address_id", addressID).
			Msg("[booking] gate locality resolve failed; defaulting to pilot locality")
		return PilotLocality, nil
	}
	if loc == nil || *loc == "" {
		return PilotLocality, nil
	}
	return *loc, nil
}

// AddressBelongsToUser reports whether address_id is owned by userID. Used by
// the availability handler to reject probing of other users' addresses.
func (s *Service) AddressBelongsToUser(ctx context.Context, addressID, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var owns bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM user_addresses WHERE id = $1::uuid AND user_id = $2::uuid)`,
		addressID, userID,
	).Scan(&owns)
	return owns, err
}

// AvailabilitySlot mirrors the slots endpoint's per-slot shape (so the mobile
// SchedulingModal can consume it as a drop-in for getTimeSlots) with two
// capacity-aware fields layered on: IsAvailable folds in live capacity, and
// AvailableCapacity exposes the remaining helper headroom.
type AvailabilitySlot struct {
	ID                string `json:"id"`
	SlotDate          string `json:"slot_date"`
	StartTime         string `json:"start_time"`
	EndTime           string `json:"end_time"`
	Period            string `json:"period"`
	MaxBookings       int    `json:"max_bookings"`
	CurrentBookings   int    `json:"current_bookings"`
	IsAvailable       bool   `json:"is_available"`
	AvailableCapacity int    `json:"available_capacity"`
}

// AvailabilityPeriod groups slots under a named period label.
type AvailabilityPeriod struct {
	Label string             `json:"label"`
	Slots []AvailabilitySlot `json:"slots"`
}

// AvailabilityResponse is the GET /bookings/availability body.
type AvailabilityResponse struct {
	Date    string               `json:"date"`
	Periods []AvailabilityPeriod `json:"periods"`
}

// GetSlotAvailability returns the day's slots (same future-filter + period
// bucketing as GET /slots) with is_available recomputed from live capacity in
// the address's locality. roster and on-leave counts are locality/date-wide,
// so they're computed once; only the committed-overlap count varies per slot.
//
// durationMin is the customer's prospective job length (cart total). When > 0,
// availability is computed over each slot's [start, start+durationMin) job
// window, matching the booking gate (availableForWindow) — so a slot that a
// long job can't actually book is not shown as available. When <= 0 it falls
// back to the slot's own window (duration-agnostic display).
func (s *Service) GetSlotAvailability(ctx context.Context, addressID, date string, durationMin int) (*AvailabilityResponse, error) {
	locality, err := s.resolveGateLocality(ctx, addressID)
	if err != nil {
		return nil, err
	}

	// Reuse the slots module's public API for generation + future-filter +
	// bucketing rather than duplicating it.
	slotsSvc := slots.NewService(slots.NewRepository(s.db))
	periods, err := slotsSvc.GetByDate(ctx, date)
	if err != nil {
		return nil, fmt.Errorf("load slots: %w", err)
	}

	roster, err := s.repo.countActiveRosterHelpers(ctx, s.db, locality)
	if err != nil {
		return nil, fmt.Errorf("roster count: %w", err)
	}
	onLeave, err := s.repo.countHelpersOnLeave(ctx, s.db, locality, date)
	if err != nil {
		return nil, fmt.Errorf("leave count: %w", err)
	}
	effective := roster - onLeave

	out := &AvailabilityResponse{Date: date, Periods: make([]AvailabilityPeriod, 0, len(periods))}
	for _, p := range periods {
		ap := AvailabilityPeriod{Label: p.Label, Slots: make([]AvailabilitySlot, 0, len(p.Slots))}
		for _, sl := range p.Slots {
			var committed int
			if durationMin > 0 {
				committed, err = s.repo.committedCountForSlotJob(ctx, s.db, locality, sl.ID, durationMin)
			} else {
				committed, err = s.repo.committedCountForSlot(ctx, s.db, locality, sl.ID)
			}
			if err != nil {
				return nil, fmt.Errorf("committed count for slot %s: %w", sl.ID, err)
			}
			avail := effective - committed
			if avail < 0 {
				avail = 0
			}
			ap.Slots = append(ap.Slots, AvailabilitySlot{
				ID:                sl.ID,
				SlotDate:          sl.SlotDate,
				StartTime:         sl.StartTime,
				EndTime:           sl.EndTime,
				Period:            sl.Period,
				MaxBookings:       sl.MaxBookings,
				CurrentBookings:   sl.CurrentBookings,
				IsAvailable:       sl.IsAvailable && avail > 0,
				AvailableCapacity: avail,
			})
		}
		out.Periods = append(out.Periods, ap)
	}
	return out, nil
}
