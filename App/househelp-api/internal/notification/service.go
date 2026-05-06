package notification

import (
	"context"
	"fmt"
	"os"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"google.golang.org/api/option"
)

// Service handles push notification delivery via Firebase Cloud Messaging.
// All public methods accept user IDs — token lookup happens internally.
type Service struct {
	fcmClient *messaging.Client
	db        *pgxpool.Pool
	// resolver is optional; when wired, the service prunes
	// device_tokens rows whose FCM token Firebase reports as
	// "unregistered" (uninstalled app, OS revoked token, token
	// rotated). nil-safe across all internal callers — production
	// deploys should call SetTokenResolver. Audit C-8 / B2-03
	// chunk 18.
	resolver *TokenResolver
}

// SetTokenResolver wires the resolver used to prune dead FCM tokens
// on Firebase "unregistered" errors. Nil is OK (pruning silently
// skipped) but production deploys should call this — without it,
// dead tokens accumulate forever and every push attempt to those
// tokens fails silently.
func (s *Service) SetTokenResolver(r *TokenResolver) { s.resolver = r }

// NewService initialises FCM and wires a DB pool for token lookup.
func NewService(ctx context.Context, db *pgxpool.Pool) *Service {
	var opts []option.ClientOption
	if creds := os.Getenv("FIREBASE_CREDENTIALS_JSON"); creds != "" {
		opts = append(opts, option.WithCredentialsFile(creds))
	}

	app, err := firebase.NewApp(ctx, nil, opts...)
	if err != nil {
		log.Warn().Err(err).Msg("[notif] firebase init failed — notifications will be mocked")
		return &Service{db: db}
	}

	client, err := app.Messaging(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("[notif] FCM client init failed — notifications will be mocked")
		return &Service{db: db}
	}

	return &Service{fcmClient: client, db: db}
}

// ── Token lookup ──────────────────────────────────────────────────────────────

// fcmToken fetches a single user's FCM token from the DB.
// Returns "" if the user has no token or the DB is unavailable.
func (s *Service) fcmToken(ctx context.Context, userID string) string {
	if s.db == nil {
		return ""
	}
	qCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var token string
	err := s.db.QueryRow(qCtx,
		`SELECT COALESCE(fcm_token, '') FROM users WHERE id = $1`,
		userID,
	).Scan(&token)
	if err != nil {
		log.Debug().Err(err).Str("user_id", userID).Msg("[notif] failed to fetch FCM token")
		return ""
	}
	return token
}

// fcmTokens fetches FCM tokens for a slice of user IDs in one query.
// Returns only tokens that exist and are non-empty.
func (s *Service) fcmTokens(ctx context.Context, userIDs []string) []string {
	if s.db == nil || len(userIDs) == 0 {
		return nil
	}
	qCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	rows, err := s.db.Query(qCtx,
		`SELECT fcm_token FROM users WHERE id = ANY($1::uuid[]) AND fcm_token IS NOT NULL AND fcm_token != ''`,
		userIDs,
	)
	if err != nil {
		log.Warn().Err(err).Msg("[notif] failed to fetch FCM tokens for user batch")
		return nil
	}
	defer rows.Close()

	var tokens []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil && t != "" {
			tokens = append(tokens, t)
		}
	}
	return tokens
}

// ── Low-level send ────────────────────────────────────────────────────────────

func (s *Service) sendToToken(ctx context.Context, token, title, body string, data map[string]string) error {
	if s.fcmClient == nil {
		log.Info().Str("title", title).Str("body", body).Msg("[notif] mocked (FCM offline)")
		return nil
	}
	_, err := s.fcmClient.Send(ctx, &messaging.Message{
		Notification: &messaging.Notification{Title: title, Body: body},
		Data:         data,
		Token:        token,
	})
	// Prune dead tokens before propagating the error. The caller
	// still gets the original err — this is a side-effect cleanup,
	// not a recovery. Audit C-8 / B2-03 chunk 18.
	s.pruneIfDead(ctx, token, err)
	return err
}

// isUnregisteredErr is the test seam for messaging.IsUnregistered.
// Production assigns the real Firebase helper; tests override this
// var to exercise the prune path without synthesising a
// *internal.FirebaseError (which lives in firebase-admin-go's
// internal package and can't be constructed from outside).
var isUnregisteredErr = messaging.IsUnregistered

// tokenStub returns the first 8 characters of an FCM token followed
// by "...". Full tokens are stable cross-session identifiers in
// Google's push system; logging them in plain text leaves a trail
// that anyone with log-aggregator access can use to silence-push a
// device. Matches the chunk-11 /me/export redaction shape.
func tokenStub(token string) string {
	if len(token) <= 8 {
		return token + "..."
	}
	return token[:8] + "..."
}

