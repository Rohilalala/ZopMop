# JSON tag rename: amount_paise / discount_paise

Several models still expose price/amount fields with legacy JSON tags
(`price_cents`, `discount_cents`, etc.) instead of the canonical
`amount_paise` / `discount_paise` naming the rest of the codebase
uses post-currency-migration.

Rename is conditional on mobile v2 client release — old client builds
still send / expect the legacy keys.

## Affected files

- `internal/booking/model.go` (4 fields)
- `internal/zop/service.go` (2 fields)
- `internal/crm/users/model.go` (1 field)
- `internal/crm/workers/model.go` (1 field)
- `internal/admin/model.go` (2 fields)
- `internal/crm/orders/orders.go` (2 fields)
- `internal/helper/model.go` (1 field)
- `internal/webhooks/payloads.go` (1 field)

## Migration plan

1. Mobile v2 ships with new keys + a backward-compat deserialiser
   that accepts both.
2. Wait for v2 adoption to reach >95% (typically 2–4 weeks).
3. Update server JSON tags to the new names.
4. Deprecate the old keys in the next mobile release.

## Why not now

Renaming server tags now breaks mobile v1 clients that still send
`price_cents` etc. Server-side renaming is gated on client adoption;
flipping early causes silent zero-value parsing on the customer
device, which would mark bookings paid for ₹0 / display ₹0 totals.

The Go field names are already canonical (`AmountPaise`,
`DiscountPaise`). The lie lives only in the wire format.

## Related

`README.md` § "Known *_cents naming drift" lists the schema-level
columns that share this pattern (`price_cents`, `mrp_cents`,
`revenue_*_cents`). Those are storage names, not wire-format
names — separate cleanup track.
