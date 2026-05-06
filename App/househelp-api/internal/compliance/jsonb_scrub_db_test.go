package compliance

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed integration tests for chunk 12. Skipped when
// TEST_DATABASE_URL is unset.

// makePushMessage inserts a crm_push_messages row with the given
// target_filter JSONB and returns its UUID. Cleaned up by t.Cleanup.
func makePushMessage(t *testing.T, pool *pgxpool.Pool, targetKind, targetFilterJSON string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO crm_push_messages (title, body, target_kind, target_filter)
		VALUES ('test-title', 'test-body', $1, $2::jsonb)
		RETURNING id::text
	`, targetKind, targetFilterJSON).Scan(&id)
	if err != nil {
		t.Fatalf("insert crm_push_messages: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM crm_push_messages WHERE id=$1::uuid`, id)
	})
	return id
}

// makePromotion inserts a promotions row with the given audience_user_ids
// UUID[] and returns its UUID. Cleaned up by t.Cleanup.
func makePromotion(t *testing.T, pool *pgxpool.Pool, audienceUserIDs []string) string {
	t.Helper()
	id := uuid.NewString()
	code := "PROMO_" + id[:8]
	_, err := pool.Exec(context.Background(), `
		INSERT INTO promotions (id, code, discount_type, discount_value, audience_user_ids)
		VALUES ($1::uuid, $2, 'fixed', 100, $3::uuid[])
	`, id, code, audienceUserIDs)
	if err != nil {
		t.Fatalf("insert promotions: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM promotions WHERE id=$1::uuid`, id)
	})
	return id
}

