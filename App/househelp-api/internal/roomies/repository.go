package roomies

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles all database operations for the roomies module.
// All queries are parameterized. Single queries use a 5s context timeout;
// callers passing a tx use the caller's context directly.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new roomies repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// isUniqueViolation returns true if err is a PostgreSQL unique constraint violation.
func isUniqueViolation(err error) bool {
	if pgErr, ok := err.(*pgconn.PgError); ok {
		return pgErr.Code == "23505"
	}
	return false
}

// ── Address Groups ────────────────────────────────────────────────────────────

// GetGroupByID returns an AddressGroup by ID, or pgx.ErrNoRows if not found.
func (r *Repository) GetGroupByID(ctx context.Context, id string) (*AddressGroup, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	g := &AddressGroup{}
	err := r.db.QueryRow(qCtx,
		`SELECT id, host_user_id, address_id, name, invite_code, created_at, updated_at
		   FROM address_groups WHERE id = $1`,
		id,
	).Scan(&g.ID, &g.HostUserID, &g.AddressID, &g.Name, &g.InviteCode, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CreateGroup inserts an address_group row inside an existing transaction.
func (r *Repository) CreateGroup(ctx context.Context, tx pgx.Tx, g *AddressGroup) error {
	err := tx.QueryRow(ctx,
		`INSERT INTO address_groups (host_user_id, address_id, name, invite_code)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, created_at, updated_at`,
		g.HostUserID, g.AddressID, g.Name, g.InviteCode,
	).Scan(&g.ID, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create address group: %w", err)
	}
	return nil
}

// HasActiveBalancesOrDebts returns true if any member has prepaid_balance > 0
// or any non-settled ledger debt exists for the group.
func (r *Repository) HasActiveBalancesOrDebts(ctx context.Context, groupID string) (bool, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var hasBalance bool
	err := r.db.QueryRow(qCtx,
		`SELECT EXISTS(
			SELECT 1 FROM address_members
			WHERE address_group_id = $1 AND prepaid_balance > 0
		)`, groupID,
	).Scan(&hasBalance)
	if err != nil {
		return false, fmt.Errorf("failed to check balances: %w", err)
	}
	if hasBalance {
		return true, nil
	}

	var hasDebt bool
	err = r.db.QueryRow(qCtx,
		`SELECT EXISTS(
			SELECT 1 FROM ledger_debts
			WHERE address_group_id = $1 AND status != 'settled'
		)`, groupID,
	).Scan(&hasDebt)
	if err != nil {
		return false, fmt.Errorf("failed to check debts: %w", err)
	}
	return hasDebt, nil
}

// GetMembersWithBalance returns all members that have prepaid_balance > 0.
func (r *Repository) GetMembersWithBalance(ctx context.Context, groupID string) ([]AddressMember, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx,
		`SELECT id, user_id, address_group_id, prepaid_balance, role, joined_at
		   FROM address_members
		  WHERE address_group_id = $1 AND prepaid_balance > 0`,
		groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get members with balance: %w", err)
	}
	defer rows.Close()
	return scanMembers(rows)
}

// ForceDeleteGroup settles all debts, zeros all balances, deletes members, then the group.
// Called when host confirms deletion despite pending dues.
// TODO: credit zeroed prepaid_balance to each member's main wallet (main wallet not yet built).
func (r *Repository) ForceDeleteGroup(ctx context.Context, groupID string) error {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.Begin(qCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	// Settle all outstanding debts.
	_, err = tx.Exec(qCtx,
		`UPDATE ledger_debts SET status = 'settled', updated_at = now()
		  WHERE address_group_id = $1 AND status != 'settled'`,
		groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to settle debts on group delete: %w", err)
	}

	// TODO: before zeroing, read balances and enqueue credits to main wallet per user.
	// For now, zero out all prepaid balances (amounts are logged at service layer).
	_, err = tx.Exec(qCtx,
		`UPDATE address_members SET prepaid_balance = 0
		  WHERE address_group_id = $1`,
		groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to zero balances on group delete: %w", err)
	}

	// Delete members then the group (FK ON DELETE RESTRICT requires member rows gone first).
	_, err = tx.Exec(qCtx, `DELETE FROM address_members WHERE address_group_id = $1`, groupID)
	if err != nil {
		return fmt.Errorf("failed to delete members: %w", err)
	}

	_, err = tx.Exec(qCtx, `DELETE FROM address_groups WHERE id = $1`, groupID)
	if err != nil {
		return fmt.Errorf("failed to delete group: %w", err)
	}

	return tx.Commit(qCtx)
}

// ── Address Members ───────────────────────────────────────────────────────────

// GetMemberByUserAndGroup returns the AddressMember for (userID, groupID), or pgx.ErrNoRows.
func (r *Repository) GetMemberByUserAndGroup(ctx context.Context, userID, groupID string) (*AddressMember, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	m := &AddressMember{}
	err := r.db.QueryRow(qCtx,
		`SELECT id, user_id, address_group_id, prepaid_balance, role, joined_at
		   FROM address_members
		  WHERE user_id = $1 AND address_group_id = $2`,
		userID, groupID,
	).Scan(&m.ID, &m.UserID, &m.AddressGroupID, &m.PrepaidBalance, &m.Role, &m.JoinedAt)
	if err != nil {
		return nil, err
	}
	return m, nil
}

// GetMembersByGroup returns all AddressMembers for a group.
func (r *Repository) GetMembersByGroup(ctx context.Context, groupID string) ([]AddressMember, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx,
		`SELECT id, user_id, address_group_id, prepaid_balance, role, joined_at
		   FROM address_members WHERE address_group_id = $1`,
		groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get members: %w", err)
	}
	defer rows.Close()
	return scanMembers(rows)
}

// GetMemberCount returns the number of members in a group.
func (r *Repository) GetMemberCount(ctx context.Context, groupID string) (int, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var count int
	err := r.db.QueryRow(qCtx,
		`SELECT COUNT(*) FROM address_members WHERE address_group_id = $1`, groupID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count members: %w", err)
	}
	return count, nil
}

// AddMember inserts a new AddressMember row. Returns ErrMemberAlreadyExists on duplicate.
func (r *Repository) AddMember(ctx context.Context, m *AddressMember) error {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	err := r.db.QueryRow(qCtx,
		`INSERT INTO address_members (user_id, address_group_id, role)
		 VALUES ($1, $2, $3)
		 RETURNING id, joined_at`,
		m.UserID, m.AddressGroupID, m.Role,
	).Scan(&m.ID, &m.JoinedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrMemberAlreadyExists
		}
		return fmt.Errorf("failed to add member: %w", err)
	}
	return nil
}

