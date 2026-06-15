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
// are excluded — a cancelled booking frees its capacity automatically by
// dropping out of this set. Kept in sync with the partial index in migration
// 136_slot_capacity_gating.
const committedStatusList = `('pending', 'searching', 'accepted', 'arrived', 'in_progress')`

// capacityTravelPadMin extends each committed booking's window by a flat travel
// allowance so a pro finishing one job is not handed an immediately-adjacent job
// with no time to get there. Mirrors travelBufferMin (spec §2) for window math.
const capacityTravelPadMin = 15

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
// locality whose [scheduled_time, scheduled_time + total_duration_minutes +
// capacityTravelPadMin) window overlaps the slot's [start, end) window. Each
// such booking holds one helper for the slot. Overlap is the standard half-open
// test (a.start < b.end AND a.end > b.start); all slot/booking arithmetic is
// anchored in Asia/Kolkata. The travel pad means a job ending exactly at a
// slot's start still holds a seat there (the pro needs time to travel), so a
// 60-minute job at 09:00 counts against both the 09:30 and the 10:00 slots.
func (r *Repository) committedCountForSlot(ctx context.Context, q rowQuerier, locality, slotID string) (int, error) {
	var n int
	err := q.QueryRow(ctx, fmt.Sprintf(`
		SELECT COUNT(*)
		FROM bookings b, time_slots ts
		WHERE ts.id = $2
		  AND b.locality = $1
		  AND b.status IN %s
		  AND b.scheduled_time IS NOT NULL
		  AND b.total_duration_minutes IS NOT NULL
		  AND b.scheduled_time
		        < ((ts.slot_date + ts.end_time)   AT TIME ZONE 'Asia/Kolkata')
		  AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes + %d))
		        > ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata')
	`, committedStatusList, capacityTravelPadMin), locality, slotID).Scan(&n)
	return n, err
}

// committedCountForSlotExcluding is committedCountForSlot with one booking left
// out of the count. The reschedule gate (RescheduleBooking) uses it so the
// booking being moved does not count against the new slot via its own, not-yet-
// moved old window — a single-seat locality must still be able to shuffle a
// booking into an adjacent (overlapping) slot. excludeBookingID is the row being
// rescheduled.
func (r *Repository) committedCountForSlotExcluding(ctx context.Context, q rowQuerier, locality, slotID, excludeBookingID string) (int, error) {
	var n int
	err := q.QueryRow(ctx, fmt.Sprintf(`
		SELECT COUNT(*)
		FROM bookings b, time_slots ts
		WHERE ts.id = $2
		  AND b.locality = $1
		  AND b.id <> $3::uuid
		  AND b.status IN %s
		  AND b.scheduled_time IS NOT NULL
		  AND b.total_duration_minutes IS NOT NULL
		  AND b.scheduled_time
		        < ((ts.slot_date + ts.end_time)   AT TIME ZONE 'Asia/Kolkata')
		  AND (b.scheduled_time + make_interval(mins => b.total_duration_minutes + %d))
		        > ((ts.slot_date + ts.start_time) AT TIME ZONE 'Asia/Kolkata')
	`, committedStatusList, capacityTravelPadMin), locality, slotID, excludeBookingID).Scan(&n)
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

// availableForSlotExcluding is availableForSlot with one booking excluded from
// the committed re-count (see committedCountForSlotExcluding). Used by the
// reschedule gate so a booking never blocks its own move into an overlapping
// slot.
func (r *Repository) availableForSlotExcluding(ctx context.Context, q rowQuerier, locality, slotID, date, excludeBookingID string) (int, error) {
	roster, err := r.countActiveRosterHelpers(ctx, q, locality)
	if err != nil {
		return 0, fmt.Errorf("roster count: %w", err)
	}
	onLeave, err := r.countHelpersOnLeave(ctx, q, locality, date)
	if err != nil {
		return 0, fmt.Errorf("leave count: %w", err)
	}
	committed, err := r.committedCountForSlotExcluding(ctx, q, locality, slotID, excludeBookingID)
	if err != nil {
		return 0, fmt.Errorf("committed count: %w", err)
	}
	avail := roster - onLeave - committed
	if avail < 0 {
		avail = 0
	}
	return avail, nil
}

// WindowCapacity is one slot's capacity breakdown for the CRM read API
// (GET /admin/capacity). Window bounds are IST wall-clock "HH:MM" strings
// (time_slots stores start_time/end_time as IST time-of-day). Free is the
// clamped headroom roster − onLeave − committed.
type WindowCapacity struct {
	SlotID      string `json:"slot_id"`
	WindowStart string `json:"window_start"` // "HH:MM" IST
	WindowEnd   string `json:"window_end"`   // "HH:MM" IST
	Roster      int    `json:"roster"`
	OnLeave     int    `json:"on_leave"`
	Committed   int    `json:"committed"`
	Free        int    `json:"free"`
}

// CapacityForDate returns the per-slot capacity breakdown for a locality on an
// IST calendar date, for read-only CRM visibility. Same math as
// GetSlotAvailability: roster and on-leave are locality/date-wide (computed
// once), only the padded committed-overlap count varies per slot. The day's
// slot list comes from the slots module (same generation + future-filter +
// bucketing the picker uses). date is "YYYY-MM-DD".
func (r *Repository) CapacityForDate(ctx context.Context, locality, date string) ([]WindowCapacity, error) {
	roster, err := r.countActiveRosterHelpers(ctx, r.db, locality)
	if err != nil {
		return nil, fmt.Errorf("roster count: %w", err)
	}
	onLeave, err := r.countHelpersOnLeave(ctx, r.db, locality, date)
	if err != nil {
		return nil, fmt.Errorf("leave count: %w", err)
	}

	// Reuse the slots module's public API for generation + future-filter +
	// bucketing rather than duplicating it.
	slotsSvc := slots.NewService(slots.NewRepository(r.db))
	periods, err := slotsSvc.GetByDate(ctx, date)
	if err != nil {
		return nil, fmt.Errorf("load slots: %w", err)
	}

	out := []WindowCapacity{}
	for _, p := range periods {
		for _, sl := range p.Slots {
			committed, err := r.committedCountForSlot(ctx, r.db, locality, sl.ID)
			if err != nil {
				return nil, fmt.Errorf("committed count for slot %s: %w", sl.ID, err)
			}
			free := roster - onLeave - committed
			if free < 0 {
				free = 0
			}
			out = append(out, WindowCapacity{
				SlotID:      sl.ID,
				WindowStart: sl.StartTime,
				WindowEnd:   sl.EndTime,
				Roster:      roster,
				OnLeave:     onLeave,
				Committed:   committed,
				Free:        free,
			})
		}
	}
	return out, nil
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
func (s *Service) GetSlotAvailability(ctx context.Context, addressID, date string) (*AvailabilityResponse, error) {
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
			committed, err := s.repo.committedCountForSlot(ctx, s.db, locality, sl.ID)
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
