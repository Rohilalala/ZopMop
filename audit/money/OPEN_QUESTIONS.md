# Money Flow Audit — Open Questions

Items the audit could not resolve from code alone. Each requires founder input, a runtime probe, or an external doc.

## Architectural / merge intent

1. **Is `feature/payroll-targets-flags` going to merge into `develop` before pilot?**
   - It contains the file `App/househelp-api/internal/crm/payroll/payroll.go` (Mark-Paid / Mark-Failed / Recompute) and migrations 109 (audit log) + 110 (helper_flags). Audit ran on `develop@f228adb` which lacks these.
   - If merge happens: LB-3 dissolves and H-A (deductions aggregation) becomes solvable inside the new handler.
   - If not: shift the legacy `crm_payouts` table off and ship a thin handler on develop against the engine `payouts` table.

2. **Will Cashfree Payouts be integrated, or do pro bank wires stay manual indefinitely?**
   - Today the entire pro-payout rail is out-of-band IMPS/UPI. Mark-Paid only flips DB state.
   - If manual stays: must add an explicit "did the wire actually leave the merchant bank?" reconciliation step.
   - If automated later: clawback (LB-2 sub-finding) becomes implementable.

3. **Cashfree dispute webhook event taxonomy.**
   - Audit found zero references to `DISPUTE_*` / `CHARGEBACK_*` in code. Cashfree docs (not visible from repo) define the exact `eventType` strings.
   - Need a sandbox dispute to capture the real envelope and signature behaviour before wiring the handler.

## Configuration / pilot scope

4. **Pilot promo strategy.**
   - Are promo codes enabled for the 5-pro pilot? If yes, LB-5 (unbounded `discount_value`) is launch-blocking. If no, demote to MEDIUM.
   - Will referral credits (`wallet_transactions.kind='referral_credit'`) be active in pilot?

5. **Surge multiplier in pilot.**
   - `pricing_config.SurgeEnabled` flag — default? Pilot value?
   - If on: H-C (surge truncation) and H-G (cart shows pre-surge total) become user-visible drift in pilot.

6. **Platform fee / base rate locked during pilot?**
   - Hardcoded RN constants `PLATFORM_FEE_CENTS=2000` (`CartScreen.tsx:53`) and `BASE_RATE_PER_HOUR=80` (`proBookingCancel.ts:17`) drift from server config the moment server changes.
   - Confirm runbook freezes `pricing_config.BaseFeeCents` and `BaseRatePaisePerHour` for pilot duration.

## Behaviour requiring runtime evidence

7. **Does Cashfree ever return a partial-capture `payment_amount` lower than `order_amount`?**
   - `App/househelp-api/internal/payments/handler.go:760,768` reads but never asserts. Cashfree docs explicitly support capture-flow; sandbox test needed.

8. **Cashfree webhook delivery semantics on 5xx.**
   - LB-9 fix proposes returning 503 on transient DB errors so Cashfree retries. Need to confirm CF retry policy (count, backoff). If CF gives up after N retries, our 503 still loses the event eventually — need DLQ.

9. **`processed_webhook_events` table size & age distribution today.**
   - No TTL. If founders haven't seen a single Cashfree webhook in dev, table is small. At scale it grows ~30 MB/yr. Confirm dev/prod row count.

10. **Does anyone use the unused `payments.reconciled` column today?**
    - `MarkReconciled` / `UnreconciledCount` / `IsReconciled` have zero callers (`internal/payments/ledger.go:125-172`). Safe to repurpose for the new reconciliation cron without rename concerns.

11. **`stack_rules` table contents in production.**
    - Schema shipped, code never reads it (H-E). Need to `SELECT count(*) FROM stack_rules WHERE is_active` to confirm no admin has created rules that aren't applied.

## Compliance

12. **GST / tax obligation.**
    - Codebase computes no tax. For a marketplace > ₹20 L/yr aggregate booking value, GST capture + place-of-supply logic is statutory.
    - Need founder to confirm current annual turnover and whether GSTN registration exists. If yes, this audit's L4 finding becomes a separate compliance project.

13. **Closed-loop wallet vs RBI PPI.**
    - `migrations/067_wallets.up.sql` comment claims closed-loop (no withdrawal, no P2P) → outside PPI licensing.
    - If product adds any redemption to bank, the wallet becomes a PPI and requires RBI authorization.

## Out-of-codebase

14. **Refund timeline SLA.**
    - Cashfree's refund settlement is T+5 to T+7. Customer-facing UI in RN app does not surface this. Founders may want to add it; out of audit scope.

15. **Audit log retention.**
    - `payout_audit_log` is append-only (mig 109). For chargeback / dispute resolution older than a year, what is the retention policy? Currently unlimited.

16. **Bank-side reconciliation.**
    - Cashfree settlement → ZopMop merchant bank → founder's view. No code in this repo tracks the merchant bank. Founder must manually reconcile bank statements against `payments` daily. Pre-scale, build a settlement-reconciliation cron with the Cashfree Settlements API (out of audit scope but on the LB-2 trail).