// UpdateMemberRole changes a member's role (host ↔ member).
func (r *Repository) UpdateMemberRole(ctx context.Context, tx pgx.Tx, userID, groupID string, role MemberRole) error {
	result, err := tx.Exec(ctx,
		`UPDATE address_members SET role = $1
		  WHERE user_id = $2 AND address_group_id = $3`,
		role, userID, groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to update member role: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotGroupMember
	}
	return nil
}

// HasActiveDebts returns true if the user has any non-settled debt in the group.
func (r *Repository) HasActiveDebts(ctx context.Context, userID, groupID string) (bool, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var exists bool
	err := r.db.QueryRow(qCtx,
		`SELECT EXISTS(
			SELECT 1 FROM ledger_debts
			WHERE address_group_id = $1
			  AND (debtor_id = $2 OR creditor_id = $2)
			  AND status != 'settled'
		)`, groupID, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check active debts: %w", err)
	}
	return exists, nil
}

// DeleteMember removes a user from a group.
func (r *Repository) DeleteMember(ctx context.Context, userID, groupID string) error {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(qCtx,
		`DELETE FROM address_members WHERE user_id = $1 AND address_group_id = $2`,
		userID, groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete member: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotGroupMember
	}
	return nil
}

// ── Prepaid Wallet ────────────────────────────────────────────────────────────

// LockMembersForUpdate acquires row-level locks on the given members within tx.
// MUST be called inside a transaction. Used to prevent double-spend race conditions (edge case 1).
func (r *Repository) LockMembersForUpdate(ctx context.Context, tx pgx.Tx, groupID string, userIDs []string) ([]AddressMember, error) {
	rows, err := tx.Query(ctx,
		`SELECT id, user_id, address_group_id, prepaid_balance, role, joined_at
		   FROM address_members
		  WHERE address_group_id = $1 AND user_id = ANY($2)
		    FOR UPDATE`,
		groupID, userIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to lock members: %w", err)
	}
	defer rows.Close()
	return scanMembers(rows)
}

// DeductPrepaidBalance subtracts amount from a member's prepaid_balance within tx.
// DB CHECK (prepaid_balance >= 0) provides defense-in-depth against underflow (edge case 9).
func (r *Repository) DeductPrepaidBalance(ctx context.Context, tx pgx.Tx, userID, groupID string, amount int) error {
	result, err := tx.Exec(ctx,
		`UPDATE address_members
		    SET prepaid_balance = prepaid_balance - $1
		  WHERE user_id = $2 AND address_group_id = $3`,
		amount, userID, groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to deduct prepaid balance: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotGroupMember
	}
	return nil
}

