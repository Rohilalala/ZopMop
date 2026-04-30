package booking

import "testing"

func TestBuildAcceptBookingOutboxEvent(t *testing.T) {
	evt := buildAcceptBookingOutboxEvent("booking-1", "customer-1", "helper-1", "Alex")

	if evt.Type != BookingOutboxEventNotifyCustomerAccepted {
		t.Fatalf("unexpected event type: %s", evt.Type)
	}
	if evt.Payload.BookingID != "booking-1" || evt.Payload.CustomerID != "customer-1" {
		t.Fatalf("unexpected payload ids: %#v", evt.Payload)
	}
	if evt.Payload.HelperID == nil || *evt.Payload.HelperID != "helper-1" {
		t.Fatalf("expected helper id in payload, got %#v", evt.Payload.HelperID)
	}
	if evt.Payload.HelperName != "Alex" {
		t.Fatalf("expected helper name Alex, got %q", evt.Payload.HelperName)
	}
}

func TestBuildCancelBookingOutboxEvents(t *testing.T) {
	helperID := "helper-1"
	events := buildCancelBookingOutboxEvents("booking-1", "customer-1", &helperID)
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	if events[0].Type != BookingOutboxEventNotifyProCancelled {
		t.Fatalf("unexpected first event type: %s", events[0].Type)
	}
	if events[1].Type != BookingOutboxEventMatchCleanup {
		t.Fatalf("unexpected second event type: %s", events[1].Type)
	}
	if events[0].Payload.HelperID == nil || *events[0].Payload.HelperID != helperID {
		t.Fatalf("expected helper id on notify-pro event")
	}
}

func TestBuildCancelBookingOutboxEventsWithoutAssignedHelper(t *testing.T) {
	events := buildCancelBookingOutboxEvents("booking-1", "customer-1", nil)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != BookingOutboxEventMatchCleanup {
		t.Fatalf("unexpected event type: %s", events[0].Type)
	}
}

func TestBuildCompleteBookingOutboxEvents(t *testing.T) {
	events := buildCompleteBookingOutboxEvents("booking-1", "customer-1", "helper-1")
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	if events[0].Type != BookingOutboxEventNotifyCustomerCompleted {
		t.Fatalf("unexpected first event type: %s", events[0].Type)
	}
	if events[1].Type != BookingOutboxEventIncrementHelperJobs {
		t.Fatalf("unexpected second event type: %s", events[1].Type)
	}
	if events[1].Payload.HelperID == nil || *events[1].Payload.HelperID != "helper-1" {
		t.Fatalf("expected helper id on increment helper jobs event")
	}
}
