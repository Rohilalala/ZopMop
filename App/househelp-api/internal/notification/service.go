package notification

import (
	"context"

	"github.com/rs/zerolog/log"
)

// Service handles push notification delivery.
// Currently a stub for FCM (Firebase Cloud Messaging) integration.
type Service struct {
	// fcmClient would be the Firebase messaging client.
	// fcmClient *messaging.Client
}

// NewService creates a new notification service.
func NewService() *Service {
	return &Service{}
}

// SendToUser sends a push notification to a specific user.
// TODO: Implement FCM integration.
//
// In production:
// 1. Look up user's FCM token from database
// 2. Build FCM message with title, body, data payload
// 3. Send via Firebase Admin SDK
// 4. Handle token refresh/invalidation
func (s *Service) SendToUser(ctx context.Context, userID, title, body string, data map[string]string) error {
	log.Info().
		Str("user_id", userID).
		Str("title", title).
		Str("body", body).
		Msg("push notification sent (stub)")

	// TODO: Implement FCM send.
	// message := &messaging.Message{
	//     Notification: &messaging.Notification{
	//         Title: title,
	//         Body:  body,
	//     },
	//     Data:  data,
	//     Token: fcmToken,
	// }
	// _, err := s.fcmClient.Send(ctx, message)
	// return err

	return nil
}

// SendToMultiple sends a push notification to multiple users.
// TODO: Implement FCM multicast.
func (s *Service) SendToMultiple(ctx context.Context, userIDs []string, title, body string, data map[string]string) error {
	for _, userID := range userIDs {
		if err := s.SendToUser(ctx, userID, title, body, data); err != nil {
			log.Error().Err(err).Str("user_id", userID).Msg("failed to send notification")
			// Continue sending to remaining users even if one fails.
		}
	}
	return nil
}

// NotifyBookingAccepted notifies the customer that a helper accepted their booking.
func (s *Service) NotifyBookingAccepted(ctx context.Context, customerID, helperName, bookingID string) error {
	return s.SendToUser(ctx, customerID,
		"Booking Accepted!",
		helperName+" is on the way to your location.",
		map[string]string{
			"type":       "booking_accepted",
			"booking_id": bookingID,
		},
	)
}

// NotifyNewBookingRequest notifies helpers about a new booking in their area.
func (s *Service) NotifyNewBookingRequest(ctx context.Context, helperIDs []string, bookingID, serviceType string) error {
	return s.SendToMultiple(ctx, helperIDs,
		"New Booking Request",
		"A customer needs "+serviceType+" service nearby.",
		map[string]string{
			"type":       "new_booking",
			"booking_id": bookingID,
		},
	)
}