// pruneIfDead checks whether err is Firebase's "unregistered token"
// sentinel and, if so, deletes the token from device_tokens. Nil-safe
// on resolver, token, and err. Failures to prune are logged but not
// propagated — best-effort cleanup, not a critical path. Caller's
// original err is unaffected.
//
// Used by both single-recipient (sendToToken) and customer-side
// multicast (sendToTokensWithReport, post-collection) paths so dead
// tokens get removed regardless of which send shape was used. Audit
// C-8 / B2-03 chunk 18.
func (s *Service) pruneIfDead(ctx context.Context, token string, err error) {
	if s.resolver == nil || token == "" || err == nil {
		return
	}
	if !isUnregisteredErr(err) {
		return
	}
	if delErr := s.resolver.DeleteToken(ctx, token); delErr != nil {
		log.Warn().Err(delErr).
			Str("token_stub", tokenStub(token)).
			Msg("[notif] failed to prune unregistered FCM token")
		return
	}
	log.Info().
		Str("token_stub", tokenStub(token)).
		Msg("[notif] pruned unregistered FCM token")
}

func (s *Service) sendToTokens(ctx context.Context, tokens []string, title, body string, data map[string]string) error {
	_, err := s.sendToTokensWithReport(ctx, tokens, title, body, data)
	return err
}

// MulticastReport carries FCM batch outcomes back to callers that need to
// (a) record send statistics and (b) prune tokens that FCM has flagged as
// permanently invalid (e.g. uninstalled apps).
type MulticastReport struct {
	Success      int
	Failure      int
	InvalidTokens []string // Tokens FCM reports as unregistered / invalid — safe to delete.
}

// sendToTokensWithReport is the reporting variant of sendToTokens. It walks
// the per-message responses to surface "unregistered" tokens so the caller
// can purge them from device_tokens. When FCM is mocked (no client) the
// report is empty.
func (s *Service) sendToTokensWithReport(ctx context.Context, tokens []string, title, body string, data map[string]string) (*MulticastReport, error) {
	rep := &MulticastReport{}
	if len(tokens) == 0 {
		return rep, nil
	}
	if s.fcmClient == nil {
		log.Info().Int("count", len(tokens)).Str("title", title).Msg("[notif] multicast mocked (FCM offline)")
		rep.Success = len(tokens)
		return rep, nil
	}
	br, err := s.fcmClient.SendEachForMulticast(ctx, &messaging.MulticastMessage{
		Notification: &messaging.Notification{Title: title, Body: body},
		Data:         data,
		Tokens:       tokens,
	})
	if err != nil {
		return rep, fmt.Errorf("FCM multicast failed: %w", err)
	}
	rep.Success = br.SuccessCount
	rep.Failure = br.FailureCount
	for i, r := range br.Responses {
		if r == nil || r.Success || r.Error == nil {
			continue
		}
		// Per-token "this device is gone" signals: registration-token-not-
		// registered AND invalid-argument both indicate the token will never
		// succeed again. Prune from device_tokens.
		if messaging.IsUnregistered(r.Error) {
			if i < len(tokens) {
				rep.InvalidTokens = append(rep.InvalidTokens, tokens[i])
			}
		}
	}
	// Actually delete the dead tokens. Pre-chunk-18, the multicast
	// path collected InvalidTokens into the report but customer-side
	// callers (sendToTokens, NotifyProNewBookingInvite, etc.)
	// discarded the report — dead tokens leaked forever. The report
	// is still returned so explicit consumers (CRM growth campaigns)
	// can do their own bookkeeping; pruning here is the default
	// behaviour. Audit C-8 / B2-03 chunk 18.
	if s.resolver != nil && len(rep.InvalidTokens) > 0 {
		for _, deadToken := range rep.InvalidTokens {
			if delErr := s.resolver.DeleteToken(ctx, deadToken); delErr != nil {
				log.Warn().Err(delErr).
					Str("token_stub", tokenStub(deadToken)).
					Msg("[notif] failed to prune unregistered FCM token (multicast)")
			}
		}
		log.Info().Int("count", len(rep.InvalidTokens)).
			Msg("[notif] pruned unregistered FCM tokens (multicast)")
	}
	log.Info().Int("success", rep.Success).Int("failure", rep.Failure).Int("invalid", len(rep.InvalidTokens)).Msg("[notif] multicast sent")
	return rep, nil
}

// ── Customer notifications ────────────────────────────────────────────────────

