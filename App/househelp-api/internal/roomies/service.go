package roomies

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// nettingCacheTTL is the Redis TTL for the simplified netting graph per group.
const nettingCacheTTL = 30 * time.Second

// debtSoftCap is the net debt ceiling (in paise/units) above which a DebtCapWarning is issued.
// Non-blocking: the transaction still proceeds (edge case 4).
const debtSoftCap = 100_000

// minTopUp is the minimum prepaid top-up amount in units (₹250).
const minTopUp = 25_000

// Service handles all business logic for the Roomies module.
type Service struct {
	repo *Repository
	db   *pgxpool.Pool
	rdb  *redis.Client
}

// NewService creates a new roomies service.
func NewService(repo *Repository, db *pgxpool.Pool, rdb *redis.Client) *Service {
	return &Service{repo: repo, db: db, rdb: rdb}
}

// nettingKey returns the Redis cache key for a group's simplified debt graph.
func nettingKey(groupID string) string {
	return "netting:" + groupID
}

// invalidateNettingCache removes the cached netting result for a group.
func (s *Service) invalidateNettingCache(ctx context.Context, groupID string) {
	if err := s.rdb.Del(ctx, nettingKey(groupID)).Err(); err != nil {
		log.Warn().Err(err).Str("group_id", groupID).Msg("roomies: failed to invalidate netting cache")
	}
}

// IsMember reports whether userID belongs to groupID. Used by handlers that
// expose group-scoped financial data (ledger, vault, chore booking) to ensure
// only members can read or mutate that data.
func (s *Service) IsMember(ctx context.Context, userID, groupID string) (bool, error) {
	_, err := s.repo.GetMemberByUserAndGroup(ctx, userID, groupID)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ── Group Management ──────────────────────────────────────────────────────────

// generateUniqueCode returns a cryptographically random 6-digit numeric string,
// retrying up to 10 times on unique constraint collision.
func (s *Service) generateUniqueCode(ctx context.Context) (string, error) {
	for range 10 {
		n, err := rand.Int(rand.Reader, big.NewInt(900_000))
		if err != nil {
			return "", fmt.Errorf("failed to generate random code: %w", err)
		}
		code := fmt.Sprintf("%06d", n.Int64()+100_000)
		_, err = s.repo.GetGroupByCode(ctx, code)
		if err == pgx.ErrNoRows {
			return code, nil // unique
		}
		if err != nil {
			return "", fmt.Errorf("failed to check code uniqueness: %w", err)
		}
	}
	return "", fmt.Errorf("failed to generate a unique invite code after 10 attempts")
}

// CreateGroup creates a new address group and assigns the creator as host.
func (s *Service) CreateGroup(ctx context.Context, hostUserID, addressID, name string) (*AddressGroup, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	code, err := s.generateUniqueCode(qCtx)
	if err != nil {
		return nil, err
	}

	tx, err := s.db.Begin(qCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	g := &AddressGroup{
		HostUserID: hostUserID,
		AddressID:  addressID,
		Name:       name,
		InviteCode: code,
	}
	if err := s.repo.CreateGroup(qCtx, tx, g); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrAddressAlreadyHasGroup
		}
		return nil, err
	}

	host := &AddressMember{
		UserID:         hostUserID,
		AddressGroupID: g.ID,
		Role:           RoleHost,
	}
	// AddMember uses pool, not tx — host insert is safe after group commit,
	// but we want atomicity: call tx directly.
	err = tx.QueryRow(qCtx,
		`INSERT INTO address_members (user_id, address_group_id, role)
		 VALUES ($1, $2, $3)
		 RETURNING id, joined_at`,
		host.UserID, host.AddressGroupID, host.Role,
	).Scan(&host.ID, &host.JoinedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to add host member: %w", err)
	}

	if err := tx.Commit(qCtx); err != nil {
		return nil, fmt.Errorf("failed to commit group creation: %w", err)
	}

	log.Info().
		Str("group_id", g.ID).
		Str("host_user_id", hostUserID).
		Str("name", name).
		Msg("roomies: address group created")

	return g, nil
}

