package notification

import (
	"context"
	"fmt"
	"os"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"github.com/rs/zerolog/log"
	"google.golang.org/api/option"
)

// Service handles push notification delivery via Firebase Cloud Messaging.
type Service struct {
	fcmClient *messaging.Client
}

// NewService creates a new notification service and initializes FCM.
func NewService(ctx context.Context) *Service {
	var opts []option.ClientOption
	if creds := os.Getenv("FIREBASE_CREDENTIALS_JSON"); creds != "" {
		opts = append(opts, option.WithCredentialsFile(creds))
	}

	app, err := firebase.NewApp(ctx, nil, opts...)
	if err != nil {
		log.Warn().Err(err).Msg("firebase config missing or invalid, notifications will mock")
		return &Service{}
	}

	client, err := app.Messaging(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("failed to initialize FCM client, notifications will mock")
		return &Service{}
	}

	return &Service{fcmClient: client}
}

// SendToUser is kept for backwards compatibility or single token pushes.
// It requires an FCM token which must be fetched by the caller first!
func (s *Service) SendToUser(ctx context.Context, fcmToken, title, body string, data map[string]string) error {
	if s.fcmClient == nil {
		log.Info().Str("title", title).Str("body", body).Msg("notification mocked (fcm offline)")
		return nil
	}

	message := &messaging.Message{
		Notification: &messaging.Notification{
			Title: title,
			Body:  body,
		},
		Data:  data,
		Token: fcmToken,
	}

	_, err := s.fcmClient.Send(ctx, message)
	return err
}

// SendToTokens sends a push notification to multiple FCM tokens in a single batch.
func (s *Service) SendToTokens(ctx context.Context, tokens []string, title, body string, data map[string]string) error {
	if len(tokens) == 0 {
		return nil
	}

	if s.fcmClient == nil {
		log.Info().Int("count", len(tokens)).Str("title", title).Msg("multicast mocked (fcm offline)")
		return nil
	}

	msg := &messaging.MulticastMessage{
		Notification: &messaging.Notification{
			Title: title,
			Body:  body,
		},
		Data:   data,
		Tokens: tokens,
	}

	br, err := s.fcmClient.SendMulticast(ctx, msg)
	if err != nil {
		return fmt.Errorf("fcm multicast failed: %w", err)
	}

	log.Info().Int("success_count", br.SuccessCount).Int("failure_count", br.FailureCount).Msg("fcm multicast completed")
	return nil
}

// SendToMultiple uses SendToTokens sequentially.
func (s *Service) SendToMultiple(ctx context.Context, fcmTokens []string, title, body string, data map[string]string) error {
	return s.SendToTokens(ctx, fcmTokens, title, body, data)
}

// NotifyBookingAccepted mock wrapper. Caller should supply the customer's FCM token.
// IMPORTANT: Currently, this requires booking service to pull the FCM token first before calling this.
func (s *Service) NotifyBookingAccepted(ctx context.Context, customerFCMToken, helperName, bookingID string) error {
	if customerFCMToken == "" {
		return nil // gracefully fail if user has no device
	}
	return s.SendToUser(ctx, customerFCMToken,
		"Booking Accepted!",
		helperName+" is on the way to your location.",
		map[string]string{
			"type":       "booking_accepted",
			"booking_id": bookingID,
		},
	)
}

// NotifyNewBookingRequest notifies helpers about a new booking in their area.
func (s *Service) NotifyNewBookingRequest(ctx context.Context, helperFCMTokens []string, bookingID, serviceType string) error {
	return s.SendToTokens(ctx, helperFCMTokens,
		"New Booking Request",
		"A customer needs "+serviceType+" service nearby.",
		map[string]string{
			"type":       "new_booking",
			"booking_id": bookingID,
		},
	)
}
