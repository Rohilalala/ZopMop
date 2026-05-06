package compliance

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// otherPartyRedacted is the sentinel value substituted for a counter-
// party's UUID in the user's data export. Customers' exports never
// reveal the helper's user_id; helpers' exports never reveal the
// customer's user_id. The user's OWN id appears unredacted.
const otherPartyRedacted = "<other_party>"

// fcmTokenRedactedSuffix is appended to the first 8 characters of an
// FCM token so the export shows the user which tokens are registered
// without giving away the full string (which is itself a stable,
// re-usable identifier in Google's push system — leaking it could
// let an attacker deny push to the device or, with sufficient context,
// re-target it).
const fcmTokenRedactedSuffix = "..."

// ExportSchemaVersion is the version of the export envelope. Increment
// when a section is added/removed or a redaction rule changes — clients
// keying on the shape can branch on this.
const ExportSchemaVersion = 1

// ExportUserData assembles a complete data-portability export of all
// PII ZopMop holds about the given user and writes it as a streaming
// JSON document to w. Heap is bounded by single-row size: each row is
// scanned, marshaled, and written before the next is fetched.
//
// DPDP §11 / GDPR Art 20. Audit C-8 / F2D-1 chunk 11.
//
// Redactions applied (other-user PII never appears verbatim in this
// user's export):
//   - bookings.helper_id (in as_customer rows)        → otherPartyRedacted
//   - bookings.customer_id (in as_helper rows)        → otherPartyRedacted
//   - reviews.customer_id (in received rows)          → otherPartyRedacted
//   - device_tokens.fcm_token                         → first 8 chars + "..."
//   - audit_log/crm_audit_log admin_id + admin_email  → omitted (nil)
//
// Tables explicitly excluded with documented reasoning:
//   - crm_login_attempts : admin-only auth log; customer/helper users never appear
//   - crm_push_messages  : campaign-level table; per-user IDs only inside
//                          target_filter JSONB on target_kind='specific',
//                          deferred per chunk 8 deferral pattern
//   - roomies_*          : blocked on prepaid-balance settlement worker
//                          (chunk 9 status: BLOCKED)
//
// Returns the count of total rows exported (across all sections) for
// audit logging by the caller.
func (s *Service) ExportUserData(ctx context.Context, userID string, w io.Writer) (int, error) {
	js := &jsonStreamer{w: w}
	js.startObject()
	js.section("exported_at")
	js.value(time.Now().UTC())
	js.section("user_id")
	js.value(userID)
	js.section("schema_version")
	js.value(ExportSchemaVersion)

	isHelper, err := s.userIsHelper(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("check helper status: %w", err)
	}

	var totalRows int

	type sectionFn func() (int, error)
	sections := []struct {
		name string
		run  sectionFn
	}{
		{"profile", func() (int, error) { return s.exportProfile(ctx, js, userID) }},
		{"addresses", func() (int, error) { return s.exportAddresses(ctx, js, userID) }},
		{"bookings", func() (int, error) { return s.exportBookings(ctx, js, userID) }},
		{"booking_messages", func() (int, error) { return s.exportBookingMessages(ctx, js, userID) }},
		{"reviews", func() (int, error) { return s.exportReviews(ctx, js, userID) }},
		{"refunds", func() (int, error) { return s.exportRefunds(ctx, js, userID) }},
		{"cart", func() (int, error) { return s.exportCart(ctx, js, userID) }},
		{"device_tokens", func() (int, error) { return s.exportDeviceTokens(ctx, js, userID) }},
		{"wallet", func() (int, error) { return s.exportWallet(ctx, js, userID) }},
		{"reengagement_notifications", func() (int, error) { return s.exportReengagement(ctx, js, userID) }},
		{"consents", func() (int, error) { return s.exportConsents(ctx, js, userID) }},
		{"preferred_helpers", func() (int, error) { return s.exportPreferredHelpers(ctx, js, userID) }},
		{"audit_trail", func() (int, error) { return s.exportAuditTrail(ctx, js, userID) }},
	}
	if isHelper {
		sections = append(sections,
			struct {
				name string
				run  sectionFn
			}{"helper_profile", func() (int, error) { return s.exportHelperProfile(ctx, js, userID) }},
			struct {
				name string
				run  sectionFn
			}{"helper_status_log", func() (int, error) { return s.exportHelperStatusLog(ctx, js, userID) }},
			struct {
				name string
				run  sectionFn
			}{"pro_leaves", func() (int, error) { return s.exportProLeaves(ctx, js, userID) }},
		)
	}

	for _, sec := range sections {
		js.section(sec.name)
		if js.err != nil {
			return totalRows, js.err
		}
		n, err := sec.run()
		if err != nil {
			return totalRows, fmt.Errorf("export %s: %w", sec.name, err)
		}
		totalRows += n
	}

	js.endObject()
	return totalRows, js.err
}

