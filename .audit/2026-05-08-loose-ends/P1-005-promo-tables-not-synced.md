P1-005 - home_promos has no admin write path; relationship to promotions/banners undefined

Severity: P1
Category: DATA
Surfaced by: System walkthrough Part 6 + investigation 2026-05-08
Date: 2026-05-08

SUMMARY
Investigation on 2026-05-08 confirmed home_promos table is wired to the SDUI
hero carousel via a single SELECT in bff/sources.go, but has zero write
paths in the codebase: no seed migration, no CRM CRUD, no Go INSERT
anywhere. Hero carousel queries an empty table. Meanwhile the CRM has a
banners CRUD module with overlapping fields. Relationship between
promotions (codes), home_promos (current hero source), and banners
(editorial CRUD with no current consumer) is undefined. Fix: pick the
canonical editorial table (likely banners), update BFF source to read
from it, drop home_promos. Approx 3-4 hr.

FINDING
Investigation results 2026-05-08:

grep -rn "home_promos" --include="*.go" App/househelp-api/
returns ONE reference: a SELECT in App/househelp-api/internal/bff/sources.go:227

No INSERT migrations, no UPDATE paths, no CRM endpoints, no test fixtures.
home_promos is a read-only sink with nothing writing to it.

Meanwhile the CRM has a Banners module per walkthrough Part 4: full CRUD,
fields like title, subtitle, image_url, tap_action, cta_label, cta_kind,
display_order, is_active, starts_at, ends_at, audience, audience_zone,
plus a reorder endpoint. These fields match what a hero carousel slide
needs.

Three possible explanations:
1. Refactor in flight: banners is the proper editorial model, BFF source
   was not migrated yet
2. Different surfaces: banners are for some other UI surface and
   home_promos was specifically for hero, but home_promos still lacks a
   write path
3. Legacy plus dead code: home_promos was an early prototype, banners is
   the replacement, BFF source is stale

All three explanations lead to the same fix: consolidate.

EVIDENCE
grep -rn "home_promos" --include="*.go" App/househelp-api/
Single result: bff/sources.go:227 (a SELECT)

grep -rn "INSERT INTO home_promos\|UPDATE home_promos\|DELETE FROM home_promos" --include="*.go" --include="*.sql" App/househelp-api/
Empty - no write paths anywhere.

grep -rn "banners" --include="*.go" App/househelp-api/internal/crm/ | head
Confirms full CRUD exists in CRM module.

BLAST RADIUS
Hero carousel always empty in production until manually populated. Even
after launch, when admin creates banners via CRM (once frontend ships),
those banners do not appear in app because BFF reads home_promos. Mental
model split: admin creates content in one place, customers read from
another, debugging requires understanding the disconnect.

At launch: visible empty hero space on home screen unless someone
hand-INSERTs rows. With first marketing campaign, no place for the
content to live cleanly.

REPRODUCTION
SELECT COUNT(*) FROM home_promos;
Likely returns 0.

SELECT COUNT(*) FROM banners;
May or may not be 0 depending on whether anything was seeded during
testing.

In the app: home screen renders, hero_carousel section is in SDUI config,
data array is empty. Section likely renders as collapsed empty space or
shows a hardcoded fallback.

FIX PLAN

Step 1: Determine canonical table
psql '<url>' -c "\d home_promos"
psql '<url>' -c "\d banners"

Compare schemas side by side. The one with more validation, more fields,
audience/zone targeting, time-window filtering is likely canonical.
Almost certainly banners.

Step 2: Pick a strategy

Option A (recommended): Banners is canonical, home_promos is dead
- Update bff/sources.go:227 SELECT to read FROM banners with proper
  filtering: is_active=true AND now() BETWEEN starts_at AND ends_at AND
  audience filtering
- Add migration 080_drop_home_promos.up.sql:
  DROP TABLE IF EXISTS home_promos CASCADE;
- Document in code: banners is the canonical editorial source for home
  hero carousel
- Optional: rename SDUI source name from promos.active to banners.active
  for clarity (breaks existing SDUI config references, may want to defer)

Option B: home_promos is canonical for hero, banners is for elsewhere
- Build CRM CRUD for home_promos
- Keep banners table for whatever surface uses it (verify what)
- Document the split clearly

Option C: Unify into one table with a surface discriminator
- Drop both, create new editorial_slides with surface field
  (home_hero/banner/inline)
- One CRM section, surface-filtered queries
- Pro: cleanest long-term
- Con: migration risk, breaks existing CRM banners code

Step 3: Implement chosen option (likely A)
1. Read banners schema, confirm fields satisfy what bff/sources.go expects
2. Update SQL query in bff/sources.go:227 to read from banners with
   audience/zone/time filtering
3. Add migration 080_drop_home_promos.up.sql
4. Test: create a banner via CRM (manual psql or API), confirm it appears
   in home hero carousel via SDUI

Step 4: Document
Add docs/EDITORIAL_CONTENT.md:
- Banners table is single source for home hero carousel slides
- CRM admin creates/edits via Banners module
- Slides may optionally link to a promotion code via promotion_id
  nullable FK (combines with original P1-005 idea)

Step 5: Verify integration with P1-001
P1-001 covers OffersScreen endpoint for discount codes. P1-005 covers
editorial hero slides. Both ship together: customers see codes in
OffersScreen (transactional surface) and themed campaigns in hero
carousel (editorial surface).

RECOMMENDATION
Step 1 first to confirm canonical table, then Option A. Do this work
inline with P1-002 (CRM frontend) since the Banners module decision
affects both.

EFFORT
- Step 1 investigation: 30 min
- Steps 2-3 implementation: 2 hr
- Step 4 documentation: 30 min
- End-to-end verification: 30 min

Total: approx 3-4 hr

DEPENDENCIES
- Decision on canonical table (Step 1)
- P1-002 (CRM frontend) consumes the canonical table - should be aligned
  before frontend builds Banners module

ACCEPTANCE CRITERIA
- BFF source reads from canonical table (banners or unified)
- A banner created via CRM API appears in home hero carousel within ETag TTL
- home_promos table either dropped or formally documented as legacy
- docs/EDITORIAL_CONTENT.md exists explaining the relationship
- No phantom content tables in schema with no write path

ANCHOR
Pre-fix tag: pre-fix-home-promos-vs-banners
