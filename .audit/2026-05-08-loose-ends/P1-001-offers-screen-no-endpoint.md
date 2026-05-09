# P1-001 — OffersScreen has no GET /offers endpoint

**Severity:** P1
**Category:** UX
**Surfaced by:** System walkthrough Part 6, confirmed in placeholder cleanup audit
**Date:** 2026-05-08

## Summary

Mobile app's OffersScreen exists and is reachable from ProfileScreen, but
there is no consumer-facing `GET /offers` endpoint on the user API. Promos
exist in two backend tables (`promotions` for codes, `home_promos` for hero
carousel), but no endpoint surfaces them as a list to the consumer's
"Offers" tab. Screen is currently dark or hardcoded. Fix: build
`GET /api/v1/offers` returning active promotions filtered by audience +
expiry. ~2 hr backend + 30 min mobile rewire.

## Finding

The mobile app has an OffersScreen accessible from the user's Profile.
ProfileScreen → "Offers" entry has been wired up to navigate to it. The
screen presumably renders a list of available offers/promotions.

But on the backend, there is no `GET /offers` route registered in
`cmd/api/main.go`. The only ways promotions surface to consumers today are:
1. Via the SDUI BFF's `promos.active` source, which feeds the home screen
   hero carousel by reading from `home_promos` table
2. By manually entering a code at checkout (`promotions` table, validated
   in CartScreen flow)

The OffersScreen has no data source. The placeholder cleanup audit annotated
this with a `TODO(backend): replace with GET /offers` comment.

## Evidence

```bash
# No /offers route in API
grep -rn "Get(\"/offers\|\"/offers\"" --include="*.go" App/househelp-api/cmd/api/

# Screen exists in mobile
ls App/zopmop-app/src/screens/main/OffersScreen.tsx

# Screen reachable
grep -rn "Offers" App/zopmop-app/src/screens/main/ProfileScreen.tsx | head -3
```

The placeholder cleanup audit (commit `959ee62`) added this as a deferred
backend item.

## Blast Radius

- **User-visible feature partially broken.** Tap "Offers" → see empty list
  or hardcoded fallback content. Looks like ZopMop has no promotions when
  the truth is the data exists.
- **Conversion impact.** Users who tap "Offers" expecting deals leave
  without booking.
- **Marketing investment wasted.** When you create a promo code in the CRM,
  no place for users to discover it organically — they only see it if you
  push it via SDUI hero carousel manually.

## Reproduction

```bash
curl https://zopmop-production.up.railway.app/api/v1/offers
# Expected: 404 Cannot GET /api/v1/offers
```

In the app: tap Profile → Offers → screen is dark or shows hardcoded list.

## Fix Plan

### Backend: Add GET /api/v1/offers

New handler in `internal/promotions/` (or wherever the promotion handlers
live). Mount under public-or-auth group depending on whether you want
unauthenticated browsing of offers.

Query shape:
```sql
SELECT id, code, name, description, discount_type, discount_value,
       min_order_cents, max_uses, uses_count, max_per_user,
       audience, audience_user_ids, categories, stackable,
       starts_at, expires_at, is_active
FROM promotions
WHERE is_active = true
  AND (starts_at IS NULL OR starts_at <= NOW())
  AND (expires_at IS NULL OR expires_at >= NOW())
  AND (max_uses IS NULL OR uses_count < max_uses)
  AND (audience = 'all'
       OR (audience = 'user_segment' AND $user_id = ANY(audience_user_ids))
       OR (audience = 'role' AND $user_role = ...))
ORDER BY display_order NULLS LAST, expires_at NULLS LAST
LIMIT 50;
```

Audience filtering must respect:
- `all` — visible to everyone
- `user_segment` — only to listed user IDs
- `role` — customer/helper specific (if used)
- `new_users` — users with bookings_count = 0 (requires join)
- `vip` — users marked VIP

Return shape (match what mobile expects — check OffersScreen.tsx after
ticket starts):
```json
{
  "offers": [
    {
      "id": "...",
      "code": "WELCOME50",
      "name": "Welcome offer",
      "description": "50% off your first booking up to ₹100",
      "discount_label": "50% OFF",
      "expires_at": "2026-06-30T23:59:59Z",
      "min_order_cents": 30000,
      "max_per_user": 1,
      "stackable": false,
      "categories": ["home_cleaning", "kitchen"]
    }
  ]
}
```

### Mobile: Wire OffersScreen to call it

Replace any hardcoded fallback with:
```typescript
const { data: offers } = useQuery({
  queryKey: ['offers'],
  queryFn: () => listOffers(token),
});
```

Add `listOffers` to `src/api/promotions.ts` (or whichever file). Standard
fetch pattern.

### Optional: Track impression + tap

```typescript
useEffect(() => {
  offers?.forEach(o => logEvent('offer_impression', { offer_id: o.id }));
}, [offers]);

const handleOfferTap = (offer) => {
  logEvent('offer_tap', { offer_id: offer.id, code: offer.code });
  promoStore.set(offer.code);
  navigate('AllServices');  // Or wherever is appropriate
};
```

(This depends on P0-002 being done — analytics SDK wired.)

## Recommendation

Do backend first, deploy, verify with curl. Then mobile rewire in same day.
Add impression tracking after P0-002 ships.

## Effort

- Backend handler + repository method + tests: 1.5 hr
- Audience filtering logic + tests: 30 min
- Mobile rewire: 30 min
- End-to-end verification with real promo: 30 min

**Total: 2.5-3 hr.**

## Dependencies

- None blocking the fix today
- Impression tracking depends on P0-002

## Acceptance Criteria

- `GET /api/v1/offers` returns active promotions filtered by audience
- OffersScreen renders real data, not hardcoded fallback
- Audience filtering verified: a user_segment promo not visible to
  non-segment users
- Expired promo not returned
- Tapping an offer copies the code or pre-fills it at checkout

## Anchor

Pre-fix tag: `pre-fix-offers-endpoint`
