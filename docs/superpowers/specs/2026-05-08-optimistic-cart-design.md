# Optimistic Cart Updates — Design Spec
**Date:** 2026-05-08  
**Branch:** feature/sdui  
**Scope:** Add-to-cart latency fix (mobile only, no backend changes)

---

## Problem

Users perceive lag when adding a service to the cart. Three distinct bugs in the existing partial implementation cause this:

1. **Blank temp item** — `addItem` creates a placeholder with `service_name: ''` and `price_cents: 0`. Cart screen renders the item immediately but shows blank name and ₹0, making it look broken until server reconciliation.
2. **Stale closure on concurrent adds** — `addItem` captures `cart` in its `useCallback` deps. Two rapid taps: the second tap snapshots the pre-first-update cart state, so its optimistic write overwrites the first item.
3. **CartScreen always hydrates** — `CartScreen` initialises `hydrating = cartMemCache.addresses.length === 0` unconditionally. Even when items are already in context, the user sees a full-page skeleton until `refreshCart()` + `loadAddresses()` both resolve.

**Bonus bug** — `FloatingCartButton` renders `🛒` (emoji), violating the project rule: Feather/vector icons only.

---

## Existing infrastructure (already correct, keep as-is)

- `CartContext` uses React Context + `useState`. No Zustand/React Query. Not changing.
- `POST /cart/add` returns `ApiCart` (full cart object). Reconciliation is `setCart(serverCart)` — trivial.
- Rollback pattern (`setCart(snapshot)` on catch + `showError`) already exists for both `addItem` and `removeItem`.
- Badge animation (`pulseBadge`) fires before the API call — correct.
- `removeItem` already uses the correct optimistic pattern. No changes needed.

---

## Design

### 1. Enrich `addItem` signature — pass name + price

**File:** `src/context/CartContext.tsx`

Change:
```ts
addItem: (serviceId: string, durationMinutes: number) => Promise<void>
```
To:
```ts
addItem: (serviceId: string, durationMinutes: number, serviceName: string, priceCents: number) => Promise<void>
```

Use `serviceName` and `priceCents` when building `tempItem`. The cart screen then renders the correct name and price during the optimistic window.

### 2. Fix concurrent-add stale closure — functional updater

**File:** `src/context/CartContext.tsx`

Replace the snapshot-based optimistic add with a functional `setCart(prev => ...)` updater. This gives the updater access to the latest state at apply-time, not at callback-creation time, eliminating the stale closure entirely.

Remove `cart` from `addItem`'s `useCallback` dep array.

For rollback: instead of restoring the pre-add snapshot (which would lose other concurrent adds), remove the specific `tempId` from the current state:
```ts
setCart(prev => prev
  ? { ...prev, items: prev.items.filter(i => i.id !== tempId) }
  : null
);
```

Use a collision-resistant temp ID:
```ts
const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
```

### 3. CartScreen — skip skeleton when items already in context

**File:** `src/screens/main/CartScreen.tsx`

Change initial `hydrating` state:
```ts
// Before
const [hydrating, setHydrating] = useState(cartMemCache.addresses.length === 0);

// After
const [hydrating, setHydrating] = useState(cartMemCache.addresses.length === 0 && itemCount === 0);
```

When the user taps "Add" and then opens Cart, `itemCount > 0` from the optimistic state — the skeleton is skipped and the cart renders immediately. `refreshCart()` and `loadAddresses()` still run in the background; once they complete, `setHydrating(false)` fires (no-op since already false) and addresses populate.

### 4. Update all `addItem` call-sites

Three call-sites need to pass the new arguments:

| File | Current call | Updated call |
|------|-------------|--------------|
| `ServiceGridSection.tsx` | `addItem(svc.id, svc.min_duration_minutes)` | `addItem(svc.id, svc.min_duration_minutes, svc.name, svc.base_price_cents)` |
| `ServiceAboutScreen.tsx` | `addItem(service.id, d)` | `addItem(service.id, d, service.name, priceCents)` |
| `AllServicesScreen.tsx` | `addItem(service.id, ...)` | add `service.name, service.base_price_cents` |

`priceCents` in `ServiceAboutScreen` is already computed locally (`Math.round(service.base_price_cents * duration / service.min_duration_minutes)`) — pass that value.

### 5. FloatingCartButton — replace emoji with Feather icon

**File:** `src/components/FloatingCartButton.tsx`

Replace `<Text style={s.icon}>🛒</Text>` with `<Feather name="shopping-cart" size={22} color={Colors.white} />`.

---

## What is NOT changing

- Backend API — no changes
- `removeItem` — already correct
- Checkout / payment flow — out of scope (high-stakes, irreversible)
- Offline queue / retry-on-reconnect — out of scope, fast-follow
- Pending visual indicator on temp items — not adding (reconciliation is fast; silent is cleaner)
- `qty-change` optimistic updates — fast-follow after this ships

---

## Verification checklist

- [ ] Tap "Add" on a service card — badge increments within one frame, no perceptible delay
- [ ] Cart screen shows item immediately with correct name and price (no blank name, no ₹0)
- [ ] Navigate to Cart immediately after adding — no skeleton flash if item was already optimistic
- [ ] Rapid double-tap — only one item added (second tap builds on first optimistic state, not stale snapshot)
- [ ] Simulate network failure — item disappears, error toast shown, cart matches server state
- [ ] Force-quit + relaunch — cart loads from server, correct items
- [ ] FloatingCartButton shows Feather icon, not emoji

---

## Files changed

| File | Type |
|------|------|
| `src/context/CartContext.tsx` | Edit |
| `src/sdui/sections/ServiceGridSection.tsx` | Edit |
| `src/screens/main/ServiceAboutScreen.tsx` | Edit |
| `src/screens/main/AllServicesScreen.tsx` | Edit |
| `src/screens/main/CartScreen.tsx` | Edit |
| `src/components/FloatingCartButton.tsx` | Edit |
