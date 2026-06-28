# Cart-Centric Booking + Payment Choice (Spec A+B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the instant/scheduled selector into the cart, clean the services screen, retire the legacy single-service instant flow, and add a two-step (when→method) checkout payment with a partial-wallet applicator that splits the remainder onto Cashfree.

**Architecture:** Phase A is pure RN frontend (delete `ModeToggle` from the services screen, relocate it to the cart, retire `InstantMatchingScreen`). Phase B1 is the frontend payment model (wallet applicator + when→method) wired to the existing `wallet`/`direct`/`cod` rails. Phase B2 is the one net-new backend capability — a `split` rail that debits the available wallet balance and charges the Cashfree remainder, atomic with rollback on cancel. Phase B3 wires the partial-wallet path in the app once B2 exists.

**Tech Stack:** RN/Expo + TypeScript (`App/zopmop-app`); Go/Fiber + pgx + Postgres (`App/househelp-api`); Cashfree PG; golang-migrate (forward-only).

**Spec:** `docs/superpowers/specs/2026-06-17-cart-centric-booking-payment-design.md` (decisions D1–D15).

---

## Execution model (agentic + recursive verify→fix)

Per the requested structure, execution proceeds in named phases and **does not stop at "implemented" — it loops until the goal is verifiably met**:

1. **Plan / baseline** — Phase 0: confirm the tree builds/typechecks green BEFORE any change (so later failures are attributable).
2. **Implement** — Phases A → B1 → B2 → B3, one bite-sized task at a time, each via a fresh subagent (subagent-driven-development). Every task self-verifies (tsc / go test / curl) before commit.
3. **Verify** — Phase V: the full gate across both apps + the headless API matrix.
4. **Fix what's broken** — Phase F: triage each Phase-V failure, dispatch a fixer subagent per failure.
5. **Verify again, recursively** — re-run Phase V after fixes. If still red, return to Phase F. **Loop F↔V until Phase V is fully green** (exit criterion in Phase F).

**Agent dispatch convention for Phases A–B3:** one subagent per Task. After each task, the orchestrator reviews the diff + the task's verification output before the next task. **Phase F** dispatches one fixer subagent per distinct failure, in parallel where the failures touch different files.

**Per-task commit rule:** every task ends with a commit on `feature/cart-booking-overhaul`. No AI-generated commit trailers (repo rule, `~/.claude/CLAUDE.md` §6). Money is **int64 paise** everywhere (repo non-negotiable).

---

## File structure (what each task touches)

**Frontend (`App/zopmop-app/`):**
- `src/screens/main/AllServicesScreen.tsx` — remove `ModeToggle`/`ModeBtn`, `mode` state, `isInstantSvc`, instant branches (A1, A2).
- `src/components/ModeToggle.tsx` — **new**: extract `ModeToggle`+`ModeBtn` into a reusable component (A1).
- `src/components/home/UsualsRow.tsx`, `src/components/ZopBookingCard.tsx` — remove `instant:true` nav params (A3).
- `src/screens/booking/InstantMatchingScreen.tsx` — **delete** (A4).
- `src/types/navigation.ts`, `src/navigation/MainNavigator.tsx` — drop `InstantMatching` route + `AllServices {instant}` param (A4).
- `src/screens/main/CartScreen.tsx` — host the timing toggle, collapse slot state, rewrite payment picker + `handleCheckout` (A5, B1.2, B1.3, B3.1).
- `src/components/SchedulingModal.tsx` — remove the ASAP option, slot-only (A5).
- `src/components/PaymentPicker.tsx` — **new**: wallet applicator + when→method (B1.1).
- `src/api/bookings.ts` — extend payload types with `payment_source: 'split'` + `wallet_apply_paise` (B1.4, B3.1).

**Backend (`App/househelp-api/`):**
- `migrations/143_booking_wallet_applied.up.sql` — **new**: `bookings.wallet_applied_paise` (B2.1).
- `internal/booking/model.go` — extend `oneof` to include `split` (B2.2).
- `internal/booking/service.go` — new `payBookingSplit` + wire into the three create paths (B2.3, B2.4).
- `internal/payments/handler.go` — `createCashfreeOrderForBooking` subtracts `wallet_applied_paise` (B2.5).
- `internal/booking/service.go` (cancel/refund path) — refund `wallet_applied_paise` on cancel of an unpaid split (B2.6).
- `internal/booking/split_payment_test.go` — **new** Go tests (B2.3, B2.6).

---

## Phase 0 — Baseline (planning)

### Task 0: Confirm green baseline before any change

**Files:** none (read-only verification).

- [ ] **Step 1: Backend builds + vets**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api && go build ./... && go vet ./...
```
Expected: no output, exit 0.

- [ ] **Step 2: Backend tests pass (DB-backed)**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api && \
TEST_DATABASE_URL=postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable \
go test ./internal/booking/... ./internal/wallet/... 2>&1 | tail -20
```
Expected: `ok` / `PASS` (or `SKIP` lines only where TEST_DATABASE_URL-dependent and unset — but it IS set here, so booking/wallet DB tests run). No `FAIL`.

- [ ] **Step 3: Frontend typechecks clean**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app && npx tsc --noEmit 2>&1 | tail -20
```
Expected: no errors (exit 0). **Record the exact output** — this is the baseline; Phase A/B must not introduce new tsc errors.

- [ ] **Step 4: Record baseline**

Note the tsc error count (should be 0) and the booking/wallet test pass count. These are the "before" numbers Phase V compares against. No commit (read-only).

---

## Phase A — Selector move + services cleanup (frontend only)

### Task A1: Extract `ModeToggle` into a reusable component

**Files:**
- Create: `App/zopmop-app/src/components/ModeToggle.tsx`
- Modify: `App/zopmop-app/src/screens/main/AllServicesScreen.tsx` (cut `ModeToggle`/`ModeBtn`, lines ~359–437)

- [ ] **Step 1: Create the reusable component**

Create `src/components/ModeToggle.tsx`. Move the verbatim `ModeToggle` (lines 359–410) and `ModeBtn` (lines 412–437) from `AllServicesScreen.tsx` into it. Export `Mode` and `ModeToggle`. Make `makeStyles`/`useC`/`useTheme` imports resolve from the same paths they used in `AllServicesScreen` (copy those imports). Public API:

```tsx
export type Mode = 'schedule' | 'instant';