// NotifyCustomerBookingAccepted tells the customer their helper is on the way.
func (s *Service) NotifyCustomerBookingAccepted(ctx context.Context, customerID, helperName, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Helper on the way!",
		helperName+" has accepted and is heading to you.",
		map[string]string{
			"type":       "booking_accepted",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerBookingCancelled tells the customer their booking was cancelled.
func (s *Service) NotifyCustomerBookingCancelled(ctx context.Context, customerID, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Booking Cancelled",
		"Your booking has been cancelled. Tap to rebook.",
		map[string]string{
			"type":       "booking_cancelled",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerNoHelperFound tells the customer the search timed out.
func (s *Service) NotifyCustomerNoHelperFound(ctx context.Context, customerID, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"No Helper Available",
		"We couldn't find a helper nearby. Please try again.",
		map[string]string{
			"type":       "no_helper_found",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerBookingCompleted tells the customer the job is done.
func (s *Service) NotifyCustomerBookingCompleted(ctx context.Context, customerID, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Service Completed",
		"Your service is done! Rate your experience.",
		map[string]string{
			"type":       "booking_completed",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerRefundProcessed tells the customer their refund has been
// initiated. amountINR is the human-readable rupee amount (e.g. "499" or
// "1,250"). The body intentionally hedges with "5-7 business days" so support
// volume doesn't spike when the bank settles slower than the gateway.
func (s *Service) NotifyCustomerRefundProcessed(ctx context.Context, customerID, amountINR, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	data := map[string]string{
		"type": "refund_processed",
	}
	if bookingID != "" {
		data["booking_id"] = bookingID
	}
	return s.sendToToken(ctx, token,
		"Refund processed",
		"Your refund of ₹"+amountINR+" has been processed. It will reflect in your account within 5-7 business days.",
		data,
	)
}

// NotifyCustomerReengagement sends a generic personalized reminder notification.
func (s *Service) NotifyCustomerReengagement(ctx context.Context, customerID, title, body string, data map[string]string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token, title, body, data)
}

// ── Pro notifications ─────────────────────────────────────────────────────────

// NotifyProNewBookingInvite notifies a set of matched pros about a nearby job.
// helperIDs is the list of helper user IDs returned by the matching engine.
func (s *Service) NotifyProNewBookingInvite(ctx context.Context, helperIDs []string, bookingID, serviceType string) error {
	tokens := s.fcmTokens(ctx, helperIDs)
	if len(tokens) == 0 {
		return nil
	}
	return s.sendToTokens(ctx, tokens,
		"New Job Nearby",
		"A customer needs "+serviceType+" service. Tap to accept.",
		map[string]string{
			"type":       "new_booking_invite",
			"booking_id": bookingID,
		},
	)
}

// NotifyProBookingCancelled tells the assigned pro the customer cancelled.
func (s *Service) NotifyProBookingCancelled(ctx context.Context, helperID, bookingID string) error {
	token := s.fcmToken(ctx, helperID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Job Cancelled",
		"The customer has cancelled this booking.",
		map[string]string{
			"type":       "booking_cancelled_for_pro",
			"booking_id": bookingID,
		},
	)
}

// NotifyProBookingAssigned notifies a pro they've been assigned a scheduled booking.
func (s *Service) NotifyProBookingAssigned(ctx context.Context, helperID, bookingID, serviceType string) error {
	token := s.fcmToken(ctx, helperID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Job Assigned",
		"You have a new scheduled "+serviceType+" job. Check your bookings.",
		map[string]string{
			"type":       "booking_assigned",
			"booking_id": bookingID,
		},
	)
}

// NotifyProBookingReassigned tells the new pro that an admin reassigned an
// existing booking to them.
func (s *Service) NotifyProBookingReassigned(ctx context.Context, helperID, bookingID, serviceType string) error {
	token := s.fcmToken(ctx, helperID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Job Reassigned to You",
		"You've been assigned a "+serviceType+" job by support. Check your bookings.",
		map[string]string{
			"type":       "booking_reassigned",
			"booking_id": bookingID,
		},
	)
}

// NotifyProBookingUnassigned tells the previous pro that an admin moved their
// booking to a different worker.
func (s *Service) NotifyProBookingUnassigned(ctx context.Context, helperID, bookingID string) error {
	token := s.fcmToken(ctx, helperID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Job Reassigned",
		"This job has been reassigned to another helper by support.",
		map[string]string{
			"type":       "booking_unassigned",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerWorkerChanged tells the customer that an admin reassigned
// their booking to a different worker.
func (s *Service) NotifyCustomerWorkerChanged(ctx context.Context, customerID, newHelperName, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Helper Changed",
		newHelperName+" will now be handling your booking.",
		map[string]string{
			"type":       "worker_changed",
			"booking_id": bookingID,
		},
	)
}

// ── Leave-driven reassignment / cancellation ────────────────────────────────

// NotifyCustomerHelperReassigned tells the customer that their assigned pro
// went on leave and a different one is taking over the same slot.
func (s *Service) NotifyCustomerHelperReassigned(ctx context.Context, customerID, bookingID string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	return s.sendToToken(ctx, token,
		"Helper updated",
		"Your service provider has changed. Your booking is confirmed.",
		map[string]string{
			"type":       "helper_reassigned",
			"booking_id": bookingID,
		},
	)
}

// NotifyCustomerBookingCancelledNoCoverage tells the customer their booking
// was cancelled because no replacement pro was available, and includes a
// list of nearest open alternatives.
func (s *Service) NotifyCustomerBookingCancelledNoCoverage(ctx context.Context, customerID, bookingID, when, alternatives string) error {
	token := s.fcmToken(ctx, customerID)
	if token == "" {
		return nil
	}
	body := "We're sorry, your booking on " + when + " has been cancelled as no service provider is available."
	if alternatives != "" {
		body += " Here are the nearest available slots: " + alternatives
	}
	return s.sendToToken(ctx, token,
		"Booking cancelled",
		body,
		map[string]string{
			"type":       "cancelled_no_coverage",
			"booking_id": bookingID,
		},
	)
}

// ── Admin broadcast ───────────────────────────────────────────────────────────

// SendToTokens is kept for admin bulk broadcast where the caller supplies tokens directly.
func (s *Service) SendToTokens(ctx context.Context, tokens []string, title, body string, data map[string]string) error {
	return s.sendToTokens(ctx, tokens, title, body, data)
}

// SendData fires a data-only push to all of a user's registered devices. No
// `notification` payload is included, so iOS / Android won't auto-display
// anything — the app's foreground/background handler routes on the `data`
// fields (e.g. type="SCHEDULED_INVITE") and decides the UX.
//
// Used by the scheduled-dispatch + stealth-dispatch invite chains: the pro
// must land on the new ProScheduledInviteScreen, never on the OS tray.
//
// FCM background data delivery on iOS requires `content-available: 1` —
// Firebase Admin SDK sets that automatically when only Data is provided
// (see APNS payload builder in firebase.google.com/go/v4/messaging).
func (s *Service) SendData(ctx context.Context, userID string, data map[string]string) error {
	tokens, err := s.deviceTokensFor(ctx, userID)
	if err != nil {
		return fmt.Errorf("send data: load tokens: %w", err)
	}
	if len(tokens) == 0 {
		return nil // user has no registered devices — nothing to do
	}
	return s.sendDataToTokens(ctx, tokens, data)
}

// deviceTokensFor returns every active device_tokens row for the given
// account, regardless of role (user_id or worker_id). Used by SendData so
// scheduled invites land on every device a pro is signed in on.
func (s *Service) deviceTokensFor(ctx context.Context, accountID string) ([]string, error) {
	if s.db == nil {
		return nil, nil
	}
	qCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	rows, err := s.db.Query(qCtx, `
		SELECT DISTINCT dt.fcm_token
		FROM device_tokens dt
		WHERE (dt.user_id = $1::uuid OR dt.worker_id = $1::uuid)
		  AND dt.fcm_token <> ''
		  AND dt.updated_at > now() - interval '90 days'
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil && t != "" {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

// sendDataToTokens is the multicast data-only sender. Skips the notification
// payload so the OS tray stays out of it; the app routes via data["type"].
func (s *Service) sendDataToTokens(ctx context.Context, tokens []string, data map[string]string) error {
	if len(tokens) == 0 {
		return nil
	}
	if s.fcmClient == nil {
		log.Info().Int("count", len(tokens)).Interface("data", data).Msg("[notif] data-only multicast mocked (FCM offline)")
		return nil
	}
	_, err := s.fcmClient.SendEachForMulticast(ctx, &messaging.MulticastMessage{
		Data:   data,
		Tokens: tokens,
		Android: &messaging.AndroidConfig{
			Priority: "high",
		},
		APNS: &messaging.APNSConfig{
			Headers: map[string]string{
				// content-available wakes the app for background delivery.
				"apns-priority":   "5",
				"apns-push-type":  "background",
			},
			Payload: &messaging.APNSPayload{
				Aps: &messaging.Aps{
					ContentAvailable: true,
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("FCM data multicast failed: %w", err)
	}
	return nil
}

// SendToTokensWithReport is the reporting-variant of SendToTokens. Returns
// per-batch success/failure counts and the list of invalid tokens that the
// caller should evict from its token store.
func (s *Service) SendToTokensWithReport(ctx context.Context, tokens []string, title, body string, data map[string]string) (*MulticastReport, error) {
	return s.sendToTokensWithReport(ctx, tokens, title, body, data)
}
