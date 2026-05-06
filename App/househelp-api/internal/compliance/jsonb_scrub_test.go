package compliance

import (
	"reflect"
	"testing"
)

func TestScrubJSONB_FlatObject(t *testing.T) {
	t.Parallel()
	in := map[string]any{
		"phone": "+919876543210",
		"name":  "Bob",
		"id":    "5d8b3a44-1111-2222-3333-444455556666",
	}
	if !ScrubJSONB(in) {
		t.Fatalf("expected changed=true")
	}
	if in["phone"] != RedactedValue {
		t.Fatalf("phone not redacted: %v", in["phone"])
	}
	if in["name"] != RedactedValue {
		t.Fatalf("name not redacted: %v", in["name"])
	}
	if in["id"] != "5d8b3a44-1111-2222-3333-444455556666" {
		t.Fatalf("id should be preserved (not in denylist): %v", in["id"])
	}
}

func TestScrubJSONB_NestedObject(t *testing.T) {
	t.Parallel()
	in := map[string]any{
		"user": map[string]any{
			"phone": "+919876543210",
			"id":    "uuid-stays",
		},
		"action": "user.suspend",
	}
	if !ScrubJSONB(in) {
		t.Fatalf("expected changed=true")
	}
	user := in["user"].(map[string]any)
	if user["phone"] != RedactedValue {
		t.Fatalf("nested phone not redacted: %v", user["phone"])
	}
	if user["id"] != "uuid-stays" {
		t.Fatalf("nested id should be preserved: %v", user["id"])
	}
	if in["action"] != "user.suspend" {
		t.Fatalf("non-PII top-level scalar should be preserved")
	}
}

func TestScrubJSONB_ArrayOfObjects(t *testing.T) {
	t.Parallel()
	in := map[string]any{
		"addresses": []any{
			map[string]any{
				"flat_no": "12B",
				"lat":     12.97,
				"lng":     77.59,
				"tag":     "Home",
			},
			map[string]any{
				"flat_no": "9A",
				"lat":     12.98,
				"tag":     "Work",
			},
		},
	}
	if !ScrubJSONB(in) {
		t.Fatalf("expected changed=true")
	}
	addrs := in["addresses"].([]any)
	if len(addrs) != 2 {
		t.Fatalf("array length changed: %d", len(addrs))
	}
	first := addrs[0].(map[string]any)
	if first["flat_no"] != RedactedValue {
		t.Fatalf("addresses[0].flat_no not redacted: %v", first["flat_no"])
	}
	if first["lat"] != RedactedValue {
		t.Fatalf("addresses[0].lat not redacted: %v", first["lat"])
	}
	if first["tag"] != "Home" {
		t.Fatalf("addresses[0].tag should be preserved")
	}
	second := addrs[1].(map[string]any)
	if second["flat_no"] != RedactedValue || second["lat"] != RedactedValue {
		t.Fatalf("addresses[1] not redacted: %#v", second)
	}
}

func TestScrubJSONB_NoMatchUnchanged(t *testing.T) {
	t.Parallel()
	in := map[string]any{
		"booking_id": "5d8b3a44-1111-2222-3333-444455556666",
		"amount":     float64(100),
		"status":     "pending",
	}
	snapshot := map[string]any{
		"booking_id": in["booking_id"],
		"amount":     in["amount"],
		"status":     in["status"],
	}
	if ScrubJSONB(in) {
		t.Fatalf("expected changed=false on payload with no denylisted keys")
	}
	if !reflect.DeepEqual(in, snapshot) {
		t.Fatalf("map mutated despite no denylist hit: got=%#v want=%#v", in, snapshot)
	}
}

func TestScrubJSONB_CaseInsensitiveKey(t *testing.T) {
	t.Parallel()
	in := map[string]any{
		"Phone":         "+919876543210",
		"EMAIL":         "bob@example.com",
		"Receiver_Name": "Bob",
	}
	if !ScrubJSONB(in) {
		t.Fatalf("expected changed=true")
	}
	if in["Phone"] != RedactedValue {
		t.Fatalf("Phone (capitalized) not redacted")
	}
	if in["EMAIL"] != RedactedValue {
		t.Fatalf("EMAIL (uppercase) not redacted")
	}
	if in["Receiver_Name"] != RedactedValue {
		t.Fatalf("Receiver_Name (mixed case) not redacted")
	}
}

func TestScrubJSONB_AlreadyRedactedNoOp(t *testing.T) {
	t.Parallel()
	// Re-running on already-scrubbed data must not flip changed=true,
	// because the value is already RedactedValue. This lets callers
	// skip a no-op UPDATE on backfill re-runs.
	in := map[string]any{
		"phone": RedactedValue,
		"name":  RedactedValue,
		"id":    "uuid-stays",
	}
	if ScrubJSONB(in) {
		t.Fatalf("expected changed=false on already-redacted payload")
	}
}
