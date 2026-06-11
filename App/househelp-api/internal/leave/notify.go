package leave

import (
	"context"
	"fmt"
	"strings"

	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/notifications"
)

// LogCRMNotifier is the default coverage-gap sink — logs an error-level row
// per cancelled booking with structured fields the CRM team can scrape via
// Loki/Sentry. Replace with a richer notifier (Slack webhook, alerts table,
// PagerDuty) once those surfaces exist.
type LogCRMNotifier struct{}

func (n *LogCRMNotifier) NotifyCoverageGap(ctx context.Context, p CoverageGapPayload) error {
	log.Error().
		Str("alert", "coverage_gap").
		Str("booking_id", p.BookingID).
		Str("customer_id", p.CustomerID).
		Str("customer_name", p.CustomerName).
		Str("service", p.ServiceName).
		Time("scheduled_at", p.ScheduledAt).
		Str("on_leave_pro_id", p.OnLeaveProID).
		Msg("CRM ALERT: booking auto-cancelled — no replacement pro available")
	return nil
}

// RecorderCRMNotifier writes one urgent crm_notifications row per cancelled
// booking via the shared CRM notification centre. Use this in production wiring
// so the bell-icon feed lights up the moment a booking auto-cancels — strictly
// richer than LogCRMNotifier (which only emits a log line).
type RecorderCRMNotifier struct {
	Recorder *notifications.Recorder
}

func (n *RecorderCRMNotifier) NotifyCoverageGap(ctx context.Context, p CoverageGapPayload) error {
	if n == nil || n.Recorder == nil {
		return nil
	}
	title := "Booking cancelled — pro on leave"
	body := fmt.Sprintf("Pro %s is on leave. Booking %s for %s (%s) at %s could not be reassigned and was cancelled.",
		p.OnLeaveProID, p.BookingID, p.CustomerName, p.ServiceName,
		p.ScheduledAt.Format("Mon Jan 2 at 3:04 PM"))
	n.Recorder.Push(ctx, notifications.SeverityUrgent, title, body, "booking", p.BookingID)
	return nil
}

// notificationSender is the minimal surface this package needs from the
// notification.Service. We keep it as an interface so the leave package
// doesn't import the notification package directly (avoids a cycle if
// notification ever wants to import leave).
type notificationSender interface {
	NotifyCustomerHelperReassigned(ctx context.Context, customerID, bookingID string) error
	NotifyCustomerBookingCancelledNoCoverage(ctx context.Context, customerID, bookingID, when, alternatives string) error
}

// CustomerNotifierAdapter wraps a sender that satisfies notificationSender
// and exposes the leave.CustomerNotifier interface.
type CustomerNotifierAdapter struct {
	Sender notificationSender
}

func (a *CustomerNotifierAdapter) NotifyHelperReassigned(ctx context.Context, customerID, bookingID string) error {
	if a == nil || a.Sender == nil {
		return nil
	}
	return a.Sender.NotifyCustomerHelperReassigned(ctx, customerID, bookingID)
}

func (a *CustomerNotifierAdapter) NotifyBookingCancelledNoCoverage(ctx context.Context, customerID, bookingID, when string, alts []string) error {
	if a == nil || a.Sender == nil {
		return nil
	}
	return a.Sender.NotifyCustomerBookingCancelledNoCoverage(ctx, customerID, bookingID, when, strings.Join(alts, " · "))
}

// proNotificationSender is the minimal pro-push surface this package needs.
type proNotificationSender interface {
	NotifyProBookingAssigned(ctx context.Context, proID, bookingID, serviceType string) error
}

// ProNotifierAdapter exposes the leave.ProNotifier interface over a sender
// that satisfies proNotificationSender (notification.Service).
type ProNotifierAdapter struct {
	Sender proNotificationSender
}

func (a *ProNotifierAdapter) NotifyProBookingAssigned(ctx context.Context, proID, bookingID, serviceType string) error {
	if a == nil || a.Sender == nil {
		return nil
	}
	return a.Sender.NotifyProBookingAssigned(ctx, proID, bookingID, serviceType)
}