// JoinGroup adds the caller to a group identified by its 6-digit invite code.
// Auto-copies the group's address to the joiner's profile if not already present.
// Returns ErrInvalidCode if no group matches, ErrGroupFull if at capacity,
// ErrAlreadyInGroup if the user is already a member somewhere.
func (s *Service) JoinGroup(ctx context.Context, code, userID string) (*JoinGroupResponse, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Reject if user already belongs to any group.
	existing, err := s.repo.GetGroupByUserID(qCtx, userID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("failed to check existing membership: %w", err)
	}
	if existing != nil {
		return nil, ErrAlreadyInGroup
	}

	group, err := s.repo.GetGroupByCode(qCtx, code)
	if err == pgx.ErrNoRows {
		return nil, ErrInvalidCode
	}
	if err != nil {
		return nil, fmt.Errorf("failed to look up group: %w", err)
	}

	count, err := s.repo.GetMemberCount(qCtx, group.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to check member count: %w", err)
	}
	if count >= 4 {
		return nil, ErrGroupFull
	}

	tx, err := s.db.Begin(qCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	addressAdded, err := s.repo.CopyAddressToUser(qCtx, tx, userID, group.AddressID)
	if err != nil {
		return nil, err
	}

	m := &AddressMember{
		UserID:         userID,
		AddressGroupID: group.ID,
		Role:           RoleMember,
	}
	if err := s.repo.AddMember(qCtx, m); err != nil {
		return nil, err
	}

	if err := tx.Commit(qCtx); err != nil {
		return nil, fmt.Errorf("failed to commit group join: %w", err)
	}

	log.Info().
		Str("group_id", group.ID).
		Str("user_id", userID).
		Bool("address_added", addressAdded).
		Msg("roomies: member joined via code")

	return &JoinGroupResponse{
		Group:        *group,
		AddressAdded: addressAdded,
		AddressLabel: group.Name,
	}, nil
}

// GetMyGroup returns the group and membership details for the authenticated user,
// or nil if the user is not in any group.
func (s *Service) GetMyGroup(ctx context.Context, userID string) (*MyGroupResponse, error) {
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	group, err := s.repo.GetGroupByUserID(qCtx, userID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get group: %w", err)
	}

	members, err := s.repo.GetMembersByGroup(qCtx, group.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get members: %w", err)
	}

	myRole := MemberRole(RoleMember)
	for _, m := range members {
		if m.UserID == userID {
			myRole = m.Role
			break
		}
	}

	return &MyGroupResponse{
		Group:   *group,
		Members: members,
		MyRole:  myRole,
	}, nil
}

// LeaveGroup removes a user from a group.
// Edge case 5 (Dead Address): hard block if role=host and member count > 1.
// Edge case 7 (Leave with debts): soft warning — caller must re-call with force=true.
func (s *Service) LeaveGroup(ctx context.Context, groupID, userID string, force bool) (*LeaveGroupResult, error) {
	member, err := s.repo.GetMemberByUserAndGroup(ctx, userID, groupID)
	if err == pgx.ErrNoRows {
		return nil, ErrNotGroupMember
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get member: %w", err)
	}

	// Edge case 5: hard block — host must transfer first.
	if member.Role == RoleHost {
		count, err := s.repo.GetMemberCount(ctx, groupID)
		if err != nil {
			return nil, fmt.Errorf("failed to count members: %w", err)
		}
		if count > 1 {
			return nil, ErrHostMustTransferFirst
		}
	}

	// Edge case 7: soft warning — inform client, do not block unless force=false.
	if !force {
		hasDebts, err := s.repo.HasActiveDebts(ctx, userID, groupID)
		if err != nil {
			return nil, fmt.Errorf("failed to check debts: %w", err)
		}
		if hasDebts {
			return &LeaveGroupResult{PendingDuesWarning: true, Left: false}, nil
		}
	}

	if err := s.repo.DeleteMember(ctx, userID, groupID); err != nil {
		return nil, err
	}

	log.Info().
		Str("group_id", groupID).
		Str("user_id", userID).
		Bool("force", force).
		Msg("roomies: member left group")

	return &LeaveGroupResult{PendingDuesWarning: false, Left: true}, nil
}

// TransferHost atomically transfers host rights from one member to another.
func (s *Service) TransferHost(ctx context.Context, groupID, fromUserID, toUserID string) error {
	from, err := s.repo.GetMemberByUserAndGroup(ctx, fromUserID, groupID)
	if err == pgx.ErrNoRows {
		return ErrNotGroupMember
	}
	if err != nil {
		return fmt.Errorf("failed to get from-member: %w", err)
	}
	if from.Role != RoleHost {
		return ErrNotGroupHost
	}

	_, err = s.repo.GetMemberByUserAndGroup(ctx, toUserID, groupID)
	if err == pgx.ErrNoRows {
		return ErrNotGroupMember
	}
	if err != nil {
		return fmt.Errorf("failed to get to-member: %w", err)
	}

	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := s.db.Begin(qCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	if err := s.repo.UpdateMemberRole(qCtx, tx, fromUserID, groupID, RoleMember); err != nil {
		return err
	}
	if err := s.repo.UpdateMemberRole(qCtx, tx, toUserID, groupID, RoleHost); err != nil {
		return err
	}

	// Update host_user_id on the group record.
	_, err = tx.Exec(qCtx,
		`UPDATE address_groups SET host_user_id = $1, updated_at = now() WHERE id = $2`,
		toUserID, groupID,
	)
	if err != nil {
		return fmt.Errorf("failed to update group host: %w", err)
	}

	if err := tx.Commit(qCtx); err != nil {
		return fmt.Errorf("failed to commit host transfer: %w", err)
	}

	log.Info().
		Str("group_id", groupID).
		Str("from", fromUserID).
		Str("to", toUserID).
		Msg("roomies: host transferred")

	return nil
}

// DeleteGroup deletes a group, with soft warning if active finances exist.
// Edge case 12: soft warning — caller must re-call with force=true to confirm.
// On force=true: prepaid balances are zeroed (TODO: credit to main wallet) and group deleted.
func (s *Service) DeleteGroup(ctx context.Context, groupID, requesterID string, force bool) (*DeleteGroupResult, error) {
	group, err := s.repo.GetGroupByID(ctx, groupID)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("group not found")
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get group: %w", err)
	}
	if group.HostUserID != requesterID {
		return nil, ErrNotGroupHost
	}

	// Edge case 12: soft warning only.
	if !force {
		hasFinancials, err := s.repo.HasActiveBalancesOrDebts(ctx, groupID)
		if err != nil {
			return nil, fmt.Errorf("failed to check group financials: %w", err)
		}
		if hasFinancials {
			membersWithBalance, err := s.repo.GetMembersWithBalance(ctx, groupID)
			if err != nil {
				return nil, fmt.Errorf("failed to get balances: %w", err)
			}
			balances := make([]MemberBalance, len(membersWithBalance))
			for i, m := range membersWithBalance {
				balances[i] = MemberBalance{UserID: m.UserID, Balance: m.PrepaidBalance}
			}
			return &DeleteGroupResult{
				PendingDuesWarning: true,
				MembersWithBalance: balances,
				Deleted:            false,
			}, nil
		}
	}

	// force=true (or no financials): queue a pending_refunds row per member with
	// a non-zero prepaid_balance BEFORE the destructive delete zeroes it out.
	// Wallet credit handled by pending_refunds settlement worker (TODO: build settlement worker).
	if force {
		membersWithBalance, err := s.repo.GetMembersWithBalance(ctx, groupID)
		if err != nil {
			return nil, fmt.Errorf("failed to get balances before delete: %w", err)
		}
		for _, m := range membersWithBalance {
			if m.PrepaidBalance <= 0 {
				continue
			}
			if _, err := s.db.Exec(ctx,
				`INSERT INTO pending_refunds (user_id, amount_cents, source, source_ref)
				 VALUES ($1, $2, 'roomies_group_delete', $3)`,
				m.UserID, m.PrepaidBalance, groupID,
			); err != nil {
				return nil, fmt.Errorf("queue refund: %w", err)
			}
			log.Info().
				Str("group_id", groupID).
				Str("user_id", m.UserID).
				Int("amount_cents", m.PrepaidBalance).
				Msg("roomies: queued pending refund before group force-delete")
		}
	}

	if err := s.repo.ForceDeleteGroup(ctx, groupID); err != nil {
		return nil, fmt.Errorf("failed to delete group: %w", err)
	}

	// Invalidate netting cache for this group.
	s.invalidateNettingCache(ctx, groupID)

	log.Info().Str("group_id", groupID).Msg("roomies: group deleted")

	return &DeleteGroupResult{Deleted: true}, nil
}

// ── Financial Engine ──────────────────────────────────────────────────────────

// BookGroupChore processes a group chore checkout using the Binary Deduction Rule.
//
// Edge cases handled:
//   - Edge case 1 (race condition): SELECT FOR UPDATE on all member rows in transaction.
//   - Edge case 2 (idempotency): key validated + scope-checked before any mutation.
//   - Edge case 4 (debt ceiling): soft cap check sets DebtCapWarning, does NOT block.
//   - Edge case 6 (idempotency scope collision): key bound to (initiatorID, groupID, totalAmount).
//   - Edge case 10 (solo booking via group context): zero-member path skips all split logic.
//   - Edge case 11 (TotalAmount validation): validated before any math.
func (s *Service) BookGroupChore(ctx context.Context, groupID string, req BookGroupChoreRequest, initiatorID string) (*BookGroupChoreResponse, error) {
	// SECURITY: only members of the group may initiate a chore booking against
	// it. Without this any authed user could write LedgerDebt rows binding
	// strangers to debts.
	if isMember, err := s.IsMember(ctx, initiatorID, groupID); err != nil {
		return nil, fmt.Errorf("failed to verify group membership: %w", err)
	} else if !isMember {
		return nil, ErrNotGroupMember
	}

	// Edge case 11: validate total amount.
	if req.TotalAmount <= 0 {
		return nil, fmt.Errorf("total_amount must be greater than zero")
	}

	// Edge case 10: solo booking via group context (zero members selected).
	if len(req.SelectedMemberIDs) == 0 {
		qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		tx, err := s.db.Begin(qCtx)
		if err != nil {
			return nil, fmt.Errorf("failed to begin transaction: %w", err)
		}
		defer tx.Rollback(qCtx)

		order := &ChoreOrder{
			IdempotencyKey: req.IdempotencyKey,
			AddressGroupID: &groupID,
			InitiatorID:    initiatorID,
			TotalAmount:    req.TotalAmount,
			InitiatorPays:  req.TotalAmount,
		}
		if err := s.repo.CreateChoreOrder(qCtx, tx, order); err != nil {
			return nil, err
		}
		if err := tx.Commit(qCtx); err != nil {
			return nil, fmt.Errorf("failed to commit solo chore order: %w", err)
		}
		return &BookGroupChoreResponse{
			ChoreOrderID:    order.ID,
			InitiatorPays:   req.TotalAmount,
			DebtCapWarning:  false,
			AffectedMembers: []AffectedMember{},
		}, nil
	}

	// Edge case 2 + 6: idempotency check with scope validation.
	existing, err := s.repo.GetChoreOrderByIdempotencyKey(ctx, req.IdempotencyKey)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("failed to check idempotency key: %w", err)
	}
	if existing != nil {
		// Scope collision guard (edge case 6): key must match exact parameters.
		groupMatch := (existing.AddressGroupID != nil && *existing.AddressGroupID == groupID)
		if existing.InitiatorID != initiatorID || !groupMatch || existing.TotalAmount != req.TotalAmount {
			return nil, ErrIdempotencyKeyConflict
		}
		// Return cached response.
		return &BookGroupChoreResponse{
			ChoreOrderID:    existing.ID,
			InitiatorPays:   existing.InitiatorPays,
			DebtCapWarning:  existing.DebtCapWarning,
			AffectedMembers: []AffectedMember{},
		}, nil
	}

	// Filter out initiator from member list.
	membersToSplit := make([]string, 0, len(req.SelectedMemberIDs))
	for _, id := range req.SelectedMemberIDs {
		if id != initiatorID {
			membersToSplit = append(membersToSplit, id)
		}
	}

	// Split math: initiator gets the remainder.
	n := len(membersToSplit) + 1
	splitAmount := req.TotalAmount / n
	remainder := req.TotalAmount % n
	initiatorBasePay := splitAmount + remainder

	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Edge case 1: begin transaction and lock all member rows.
	tx, err := s.db.Begin(qCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	// SELECT FOR UPDATE — prevents double-spend race conditions.
	lockedMembers, err := s.repo.LockMembersForUpdate(qCtx, tx, groupID, membersToSplit)
	if err != nil {
		return nil, fmt.Errorf("failed to lock members: %w", err)
	}

	// Build a lookup map for locked member data.
	memberMap := make(map[string]AddressMember, len(lockedMembers))
	for _, m := range lockedMembers {
		memberMap[m.UserID] = m
	}

	initiatorShortfall := 0
	debtCapWarning := false
	affectedMembers := make([]AffectedMember, 0, len(membersToSplit))

	// Create a placeholder ChoreOrder so we have an ID for LedgerDebt FK.
	// We'll insert the full order after processing splits.
	choreOrder := &ChoreOrder{
		IdempotencyKey: req.IdempotencyKey,
		AddressGroupID: &groupID,
		InitiatorID:    initiatorID,
		TotalAmount:    req.TotalAmount,
	}
	if err := s.repo.CreateChoreOrder(qCtx, tx, choreOrder); err != nil {
		return nil, fmt.Errorf("failed to create chore order: %w", err)
	}

	// Binary Deduction Rule.
	for _, memberID := range membersToSplit {
		m, ok := memberMap[memberID]
		if !ok {
			return nil, fmt.Errorf("member %s not found in group", memberID)
		}

		affected := AffectedMember{UserID: memberID}

		if m.PrepaidBalance >= splitAmount {
			// Sufficient balance: deduct instantly.
			if err := s.repo.DeductPrepaidBalance(qCtx, tx, memberID, groupID, splitAmount); err != nil {
				return nil, fmt.Errorf("failed to deduct balance for member %s: %w", memberID, err)
			}
			affected.Deducted = splitAmount
		} else {
			// Insufficient balance (even by 1 unit): deduct ZERO, initiator covers shortfall.
			initiatorShortfall += splitAmount
			affected.ShortfallDebt = splitAmount

			debt := &LedgerDebt{
				AddressGroupID: groupID,
				DebtorID:       memberID,
				CreditorID:     initiatorID,
				ChoreOrderID:   choreOrder.ID,
				Amount:         splitAmount,
			}
			if err := s.repo.CreateLedgerDebt(qCtx, tx, debt); err != nil {
				return nil, fmt.Errorf("failed to create ledger debt for member %s: %w", memberID, err)
			}
		}

		// Edge case 4: soft debt ceiling check (non-blocking).
		netDebt, err := s.repo.GetNetDebtForUser(qCtx, memberID, groupID)
		if err != nil {
			log.Warn().Err(err).Str("user_id", memberID).Msg("roomies: failed to check net debt for cap")
		} else if netDebt > debtSoftCap {
			debtCapWarning = true
			log.Warn().
				Str("user_id", memberID).
				Str("group_id", groupID).
				Int("net_debt", netDebt).
				Msg("roomies: user exceeded debt soft cap — warning issued, transaction proceeds")
		}

		affectedMembers = append(affectedMembers, affected)
	}

	initiatorPays := initiatorBasePay + initiatorShortfall

	// Update chore_order with final initiator_pays and debt_cap_warning.
	_, err = tx.Exec(qCtx,
		`UPDATE chore_orders SET initiator_pays = $1, debt_cap_warning = $2 WHERE id = $3`,
		initiatorPays, debtCapWarning, choreOrder.ID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to update chore order: %w", err)
	}

	if err := tx.Commit(qCtx); err != nil {
		return nil, fmt.Errorf("failed to commit group chore booking: %w", err)
	}

	// Edge case 8: invalidate netting cache so next read reflects new debts.
	s.invalidateNettingCache(ctx, groupID)

	log.Info().
		Str("chore_order_id", choreOrder.ID).
		Str("initiator_id", initiatorID).
		Int("initiator_pays", initiatorPays).
		Int("shortfall", initiatorShortfall).
		Bool("debt_cap_warning", debtCapWarning).
		Msg("roomies: group chore booked")

	return &BookGroupChoreResponse{
		ChoreOrderID:    choreOrder.ID,
		InitiatorPays:   initiatorPays,
		DebtCapWarning:  debtCapWarning,
		AffectedMembers: affectedMembers,
	}, nil
}

// TopUpPrepaid adds funds to a member's prepaid vault.
// Enforces the minimum top-up of ₹250 (25000 units) — edge case 4.
// Uses SELECT FOR UPDATE to prevent concurrent top-up race conditions (edge case 1).
func (s *Service) TopUpPrepaid(ctx context.Context, userID, groupID string, amount int) error {
	if amount < minTopUp {
		return ErrBelowMinimumTopUp
	}

	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := s.db.Begin(qCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(qCtx)

	// Lock the member row to prevent concurrent top-up race (edge case 1).
	_, err = s.repo.LockMembersForUpdate(qCtx, tx, groupID, []string{userID})
	if err != nil {
		return fmt.Errorf("failed to lock member for top-up: %w", err)
	}

	if err := s.repo.TopUpPrepaidBalance(qCtx, tx, userID, groupID, amount); err != nil {
		return err
	}

	if err := tx.Commit(qCtx); err != nil {
		return fmt.Errorf("failed to commit top-up: %w", err)
	}

	// Invalidate netting cache (vault balance changed).
	s.invalidateNettingCache(ctx, groupID)

	log.Info().
		Str("user_id", userID).
		Str("group_id", groupID).
		Int("amount", amount).
		Msg("roomies: prepaid balance topped up")

	return nil
}

// MarkSettlementExternal transitions a debt to pending_verification.
// Only the debtor can initiate external settlement (edge case 3).
func (s *Service) MarkSettlementExternal(ctx context.Context, debtID, debtorID string) error {
	debt, err := s.repo.GetDebtByID(ctx, debtID)
	if err == pgx.ErrNoRows {
		return ErrDebtNotFound
	}
	if err != nil {
		return fmt.Errorf("failed to get debt: %w", err)
	}
	if debt.DebtorID != debtorID {
		return ErrUnauthorized
	}

	if err := s.repo.UpdateDebtStatus(ctx, debtID, DebtPendingVerification); err != nil {
		return err
	}

	log.Info().Str("debt_id", debtID).Str("debtor_id", debtorID).Msg("roomies: debt marked pending verification")
	return nil
}

// VerifySettlement marks a debt as settled. Only the creditor can verify.
// Invalidates netting cache (edge case 8).
func (s *Service) VerifySettlement(ctx context.Context, debtID, creditorID string) error {
	debt, err := s.repo.GetDebtByID(ctx, debtID)
	if err == pgx.ErrNoRows {
		return ErrDebtNotFound
	}
	if err != nil {
		return fmt.Errorf("failed to get debt: %w", err)
	}
	if debt.CreditorID != creditorID {
		return ErrUnauthorized
	}

	if err := s.repo.UpdateDebtStatus(ctx, debtID, DebtSettled); err != nil {
		return err
	}

	// Edge case 8: invalidate netting cache.
	s.invalidateNettingCache(ctx, debt.AddressGroupID)

	log.Info().Str("debt_id", debtID).Str("creditor_id", creditorID).Msg("roomies: debt verified and settled")
	return nil
}

// NetDebts returns the simplified (netted) debt graph for a group.
//
// Algorithm:
//  1. Fetch all active LedgerDebts.
//  2. Compute per-user net balance (positive = net creditor, negative = net debtor).
//  3. Greedy two-pointer: repeatedly match the biggest debtor against the biggest creditor.
//
// Result is cached in Redis for 30s to avoid re-computation on every poll (edge case 8).
func (s *Service) NetDebts(ctx context.Context, groupID string) ([]SimplifiedDebt, error) {
	// Edge case 8: serve from cache if available.
	cacheKey := nettingKey(groupID)
	if cached, err := s.rdb.Get(ctx, cacheKey).Bytes(); err == nil {
		var result []SimplifiedDebt
		if jsonErr := json.Unmarshal(cached, &result); jsonErr == nil {
			return result, nil
		}
	}

	debts, err := s.repo.GetActiveDebtsForGroup(ctx, groupID)
	if err != nil {
		return nil, fmt.Errorf("failed to get active debts: %w", err)
	}
	if len(debts) == 0 {
		return []SimplifiedDebt{}, nil
	}

	// Build net balance map.
	balance := make(map[string]int)
	for _, d := range debts {
		balance[d.DebtorID] -= d.Amount
		balance[d.CreditorID] += d.Amount
	}

	// Separate into sorted creditors and debtors.
	type userBalance struct {
		userID string
		amount int
	}
	var creditors, debtors []userBalance
	for uid, bal := range balance {
		if bal > 0 {
			creditors = append(creditors, userBalance{uid, bal})
		} else if bal < 0 {
			debtors = append(debtors, userBalance{uid, -bal}) // store positive
		}
	}
	sort.Slice(creditors, func(i, j int) bool { return creditors[i].amount > creditors[j].amount })
	sort.Slice(debtors, func(i, j int) bool { return debtors[i].amount > debtors[j].amount })

	// Greedy two-pointer reduction.
	var simplified []SimplifiedDebt
	ci, di := 0, 0
	for ci < len(creditors) && di < len(debtors) {
		settle := min(creditors[ci].amount, debtors[di].amount)
		simplified = append(simplified, SimplifiedDebt{
			From:   debtors[di].userID,
			To:     creditors[ci].userID,
			Amount: settle,
		})
		creditors[ci].amount -= settle
		debtors[di].amount -= settle
		if creditors[ci].amount == 0 {
			ci++
		}
		if debtors[di].amount == 0 {
			di++
		}
	}

	// Cache for 30s (edge case 8).
	if data, err := json.Marshal(simplified); err == nil {
		s.rdb.Set(ctx, cacheKey, data, nettingCacheTTL)
	}

	return simplified, nil
}

// GetVaultSummary returns total household balance and per-member breakdown.
func (s *Service) GetVaultSummary(ctx context.Context, groupID string) (*VaultSummary, error) {
	members, err := s.repo.GetMembersByGroup(ctx, groupID)
	if err != nil {
		return nil, fmt.Errorf("failed to get members: %w", err)
	}

	total := 0
	memberBalances := make([]MemberBalance, len(members))
	for i, m := range members {
		total += m.PrepaidBalance
		memberBalances[i] = MemberBalance{UserID: m.UserID, Balance: m.PrepaidBalance}
	}

	return &VaultSummary{TotalBalance: total, Members: memberBalances}, nil
}

// AutoSettleStalePendingDebts finds debts stuck in pending_verification for > 48h
// and force-settles them. Returns the count of settled debts.
// This prevents the "hostage situation" (edge case 3).
func (s *Service) AutoSettleStalePendingDebts(ctx context.Context) (int, error) {
	stuckDebts, err := s.repo.GetStuckDebts(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get stuck debts: %w", err)
	}
	if len(stuckDebts) == 0 {
		return 0, nil
	}

	ids := make([]string, len(stuckDebts))
	groupIDs := make(map[string]struct{})
	for i, d := range stuckDebts {
		ids[i] = d.ID
		groupIDs[d.AddressGroupID] = struct{}{}
	}

	if err := s.repo.BulkSettleDebts(ctx, ids); err != nil {
		return 0, err
	}

	// Invalidate netting cache for all affected groups (edge case 8).
	for groupID := range groupIDs {
		s.invalidateNettingCache(ctx, groupID)
	}

	return len(stuckDebts), nil
}