export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (next: Mode) => void }) {
  /* ...verbatim body from AllServicesScreen.tsx:359–410... */
}
// ModeBtn stays private to this file (verbatim from AllServicesScreen.tsx:412–437)
```

- [ ] **Step 2: Typecheck**

Run: `cd App/zopmop-app && npx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors (the component compiles standalone; `AllServicesScreen` still has its own copy at this point — A2 removes it).

- [ ] **Step 3: Commit**

```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm
git add App/zopmop-app/src/components/ModeToggle.tsx
git commit -m "feat(app): extract reusable ModeToggle component"
```

### Task A2: Strip instant mode from `AllServicesScreen` (clean browse grid)

**Files:**
- Modify: `App/zopmop-app/src/screens/main/AllServicesScreen.tsx`

- [ ] **Step 1: Remove the in-file `ModeToggle`/`ModeBtn` definitions**

Delete the `ModeToggle` (lines ~359–410) and `ModeBtn` (lines ~412–437) function definitions now living in `src/components/ModeToggle.tsx`.

- [ ] **Step 2: Remove mode state + instant branches**

Apply these exact removals:
- Delete `const [mode, setMode] = useState<Mode>(route.params?.instant ? 'instant' : 'schedule');` (line ~141) and `const instantMode = mode === 'instant';` (line ~150).
- Delete `function isInstantSvc(s: ApiService): boolean { return s.min_duration_minutes <= 30; }` (lines ~104–106).
- Replace `const modeFiltered = useMemo(() => instantMode ? services.filter(isInstantSvc) : services, [services, instantMode]);` (lines ~200–202) with `const modeFiltered = services;` (or inline `services` at its use site).
- Delete the `<ModeToggle mode={mode} onChange={setMode} />` render (line ~293).
- Change `{!instantMode && <HomeCartBar />}` (line ~351) → `<HomeCartBar />`.
- In `ServiceCard.handleCardPress` (lines ~531–543) delete the `if (instantMode) { navigation.navigate('InstantMatching', {...}); return; }` block, leaving only `if (!inCart) navigation.navigate('ServiceAbout', { service });`.

- [ ] **Step 3: Remove now-dead imports**

Remove the `Mode`/`ModeToggle` local references and any import made unused by Step 2 (e.g. an animation import only used by the deleted toggle). Do NOT remove imports still used elsewhere.

- [ ] **Step 4: Typecheck**