// TopUpPrepaidBalance adds amount to a member's prepaid_balance within tx.
func (r *Repository) TopUpPrepaidBalance(ctx context.Context, tx pgx.Tx, userID, groupID string, amount int) error {
	result, err := tx.Exec(ctx,
		`UPDATE address_members
		    SET prepaid_balance = prepaid_balance + $1
		  WHERE user_id = $2 AND address_group_id = $3`,
		amount, userID, groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to top up prepaid balance: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotGroupMember
	}
	return nil
}

// ── Chore Orders ──────────────────────────────────────────────────────────────

// GetChoreOrderByIdempotencyKey returns an existing ChoreOrder by idempotency key,
// or pgx.ErrNoRows if not found.
func (r *Repository) GetChoreOrderByIdempotencyKey(ctx context.Context, key string) (*ChoreOrder, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	o := &ChoreOrder{}
	err := r.db.QueryRow(qCtx,
		`SELECT id, idempotency_key, address_group_id, initiator_id, booking_id,
		        total_amount, initiator_pays, status, debt_cap_warning, created_at
		   FROM chore_orders WHERE idempotency_key = $1`,
		key,
	).Scan(
		&o.ID, &o.IdempotencyKey, &o.AddressGroupID, &o.InitiatorID, &o.BookingID,
		&o.TotalAmount, &o.InitiatorPays, &o.Status, &o.DebtCapWarning, &o.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return o, nil
}

// CreateChoreOrder inserts a chore_order row inside an existing transaction.
func (r *Repository) CreateChoreOrder(ctx context.Context, tx pgx.Tx, o *ChoreOrder) error {
	err := tx.QueryRow(ctx,
		`INSERT INTO chore_orders
		    (idempotency_key, address_group_id, initiator_id, total_amount, initiator_pays, debt_cap_warning)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, created_at`,
		o.IdempotencyKey, o.AddressGroupID, o.InitiatorID,
		o.TotalAmount, o.InitiatorPays, o.DebtCapWarning,
	).Scan(&o.ID, &o.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to create chore order: %w", err)
	}
	return nil
}

// ── Ledger Debts ──────────────────────────────────────────────────────────────

// GetActiveDebtsForGroup returns all non-settled LedgerDebts for a group.
func (r *Repository) GetActiveDebtsForGroup(ctx context.Context, groupID string) ([]LedgerDebt, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx,
		`SELECT id, address_group_id, debtor_id, creditor_id, chore_order_id,
		        amount, status, created_at, updated_at
		   FROM ledger_debts
		  WHERE address_group_id = $1 AND status = 'active'`,
		groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get active debts: %w", err)
	}
	defer rows.Close()
	return scanDebts(rows)
}

