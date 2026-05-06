package compliance

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DB-backed integration tests for chunk 11 — /me/export. Skipped when
// TEST_DATABASE_URL is unset. Reuses helpers from purge_test.go
// (makeUser, makeBooking, makeHelper) so insert semantics stay
// consistent across compliance test suites (e.g. the dedup-trigger
// workaround in makeBooking).

func decodeExport(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(buf).Decode(&out); err != nil {
		t.Fatalf("decode export JSON: %v\nraw=%s", err, buf.String())
	}
	return out
}

func TestExportUserData_HappyPath_Customer(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userID := makeUser(t, pool, uuid.NewString())
	// One address.
	_, err := pool.Exec(ctx, `
		INSERT INTO user_addresses (user_id, tag, title, flat_no, building_name, full_address, lat, lon)
		VALUES ($1::uuid, 'Home', 'home', '1', 'Tower', '1 Tower St', 12.9, 77.6)
	`, userID)
	if err != nil {
		t.Fatalf("insert address: %v", err)
	}
	// One booking (status='completed' bypasses dedup trigger).
	_ = makeBooking(t, pool, userID)

	var buf bytes.Buffer
	rows, err := svc.ExportUserData(ctx, userID, &buf)
	if err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	if rows == 0 {
		t.Fatalf("expected non-zero rows, got 0")
	}
	doc := decodeExport(t, &buf)

	if doc["user_id"].(string) != userID {
		t.Fatalf("user_id mismatch: got %v want %s", doc["user_id"], userID)
	}
	if int(doc["schema_version"].(float64)) != ExportSchemaVersion {
		t.Fatalf("schema_version mismatch")
	}
	profile, _ := doc["profile"].(map[string]any)
	if profile == nil || profile["id"].(string) != userID {
		t.Fatalf("profile.id mismatch: %#v", profile)
	}
	addrs, _ := doc["addresses"].([]any)
	if len(addrs) != 1 {
		t.Fatalf("expected 1 address, got %d", len(addrs))
	}
	bookings, _ := doc["bookings"].(map[string]any)
	if bookings == nil {
		t.Fatalf("bookings section missing")
	}
	custBookings, _ := bookings["as_customer"].([]any)
	if len(custBookings) != 1 {
		t.Fatalf("expected 1 customer booking, got %d", len(custBookings))
	}
	// Helper sections should NOT appear for customer-only user.
	if _, ok := doc["helper_profile"]; ok {
		t.Fatalf("helper_profile must not appear for customer-only user")
	}
	if _, ok := doc["helper_status_log"]; ok {
		t.Fatalf("helper_status_log must not appear for customer-only user")
	}
}

func TestExportUserData_RedactsOtherParty_Customer(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	customerID := makeUser(t, pool, uuid.NewString())
	helperUser := makeUser(t, pool, uuid.NewString())
	helperID := makeHelper(t, pool, helperUser)
	bookingID := makeBooking(t, pool, customerID)
	if _, err := pool.Exec(ctx, `UPDATE bookings SET helper_id=$1::uuid WHERE id=$2::uuid`, helperID, bookingID); err != nil {
		t.Fatalf("set helper_id: %v", err)
	}

	var buf bytes.Buffer
	if _, err := svc.ExportUserData(ctx, customerID, &buf); err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	raw := buf.String()
	if strings.Contains(raw, helperID) {
		t.Fatalf("customer export leaked helper UUID %s", helperID)
	}
	doc := decodeExport(t, bytes.NewBuffer([]byte(raw)))
	bookings := doc["bookings"].(map[string]any)
	cust := bookings["as_customer"].([]any)
	if len(cust) != 1 {
		t.Fatalf("expected 1 customer booking, got %d", len(cust))
	}
	row := cust[0].(map[string]any)
	if row["helper_id"] != otherPartyRedacted {
		t.Fatalf("expected helper_id=%q, got %v", otherPartyRedacted, row["helper_id"])
	}
	if row["customer_id"] != customerID {
		t.Fatalf("customer_id should be unredacted in own export, got %v", row["customer_id"])
	}
}

