# Breaking changes

## 2026-05-15 — money fields renamed `*_cents` → `*_paise` on every API
## payload, webhook payload, and CRM contract.

### What changed

Every JSON wire-format key that ended in `_cents` is now `_paise`. The
values were always paise — India has no cents — but the keys claimed
otherwise. Affected keys across every customer / pro / CRM / webhook
endpoint:

| Old key | New key |
|---|---|
| `price_cents` | `price_paise` |
| `discount_cents` | `discount_paise` |
| `amount_cents` | `amount_paise` |
| `base_price_cents` | `base_price_paise` |
| `mrp_cents` | `mrp_paise` |
| `cancellation_fee_cents` | `cancellation_fee_paise` |
| `revenue_cents`, `revenue_today_cents`, `revenue_paise`, etc | `revenue_paise`, `revenue_today_paise` |
| `min_order_cents` | `min_order_paise` |
| `ltv_cents`, `avg_order_cents`, `avg_order_value_cents` | `_paise` variants |
| `base_fee_cents` | `base_fee_paise` |
| `gross_revenue_cents`, `net_revenue_cents`, `total_revenue_cents` | `_paise` variants |
| `partial_amount_cents` | `partial_amount_paise` |

Migration files renamed `booking_services.price_cents → price_paise`
(migration 094, already applied to prod) — backend SQL now matches the
schema. `cart_items.price_cents` and `service_categories.base_price_cents`
are still cents-named at the database layer; the JSON wire format is
paise-correct.

Go struct field names that previously read `*Cents` while their JSON
tag read `*_paise` were left as-is internally (e.g. `PriceCents int` is
still `PriceCents` in the Go source). The on-the-wire JSON key is the
contract; internal field names are a follow-up cleanup that doesn't
affect any consumer.

### Why

Audit code-quality finding #1 (Critical): 14 Go structs declared
`AmountPaise int` and serialised it as `json:"price_cents"`. External
integrators who didn't read Go source could legitimately interpret the
JSON as cents and multiply by 100, paying 100× wrong. Internal mobile
clients were also at risk of the same mistake after any handoff.

Locked decision (2026-05-15): money is paise end-to-end. No cents.

### Who needs to know

| Consumer | Action required |
|---|---|
| **ZopMop mobile customer app** | Mobile TS types updated in the same release. Old TestFlight builds (1.0.0(1) or earlier) will read `price_paise:null` as `undefined`, default to 0, and produce ₹0 totals everywhere. **Force-upgrade required on the day this ships.** |
| **ZopMop pro app** | Same — pro screens read pricing fields. Updated in same release. |
| **ZopMop CRM web app** | If `App/zopmop-crm/` reads any of the affected keys, update its types in the same deploy window. |
| **Webhook integrators (Cashfree, internal ops endpoints)** | All outgoing webhook payloads carry the new keys. If you've stood up internal ops dashboards that read our webhook payloads, update them in the same window. |
| **Sentry / PostHog event consumers** | The mobile `subtotal_cents` / `total_cents` PostHog event properties on `booking_checkout_started` are now `subtotal_paise` / `total_paise`. Update any saved insights / cohorts. |

### Rollback path

The change is mechanical. Reverting:

```bash
find internal pkg -name '*.go' -exec sed -i '' \
  -e 's|json:"price_paise"|json:"price_cents"|g' \
  -e 's|json:"discount_paise"|json:"discount_cents"|g' \
  -e 's|json:"amount_paise"|json:"amount_cents"|g' \
  -e 's|json:"base_price_paise"|json:"base_price_cents"|g' \
  -e 's|json:"mrp_paise"|json:"mrp_cents"|g' \
  -e 's|json:"cancellation_fee_paise"|json:"cancellation_fee_cents"|g' \
  -e 's|json:"revenue_paise"|json:"revenue_cents"|g' \
  -e 's|json:"revenue_today_paise"|json:"revenue_today_cents"|g' \
  -e 's|json:"min_order_paise"|json:"min_order_cents"|g' \
  -e 's|json:"ltv_paise"|json:"ltv_cents"|g' \
  -e 's|json:"avg_order_paise"|json:"avg_order_cents"|g' \
  -e 's|json:"avg_order_value_paise"|json:"avg_order_value_cents"|g' \
  -e 's|json:"base_fee_paise"|json:"base_fee_cents"|g' \
  -e 's|json:"gross_revenue_paise"|json:"gross_revenue_cents"|g' \
  -e 's|json:"net_revenue_paise"|json:"net_revenue_cents"|g' \
  -e 's|json:"total_revenue_paise"|json:"total_revenue_cents"|g' \
  -e 's|json:"partial_amount_paise"|json:"partial_amount_cents"|g' {} +
```

Plus the inverse on mobile TS. Schema doesn't roll back — migration
094 already shipped to prod. `booking_services.price_paise` stays.

---

## 2026-05-15 — `bookings.status` lifecycle adds `searching` as a valid pre-assignment state

### What changed

`AcceptBooking` now accepts both `pending` and `searching` as the
pre-assignment status, matching the StealthDispatcher's status flip
that was always intended to be acceptable.

Add `searching` to any external `bookings.status` enum documentation.

### Who needs to know

- CRM web app booking-status filters: if a "pending bookings" list
  query filters strictly on `status='pending'`, it will now miss the
  stealth-instant bookings in their pre-accept window. Either rename
  to "unassigned" with `IN ('pending', 'searching')` or accept the
  ~25 s gap during which a stealth booking is invisible.

### Rollback path

Reverts to single-status CAS. Don't do this without restoring the
stealth dispatcher's `status='searching'` flip too — they need to
move in lockstep.
