package roomies

import "time"

// MemberRole is a typed enum for address group roles.
type MemberRole string

const (
	RoleHost   MemberRole = "host"
	RoleMember MemberRole = "member"
)

// DebtStatus is a typed enum for ledger debt lifecycle.
type DebtStatus string

const (
	DebtActive              DebtStatus = "active"
	DebtPendingVerification DebtStatus = "pending_verification"
	DebtSettled             DebtStatus = "settled"
)

// ChoreOrderStatus is a typed enum for chore order lifecycle.
type ChoreOrderStatus string

const (
	ChoreCreated   ChoreOrderStatus = "created"
	ChorePaid      ChoreOrderStatus = "paid"
	ChoreCancelled ChoreOrderStatus = "cancelled"
)

// AddressGroup represents a shared physical home group.
type AddressGroup struct {
	ID          string    `json:"id"`
	HostUserID  string    `json:"host_user_id"`
	AddressID   string    `json:"address_id"`
	Name        string    `json:"name"`
	InviteCode  string    `json:"invite_code"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// AddressMember maps a user to an address group with their prepaid vault balance.
type AddressMember struct {
	ID             string     `json:"id"`
	UserID         string     `json:"user_id"`
	AddressGroupID string     `json:"address_group_id"`
	PrepaidBalance int        `json:"prepaid_balance"`
	Role           MemberRole `json:"role"`
	JoinedAt       time.Time  `json:"joined_at"`
}

// ChoreOrder records a group chore checkout. AddressGroupID is nullable (solo users).
type ChoreOrder struct {
	ID             string           `json:"id"`
	IdempotencyKey string           `json:"idempotency_key"`
	AddressGroupID *string          `json:"address_group_id,omitempty"`
	InitiatorID    string           `json:"initiator_id"`
	BookingID      *string          `json:"booking_id,omitempty"`
	TotalAmount    int              `json:"total_amount"`
	InitiatorPays  int              `json:"initiator_pays"`
	Status         ChoreOrderStatus `json:"status"`
	DebtCapWarning bool             `json:"debt_cap_warning"`
	CreatedAt      time.Time        `json:"created_at"`
}

// LedgerDebt is a shadow-ledger IOU created when a member's prepaid balance was insufficient.
type LedgerDebt struct {
	ID             string     `json:"id"`
	AddressGroupID string     `json:"address_group_id"`
	DebtorID       string     `json:"debtor_id"`
	CreditorID     string     `json:"creditor_id"`
	ChoreOrderID   string     `json:"chore_order_id"`
	Amount         int        `json:"amount"`
	Status         DebtStatus `json:"status"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// --- Request types ---

// CreateGroupRequest is the input for POST /groups.
type CreateGroupRequest struct {
	AddressID string `json:"address_id" validate:"required,uuid_format"`
	Name      string `json:"name"       validate:"required,min=1,max=100"`
}

// JoinGroupRequest is the input for POST /groups/join.
type JoinGroupRequest struct {
	Code string `json:"code" validate:"required,len=6"`
}

// TransferHostRequest is the input for POST /groups/:id/transfer-host.
type TransferHostRequest struct {
	ToUserID string `json:"to_user_id" validate:"required,uuid_format"`
}

// BookGroupChoreRequest is the input for POST /groups/:id/book.
// IdempotencyKey must be 16–64 chars, generated client-side (e.g. UUID v4).
type BookGroupChoreRequest struct {
	TotalAmount       int      `json:"total_amount"        validate:"required,min=1"`
	SelectedMemberIDs []string `json:"selected_member_ids"`
	IdempotencyKey    string   `json:"idempotency_key"     validate:"required,min=16,max=64"`
}

// TopUpRequest is the input for POST /members/:memberID/topup.
// Minimum enforced server-side: 25000 units (₹250).
type TopUpRequest struct {
	Amount int `json:"amount" validate:"required,min=25000"`
}

// --- Response types ---

// AffectedMember describes one member's outcome in a group booking.
type AffectedMember struct {
	UserID        string `json:"user_id"`
	Deducted      int    `json:"deducted"`       // 0 if shortfall path
	ShortfallDebt int    `json:"shortfall_debt"` // 0 if balance was sufficient
}

// BookGroupChoreResponse is returned by POST /groups/:id/book.
type BookGroupChoreResponse struct {
	ChoreOrderID    string           `json:"chore_order_id"`
	InitiatorPays   int              `json:"initiator_pays"`
	DebtCapWarning  bool             `json:"debt_cap_warning"`
	AffectedMembers []AffectedMember `json:"affected_members"`
}

// SimplifiedDebt is one edge in the netting algorithm output.
type SimplifiedDebt struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Amount int    `json:"amount"`
}

// MemberBalance holds one member's prepaid vault balance.
type MemberBalance struct {
	UserID  string `json:"user_id"`
	Balance int    `json:"balance"`
}

// VaultSummary is returned by GET /groups/:id/vault.
type VaultSummary struct {
	TotalBalance int             `json:"total_balance"`
	Members      []MemberBalance `json:"members"`
}

// JoinGroupResponse is returned by POST /groups/join.
type JoinGroupResponse struct {
	Group        AddressGroup `json:"group"`
	AddressAdded bool         `json:"address_added"` // true if the address was auto-copied to the joiner's profile
	AddressLabel string       `json:"address_label"`
}

// MyGroupResponse is returned by GET /groups/me.
type MyGroupResponse struct {
	Group   AddressGroup    `json:"group"`
	Members []AddressMember `json:"members"`
	MyRole  MemberRole      `json:"my_role"`
}

// LeaveGroupResult is returned by DELETE /groups/:id/members/:userID.
// If PendingDuesWarning is true, client must confirm before re-calling with force=true.
type LeaveGroupResult struct {
	PendingDuesWarning bool `json:"pending_dues_warning"`
	Left               bool `json:"left"`
}

// DeleteGroupResult is returned by DELETE /groups/:id.
// If PendingDuesWarning is true, client shows confirmation with balance details.
// On force=true, balances are credited back (TODO: main wallet) and group is deleted.
type DeleteGroupResult struct {
	PendingDuesWarning  bool            `json:"pending_dues_warning"`
	MembersWithBalance  []MemberBalance `json:"members_with_balance,omitempty"`
	Deleted             bool            `json:"deleted"`
}