Run: `cd App/zopmop-app && npx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors. (If `route.params?.instant` is referenced elsewhere it will error — A4 removes the param; if tsc flags it here, leave the `AllServices` param type untouched until A4 and ensure no other read of `instant` remains in this file.)

- [ ] **Step 5: Commit**

```bash
git add App/zopmop-app/src/screens/main/AllServicesScreen.tsx
git commit -m "feat(app): remove instant mode toggle from services screen"
```

### Task A3: Remove `instant:true` entry points

**Files:**
- Modify: `App/zopmop-app/src/components/home/UsualsRow.tsx` (line ~65)
- Verify: `App/zopmop-app/src/components/ZopBookingCard.tsx` (line ~79 — already no instant param; confirm no change needed)

- [ ] **Step 1: Fix the Usuals pin nav**

In `UsualsRow.tsx`, change `navigation.navigate('AllServices', { instant: true });` (line ~65) → `navigation.navigate('AllServices');`.

- [ ] **Step 2: Grep for any remaining instant entry points**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app
grep -rn "instant: true\|instant:true\|InstantMatching" src/ | grep -v "InstantMatchingScreen.tsx"
```
Expected: **no matches** (besides the screen file itself, deleted in A4). If any remain, fix each to drop the param / navigate to the cart flow.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | tail -5` → 0 errors.
```bash
git add App/zopmop-app/src/components/home/UsualsRow.tsx
git commit -m "feat(app): drop instant entry point from Usuals pin"
```

### Task A4: Retire `InstantMatchingScreen` + its route/param

**Files:**
- Delete: `App/zopmop-app/src/screens/booking/InstantMatchingScreen.tsx`
- Modify: `App/zopmop-app/src/navigation/MainNavigator.tsx` (route reg, lines ~158–162)
- Modify: `App/zopmop-app/src/types/navigation.ts` (`InstantMatching` entry line ~61; `AllServices: { instant?: boolean }` line ~40)

- [ ] **Step 1: Delete the screen + its route registration**

```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/zopmop-app
git rm src/screens/booking/InstantMatchingScreen.tsx
```
In `MainNavigator.tsx` delete the `<Stack.Screen name="InstantMatching" ... />` block (lines ~158–162) and its `import InstantMatchingScreen ...`.

- [ ] **Step 2: Update nav types**

In `src/types/navigation.ts`:
- Delete `InstantMatching: { serviceId: string; serviceName: string; durationMinutes?: number };` (line ~61).
- Change `AllServices: { instant?: boolean } | undefined;` (line ~40) → `AllServices: undefined;`.
- Leave `BookingConfirmed.bookingType: 'instant' | 'scheduled'` AS-IS (instant is still a valid booking *type*; only the *screen* is retired).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors. Any error here means a dangling reference to `InstantMatching`/`instant` param — fix it.

- [ ] **Step 4: Commit**

```bash
git add -A App/zopmop-app/src
git commit -m "feat(app): retire single-service InstantMatching flow"
```

### Task A5: Cart hosts the timing toggle; SchedulingModal becomes slot-only

**Files:**
- Modify: `App/zopmop-app/src/screens/main/CartScreen.tsx`
- Modify: `App/zopmop-app/src/components/SchedulingModal.tsx`

- [ ] **Step 1: Collapse cart timing state**

In `CartScreen.tsx`, replace the three timing fields (`selectedSlotId`, `selectedSlotLabel`, `asapSelected`, lines ~108–113) with:
```tsx
type Timing = 'instant' | 'scheduled';
const [timing, setTiming] = useState<Timing>('instant');
const [slot, setSlot] = useState<{ id: string; label: string } | null>(null);
```
Update every read: `asapSelected` → `timing === 'instant'`; `selectedSlotId` → `slot?.id`; `selectedSlotLabel` → `slot?.label`.

- [ ] **Step 2: Render the relocated `ModeToggle` once the cart is non-empty**

Import `ModeToggle, Mode` from `../../components/ModeToggle`. Above the payment section, render (only when `itemCount > 0`):
```tsx
{itemCount > 0 && (
  <ModeToggle
    mode={timing === 'instant' ? 'instant' : 'schedule'}
    onChange={(m) => {
      setTiming(m === 'instant' ? 'instant' : 'scheduled');
      if (m === 'instant') setSlot(null);
      else setSchedulingVisible(true); // open slot picker for scheduled
    }}
  />
)}
```

- [ ] **Step 3: SchedulingModal — remove ASAP, slot-only**

In `SchedulingModal.tsx`:
- Delete the ASAP card block (lines ~268–285) and the `asapSelected` state it drives.
- Narrow `ScheduleSelection` (lines ~22–24) to `export type ScheduleSelection = { kind: 'slot'; slotId: string; label: string };`.
- The slot tap (`onPress={() => { setSelectedSlot(slot); ... }}`) now always confirms a slot.

In `CartScreen.tsx`, the `onConfirm` handler (lines ~738–748) becomes:
```tsx
onConfirm={(sel: ScheduleSelection) => {
  setTiming('scheduled');
  setSlot({ id: sel.slotId, label: sel.label });
  setSchedulingVisible(false);
}}
```

- [ ] **Step 4: Confirm-button validation**

In `handleCheckout`, replace the slot guard with: `if (timing === 'scheduled' && !slot) { showError('Please pick a date and time slot.', { title: 'No time selected' }); return; }`. Instant requires no slot.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors. (Payment + the `handleCheckout` API calls are rewritten in B1; for now keep the existing `createInstantCartBooking`/`createScheduledBooking` calls working with `timing`/`slot`.)

- [ ] **Step 6: Commit**

```bash
git add App/zopmop-app/src/screens/main/CartScreen.tsx App/zopmop-app/src/components/SchedulingModal.tsx
git commit -m "feat(app): cart hosts instant/scheduled toggle; modal is slot-only"
```

### Task A6: Manual smoke of Phase A (services + cart nav)

**Files:** none (manual + run-app).

- [ ] **Step 1: Launch the app against the local stack**

Run: `cd App/zopmop-app && npx expo start` (or `expo run:ios`). Backend stack already up on :8080.

- [ ] **Step 2: Verify the flows**

Confirm: (a) services screen has NO Schedule/Instant toggle and shows ALL services (no min-duration filter); (b) adding a service → cart shows the Instant|Scheduled toggle; (c) Instant confirms with no slot; (d) Scheduled opens the slot modal (no ASAP option) and requires a slot. Note any defect for Phase F.

- [ ] **Step 3: No commit** (observation only; defects → Phase F).

---

## Phase B1 — Payment UI + non-split rails (frontend)

### Task B1.1: New `PaymentPicker` component (wallet applicator + when→method)

**Files:**
- Create: `App/zopmop-app/src/components/PaymentPicker.tsx`

- [ ] **Step 1: Define the payment model + component**

Create `src/components/PaymentPicker.tsx`:
```tsx
export type PayPlan =
  | { kind: 'wallet_full' }                 // wallet covers total
  | { kind: 'wallet_split' }                // wallet partial + online remainder
  | { kind: 'online' }                      // pay now, online, no wallet
  | { kind: 'pay_after' };                  // cod

export function PaymentPicker({
  totalPaise, walletBalancePaise, value, onChange,
}: {
  totalPaise: number;
  walletBalancePaise: number | null;        // null = not yet fetched
  value: { useWallet: boolean; payWhen: 'now' | 'after' };
  onChange: (next: { useWallet: boolean; payWhen: 'now' | 'after' }) => void;
}) {
  const bal = walletBalancePaise ?? 0;
  const applied = Math.min(bal, totalPaise);
  const covers = bal >= totalPaise && bal > 0;
  // When wallet is applied, the remainder is online-only → force payWhen='now'
  // and the Pay-after option is not offered (D13). `PayCard` below is modeled
  // verbatim on the existing `PaymentSourceCard` (lightweight selectable card,
  // NOT a filled CTA). `pp` styles via StyleSheet.create following the file's
  // existing style patterns.
  return (
    <View style={pp.wrap}>
      {bal > 0 && (
        <Pressable
          style={[pp.walletRow, value.useWallet && pp.walletRowOn]}
          onPress={() => onChange({ useWallet: !value.useWallet, payWhen: 'now' })}
        >
          <Feather name="zap" size={16} color={c.amber} />
          <Text style={pp.walletText}>Use wallet (₹{(bal / 100).toFixed(0)} available)</Text>
          <View style={[pp.check, value.useWallet && pp.checkOn]}>
            {value.useWallet && <Feather name="check" size={12} color={c.ink} />}
          </View>
        </Pressable>
      )}
      {value.useWallet && !covers && (
        <Text style={pp.hint}>
          ₹{(applied / 100).toFixed(0)} from wallet + ₹{((totalPaise - applied) / 100).toFixed(0)} online
        </Text>
      )}
      {value.useWallet && covers && <Text style={pp.hint}>Paid fully from wallet</Text>}
      {!value.useWallet && (
        <View style={pp.whenRow}>
          <PayCard label="Pay now" sub="UPI, card, netbanking" active={value.payWhen === 'now'}
            onPress={() => onChange({ useWallet: false, payWhen: 'now' })} />
          <PayCard label="Pay after service" sub="Cash, or pay online anytime" active={value.payWhen === 'after'}
            onPress={() => onChange({ useWallet: false, payWhen: 'after' })} />
        </View>
      )}
    </View>
  );
}

