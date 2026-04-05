package slots

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles database access for time slots.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new slots repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetByDate returns all active, future time slots for a given date.
//
// Past slots are excluded: a slot is past when its start time (interpreted as
// IST) is earlier than the current moment.  An additional 30-minute buffer
// ensures customers cannot book a slot that starts imminently.
func (r *Repository) GetByDate(ctx context.Context, date string) ([]TimeSlot, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := r.ensureSlotsExist(ctx, date); err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx,
		// (slot_date + start_time) AT TIME ZONE 'Asia/Kolkata' converts the
		// naive IST timestamp to UTC so it can be compared against NOW().
		// The 30-minute booking buffer prevents near-future slots appearing.
		`SELECT id,
		        to_char(slot_date,   'YYYY-MM-DD') AS slot_date,
		        to_char(start_time,  'HH24:MI')    AS start_time,
		        to_char(end_time,    'HH24:MI')    AS end_time,
		        max_bookings, current_bookings, is_active, created_at
		 FROM time_slots
		 WHERE slot_date = $1
		   AND is_active = true
		   AND (slot_date + start_time) AT TIME ZONE 'Asia/Kolkata' > NOW() + INTERVAL '30 minutes'
		 ORDER BY start_time ASC`,
		date,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query time slots: %w", err)
	}
	defer rows.Close()

	var list []TimeSlot
	for rows.Next() {
		var s TimeSlot
		var isActive bool
		if err := rows.Scan(
			&s.ID, &s.SlotDate, &s.StartTime, &s.EndTime,
			&s.MaxBookings, &s.CurrentBookings, &isActive, &s.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan slot: %w", err)
		}
		s.IsAvailable = isActive && s.CurrentBookings < s.MaxBookings
		s.Period = periodForTime(s.StartTime)
		list = append(list, s)
	}
	if list == nil {
		list = []TimeSlot{}
	}
	return list, rows.Err()
}

// IncrementBooking atomically increments current_bookings for a slot,
// returning an error if the slot is full or unavailable.
func (r *Repository) IncrementBooking(ctx context.Context, slotID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(ctx,
		`UPDATE time_slots
		 SET current_bookings = current_bookings + 1
		 WHERE id = $1 AND is_active = true AND current_bookings < max_bookings`,
		slotID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment slot booking: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("time slot is unavailable or fully booked")
	}
	return nil
}

// ── Slot generation ───────────────────────────────────────────────────────────
//
// 30-minute slots across three periods (all times IST):
//   Morning   07:00 – 12:00  (10 slots)
//   Afternoon 12:00 – 17:00  (10 slots)
//   Evening   17:00 – 21:00  ( 8 slots)

func generateSlotWindows() [][2]string {
	var windows [][2]string
	periods := [][2]int{
		{7, 12},  // morning
		{12, 17}, // afternoon
		{17, 21}, // evening
	}
	for _, p := range periods {
		for h := p[0]; h < p[1]; h++ {
			windows = append(windows,
				[2]string{fmt.Sprintf("%02d:00", h), fmt.Sprintf("%02d:30", h)},
				[2]string{fmt.Sprintf("%02d:30", h), fmt.Sprintf("%02d:00", h+1)},
			)
		}
	}
	return windows
}

// ensureSlotsExist generates default 30-minute slots for a date if none exist.
func (r *Repository) ensureSlotsExist(ctx context.Context, date string) error {
	var count int
	if err := r.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM time_slots WHERE slot_date = $1`, date,
	).Scan(&count); err != nil || count > 0 {
		return err
	}

	for _, w := range generateSlotWindows() {
		if _, err := r.db.Exec(ctx,
			`INSERT INTO time_slots (slot_date, start_time, end_time)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (slot_date, start_time) DO NOTHING`,
			date, w[0], w[1],
		); err != nil {
			return fmt.Errorf("failed to create slot %s: %w", w[0], err)
		}
	}
	return nil
}

// periodForTime maps an "HH:MM" start time to its period label.
func periodForTime(startTime string) string {
	if len(startTime) < 2 {
		return "morning"
	}
	var h int
	fmt.Sscanf(startTime[:2], "%d", &h)
	switch {
	case h < 12:
		return "morning"
	case h < 17:
		return "afternoon"
	default:
		return "evening"
	}
}
