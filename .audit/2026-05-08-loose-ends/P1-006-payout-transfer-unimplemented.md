# P1-006 — Payouts module unused for launch (fixed-salary model)

**Severity:** P3 (downgraded from P1 per business logic clarification 2026-05-08)
**Category:** OPS
**Surfaced by:** System walkthrough Part 4 (CRM Payouts module)
**Date:** 2026-05-08

## Summary

The CRM has a Payouts module with state machine UI but no payment provider
integration for actual bank transfers. Originally classified P1 assuming
ZopMop would pay helpers via in-app earnings model. Per business logic
clarification on 2026-05-08, helpers are paid fixed salaries through
external payroll for the first several months — the entire payouts feature
is not used at launch. Fix: hide the Payouts module from CRM v1 (P1-002
scoping), document that payouts is a deferred feature, revisit when the
business model shifts to per-booking earnings. Approx 30 min documentation
and CRM v1 scoping decision.

## Finding

The system has scaffolding for per-booking earnings payouts:
- `crm_payouts` table
- CRM Payouts API module (list, mark paid, mark failed)
- State machine fields

But two pieces are missing:
- No payment provider integration for actual transfers
- No upstream feeder logic that converts completed bookings into payout rows

For the originally-feared scenario (helpers see earnings they cannot
withdraw), the second missing piece actually saves us — there is no path
that creates payout rows automatically. The table is empty.

Per business logic confirmed 2026-05-08: ZopMop pays helpers fixed monthly
salaries during the early operational period. Payroll happens outside the
system entirely. The `crm_payouts` module is forward-compatible scaffolding
for a future per-booking earnings model, not active functionality.

## Evidence

```bash
grep -rn "crm_payouts" --include="*.go" App/househelp-api/
grep -rn "INSERT INTO crm_payouts" --include="*.go" App/househelp-api/
```

Expected: read paths exist in CRM module, no automatic insert paths from
booking completion flow.

## Blast Radius Under Fixed-Salary Model

None today. The feature is dormant. No helper sees earnings in-app
because no earnings UI exists on the helper side. No admin will mark
payouts because no payout rows are created. The module is invisible.

The only risk is "feature surface area without owner" — someone could
accidentally enable the feature in CRM v1, build a UI for it, and then
realize it doesn't actually transfer money. Prevented by explicit scoping
decision.

## Reproduction

Not applicable. Feature is unused.

## Fix Plan

### Step 1: Document the deferral

Add `docs/PAYOUTS_DEFERRED.md`:
- Business model: helpers paid fixed monthly salaries via external payroll
  during early launch (specific timeline TBD)
- `crm_payouts` table is dormant scaffolding
- Do not build CRM v1 UI for Payouts module
- Revisit when business model shifts to per-booking earnings

### Step 2: CRM v1 scoping (combines with P1-002)

When P1-002 (CRM frontend v1) gets built, explicitly exclude the Payouts
module from Tier 1. Note in CRM v1 scope doc: "Payouts deferred per
fixed-salary launch model — see `docs/PAYOUTS_DEFERRED.md`."

### Step 3: Helper-side check

Confirm no UI in `zopmop-app` shows helpers any earnings or payout balance.

```bash
grep -rn "earnings\|payout\|salary\|wallet_pro" App/zopmop-app/src/screens/pro/
```

If anything shows helpers a balance, hide it for launch.

### Step 4: When the model shifts (future)

At the point ZopMop transitions to per-booking earnings:
- Build the upstream feeder: completed booking → `crm_payouts` row insert
- Wire payment provider (Cashfree Payouts API recommended)
- Add helper bank details + PAN to onboarding
- Build CRM admin UI for payout queue

The original ticket detail becomes relevant only at that future point.
Carry it as a separate epic in your launch+90 backlog.

## Recommendation

Step 1 + Step 2 + Step 3 today. Step 4 deferred to whenever business model
changes. Reclassify ticket as P3 (cleanup/scoping concern) until then.

## Effort

- Step 1: 15 min documentation
- Step 2: covered in P1-002 scoping (no marginal cost)
- Step 3: 10 min grep + visual check
- Step 4: 8-10 hr when activated, plus KYC wait

**Total today: under 30 min.**

## Dependencies

- P1-002 (CRM frontend) scoping respects deferral
- Helper-side UI does not surface payout/earnings UI

## Acceptance Criteria (today)

- `docs/PAYOUTS_DEFERRED.md` exists explaining the deferral
- P1-002 ticket annotated to exclude Payouts from CRM v1
- Pro-side mobile screens contain no earnings/payout UI
- `crm_payouts` table left in place as forward-compat scaffolding

## Acceptance Criteria (when activated — future)

See original P1-006 ticket spec in git history. Pre-fix tag
`pre-fix-payouts-implementation` to be created when work begins.

## Anchor

No anchor needed for documentation-only change today.