// PayCard — copy the existing PaymentSourceCard component (selectable card,
// title + subtitle + selected ring). Kept private to this file.
function PayCard({ label, sub, active, onPress }: { label: string; sub: string; active: boolean; onPress: () => void }) {
  /* verbatim structure of the old CartScreen PaymentSourceCard */
  return null as never; // replaced by the copied card markup during implementation
}

export function planFor(useWallet: boolean, payWhen: 'now' | 'after', totalPaise: number, walletBalancePaise: number | null): PayPlan {
  const bal = walletBalancePaise ?? 0;
  if (useWallet && bal > 0) return bal >= totalPaise ? { kind: 'wallet_full' } : { kind: 'wallet_split' };
  return payWhen === 'after' ? { kind: 'pay_after' } : { kind: 'online' };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd App/zopmop-app && npx tsc --noEmit 2>&1 | tail -10` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add App/zopmop-app/src/components/PaymentPicker.tsx
git commit -m "feat(app): PaymentPicker with wallet applicator + when/method model"
```

### Task B1.2: Map `PayPlan` → `payment_source` and wire into `handleCheckout`

**Files:**
- Modify: `App/zopmop-app/src/api/bookings.ts`
- Modify: `App/zopmop-app/src/screens/main/CartScreen.tsx`

- [ ] **Step 1: Extend the API payload types**

In `bookings.ts`, widen `payment_source` and add the wallet-apply hint:
```ts
// CreateBookingPayload + createInstantCartBooking payload:
payment_source?: 'direct' | 'wallet' | 'cod' | 'split';
wallet_apply_paise?: number; // only sent with 'split'
```
Apply to both `CreateBookingPayload` (lines ~52–65) and the inline `createInstantCartBooking` payload type (line ~148).

- [ ] **Step 2: Replace cart payment state + picker**

In `CartScreen.tsx`, replace `const [paymentSource, setPaymentSource] = useState<'direct'|'wallet'>('direct');` (line ~125) with:
```tsx
const [useWallet, setUseWallet] = useState(false);
const [payWhen, setPayWhen] = useState<'now' | 'after'>('now');
```
Replace the `<PaymentSourcePicker .../>` render with `<PaymentPicker totalPaise={totalCents} walletBalancePaise={walletBalance} value={{ useWallet, payWhen }} onChange={(v) => { setUseWallet(v.useWallet); setPayWhen(v.payWhen); }} />`. Delete the old `PaymentSourcePicker`/`PaymentSourceCard` definitions.

- [ ] **Step 3: Map plan → request in `handleCheckout`**

At the top of `handleCheckout`, compute:
```tsx
import { planFor } from '../../components/PaymentPicker';
const plan = planFor(useWallet, payWhen, totalCents, walletBalance);
const applied = Math.min(walletBalance ?? 0, totalCents);
const paymentSource = ({ wallet_full: 'wallet', wallet_split: 'split', online: 'direct', pay_after: 'cod' } as const)[plan.kind];
```
Replace the wallet pre-flight guard (lines ~263–268) with: only block when `plan.kind === 'wallet_full'` and `(walletBalance == null || walletBalance < totalCents)`. (Split never blocks on balance — it uses whatever is there.)
Pass `payment_source: paymentSource` (and, when `plan.kind==='wallet_split'`, `wallet_apply_paise: applied`) into both `createInstantCartBooking` and `createScheduledBooking` payloads.

- [ ] **Step 4: Post-confirm routing per plan**

- `plan.kind==='online'` or `'wallet_split'` → after create, `navigation.replace('Payment', { booking_id, amount_paise: <remainder for split, full for online>, bookingType, ...asap fields })` (Cashfree sheet). For split, the amount shown is `created.price_paise - applied`.
- `plan.kind==='wallet_full'` → `navigation.replace('BookingConfirmed', {...})` (paid inline).
- `plan.kind==='pay_after'` → `navigation.replace('BookingConfirmed', {...})` (cod, assigned immediately).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -20` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add App/zopmop-app/src/api/bookings.ts App/zopmop-app/src/screens/main/CartScreen.tsx
git commit -m "feat(app): wire wallet/online/pay-after rails through PaymentPicker"
```

### Task B1.3: Disable Roomies split under Pay-after (D-edge)

**Files:**
- Modify: `App/zopmop-app/src/screens/main/CartScreen.tsx`

- [ ] **Step 1: Gate the split UI**

Where the Roomies split section renders (driven by `splitEnabled`/`selectedMemberIds`), wrap it so it is hidden/disabled when `payWhen === 'after' || useWallet === false && ... ` — concretely: only allow Roomies split when `plan.kind === 'online' || plan.kind === 'wallet_full' || plan.kind === 'wallet_split'` (i.e. NOT `pay_after`). When `plan.kind==='pay_after'`, force `setSplitEnabled(false)`.

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | tail -5` → 0 errors.
```bash
git add App/zopmop-app/src/screens/main/CartScreen.tsx
git commit -m "feat(app): disable bill-split for pay-after bookings"
```

### Task B1.4: Headless verify the non-split rails (wallet-full / online / pay-after)

**Files:** none (uses the live stack + curl).

- [ ] **Step 1: Get a customer token**

Run (dev OTP 999999):
```bash
BASE=http://localhost:8080/api/v1
TOKEN=$(curl -s -X POST $BASE/auth/send-otp -H 'Content-Type: application/json' -d '{"phone":"+919000000001"}' >/dev/null; \
  curl -s -X POST $BASE/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"phone":"+919000000001","otp":"999999","has_accepted_privacy_policy":true}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
echo "len=${#TOKEN}"
```
Expected: `len` ≈ 400+.

- [ ] **Step 2: pay-after (cod) instant booking dispatches**

(Ensure the test pro is reseeded per `[[zopmop-unified-dispatch]]` — shift today + locality.) Then:
```bash
curl -s -X POST $BASE/bookings/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service_category_id":"a1000000-0000-0000-0000-000000000001","address":"A-101, Orchid Island, Sector 51, Gurugram","lat":28.4360,"lng":77.0680,"payment_source":"cod"}'
```
Expected: HTTP 201, `"assigned":true`, `helper_name` set. Verify DB: `payment_method='cod'`, `payment_status` NULL, `status='accepted'`.

- [ ] **Step 3: wallet-full instant booking dispatches**

```bash
curl -s -X POST $BASE/bookings/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service_category_id":"a1000000-0000-0000-0000-000000000001","address":"A-101, Orchid Island, Sector 51, Gurugram","lat":28.4360,"lng":77.0680,"payment_source":"wallet"}'
```
Expected: 201, assigned, wallet debited (`payment_status='paid'`). (This is the already-verified rail; confirms no regression.)

- [ ] **Step 4: No commit** (verification only; failures → Phase F).

---

## Phase B2 — Backend split charge (the one net-new capability)

### Task B2.1: Migration — `bookings.wallet_applied_paise`

**Files:**
- Create: `App/househelp-api/migrations/143_booking_wallet_applied.up.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 143_booking_wallet_applied.up.sql
-- Split payment: amount of the booking net already covered from the customer's
-- wallet at create time. The Cashfree order for a split booking charges
-- (amount_paise - discount_paise - wallet_applied_paise). Forward-only (repo policy).
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS wallet_applied_paise BIGINT NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply (rebuild migrate image first — see [[zopmop-migrations-testing]] footgun)**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api
docker compose build backend && docker compose run --rm migrate up
```
- [ ] **Step 3: Verify by OBJECT (not version line)**

Run:
```bash
docker exec househelp-postgres psql -U househelp -d househelp_db -tAc \
"SELECT column_name FROM information_schema.columns WHERE table_name='bookings' AND column_name='wallet_applied_paise';"
```
Expected: `wallet_applied_paise`.

- [ ] **Step 4: Commit**

```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm
git add App/househelp-api/migrations/143_booking_wallet_applied.up.sql
git commit -m "feat(api): add bookings.wallet_applied_paise for split payment"
```

### Task B2.2: Extend `payment_source` validation to allow `split`

**Files:**
- Modify: `App/househelp-api/internal/booking/model.go` (lines ~144, ~184, ~192)

- [ ] **Step 1: Widen the `oneof` on all three request structs**

In `CreateBookingRequest`, `CreateScheduledBookingRequest`, `CreateInstantBookingRequest`, change:
`validate:"omitempty,oneof=direct wallet cod"` → `validate:"omitempty,oneof=direct wallet cod split"`.
Add to each struct: `WalletApplyPaise int64 \`json:"wallet_apply_paise,omitempty" validate:"omitempty,gte=0"\``.

- [ ] **Step 2: Build**

Run: `cd App/househelp-api && go build ./internal/booking/` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add App/househelp-api/internal/booking/model.go
git commit -m "feat(api): accept payment_source=split + wallet_apply_paise"
```

### Task B2.3: `payBookingSplit` — debit partial wallet, leave Cashfree remainder (TDD)

**Files:**
- Create: `App/househelp-api/internal/booking/split_payment_test.go`
- Modify: `App/househelp-api/internal/booking/service.go` (new method near `payBookingFromWallet`, ~line 307)

- [ ] **Step 1: Write the failing test**

Create `internal/booking/split_payment_test.go` (models the `wallet/service_test.go` fixture pattern — no testify):
```go
package booking

import (
	"context"
	"os"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/wallet"
	"github.com/jackc/pgx/v5/pgxpool"
)

func splitTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// payBookingSplit debits min(balance, net) and stamps wallet_applied_paise,
// leaving the booking unpaid (payment_status pending) for the Cashfree remainder.
func TestPayBookingSplit_PartialDebit(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	// seed: a booking row (pending) + a customer wallet with 3000 paise.
	customer := makeUUID(t, "split-cust")
	bookingID := seedPendingBooking(t, pool, customer, 13000 /*net*/)
	w := wallet.NewService(wallet.NewRepository(pool))
	if _, err := w.Credit(ctx, customer, 3000, wallet.KindAdjustment, nil, nil, "seed"); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}
	svc := newSplitTestService(t, pool, w)

	applied, err := svc.payBookingSplit(ctx, bookingID, customer, 13000, 3000)
	if err != nil {
		t.Fatalf("payBookingSplit: %v", err)
	}
	if applied != 3000 {
		t.Fatalf("applied = %d, want 3000", applied)
	}
	// wallet drained to 0
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 0 {
		t.Fatalf("wallet balance = %d, want 0", bal)
	}
	// booking stamped: wallet_applied_paise=3000, payment_method='cashfree', payment_status pending (NULL)
	var applied2 int64
	var method, status *string
	pool.QueryRow(ctx, `SELECT wallet_applied_paise, payment_method, payment_status FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&applied2, &method, &status)
	if applied2 != 3000 || method == nil || *method != "cashfree" || status != nil {
		t.Fatalf("stamp mismatch: applied=%d method=%v status=%v", applied2, method, status)
	}
}
```
(Provide `makeUUID`, `seedPendingBooking`, `newSplitTestService` as small helpers in this test file — `seedPendingBooking` inserts a minimal `bookings` row with `amount_paise`, `status='pending'`; `newSplitTestService` constructs a `*Service` with the wallet + a ledger stub. Model exact column names on `internal/booking/capacity_test.go`'s seeding.)

- [ ] **Step 2: Run — verify it fails (method undefined)**

Run:
```bash
cd App/househelp-api && TEST_DATABASE_URL=postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable \
go test ./internal/booking/ -run TestPayBookingSplit_PartialDebit -v 2>&1 | tail -20
```
Expected: compile error `svc.payBookingSplit undefined` (or FAIL).

- [ ] **Step 3: Implement `payBookingSplit`**

In `service.go`, after `payBookingFromWallet` (~line 307), add (mirrors the single-tx pattern, returns the applied amount):
```go
// payBookingSplit debits min(walletBalance, netPaise) from the customer's
// wallet inside one tx, records the wallet payment row, stamps
// wallet_applied_paise + payment_method='cashfree' (remainder is charged via
// the Cashfree order, which subtracts wallet_applied_paise). payment_status
// stays unpaid until the gateway webhook confirms the remainder. Returns the
// applied paise. If walletBalance is 0 it applies 0 and the caller falls back
// to the plain direct path.
func (s *Service) payBookingSplit(ctx context.Context, bookingID, userID string, netPaise, requestedApply int64) (int64, error) {
	if s.wallet == nil || s.ledger == nil {
		return 0, fmt.Errorf("wallet payment not configured")
	}
	var applied int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		bal, err := s.walletRepo.GetBalanceTx(ctx, tx, userID) // FOR UPDATE inside the tx
		if err != nil {
			return fmt.Errorf("read wallet balance: %w", err)
		}
		applied = min64(bal, netPaise)
		if requestedApply > 0 {
			applied = min64(applied, requestedApply)
		}
		if applied <= 0 {
			return nil // nothing to apply; caller treats as plain direct
		}
		bid := bookingID
		if err := s.wallet.DebitTx(ctx, tx, userID, applied, "spend", &bid, "Booking "+bookingID+" (partial)"); err != nil {
			if isInsufficientBalance(err) { // should not happen — applied<=bal
				return ErrInsufficientWalletBalance
			}
			return fmt.Errorf("wallet debit (split): %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_status, webhook_received_at, reconciled)
			VALUES ($1::uuid, $2::uuid, $3, 'wallet', 'success', NOW(), TRUE)
		`, bookingID, userID, applied); err != nil {
			return fmt.Errorf("insert split wallet payment row: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bookings SET wallet_applied_paise = $2, payment_method = 'cashfree', updated_at = NOW()
			WHERE id = $1::uuid
		`, bookingID, applied); err != nil {
			return fmt.Errorf("stamp split booking: %w", err)
		}
		return nil
	})
	return applied, err
}

func min64(a, b int64) int64 { if a < b { return a }; return b }
```
Add a `GetBalanceTx(ctx, tx, userID)` to `internal/wallet/repository.go` if absent (a `SELECT balance_paise ... FOR UPDATE` variant of `GetBalance`); wire `s.walletRepo` on the booking `Service` if it only holds the wallet service today. If the booking Service has no direct repo handle, read the balance via a new `wallet.Service.BalanceTx(ctx, tx, userID)` wrapper instead — pick whichever matches the existing wiring and note it in the commit.

- [ ] **Step 4: Run — verify pass**

Run: same command as Step 2. Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/booking/split_payment_test.go App/househelp-api/internal/booking/service.go App/househelp-api/internal/wallet/repository.go
git commit -m "feat(api): payBookingSplit — partial wallet debit + Cashfree remainder"
```

### Task B2.4: Wire `split` into the three create paths

**Files:**
- Modify: `App/househelp-api/internal/booking/service.go` (the switches at ~714, ~1334, ~1506)

- [ ] **Step 1: Add the `split` case to `CreateBooking` (line ~714 switch)**

Add a `case "split":` that calls `payBookingSplit` and sets `unpaidCashfree = true` so the pro is NOT dispatched until the Cashfree remainder confirms:
```go
case "split":
	applied, err := s.payBookingSplit(ctx, booking.ID, customerID, int64(netPaise), req.WalletApplyPaise)
	if err != nil {
		if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
			log.Error().Err(cancelErr).Str("booking_id", booking.ID).Msg("rollback after split wallet debit failed")
		}
		return nil, fmt.Errorf("split payment failed: %w", err)
	}
	if applied >= int64(netPaise) {
		// Wallet covered the whole net (balance grew / rounding) — treat as wallet-only: stamp paid, dispatch.
		s.markSplitFullyPaid(ctx, booking.ID) // UPDATE payment_status='paid' + emit booking.paid
	} else {
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise-int(applied))
		unpaidCashfree = true
	}
```
Add the tiny `markSplitFullyPaid` helper (UPDATE `payment_status='paid'` + the booking.paid outbox insert, mirroring `payBookingFromWallet`'s tail).

- [ ] **Step 2: Mirror in `CreateInstantBookingFromCart` (line ~1506 switch)**

Add the identical `case "split":` block (same logic; `unpaidCashfree` already declared there).

- [ ] **Step 3: Mirror in `CreateScheduledBooking` (line ~1334)**

That path uses an `if req.PaymentSource == "wallet"` form. Convert to a `switch` (wallet / split / else) and add the split branch (no `unpaidCashfree` var there — scheduled doesn't sync-assign; the JIT cron + ClaimDue payment gate handles dispatch, which already requires `payment_status='paid'` for cashfree rows, so a split row stays ungated until the webhook).

- [ ] **Step 4: Build + run full booking tests**

Run: `cd App/househelp-api && go build ./... && TEST_DATABASE_URL=postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable go test ./internal/booking/ 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/booking/service.go
git commit -m "feat(api): wire split rail into all three booking-create paths"
```

### Task B2.5: Cashfree order charges the remainder for split bookings

**Files:**
- Modify: `App/househelp-api/internal/payments/handler.go` (`createCashfreeOrderForBooking`, lines ~391–462)

- [ ] **Step 1: Read + subtract `wallet_applied_paise`**

Change the booking-load SELECT (line ~404) to also read `wallet_applied_paise`, and compute `netPaise = amount_paise - discount_paise - wallet_applied_paise`:
```go
var walletApplied int64
err := h.db.QueryRow(ctx, `
	SELECT customer_id::text, amount_paise, COALESCE(discount_paise,0), COALESCE(wallet_applied_paise,0), status
	FROM bookings WHERE id = $1::uuid
`, bookingID).Scan(&bookingCustomerID, &amountPaise, &discountPaise, &walletApplied, &status)
// ...
netPaise := amountPaise - discountPaise - walletApplied
if netPaise <= 0 {
	return errResp(c, fiber.StatusConflict, "zero_amount", "no remainder due")
}
```

- [ ] **Step 2: Build**

Run: `cd App/househelp-api && go build ./internal/payments/` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add App/househelp-api/internal/payments/handler.go
git commit -m "feat(api): Cashfree order charges booking remainder after wallet_applied"
```

### Task B2.6: Refund the wallet portion when a split booking is cancelled unpaid (TDD)

**Files:**
- Modify: `App/househelp-api/internal/booking/service.go` (cancellation/refund path)
- Modify: `App/househelp-api/internal/booking/split_payment_test.go` (add test)

- [ ] **Step 1: Write the failing test**

Append to `split_payment_test.go`:
```go
// Cancelling a split booking that never paid its Cashfree remainder must
// credit the wallet_applied_paise back to the customer.
func TestSplitCancel_RefundsWalletPortion(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	customer := makeUUID(t, "split-cancel")
	bookingID := seedPendingBooking(t, pool, customer, 13000)
	w := wallet.NewService(wallet.NewRepository(pool))
	w.Credit(ctx, customer, 3000, wallet.KindAdjustment, nil, nil, "seed")
	svc := newSplitTestService(t, pool, w)
	if _, err := svc.payBookingSplit(ctx, bookingID, customer, 13000, 3000); err != nil {
		t.Fatalf("split: %v", err)
	}
	// balance now 0; cancel the unpaid split.
	if err := svc.refundSplitWalletOnCancel(ctx, bookingID); err != nil {
		t.Fatalf("refund on cancel: %v", err)
	}
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 3000 {
		t.Fatalf("balance after cancel-refund = %d, want 3000", bal)
	}
}
```

- [ ] **Step 2: Run — verify fail**

Run: `TEST_DATABASE_URL=... go test ./internal/booking/ -run TestSplitCancel_RefundsWalletPortion -v 2>&1 | tail -15`
Expected: `refundSplitWalletOnCancel undefined`.

- [ ] **Step 3: Implement + hook into the cancel path**

Add:
```go
// refundSplitWalletOnCancel credits back the wallet portion of a split booking
// whose Cashfree remainder never settled. Idempotent: it zeroes
// wallet_applied_paise so a re-cancel can't double-refund.
func (s *Service) refundSplitWalletOnCancel(ctx context.Context, bookingID string) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var customerID string
		var applied int64
		var status *string
		if err := tx.QueryRow(ctx, `
			SELECT customer_id::text, COALESCE(wallet_applied_paise,0), payment_status
			FROM bookings WHERE id = $1::uuid FOR UPDATE`, bookingID).Scan(&customerID, &applied, &status); err != nil {
			return err
		}
		if applied <= 0 || (status != nil && *status == "paid") {
			return nil // nothing to refund, or fully paid (the gateway refund path handles paid)
		}
		bid := bookingID
		if _, err := s.walletRepo.ApplyTransactionTx(ctx, tx, wallet.WalletTx{
			UserID: customerID, AmountPaise: applied, Kind: wallet.KindRefundCredit,
			BookingID: &bid, Note: "Split booking cancelled — wallet portion returned",
		}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE bookings SET wallet_applied_paise = 0, updated_at = NOW() WHERE id = $1::uuid`, bookingID); err != nil {
			return err
		}
		return nil
	})
}
```
Call `refundSplitWalletOnCancel` from every cancel entry that can terminate an unpaid booking: the no-pro ASAP terminal path (`markASAPNoPro`), the user-cancel handler, and the JIT-cron terminal cancel (assigner_cron). Add the call right before/after the existing `CancelBookingWithFee` so the wallet portion is returned in the same logical cancel.

- [ ] **Step 4: Run — verify pass + full booking suite**

Run: `TEST_DATABASE_URL=... go test ./internal/booking/ 2>&1 | tail -20` → PASS.

- [ ] **Step 5: Commit**

```bash
git add App/househelp-api/internal/booking/service.go App/househelp-api/internal/booking/split_payment_test.go
git commit -m "feat(api): refund wallet portion when an unpaid split booking is cancelled"
```

---

## Phase B3 — Wire the partial-wallet path in the app

### Task B3.1: Split confirm → Cashfree sheet for the remainder

**Files:**
- Modify: `App/zopmop-app/src/screens/main/CartScreen.tsx`

- [ ] **Step 1: Verify the split branch in `handleCheckout`**

Confirm B1.2 already sends `payment_source: 'split'` + `wallet_apply_paise: applied` for `plan.kind==='wallet_split'`, and routes to the `Payment` screen with `amount_paise: created.price_paise - applied`. If the `Payment` screen creates the Cashfree order via `POST /payments/cashfree/order {payment_source:'direct', booking_id}`, no change is needed there — B2.5 makes that order charge the remainder. Confirm the `Payment` screen passes `booking_id` (not an amount) to the order endpoint.

- [ ] **Step 2: Typecheck**

Run: `cd App/zopmop-app && npx tsc --noEmit 2>&1 | tail -10` → 0 errors.

- [ ] **Step 3: Commit (if any change)**

```bash
git add App/zopmop-app/src/screens/main/CartScreen.tsx
git commit -m "feat(app): split confirm routes remainder to Cashfree sheet"
```

### Task B3.2: Headless verify the split rail end-to-end

**Files:** none (live stack + curl + DB).

- [ ] **Step 1: Seed a partial wallet + create a split booking**

Set the customer wallet to LESS than a booking total (e.g. 3000 paise), then:
```bash
curl -s -X POST $BASE/bookings/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service_category_id":"a1000000-0000-0000-0000-000000000001","address":"A-101, Orchid Island, Sector 51, Gurugram","lat":28.4360,"lng":77.0680,"payment_source":"split","wallet_apply_paise":3000}'
```
Expected: 201, booking `status='pending'`, **not** assigned yet (unpaidCashfree). DB: `wallet_applied_paise=3000`, wallet balance 0, `payment_method='cashfree'`, `payment_status` NULL.

- [ ] **Step 2: Create the Cashfree order — assert remainder amount**

```bash
curl -s -X POST $BASE/payments/cashfree/order -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"payment_source":"direct","booking_id":"<id>"}'
```
Expected: a `payment_session_id` + an amount equal to `(booking total − 3000)`. (In sandbox; Cashfree may be disabled locally — if so, assert the handler computed `netPaise = amount - discount - 3000` via a unit/log check instead, and record that the live gateway leg is sandbox-gated.)

- [ ] **Step 3: Cancel the unpaid split → wallet refunded**

Cancel the booking; assert wallet balance returns to 3000 and `wallet_applied_paise=0` (per B2.6).

- [ ] **Step 4: No commit** (verification only; failures → Phase F).

---

## Phase V — Verification gate (run after all tasks)

### Task V: Full gate

**Files:** none.

- [ ] **Step 1: Backend build + vet + tests**

Run:
```bash
cd /Users/adityarohilla/Documents/zopmop-wt-crm/App/househelp-api && go build ./... && go vet ./... && \
TEST_DATABASE_URL=postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable go test ./... 2>&1 | tail -30
```
Expected: build/vet clean; tests `PASS`/`ok` (skips only where TEST_DATABASE_URL-independent suites legitimately skip). **No `FAIL`.**

- [ ] **Step 2: Migrations apply clean on a throwaway DB**

Run (proves 143 composes from baseline):
```bash
cd App/househelp-api
docker exec househelp-postgres psql -U househelp -c "DROP DATABASE IF EXISTS hh_verify; CREATE DATABASE hh_verify;" 2>&1 | tail -2
DATABASE_URL=postgres://househelp:localdev123@localhost:5433/hh_verify?sslmode=disable MIGRATIONS_PATH=$(pwd)/migrations go run ./cmd/migrate up 2>&1 | tail -3
```
Expected: `version: 143`, no error. Then `DROP DATABASE hh_verify`.

- [ ] **Step 3: Frontend typecheck (no new errors vs Phase 0 baseline)**

Run: `cd App/zopmop-app && npx tsc --noEmit 2>&1 | tail -30`
Expected: error count == Phase 0 baseline (0).

- [ ] **Step 4: Headless rail matrix**

Drive all four rails via the API (reseed the test pro first per `[[zopmop-unified-dispatch]]`): `cod` (assign now, unpaid), `wallet` full (paid+assign), `direct` (pending until webhook), `split` (partial debit + remainder order + cancel-refund). Assert each rail's `payment_source`/`payment_method`/`payment_status`/dispatch per §4.3 of the spec. Capture a pass/fail line per rail.

- [ ] **Step 5: Manual UI matrix**

In the app: services screen has no toggle + shows all services; cart shows the relocated toggle (instant/scheduled) + the wallet applicator + when→method; each combination confirms to the right screen. Record pass/fail per item.

- [ ] **Step 6: Produce the verification report**

List every Step 1–5 check as ✅/❌ with the failing output quoted. **If all ✅ → goal met, STOP.** If any ❌ → Phase F.

---

## Phase F — Recursive fix (loop until Phase V is green)

> This phase implements the user's "fix what's broken → verify again and again → fix recursively till the goal is met" requirement. It is a LOOP, not a one-shot.

### Task F: Triage → fix → re-verify (repeat)

- [ ] **Step 1: Triage the Phase-V report**

For each ❌, classify: which file/layer, root cause (read the failing test/curl output + the relevant source), and whether it's independent of other failures.

- [ ] **Step 2: Dispatch one fixer subagent per distinct failure**

For each failure, dispatch a subagent with: the exact failing command + output, the relevant file:line, the spec section it violates, and the instruction to fix **only** that failure (surgical — `~/.claude/CLAUDE.md` §3) with a test/curl proving the fix. Run independent fixers in parallel (different files); serialize fixers that touch the same file.

- [ ] **Step 3: Re-run the affected Phase-V step(s)**

Re-run only the checks that were ❌ (plus any check whose files the fix touched). Confirm they flip to ✅ and that no previously-green check regressed (if a fix touches shared code, re-run Step 1 build+test of Phase V).

- [ ] **Step 4: Recurse**

If any check is still ❌ (or a fix caused a new ❌), return to **Step 1** with the updated report. **Exit only when an entire Phase V run is green with zero fixes applied in that pass** (a clean full pass = goal met).

- [ ] **Step 5: Final commit + summary**

When Phase V is fully green: ensure every change is committed on `feature/cart-booking-overhaul`, and write a one-paragraph completion summary listing the rails verified + the UI flows confirmed. Do NOT push or open a PR unless the user asks (`~/.claude/CLAUDE.md` §6).

---

## Notes / landmines (carry into execution)

- **Migration footgun** ([[zopmop-migrations-testing]]): after adding migration 143, `docker compose build backend` BEFORE `migrate` — the migrate service bakes migrations into the image; a stale image silently no-ops. Verify by OBJECT, not the version line.
- **Reseed the test pro** before any dispatch-dependent verification ([[zopmop-unified-dispatch]]): shift today + `helpers.locality='Orchid Island Gurugram'`; the assigner gate is `shift_sessions`+`shift_commitments`+locality, NOT redis/`is_available`.
- **Cashfree is sandbox/may be disabled locally** — the split's gateway leg may not complete end-to-end without sandbox creds; where it can't, assert the computed remainder amount + the wallet debit/refund (the parts that don't need the live gateway) and record the gateway leg as sandbox-gated.
- **int64 paise** everywhere; **no AI commit trailers**; **never push `main`**; this work lives on `feature/cart-booking-overhaul` → PR to `develop` when the user asks.
- **C10 (OTP "999999")** is an open business-rule blocker (`docs/business-rules-audit-2026-05-21.md`) relevant to Spec C's server-OTP work, not A+B.
