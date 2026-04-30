package booking

import (
	"reflect"
	"testing"
)

func TestOutboxPayloadRoundTrip(t *testing.T) {
	t.Parallel()

	helperID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	original := BookingOutboxPayload{
		BookingID:  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		CustomerID: "cccccccc-cccc-cccc-cccc-cccccccccccc",
		HelperID:   &helperID,
		FromStatus: StatusPending,
		ToStatus:   StatusAccepted,
		Reason:     "helper accepted booking",
		Metadata: map[string]string{
			"source": "booking-service",
		},
	}

	raw, err := original.Marshal()
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	decoded, err := UnmarshalBookingOutboxPayload(raw)
	if err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}

	if !reflect.DeepEqual(original, decoded) {
		t.Fatalf("payload mismatch\nwant: %#v\ngot:  %#v", original, decoded)
	}
}
