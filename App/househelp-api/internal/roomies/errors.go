package roomies

import "errors"

var (
	ErrHostMustTransferFirst    = errors.New("host must transfer rights before leaving")
	ErrMemberAlreadyExists      = errors.New("user is already a member of this group")
	ErrNotGroupMember           = errors.New("user is not a member of this group")
	ErrNotGroupHost             = errors.New("user is not the host of this group")
	ErrGroupHasActiveFinancials = errors.New("group has active balances or debts")
	ErrDebtNotFound             = errors.New("debt record not found")
	ErrUnauthorized             = errors.New("unauthorized")
	ErrBelowMinimumTopUp        = errors.New("top-up amount is below the minimum of ₹250 (25000 units)")
	ErrIdempotencyKeyConflict   = errors.New("idempotency key already used with different parameters")
	ErrGroupFull                = errors.New("this household is full (maximum 4 members)")
	ErrInvalidCode              = errors.New("no household found with this code")
	ErrAlreadyInGroup           = errors.New("you are already in a household group")
	ErrAddressAlreadyHasGroup   = errors.New("this address already has a household group")
)