func TestScrubAuditLogJSONBForUser_RedactsTargetRows(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	adminID := uuid.NewString()
	adminEmail := "admin-c12-" + adminID[:8] + "@zopmop.local"
	makeCRMAdmin(t, pool, adminID, adminEmail)

	// PII payload baked into after_value (simulates a future module
	// that logs a user-row snapshot on suspend).
	piiAfter := `{"phone":"+919876543210","name":"Bob","action":"suspend"}`
	rowID := insertCRMAuditRow(t, pool, adminID, adminEmail,
		"user.suspend", "users", "user", userX, "null", piiAfter)

	scrubbed, err := svc.ScrubAuditLogJSONBForUser(ctx, userX)
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	if scrubbed != 1 {
		t.Fatalf("scrubbed = %d, want 1", scrubbed)
	}

	var afterRaw []byte
	if err := pool.QueryRow(ctx, `SELECT after_value FROM crm_audit_log WHERE id=$1`, rowID).Scan(&afterRaw); err != nil {
		t.Fatalf("read after_value: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(afterRaw, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["phone"] != RedactedValue {
		t.Errorf("phone not redacted: %v", got["phone"])
	}
	if got["name"] != RedactedValue {
		t.Errorf("name not redacted: %v", got["name"])
	}
	if got["action"] != "suspend" {
		t.Errorf("non-PII action mutated: %v", got["action"])
	}
}

func TestScrubAuditLogJSONBForUser_PreservesOtherTargetRows(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	userY := makeUser(t, pool, uuid.NewString())
	adminID := uuid.NewString()
	adminEmail := "admin-c12b-" + adminID[:8] + "@zopmop.local"
	makeCRMAdmin(t, pool, adminID, adminEmail)

	yPayload := `{"phone":"+919999999999"}`
	yRow := insertCRMAuditRow(t, pool, adminID, adminEmail,
		"user.suspend", "users", "user", userY, "null", yPayload)

	if _, err := svc.ScrubAuditLogJSONBForUser(ctx, userX); err != nil {
		t.Fatalf("scrub: %v", err)
	}

	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT after_value FROM crm_audit_log WHERE id=$1`, yRow).Scan(&raw); err != nil {
		t.Fatalf("read: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	if got["phone"] != "+919999999999" {
		t.Errorf("Y's row mutated by scrub targeting X: %v", got["phone"])
	}
}

func TestScrubAuditLogJSONBForUser_ScrubsBothBeforeAndAfter(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	adminID := uuid.NewString()
	adminEmail := "admin-c12c-" + adminID[:8] + "@zopmop.local"
	makeCRMAdmin(t, pool, adminID, adminEmail)

	before := `{"name":"OldName","email":"old@example.com"}`
	after := `{"name":"NewName","phone":"+91111"}`
	rowID := insertCRMAuditRow(t, pool, adminID, adminEmail,
		"user.update", "users", "user", userX, before, after)

	scrubbed, err := svc.ScrubAuditLogJSONBForUser(ctx, userX)
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	if scrubbed != 1 {
		t.Fatalf("scrubbed = %d, want 1", scrubbed)
	}

	var bRaw, aRaw []byte
	if err := pool.QueryRow(ctx,
		`SELECT before_value, after_value FROM crm_audit_log WHERE id=$1`, rowID,
	).Scan(&bRaw, &aRaw); err != nil {
		t.Fatalf("read: %v", err)
	}
	var b, a map[string]any
	_ = json.Unmarshal(bRaw, &b)
	_ = json.Unmarshal(aRaw, &a)
	if b["name"] != RedactedValue || b["email"] != RedactedValue {
		t.Errorf("before not fully scrubbed: %#v", b)
	}
	if a["name"] != RedactedValue || a["phone"] != RedactedValue {
		t.Errorf("after not fully scrubbed: %#v", a)
	}
}

func TestScrubUserFromCampaignTargets_PushMessagesUpdated(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	userY := makeUser(t, pool, uuid.NewString())
	pushID := makePushMessage(t, pool, "specific",
		`{"user_ids":["`+userX+`","`+userY+`"]}`)

	updated, err := svc.ScrubUserFromCampaignTargets(ctx, userX)
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	if updated < 1 {
		t.Fatalf("updated = %d, want >= 1", updated)
	}

	var raw []byte
	if err := pool.QueryRow(ctx,
		`SELECT target_filter FROM crm_push_messages WHERE id=$1::uuid`, pushID,
	).Scan(&raw); err != nil {
		t.Fatalf("read: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	users, _ := got["user_ids"].([]any)
	if len(users) != 1 || users[0] != userY {
		t.Fatalf("user_ids after scrub = %v, want [%s]", users, userY)
	}
}

func TestScrubUserFromCampaignTargets_PromotionsArrayUpdated(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	userY := makeUser(t, pool, uuid.NewString())
	promoID := makePromotion(t, pool, []string{userX, userY})

	if _, err := svc.ScrubUserFromCampaignTargets(ctx, userX); err != nil {
		t.Fatalf("scrub: %v", err)
	}

	var got []string
	if err := pool.QueryRow(ctx,
		`SELECT audience_user_ids::text[] FROM promotions WHERE id=$1::uuid`, promoID,
	).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 1 || got[0] != userY {
		t.Fatalf("audience_user_ids after scrub = %v, want [%s]", got, userY)
	}
}

func TestScrubUserFromCampaignTargets_OtherUsersPreserved(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	userY := makeUser(t, pool, uuid.NewString())
	userZ := makeUser(t, pool, uuid.NewString())

	// Push message targets only Y+Z (not X). Scrubbing X must leave
	// this row completely untouched.
	pushID := makePushMessage(t, pool, "specific",
		`{"user_ids":["`+userY+`","`+userZ+`"]}`)

	if _, err := svc.ScrubUserFromCampaignTargets(ctx, userX); err != nil {
		t.Fatalf("scrub: %v", err)
	}
	var raw []byte
	if err := pool.QueryRow(ctx,
		`SELECT target_filter FROM crm_push_messages WHERE id=$1::uuid`, pushID,
	).Scan(&raw); err != nil {
		t.Fatalf("read: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	users, _ := got["user_ids"].([]any)
	if len(users) != 2 {
		t.Fatalf("non-target row mutated: user_ids=%v", users)
	}
}

func TestSoftDeleteUser_ScrubsAuditAndCampaigns_E2E(t *testing.T) {
	// Simulates the chunk-12 portion of SoftDeleteUser within the
	// compliance package: the AnonymizeAuditLogsAsTarget call (now
	// scrubs JSONB + reassigns target_id in one tx) plus the
	// ScrubUserFromCampaignTargets call. End-to-end coverage of
	// SoftDeleteUser itself sits in the auth package.
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())
	ctx := context.Background()

	userX := makeUser(t, pool, uuid.NewString())
	userY := makeUser(t, pool, uuid.NewString())
	adminID := uuid.NewString()
	adminEmail := "admin-c12e-" + adminID[:8] + "@zopmop.local"
	makeCRMAdmin(t, pool, adminID, adminEmail)

	// Audit row about user X with PII payload.
	piiPayload := `{"phone":"+919876543210","name":"Bob"}`
	auditID := insertCRMAuditRow(t, pool, adminID, adminEmail,
		"user.suspend", "users", "user", userX, "null", piiPayload)
	// Campaign targeting X+Y.
	pushID := makePushMessage(t, pool, "specific",
		`{"user_ids":["`+userX+`","`+userY+`"]}`)
	// Promotion targeting X+Y.
	promoID := makePromotion(t, pool, []string{userX, userY})

	// Compose: scrub audit JSONB + reassign target_id + scrub campaign
	// targets — the chunk-12 portion of SoftDeleteUser.
	if _, _, err := svc.AnonymizeAuditLogsAsTarget(ctx, userX); err != nil {
		t.Fatalf("anonymize audit: %v", err)
	}
	if _, err := svc.ScrubUserFromCampaignTargets(ctx, userX); err != nil {
		t.Fatalf("scrub campaign: %v", err)
	}

	// Audit row: target_id reassigned to tombstone, JSONB scrubbed.
	var gotTargetID string
	var afterRaw []byte
	if err := pool.QueryRow(ctx,
		`SELECT target_id, after_value FROM crm_audit_log WHERE id=$1`, auditID,
	).Scan(&gotTargetID, &afterRaw); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if gotTargetID != TombstoneUserID {
		t.Errorf("target_id = %s, want tombstone %s", gotTargetID, TombstoneUserID)
	}
	var afterDecoded map[string]any
	_ = json.Unmarshal(afterRaw, &afterDecoded)
	if afterDecoded["phone"] != RedactedValue || afterDecoded["name"] != RedactedValue {
		t.Errorf("audit JSONB not scrubbed: %#v", afterDecoded)
	}

	// Push message: only userY remains.
	var pushRaw []byte
	pool.QueryRow(ctx,
		`SELECT target_filter FROM crm_push_messages WHERE id=$1::uuid`, pushID,
	).Scan(&pushRaw)
	var pushDecoded map[string]any
	_ = json.Unmarshal(pushRaw, &pushDecoded)
	pushUsers, _ := pushDecoded["user_ids"].([]any)
	if len(pushUsers) != 1 || pushUsers[0] != userY {
		t.Errorf("push user_ids after scrub = %v, want [%s]", pushUsers, userY)
	}

	// Promotion: only userY remains.
	var promoUsers []string
	pool.QueryRow(ctx,
		`SELECT audience_user_ids::text[] FROM promotions WHERE id=$1::uuid`, promoID,
	).Scan(&promoUsers)
	if len(promoUsers) != 1 || promoUsers[0] != userY {
		t.Errorf("promo audience_user_ids = %v, want [%s]", promoUsers, userY)
	}
}
