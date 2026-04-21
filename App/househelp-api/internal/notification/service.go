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
}

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
	return err
}

func (s *Service) sendToTokens(ctx context.Context, tokens []string, title, body string, data map[string]string) error {
	if len(tokens) == 0 {
		return nil
	}
	if s.fcmClient == nil {
		log.Info().Int("count", len(tokens)).Str("title", title).Msg("[notif] multicast mocked (FCM offline)")
		return nil
	}
	br, err := s.fcmClient.SendEachForMulticast(ctx, &messaging.MulticastMessage{
		Notification: &messaging.Notification{Title: title, Body: body},
		Data:         data,
		Tokens:       tokens,
	})
	if err != nil {
		return fmt.Errorf("FCM multicast failed: %w", err)
	}
	log.Info().Int("success", br.SuccessCount).Int("failure", br.FailureCount).Msg("[notif] multicast sent")
	return nil
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

// ── Admin broadcast ───────────────────────────────────────────────────────────

// SendToTokens is kept for admin bulk broadcast where the caller supplies tokens directly.
func (s *Service) SendToTokens(ctx context.Context, tokens []string, title, body string, data map[string]string) error {
	return s.sendToTokens(ctx, tokens, title, body, data)
}
