package booking

import "encoding/json"

// BookingOutboxEventType is the event identifier used by booking outbox messages.
type BookingOutboxEventType string

const (
	BookingOutboxEventStatusChanged  BookingOutboxEventType = "booking.status_changed"
	BookingOutboxEventHelperAssigned BookingOutboxEventType = "booking.helper_assigned"
	BookingOutboxEventCancelled      BookingOutboxEventType = "booking.cancelled"
)

// BookingOutboxPayload contains event data persisted in booking_outbox.payload.
type BookingOutboxPayload struct {
	BookingID  string            `json:"booking_id"`
	CustomerID string            `json:"customer_id"`
	HelperID   *string           `json:"helper_id,omitempty"`
	FromStatus BookingStatus     `json:"from_status,omitempty"`
	ToStatus   BookingStatus     `json:"to_status,omitempty"`
	Reason     string            `json:"reason,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// OutboxEvent is a booking side-effect event to be stored in booking_outbox.
type OutboxEvent struct {
	Type    BookingOutboxEventType
	Payload BookingOutboxPayload
}

// Marshal encodes payload for storage in booking_outbox.payload.
func (p BookingOutboxPayload) Marshal() ([]byte, error) {
	return json.Marshal(p)
}

// UnmarshalBookingOutboxPayload decodes booking_outbox.payload.
func UnmarshalBookingOutboxPayload(data []byte) (BookingOutboxPayload, error) {
	var payload BookingOutboxPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return BookingOutboxPayload{}, err
	}
	return payload, nil
}
