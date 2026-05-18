package shift

import (
	"context"

	"github.com/rs/zerolog/log"
)

// PushClient is the narrow surface the shift system needs. The
// concrete implementation (in cmd/api/main.go) wraps
// notification.Service. Defined as an interface so the shift
// package never imports notification and tests can stub it.
type PushClient interface {
	SendToAdmins(ctx context.Context, title, body string, data map[string]string) error
	SendToProByID(ctx context.Context, proID, title, body string, data map[string]string) error
}

// NewNotifier wires a Notifier that pushes via the supplied push
// client. Pro-name lookups happen in the service via repo.NameForPro
// before the helper is invoked, so this adapter stays narrow.
func NewNotifier(push PushClient) Notifier {
	return &fcmNotifier{push: push}
}

type fcmNotifier struct {
	push PushClient
}

func (n *fcmNotifier) PushToPro(ctx context.Context, proID, title, body string, data map[string]string) error {
	if n.push == nil {
		return nil
	}
	return n.push.SendToProByID(ctx, proID, title, body, data)
}

func (n *fcmNotifier) PushToAdminGroup(ctx context.Context, title, body string, data map[string]string) error {
	if n.push == nil {
		return nil
	}
	err := n.push.SendToAdmins(ctx, title, body, data)
	if err != nil {
		log.Warn().Err(err).Msg("[shift.notifier] admin fan-out failed")
	}
	return err
}

// PushZoneApprovalPending is the typed wrapper used by the service.
// Body interpolates pro_name when available.
func (s *Service) PushZoneApprovalPending(ctx context.Context, requestID, proID, proName string) {
	if s.ntf == nil {
		return
	}
	body := "A pro is outside their assigned zone and needs manual approval"
	if proName != "" {
		body = proName + " is outside their assigned zone and needs manual approval"
	}
	_ = s.ntf.PushToAdminGroup(ctx, "Zone approval needed", body, map[string]string{
		"type":       "zone_approval_pending",
		"request_id": requestID,
		"pro_id":     proID,
		"pro_name":   proName,
	})
}

// PushZoneApprovalRejected notifies the pro that admin rejected their
// outside-zone request. Body interpolates the admin's notes when present
// so the pro knows why and what to do next.
func (s *Service) PushZoneApprovalRejected(ctx context.Context, proID, requestID, notes string) {
	if s.ntf == nil {
		return
	}
	body := "Your zone exception request was rejected. Please head to your assigned zone."
	if notes != "" {
		body = "Reason: " + notes + ". Please head to your assigned zone to go online."
	}
	_ = s.ntf.PushToPro(ctx, proID,
		"Zone exception rejected",
		body,
		map[string]string{
			"type":       "zone_approval_rejected",
			"request_id": requestID,
		})
}

// PushZoneApprovalGranted notifies the pro that admin approved
// their outside-zone request. Hindi copy per spec.
func (s *Service) PushZoneApprovalGranted(ctx context.Context, proID, requestID, commitmentID string) {
	if s.ntf == nil {
		return
	}
	_ = s.ntf.PushToPro(ctx, proID,
		"ज़ोन मंज़ूरी मिल गई",
		"अब आप ऑनलाइन जा सकते हैं",
		map[string]string{
			"type":          "zone_approval_granted",
			"request_id":    requestID,
			"commitment_id": commitmentID,
		})
}
