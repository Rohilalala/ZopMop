# Batch 2 deferred items

## D3-F1 — validateInviteIDs serial poll

Audit D3-F1 references a `validateInviteIDs` function. Grep across the entire repo finds it only in the audit doc itself — no Go code defines or calls it. Either the function was renamed since the audit, the audit captured it from a stale snapshot, or it was never landed.

Decision: investigate when awake. If a serial-poll pattern still exists somewhere in matching, batch it. If not, mark D3-F1 as already-fixed-or-stale.

## NEW-A5-001 — RequirePermission on CRM GET routes

Mechanical addition is straightforward (~32 LOC: 8 new permission keys + ~24 RequirePermission calls on GET routes across users/workers/orders/refunds/payouts/banners/promos/experiments).

Design call required: at what role floor should reads sit?
- `users.read` at RoleViewer (current behaviour, no change): every JWT-bearer can see PII drawer.
- `users.read` at RoleSupport: viewers blocked from PII drawer. Probably the intended split, but changes existing behaviour and may break a viewer-tier dashboard the user has in production.

Same call for workers / orders / refunds / payouts. The right answer depends on org policy.

Resume when awake.

