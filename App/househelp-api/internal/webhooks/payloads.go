package webhooks

import "time"

// Stable contracts for outbound webhook payloads. Domain types (booking.Booking,
// helper.Profile, etc.) intentionally stay out of these structs so internal
// renames or new private fields never leak to subscribers.

// Event names as constants so producers and the CRM subscription UI agree on
// the wire string.
const (
	EventOrderCreated   = "order.created"
	EventOrderAssigned  = "order.assigned"
	EventOrderStarted   = "order.started"
	EventOrderCompleted = "order.completed"
	EventOrderCancelled = "order.cancelled"
	EventOrderReassigned = "order.reassigned"
	EventLeaveDeclared   = "pro.leave.declared"
	EventWorkerOnline   = "worker.online"
	EventWorkerOffline  = "worker.offline"

	// Admin (CRM) events. Fired from the cmd/crm-api side after an admin
	// action's DB write succeeds.
	EventAdminUserBanned       = "admin.user.banned"
	EventAdminUserSuspended    = "admin.user.suspended"
	EventAdminWorkerSuspended  = "admin.worker.suspended"
	EventAdminWorkerApproved   = "admin.worker.approved"
	EventAdminFlagChanged      = "admin.flag.changed"
	EventAdminPromoCreated     = "admin.promo.created"
	EventAdminSurgeActivated   = "admin.surge.activated"
	EventRefundApproved        = "refund.approved"
	EventRefundProcessed       = "refund.processed"
)

// OrderEvent is the base shape for order.* events.
type OrderEvent struct {
	OrderID           string    `json:"order_id"`
	Status            string    `json:"status"`
	CustomerID        string    `json:"customer_id"`
	HelperID          *string   `json:"helper_id,omitempty"`
	ServiceCategoryID string    `json:"service_category_id,omitempty"`
	AmountPaise       int64     `json:"price_cents,omitempty"`
	OccurredAt  time.Time `json:"occurred_at"`
}

// OrderCancelledEvent extends OrderEvent with cancellation metadata.
type OrderCancelledEvent struct {
	OrderEvent
	CancelledBy string `json:"cancelled_by,omitempty"` // "customer" | "helper" | "admin" | "system"
	Reason      string `json:"reason,omitempty"`
}

// LeaveDeclaredEvent fires when a pro declares a leave day. Subscribers
// receive both the per-booking reassignment outcomes (so CRM dashboards can
// reflect cancellations promptly) and a summary count.
type LeaveDeclaredEvent struct {
	ProID         string                 `json:"pro_id"`
	LeaveDate     string                 `json:"leave_date"` // YYYY-MM-DD (IST)
	Reassigned    int                    `json:"reassigned"`
	Cancelled     int                    `json:"cancelled"`
	Outcomes      []LeaveBookingOutcome  `json:"outcomes,omitempty"`
	BalanceAfter  int                    `json:"balance_after"`
	OccurredAt    time.Time              `json:"occurred_at"`
}

// LeaveBookingOutcome is the per-booking result of the reassignment loop.
type LeaveBookingOutcome struct {
	BookingID    string `json:"booking_id"`
	Cancelled    bool   `json:"cancelled"`
	NewProID     string `json:"new_pro_id,omitempty"`
	CustomerID   string `json:"customer_id,omitempty"`
	CustomerName string `json:"customer_name,omitempty"`
	ServiceName  string `json:"service_name,omitempty"`
	ScheduledAt  string `json:"scheduled_at,omitempty"`
}

// OrderReassignedEvent fires when an admin moves a booking from one worker to another.
type OrderReassignedEvent struct {
	OrderID          string    `json:"order_id"`
	PreviousHelperID string    `json:"previous_helper_id"`
	NewHelperID      string    `json:"new_helper_id"`
	Reason           string    `json:"reason,omitempty"`
	ReassignedBy     string    `json:"reassigned_by"` // admin email
	OccurredAt       time.Time `json:"occurred_at"`
}

// WorkerStatusEvent is fired for worker.online / worker.offline.
type WorkerStatusEvent struct {
	HelperID   string    `json:"helper_id"`
	IsOnline   bool      `json:"is_online"`
	Lat        *float64  `json:"lat,omitempty"`
	Lng        *float64  `json:"lng,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// ── Admin / CRM payloads ───────────────────────────────────────────────

// AdminUserActionEvent fires for ban / suspend / unban / unsuspend on a user.
type AdminUserActionEvent struct {
	UserID     string    `json:"user_id"`
	Action     string    `json:"action"` // "banned" | "suspended" | "unbanned" | "unsuspended"
	Reason     string    `json:"reason,omitempty"`
	AdminID    string    `json:"admin_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

// AdminWorkerActionEvent fires for approve / reject / suspend / unsuspend on a worker.
type AdminWorkerActionEvent struct {
	WorkerID   string    `json:"worker_id"`
	Action     string    `json:"action"` // "suspended" | "approved" | "rejected" | ...
	Reason     string    `json:"reason,omitempty"`
	AdminID    string    `json:"admin_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

// AdminFlagChangedEvent fires after a flag value is set successfully.
type AdminFlagChangedEvent struct {
	Key        string      `json:"key"`
	OldValue   any         `json:"old_value,omitempty"`
	NewValue   any         `json:"new_value"`
	AdminID    string      `json:"admin_id"`
	OccurredAt time.Time   `json:"occurred_at"`
}

// AdminPromoCreatedEvent fires after a new promo row is inserted.
type AdminPromoCreatedEvent struct {
	PromoID    string    `json:"promo_id"`
	Code       string    `json:"code"`
	AdminID    string    `json:"admin_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

// AdminSurgeActivatedEvent fires after a surge rule is created.
type AdminSurgeActivatedEvent struct {
	SurgeID    string    `json:"surge_id"`
	Zone       string    `json:"zone,omitempty"`
	Multiplier float64   `json:"multiplier"`
	AdminID    string    `json:"admin_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

// RefundApprovedEvent fires after a refund moves to status='approved'.
type RefundApprovedEvent struct {
	RefundID    string    `json:"refund_id"`
	UserID      string    `json:"user_id"`
	AmountCents int64     `json:"amount_cents"`
	AdminID     string    `json:"admin_id"`
	OccurredAt  time.Time `json:"occurred_at"`
}

// RefundProcessedEvent fires after a refund moves to status='processed' or
// 'processed_manual'. Subscribers use this to close the loop on accounting
// (e.g. stripe of cash, support follow-up email, etc).
type RefundProcessedEvent struct {
	RefundID        string    `json:"refund_id"`
	BookingID       string    `json:"booking_id,omitempty"`
	UserID          string    `json:"user_id"`
	AmountCents     int64     `json:"amount_cents"`
	PaymentMethod   string    `json:"payment_method,omitempty"`
	GatewayRefundID string    `json:"gateway_refund_id,omitempty"`
	Manual          bool      `json:"manual"`
	AdminID         string    `json:"admin_id"`
	OccurredAt      time.Time `json:"occurred_at"`
}