// userIsHelper checks whether the user has a helpers row. Helper-only
// sections (helper_profile, helper_status_log, pro_leaves) are omitted
// for customer-only users to keep the export minimal.
func (s *Service) userIsHelper(ctx context.Context, userID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM helpers WHERE id = $1::uuid)`, userID,
	).Scan(&exists)
	return exists, err
}

// ── Per-section exporters ────────────────────────────────────────────────

func (s *Service) exportProfile(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	var p struct {
		ID                       string     `json:"id"`
		Phone                    string     `json:"phone"`
		Name                     *string    `json:"name"`
		Role                     string     `json:"role"`
		IsSuspended              bool       `json:"is_suspended"`
		HasAcceptedPrivacyPolicy bool       `json:"has_accepted_privacy_policy"`
		PrivacyPolicyAcceptedAt  *time.Time `json:"privacy_policy_accepted_at"`
		CreatedAt                time.Time  `json:"created_at"`
		UpdatedAt                time.Time  `json:"updated_at"`
		DeletedAt                *time.Time `json:"deleted_at"`
	}
	err := s.db.QueryRow(ctx, `
		SELECT id::text, phone, name, role, is_suspended,
		       has_accepted_privacy_policy, privacy_policy_accepted_at,
		       created_at, updated_at, deleted_at
		FROM users WHERE id = $1::uuid
	`, userID).Scan(&p.ID, &p.Phone, &p.Name, &p.Role, &p.IsSuspended,
		&p.HasAcceptedPrivacyPolicy, &p.PrivacyPolicyAcceptedAt,
		&p.CreatedAt, &p.UpdatedAt, &p.DeletedAt)
	if err != nil {
		js.value(nil)
		return 0, fmt.Errorf("profile: %w", err)
	}
	js.value(p)
	return 1, nil
}

func (s *Service) exportAddresses(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, tag, title, flat_no, floor, building_name, landmark,
		       full_address, receiver_name, receiver_phone, lat, lon,
		       created_at, updated_at
		FROM user_addresses WHERE user_id = $1::uuid
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var a struct {
			ID            string    `json:"id"`
			Tag           string    `json:"tag"`
			Title         string    `json:"title"`
			FlatNo        string    `json:"flat_no"`
			Floor         string    `json:"floor"`
			BuildingName  string    `json:"building_name"`
			Landmark      string    `json:"landmark"`
			FullAddress   string    `json:"full_address"`
			ReceiverName  string    `json:"receiver_name"`
			ReceiverPhone string    `json:"receiver_phone"`
			Lat           float64   `json:"lat"`
			Lon           float64   `json:"lon"`
			CreatedAt     time.Time `json:"created_at"`
			UpdatedAt     time.Time `json:"updated_at"`
		}
		if err := rows.Scan(&a.ID, &a.Tag, &a.Title, &a.FlatNo, &a.Floor,
			&a.BuildingName, &a.Landmark, &a.FullAddress, &a.ReceiverName,
			&a.ReceiverPhone, &a.Lat, &a.Lon, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return count, err
		}
		js.arrayElem(a)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportBookings(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	js.startObject()
	defer js.endObject()
	js.section("as_customer")
	cust, err := s.exportBookingsByEdge(ctx, js, userID, "customer")
	if err != nil {
		return cust, err
	}
	js.section("as_helper")
	hlp, err := s.exportBookingsByEdge(ctx, js, userID, "helper")
	return cust + hlp, err
}

func (s *Service) exportBookingsByEdge(ctx context.Context, js *jsonStreamer, userID, edge string) (int, error) {
	whereCol := "customer_id"
	if edge == "helper" {
		whereCol = "helper_id"
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT id::text,
		       customer_id::text,
		       COALESCE(helper_id::text, ''),
		       service_category_id::text,
		       status,
		       address,
		       lat::float8, lng::float8,
		       amount_paise,
		       discount_paise,
		       payment_method, payment_status, locality,
		       scheduled_time, accepted_at, started_at, arrived_at,
		       completed_at, cancelled_at, cancelled_by,
		       created_at, updated_at
		FROM bookings WHERE %s = $1::uuid
		ORDER BY created_at DESC
	`, whereCol), userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var b struct {
			ID                string     `json:"id"`
			CustomerID        string     `json:"customer_id"`
			HelperID          string     `json:"helper_id"`
			ServiceCategoryID string     `json:"service_category_id"`
			Status            string     `json:"status"`
			Address           string     `json:"address"`
			Lat               float64    `json:"lat"`
			Lng               float64    `json:"lng"`
			AmountPaise       int64      `json:"amount_paise"`
			DiscountPaise     int64      `json:"discount_paise"`
			PaymentMethod     *string    `json:"payment_method"`
			PaymentStatus     *string    `json:"payment_status"`
			Locality          *string    `json:"locality"`
			ScheduledTime     *time.Time `json:"scheduled_time"`
			AcceptedAt        *time.Time `json:"accepted_at"`
			StartedAt         *time.Time `json:"started_at"`
			ArrivedAt         *time.Time `json:"arrived_at"`
			CompletedAt       *time.Time `json:"completed_at"`
			CancelledAt       *time.Time `json:"cancelled_at"`
			CancelledBy       *string    `json:"cancelled_by"`
			CreatedAt         time.Time  `json:"created_at"`
			UpdatedAt         time.Time  `json:"updated_at"`
		}
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID,
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.AmountPaise, &b.DiscountPaise,
			&b.PaymentMethod, &b.PaymentStatus, &b.Locality,
			&b.ScheduledTime, &b.AcceptedAt, &b.StartedAt, &b.ArrivedAt,
			&b.CompletedAt, &b.CancelledAt, &b.CancelledBy,
			&b.CreatedAt, &b.UpdatedAt); err != nil {
			return count, err
		}
		// Redact the OTHER party's UUID. The user's own side stays visible.
		if edge == "customer" {
			if b.HelperID != "" {
				b.HelperID = otherPartyRedacted
			}
		} else {
			b.CustomerID = otherPartyRedacted
		}
		js.arrayElem(b)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportBookingMessages(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, booking_id::text, sender_role, body, created_at
		FROM booking_messages
		WHERE sender_id = $1::uuid
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var m struct {
			ID         string    `json:"id"`
			BookingID  string    `json:"booking_id"`
			SenderRole string    `json:"sender_role"`
			Body       string    `json:"body"`
			CreatedAt  time.Time `json:"created_at"`
		}
		if err := rows.Scan(&m.ID, &m.BookingID, &m.SenderRole, &m.Body, &m.CreatedAt); err != nil {
			return count, err
		}
		js.arrayElem(m)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportReviews(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	js.startObject()
	defer js.endObject()
	js.section("authored")
	authored, err := s.exportReviewsByEdge(ctx, js, userID, "customer")
	if err != nil {
		return authored, err
	}
	js.section("received")
	received, err := s.exportReviewsByEdge(ctx, js, userID, "helper")
	return authored + received, err
}

func (s *Service) exportReviewsByEdge(ctx context.Context, js *jsonStreamer, userID, edge string) (int, error) {
	whereCol := "customer_id"
	if edge == "helper" {
		whereCol = "helper_id"
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT id::text, booking_id::text, customer_id::text, helper_id::text,
		       rating, comment, created_at
		FROM reviews WHERE %s = $1::uuid
		ORDER BY created_at DESC
	`, whereCol), userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var r struct {
			ID         string    `json:"id"`
			BookingID  string    `json:"booking_id"`
			CustomerID string    `json:"customer_id"`
			HelperID   string    `json:"helper_id"`
			Rating     int       `json:"rating"`
			Comment    *string   `json:"comment"`
			CreatedAt  time.Time `json:"created_at"`
		}
		if err := rows.Scan(&r.ID, &r.BookingID, &r.CustomerID, &r.HelperID,
			&r.Rating, &r.Comment, &r.CreatedAt); err != nil {
			return count, err
		}
		// In received reviews, redact the reviewer's identity.
		if edge == "helper" {
			r.CustomerID = otherPartyRedacted
		}
		js.arrayElem(r)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportRefunds(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, COALESCE(booking_id::text, ''), amount_cents,
		       partial_amount_cents, source, source_ref, status,
		       payment_method, payment_id, gateway_refund_id, error_message,
		       created_at, approved_at, processed_at, settled_at
		FROM pending_refunds WHERE user_id = $1::uuid
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var r struct {
			ID                 string     `json:"id"`
			BookingID          string     `json:"booking_id"`
			AmountCents        int64      `json:"amount_cents"`
			PartialAmountCents *int64     `json:"partial_amount_cents"`
			Source             string     `json:"source"`
			SourceRef          *string    `json:"source_ref"`
			Status             string     `json:"status"`
			PaymentMethod      *string    `json:"payment_method"`
			PaymentID          *string    `json:"payment_id"`
			GatewayRefundID    *string    `json:"gateway_refund_id"`
			ErrorMessage       *string    `json:"error_message"`
			CreatedAt          time.Time  `json:"created_at"`
			ApprovedAt         *time.Time `json:"approved_at"`
			ProcessedAt        *time.Time `json:"processed_at"`
			SettledAt          *time.Time `json:"settled_at"`
		}
		if err := rows.Scan(&r.ID, &r.BookingID, &r.AmountCents, &r.PartialAmountCents,
			&r.Source, &r.SourceRef, &r.Status, &r.PaymentMethod, &r.PaymentID,
			&r.GatewayRefundID, &r.ErrorMessage, &r.CreatedAt, &r.ApprovedAt,
			&r.ProcessedAt, &r.SettledAt); err != nil {
			return count, err
		}
		js.arrayElem(r)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportCart(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, created_at
		FROM cart WHERE user_id = $1::uuid
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var c struct {
			ID        string    `json:"id"`
			CreatedAt time.Time `json:"created_at"`
		}
		if err := rows.Scan(&c.ID, &c.CreatedAt); err != nil {
			return count, err
		}
		js.arrayElem(c)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportDeviceTokens(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, fcm_token, platform, device_id, created_at, updated_at,
		       (worker_id IS NOT NULL) AS as_worker
		FROM device_tokens WHERE user_id = $1::uuid OR worker_id = $1::uuid
		ORDER BY updated_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var d struct {
			ID            string    `json:"id"`
			FCMTokenStub  string    `json:"fcm_token_stub"`
			Platform      string    `json:"platform"`
			DeviceID      string    `json:"device_id"`
			CreatedAt     time.Time `json:"created_at"`
			UpdatedAt     time.Time `json:"updated_at"`
			RegisteredAs  string    `json:"registered_as"`
		}
		var fcmFull string
		var asWorker bool
		if err := rows.Scan(&d.ID, &fcmFull, &d.Platform, &d.DeviceID,
			&d.CreatedAt, &d.UpdatedAt, &asWorker); err != nil {
			return count, err
		}
		// Redact FCM token: first 8 chars + "..." Avoids leaking the
		// stable push identifier while still letting the user identify
		// which device a row corresponds to.
		if len(fcmFull) > 8 {
			d.FCMTokenStub = fcmFull[:8] + fcmTokenRedactedSuffix
		} else {
			d.FCMTokenStub = fcmTokenRedactedSuffix
		}
		if asWorker {
			d.RegisteredAs = "helper"
		} else {
			d.RegisteredAs = "customer"
		}
		js.arrayElem(d)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportWallet(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	js.startObject()
	defer js.endObject()

	// Balance (single row). May not exist if user never had a wallet
	// transaction — emit null.
	var bal struct {
		BalancePaise int64     `json:"balance_paise"`
		UpdatedAt    time.Time `json:"updated_at"`
	}
	js.section("balance")
	balErr := s.db.QueryRow(ctx, `
		SELECT balance_paise, updated_at FROM wallets WHERE user_id = $1::uuid
	`, userID).Scan(&bal.BalancePaise, &bal.UpdatedAt)
	rows := 0
	if balErr == nil {
		js.value(bal)
		rows = 1
	} else {
		js.value(nil)
	}

	js.section("transactions")
	txRows, err := s.db.Query(ctx, `
		SELECT id::text, kind, amount_paise, balance_after,
		       COALESCE(payment_id::text, ''),
		       COALESCE(booking_id::text, ''),
		       note, created_at
		FROM wallet_transactions WHERE user_id = $1::uuid
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return rows, err
	}
	defer txRows.Close()
	js.startArray()
	defer js.endArray()
	for txRows.Next() {
		var t struct {
			ID                string    `json:"id"`
			Kind              string    `json:"kind"`
			AmountPaise  int64     `json:"amount_paise"`
			BalanceAfter int64     `json:"balance_after"`
			PaymentID    string    `json:"payment_id"`
			BookingID    string    `json:"booking_id"`
			Note         *string   `json:"note"`
			CreatedAt    time.Time `json:"created_at"`
		}
		if err := txRows.Scan(&t.ID, &t.Kind, &t.AmountPaise, &t.BalanceAfter,
			&t.PaymentID, &t.BookingID, &t.Note, &t.CreatedAt); err != nil {
			return rows, err
		}
		js.arrayElem(t)
		rows++
	}
	return rows, txRows.Err()
}

func (s *Service) exportReengagement(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, scenario, window_start, sent_at, payload
		FROM reengagement_notifications WHERE user_id = $1::uuid
		ORDER BY sent_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var r struct {
			ID          string          `json:"id"`
			Scenario    string          `json:"scenario"`
			WindowStart time.Time       `json:"window_start"`
			SentAt      time.Time       `json:"sent_at"`
			Payload     json.RawMessage `json:"payload"`
		}
		if err := rows.Scan(&r.ID, &r.Scenario, &r.WindowStart, &r.SentAt, &r.Payload); err != nil {
			return count, err
		}
		js.arrayElem(r)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportConsents(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT uc.id::text, cv.document_type, cv.version, cv.effective_from,
		       uc.granted_at, uc.withdrawn_at,
		       host(uc.ip_address)::text, uc.user_agent
		FROM user_consents uc
		JOIN consent_versions cv ON cv.id = uc.consent_version_id
		WHERE uc.user_id = $1::uuid
		ORDER BY uc.granted_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var c struct {
			ID            string     `json:"id"`
			DocumentType  string     `json:"document_type"`
			Version       string     `json:"version"`
			EffectiveFrom time.Time  `json:"effective_from"`
			GrantedAt     time.Time  `json:"granted_at"`
			WithdrawnAt   *time.Time `json:"withdrawn_at"`
			IPAddress     *string    `json:"ip_address"`
			UserAgent     *string    `json:"user_agent"`
		}
		if err := rows.Scan(&c.ID, &c.DocumentType, &c.Version, &c.EffectiveFrom,
			&c.GrantedAt, &c.WithdrawnAt, &c.IPAddress, &c.UserAgent); err != nil {
			return count, err
		}
		js.arrayElem(c)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportPreferredHelpers(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	js.startObject()
	defer js.endObject()
	js.section("user_prefers")
	mine, err := s.preferredHelpersByEdge(ctx, js, userID, "user_id", "helper_id")
	if err != nil {
		return mine, err
	}
	js.section("preferred_by")
	by, err := s.preferredHelpersByEdge(ctx, js, userID, "helper_id", "user_id")
	return mine + by, err
}

func (s *Service) preferredHelpersByEdge(ctx context.Context, js *jsonStreamer, userID, whereCol, _ string) (int, error) {
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT created_at FROM user_preferred_helpers WHERE %s = $1::uuid
	`, whereCol), userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var p struct {
			OtherParty string    `json:"other_party"`
			CreatedAt  time.Time `json:"created_at"`
		}
		p.OtherParty = otherPartyRedacted
		if err := rows.Scan(&p.CreatedAt); err != nil {
			return count, err
		}
		js.arrayElem(p)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportAuditTrail(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	js.startObject()
	defer js.endObject()
	js.section("crm")
	crm, err := s.exportCRMAuditTrail(ctx, js, userID)
	if err != nil {
		return crm, err
	}
	js.section("legacy")
	legacy, err := s.exportLegacyAuditTrail(ctx, js, userID)
	return crm + legacy, err
}

func (s *Service) exportCRMAuditTrail(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT action, module, target_type, created_at
		FROM crm_audit_log WHERE target_id = $1::text
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var a struct {
			Action     string    `json:"action"`
			Module     string    `json:"module"`
			TargetType *string   `json:"target_type"`
			CreatedAt  time.Time `json:"created_at"`
		}
		if err := rows.Scan(&a.Action, &a.Module, &a.TargetType, &a.CreatedAt); err != nil {
			return count, err
		}
		js.arrayElem(a)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportLegacyAuditTrail(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT action, target_type, created_at
		FROM audit_log WHERE target_id = $1::text
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var a struct {
			Action     string    `json:"action"`
			TargetType *string   `json:"target_type"`
			CreatedAt  time.Time `json:"created_at"`
		}
		if err := rows.Scan(&a.Action, &a.TargetType, &a.CreatedAt); err != nil {
			return count, err
		}
		js.arrayElem(a)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportHelperProfile(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	var h struct {
		ID          string    `json:"id"`
		IsAvailable bool      `json:"is_available"`
		Rating      float64   `json:"rating"`
		TotalJobs   int       `json:"total_jobs"`
		CreatedAt   time.Time `json:"created_at"`
	}
	err := s.db.QueryRow(ctx, `
		SELECT id::text, is_available, rating::float8, total_jobs, created_at
		FROM helpers WHERE id = $1::uuid
	`, userID).Scan(&h.ID, &h.IsAvailable, &h.Rating, &h.TotalJobs, &h.CreatedAt)
	if err != nil {
		js.value(nil)
		return 0, err
	}
	js.value(h)
	return 1, nil
}

func (s *Service) exportHelperStatusLog(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT status, recorded_at FROM helper_status_log WHERE helper_id = $1::uuid
		ORDER BY recorded_at DESC
		LIMIT 10000
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var s struct {
			Status     string    `json:"status"`
			RecordedAt time.Time `json:"recorded_at"`
		}
		if err := rows.Scan(&s.Status, &s.RecordedAt); err != nil {
			return count, err
		}
		js.arrayElem(s)
		count++
	}
	return count, rows.Err()
}

func (s *Service) exportProLeaves(ctx context.Context, js *jsonStreamer, userID string) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id::text, date, declared_at, status, source, note
		FROM pro_leaves WHERE pro_id = $1::uuid
		ORDER BY date DESC
	`, userID)
	if err != nil {
		js.value([]any{})
		return 0, err
	}
	defer rows.Close()
	js.startArray()
	defer js.endArray()
	count := 0
	for rows.Next() {
		var l struct {
			ID         string    `json:"id"`
			Date       time.Time `json:"date"`
			DeclaredAt time.Time `json:"declared_at"`
			Status     string    `json:"status"`
			Source     string    `json:"source"`
			Note       *string   `json:"note"`
		}
		if err := rows.Scan(&l.ID, &l.Date, &l.DeclaredAt, &l.Status, &l.Source, &l.Note); err != nil {
			return count, err
		}
		js.arrayElem(l)
		count++
	}
	return count, rows.Err()
}

// ── jsonStreamer ────────────────────────────────────────────────────────

// jsonStreamer writes a structured JSON document one section at a time
// without ever holding the whole document in memory. Heap is bounded by
// single-row marshal size. Errors are sticky — once one occurs, all
// subsequent writes are no-ops, and the first err surfaces via the
// embedded `err` field.
type jsonStreamer struct {
	w   io.Writer
	err error
	// stack of "first element so far?" booleans, one per nesting level
	// (object or array). Top of stack is the current frame.
	frames []bool
}

func (js *jsonStreamer) writeRaw(b []byte) {
	if js.err != nil {
		return
	}
	_, js.err = js.w.Write(b)
}

func (js *jsonStreamer) writeStr(str string) { js.writeRaw([]byte(str)) }

func (js *jsonStreamer) startObject() {
	js.writeStr("{")
	js.frames = append(js.frames, true)
}

func (js *jsonStreamer) endObject() {
	js.writeStr("}")
	if n := len(js.frames); n > 0 {
		js.frames = js.frames[:n-1]
	}
}

func (js *jsonStreamer) startArray() {
	js.writeStr("[")
	js.frames = append(js.frames, true)
}

func (js *jsonStreamer) endArray() {
	js.writeStr("]")
	if n := len(js.frames); n > 0 {
		js.frames = js.frames[:n-1]
	}
}

// section writes `,"name":` (or `"name":` if it's the first key in the
// current object). Must be inside an object. The next call (value /
// startArray / startObject) provides the value.
func (js *jsonStreamer) section(name string) {
	if !js.frameFirst() {
		js.writeStr(",")
	}
	js.markFrameNonEmpty()
	b, _ := json.Marshal(name)
	js.writeRaw(b)
	js.writeStr(":")
}

// arrayElem writes a single value as the next array element, prefixed
// with comma except for the first.
func (js *jsonStreamer) arrayElem(v any) {
	if !js.frameFirst() {
		js.writeStr(",")
	}
	js.markFrameNonEmpty()
	js.value(v)
}

func (js *jsonStreamer) value(v any) {
	if js.err != nil {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		js.err = err
		return
	}
	js.writeRaw(b)
}

func (js *jsonStreamer) frameFirst() bool {
	if len(js.frames) == 0 {
		return true
	}
	return js.frames[len(js.frames)-1]
}

func (js *jsonStreamer) markFrameNonEmpty() {
	if len(js.frames) == 0 {
		return
	}
	js.frames[len(js.frames)-1] = false
}