func TestExportUserData_RedactsOtherParty_Helper(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	customerID := makeUser(t, pool, uuid.NewString())
	helperUser := makeUser(t, pool, uuid.NewString())
	helperID := makeHelper(t, pool, helperUser)
	bookingID := makeBooking(t, pool, customerID)
	if _, err := pool.Exec(ctx, `UPDATE bookings SET helper_id=$1::uuid WHERE id=$2::uuid`, helperID, bookingID); err != nil {
		t.Fatalf("set helper_id: %v", err)
	}

	var buf bytes.Buffer
	if _, err := svc.ExportUserData(ctx, helperUser, &buf); err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	raw := buf.String()
	if strings.Contains(raw, customerID) {
		t.Fatalf("helper export leaked customer UUID %s", customerID)
	}
	doc := decodeExport(t, bytes.NewBuffer([]byte(raw)))
	if _, ok := doc["helper_profile"]; !ok {
		t.Fatalf("helper_profile missing for helper user")
	}
	bookings := doc["bookings"].(map[string]any)
	asHelper := bookings["as_helper"].([]any)
	if len(asHelper) != 1 {
		t.Fatalf("expected 1 helper-side booking, got %d", len(asHelper))
	}
	row := asHelper[0].(map[string]any)
	if row["customer_id"] != otherPartyRedacted {
		t.Fatalf("expected customer_id=%q, got %v", otherPartyRedacted, row["customer_id"])
	}
}

func TestExportUserData_RedactsFCMToken(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userID := makeUser(t, pool, uuid.NewString())
	const realToken = "fGcM-VeRy-LoNg-FcM-ToKeN-12345"
	_, err := pool.Exec(ctx, `
		INSERT INTO device_tokens (user_id, fcm_token, platform, device_id)
		VALUES ($1::uuid, $2, 'ios', 'dev-1')
	`, userID, realToken)
	if err != nil {
		t.Fatalf("insert device_token: %v", err)
	}

	var buf bytes.Buffer
	if _, err := svc.ExportUserData(ctx, userID, &buf); err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	raw := buf.String()
	if strings.Contains(raw, realToken) {
		t.Fatalf("export leaked full FCM token")
	}
	want := realToken[:8] + fcmTokenRedactedSuffix
	if !strings.Contains(raw, want) {
		t.Fatalf("expected stub %q in export, got: %s", want, raw)
	}
}

func TestExportUserData_OnlyExportsTargetUser(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	target := makeUser(t, pool, uuid.NewString())
	other := makeUser(t, pool, uuid.NewString())
	_, err := pool.Exec(ctx, `
		INSERT INTO user_addresses (user_id, tag, title, flat_no, building_name, full_address, lat, lon)
		VALUES ($1::uuid, 'Home', 'other-secret-title', '99', 'OtherTower', '99 Other St', 1, 1)
	`, other)
	if err != nil {
		t.Fatalf("insert other user address: %v", err)
	}

	var buf bytes.Buffer
	if _, err := svc.ExportUserData(ctx, target, &buf); err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	raw := buf.String()
	if strings.Contains(raw, "other-secret-title") {
		t.Fatalf("target export contained other user's address")
	}
	if strings.Contains(raw, other) {
		t.Fatalf("target export contained other user's UUID")
	}
}

func TestExportUserData_StreamsValidJSON(t *testing.T) {
	// Sanity: the streamer output must be a single well-formed JSON
	// document. json.Decoder enforces this; happy-path test already
	// exercises decode, but this test deliberately hits a user with
	// ZERO rows (only the profile) to confirm empty arrays render
	// validly (e.g. `"addresses":[]` not `"addresses":[,]`).
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userID := makeUser(t, pool, uuid.NewString())

	var buf bytes.Buffer
	if _, err := svc.ExportUserData(ctx, userID, &buf); err != nil {
		t.Fatalf("ExportUserData: %v", err)
	}
	doc := decodeExport(t, &buf)
	if doc["user_id"].(string) != userID {
		t.Fatalf("user_id mismatch")
	}
	if addrs, _ := doc["addresses"].([]any); len(addrs) != 0 {
		t.Fatalf("expected empty addresses, got %d", len(addrs))
	}
	if got, _ := doc["bookings"].(map[string]any); got == nil {
		t.Fatalf("bookings must be an object even when empty")
	} else {
		ac, _ := got["as_customer"].([]any)
		ah, _ := got["as_helper"].([]any)
		if len(ac) != 0 || len(ah) != 0 {
			t.Fatalf("expected empty bookings sub-arrays")
		}
	}
}
