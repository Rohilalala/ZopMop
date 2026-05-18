# Legacy pro lifecycle screens — Archived

This directory holds the three pre-Phase 10 pro screens that were
replaced by the single state-machine `JobDetailScreen` + the
`JobOfferScreen` modal.

| | |
|---|---|
| Archived on | 2026-05-17 |
| Original replacement | Phase 10 Part B — job lifecycle |
| Removal target | 2026-08-15 (90 days from archival) |

## Files

| File | Old role |
|------|----------|
| `ProMatchedScreen.tsx` | "You matched with this booking" screen between accept and on-the-way. Folded into `JobDetailScreen` state `accepted, en_route_at IS NULL`. |
| `ProActiveScreen.tsx` | Live job screen during in-progress. Folded into `JobDetailScreen` state `in_progress`. |
| `ProScheduledInviteScreen.tsx` | Push-triggered scheduled-booking invite. Replaced by the FCM-driven `JobOfferScreen` (which handles both stealth + scheduled invites via the unified `booking_offer` event). |

## What replaced them

- `src/screens/pro/JobsListScreen.tsx` — 3-section list (offers, active, today's completed)
- `src/screens/pro/JobOfferScreen.tsx` — 25-second offer modal, server-side timeout decoration
- `src/screens/pro/JobDetailScreen.tsx` — single state-machine screen keyed by booking status + timestamps

## Why these stay archived for 90 days

If Phase 10 rollout hits an unexpected snag (e.g. an FCM payload field
the legacy screens were quietly relying on), we can pull a specific
screen back without rebuilding from scratch. After 2026-08-15 — if no
rollback has happened — delete this directory in a single PR.

## Verification commands

```bash
# No active screens import these:
grep -r "ProMatchedScreen\|ProActiveScreen\|ProScheduledInviteScreen" src/ --include='*.ts' --include='*.tsx'

# No navigation routes target them:
grep -rE "navigate\(['\"](ProMatched|ProActive|ProScheduledInvite)['\"]" src/ --include='*.ts' --include='*.tsx'
```

Both should return zero hits.
