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

// GetByDate returns all active time slots for a given date, generating
// default slots if none exist yet.
func (r *Repository) GetByDate(ctx context.Context, date string) ([]TimeSlot, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Generate default slots for the date if missing.
	if err := r.ensureSlotsExist(ctx, date); err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx,
		`SELECT id,
		        to_char(slot_date, 'YYYY-MM-DD') AS slot_date,
		        to_char(start_time, 'HH24:MI')   AS start_time,
		        to_char(end_time,   'HH24:MI')   AS end_time,
		        max_bookings, current_bookings, is_active, created_at
		 FROM time_slots
		 WHERE slot_date = $1 AND is_active = true
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

// defaultSlotTimes are the standard time windows generated for each day.
var defaultSlotTimes = [][2]string{
	{"07:00", "09:00"},
	{"09:00", "11:00"},
	{"11:00", "13:00"},
	{"13:00", "15:00"},
	{"15:00", "17:00"},
	{"17:00", "19:00"},
	{"19:00", "21:00"},
}

// ensureSlotsExist generates default slots for a date if none exist.
func (r *Repository) ensureSlotsExist(ctx context.Context, date string) error {
	var count int
	err := r.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM time_slots WHERE slot_date = $1`, date,
	).Scan(&count)
	if err != nil || count > 0 {
		return err
	}

	for _, window := range defaultSlotTimes {
		_, err := r.db.Exec(ctx,
			`INSERT INTO time_slots (slot_date, start_time, end_time)
			 VALUES ($1, $2, $3) ON CONFLICT (slot_date, start_time) DO NOTHING`,
			date, window[0], window[1],
		)
		if err != nil {
			return fmt.Errorf("failed to create default slot %s: %w", window[0], err)
		}
	}
	return nil
}
