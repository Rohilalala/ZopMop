package slots

import "time"

// TimeSlot is a bookable 30-minute window for a given date.
type TimeSlot struct {
	ID              string    `json:"id"`
	SlotDate        string    `json:"slot_date"`  // "YYYY-MM-DD"
	StartTime       string    `json:"start_time"` // "HH:MM"
	EndTime         string    `json:"end_time"`   // "HH:MM"
	Period          string    `json:"period"`     // "morning" | "afternoon" | "evening"
	MaxBookings     int       `json:"max_bookings"`
	CurrentBookings int       `json:"current_bookings"`
	IsAvailable     bool      `json:"is_available"`
	CreatedAt       time.Time `json:"created_at"`
}

// SlotPeriod groups slots under a named time-of-day label for the UI.
type SlotPeriod struct {
	Label string     `json:"label"` // "Morning", "Afternoon", "Evening"
	Slots []TimeSlot `json:"slots"`
}
