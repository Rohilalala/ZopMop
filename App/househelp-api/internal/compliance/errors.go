package compliance

import "errors"

// Sentinel errors returned by the compliance Service. Handlers map these
// to HTTP responses; CRM tooling matches them via errors.Is.

// ErrPolicyDecisionRequired signals that a table touched by PurgeUserData
// has no registered RetentionPolicy and the operation cannot proceed
// without a documented retention decision (anonymize-vs-delete, retention
// window, legal carve-out). This is intentional: the codebase refuses to
// silently invent compliance posture for ambiguous tables. Audit F2D-1.
var ErrPolicyDecisionRequired = errors.New("compliance: retention policy decision required for table")

// ErrUserHasOpenObligations is returned when a user cannot be purged
// because they hold open state that would orphan a counterparty —
// non-zero wallet balance, open roomies prepaid balance, in-flight
// booking, unresolved dispute, etc. The caller (CRM admin or the user
// themselves) must resolve those obligations first.
var ErrUserHasOpenObligations = errors.New("compliance: user has open obligations preventing purge")

// ErrPurgeIncomplete signals that PurgeUserData partially succeeded and
// the transaction was rolled back. The user's row state is unchanged;
// retry is safe. Wraps the underlying per-table error so callers can
// log the proximate cause.
var ErrPurgeIncomplete = errors.New("compliance: purge could not complete; transaction rolled back")