// GetDebtByID returns a LedgerDebt by ID.
func (r *Repository) GetDebtByID(ctx context.Context, id string) (*LedgerDebt, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	d := &LedgerDebt{}
	err := r.db.QueryRow(qCtx,
		`SELECT id, address_group_id, debtor_id, creditor_id, chore_order_id,
		        amount, status, created_at, updated_at
		   FROM ledger_debts WHERE id = $1`,
		id,
	).Scan(
		&d.ID, &d.AddressGroupID, &d.DebtorID, &d.CreditorID, &d.ChoreOrderID,
		&d.Amount, &d.Status, &d.CreatedAt, &d.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// CreateLedgerDebt inserts a ledger_debt row inside an existing transaction.
func (r *Repository) CreateLedgerDebt(ctx context.Context, tx pgx.Tx, d *LedgerDebt) error {
	err := tx.QueryRow(ctx,
		`INSERT INTO ledger_debts (address_group_id, debtor_id, creditor_id, chore_order_id, amount)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, created_at, updated_at`,
		d.AddressGroupID, d.DebtorID, d.CreditorID, d.ChoreOrderID, d.Amount,
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create ledger debt: %w", err)
	}
	return nil
}

// UpdateDebtStatus transitions a LedgerDebt to the given status.
func (r *Repository) UpdateDebtStatus(ctx context.Context, id string, status DebtStatus) error {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(qCtx,
		`UPDATE ledger_debts SET status = $1, updated_at = now() WHERE id = $2`,
		status, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update debt status: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrDebtNotFound
	}
	return nil
}

// GetNetDebtForUser returns the user's net debt position in a group (positive = owed to others).
// net = sum(debts as debtor) - sum(debts as creditor) for active debts.
func (r *Repository) GetNetDebtForUser(ctx context.Context, userID, groupID string) (int, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var net int
	err := r.db.QueryRow(qCtx,
		`SELECT COALESCE(SUM(CASE WHEN debtor_id = $1 THEN amount ELSE -amount END), 0)
		   FROM ledger_debts
		  WHERE address_group_id = $2
		    AND (debtor_id = $1 OR creditor_id = $1)
		    AND status = 'active'`,
		userID, groupID,
	).Scan(&net)
	if err != nil {
		return 0, fmt.Errorf("failed to get net debt: %w", err)
	}
	return net, nil
}

// GetStuckDebts returns all debts in pending_verification older than 48 hours.
// Used by the auto-settle cron job (edge case 3: hostage situation).
func (r *Repository) GetStuckDebts(ctx context.Context) ([]LedgerDebt, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx,
		`SELECT id, address_group_id, debtor_id, creditor_id, chore_order_id,
		        amount, status, created_at, updated_at
		   FROM ledger_debts
		  WHERE status = 'pending_verification'
		    AND updated_at < NOW() - INTERVAL '48 hours'`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get stuck debts: %w", err)
	}
	defer rows.Close()
	return scanDebts(rows)
}

// BulkSettleDebts marks a slice of debt IDs as settled. Used by the cron job.
func (r *Repository) BulkSettleDebts(ctx context.Context, ids []string) error {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := r.db.Exec(qCtx,
		`UPDATE ledger_debts SET status = 'settled', updated_at = now()
		  WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return fmt.Errorf("failed to bulk settle debts: %w", err)
	}
	return nil
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanMembers(rows pgx.Rows) ([]AddressMember, error) {
	var members []AddressMember
	for rows.Next() {
		var m AddressMember
		if err := rows.Scan(
			&m.ID, &m.UserID, &m.AddressGroupID, &m.PrepaidBalance, &m.Role, &m.JoinedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan member: %w", err)
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

func scanDebts(rows pgx.Rows) ([]LedgerDebt, error) {
	var debts []LedgerDebt
	for rows.Next() {
		var d LedgerDebt
		if err := rows.Scan(
			&d.ID, &d.AddressGroupID, &d.DebtorID, &d.CreditorID, &d.ChoreOrderID,
			&d.Amount, &d.Status, &d.CreatedAt, &d.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan debt: %w", err)
		}
		debts = append(debts, d)
	}
	return debts, rows.Err()
}

// ── Code-based Join ───────────────────────────────────────────────────────────

// GetGroupByCode returns the AddressGroup with the given 6-digit invite code.
// Returns pgx.ErrNoRows if no group matches.
func (r *Repository) GetGroupByCode(ctx context.Context, code string) (*AddressGroup, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	g := &AddressGroup{}
	err := r.db.QueryRow(qCtx,
		`SELECT id, host_user_id, address_id, name, invite_code, created_at, updated_at
		   FROM address_groups WHERE invite_code = $1`,
		code,
	).Scan(&g.ID, &g.HostUserID, &g.AddressID, &g.Name, &g.InviteCode, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// GetGroupByUserID returns the AddressGroup the user belongs to (via address_members).
// Returns pgx.ErrNoRows if the user is not in any group.
func (r *Repository) GetGroupByUserID(ctx context.Context, userID string) (*AddressGroup, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	g := &AddressGroup{}
	err := r.db.QueryRow(qCtx,
		`SELECT ag.id, ag.host_user_id, ag.address_id, ag.name, ag.invite_code,
		        ag.created_at, ag.updated_at
		   FROM address_groups ag
		   JOIN address_members am ON am.address_group_id = ag.id
		  WHERE am.user_id = $1
		  LIMIT 1`,
		userID,
	).Scan(&g.ID, &g.HostUserID, &g.AddressID, &g.Name, &g.InviteCode, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CopyAddressToUser copies an address into a user's profile if not already present.
// Returns (true, nil) if the row was inserted, (false, nil) if it already existed.
// Must be called inside a transaction to stay atomic with AddMember.
func (r *Repository) CopyAddressToUser(ctx context.Context, tx pgx.Tx, userID, addressID string) (bool, error) {
	// Check if user already has this address linked.
	var exists bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM user_addresses WHERE user_id = $1 AND id = $2)`,
		userID, addressID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check existing address: %w", err)
	}
	if exists {
		return false, nil
	}

	// Copy the address row into the joining user's profile.
	_, err = tx.Exec(ctx,
		`INSERT INTO user_addresses
		        (user_id, tag, title, flat_no, floor, building_name, landmark,
		         full_address, receiver_name, receiver_phone, lat, lon)
		 SELECT $1,      tag, title, flat_no, floor, building_name, landmark,
		         full_address, receiver_name, receiver_phone, lat, lon
		   FROM user_addresses
		  WHERE id = $2`,
		userID, addressID,
	)
	if err != nil {
		return false, fmt.Errorf("failed to copy address: %w", err)
	}
	return true, nil
}
