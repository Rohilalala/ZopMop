# Independent Review — Catalog Pre-Merge Sweep

**Reviewer role:** fresh, skeptical verifier (did not write the report).
**Date:** 2026-06-07 (Asia/Kolkata)
**Branch under review:** `feature/appearance-and-location-toast`
**Scope:** verify `.audit/2026-06-07-catalog-premerge-sweep/REPORT.md` against the
code, re-check the highest-stakes claims, catch material omissions.

---

## 0. Blocking precondition — THE REPORT DOES NOT EXIST

`.audit/2026-06-07-catalog-premerge-sweep/REPORT.md` **is not present.** The
directory exists but is empty:

```
$ ls -la .audit/2026-06-07-catalog-premerge-sweep/
total 0
drwxr-xr-x  2 ...  .
drwxr-xr-x  6 ...  ..
```

No `REPORT.md` exists anywhere in the repo (the only `REPORT*.md` is
`/Users/adityarohilla/Documents/ZopMop/report/report.md`, which is unrelated —
different path, not a catalog sweep). The sibling `.audit/2026-06-07-service-catalog/`
contains only a `.DS_Store`.

**Consequence:** there is no report to verify for accuracy or completeness. The
labels the task references — **BLOCKER / SHOULD-FIX list, the merge-decision
list, and findings "B-A / B-B / B-C"** — exist only in the (missing) report.
A repo-wide grep for `B-A` / `B-B` / `B-C` returns **zero matches** in any `.md`,
`.go`, or `.sql` file. I therefore cannot confirm or refute the report's
characterization of B-A/B-B/B-C; those IDs have no source artifact to anchor to.

So that the parent agent still gets a usable merge signal, the rest of this
review is an **independent first-principles sweep** of the same high-stakes
areas, citing file:line directly.

**Verdict on the stated task (verify the report):** *Cannot complete — the
report is absent.* **Verdict on the underlying merge question:** *DO NOT MERGE
as-is* — there is at least one true BLOCKER (duplicate migration 109 prevents
the new migrations from applying at all) and one true high-severity data issue
(four active, bookable services priced at the ₹1 placeholder, with the server
treating that ₹1 as the authoritative price). Details below.

---

## A. Independent re-check of the highest-stakes claims

### A1. Placeholder ₹1 booking guard — IS THERE REALLY NO PRICE FLOOR? → CONFIRMED: no floor anywhere

- `migrations/112_reconcile_service_catalog_17.up.sql:38-51` inserts **4 new,
  `is_active=true` services** with `base_price_cents = 100` (= ₹1), `mrp_cents = 100`:
  Packing (id …019), Unpacking (…020), Fan Cleaning (…021), and
  Pre and Post Party Clean (…022). The migration header (lines 14-15, 39-41)
  itself labels these "PLACEHOLDER price … DO NOT treat as real pricing."
- These rows are active, so they appear in the customer catalog
  (`internal/services/repository.go:23-33`, `List` filters `is_active = true`).
- **Server is authoritative on price and re-derives from the same ₹1 base:**
  - Cart add path: `internal/cart/service.go:45` calls
    `repo.GetServicePrice(...)` and **ignores the client-supplied price** — the
    RN `priceFor()` value is display-only.
  - `internal/cart/repository.go:169-190` `GetServicePrice` =
    `base_price_cents * durationMinutes / minDuration`. For a ₹1 base this is
    ₹1 at 30 min, ₹3 at 90 min. There is **no `MAX`, no floor, no minimum-order
    clamp.**
  - Booking-from-cart sums `ci.price_cents` (`internal/booking/service.go:764,
    1075-1084, 1216-1225`) and only adds `BaseFeeCents`. So the ₹1 line item
    flows straight into a real, payable booking total.
  - The single-service booking path (`internal/booking/service.go:403-426`)
    reads `base_price_cents` directly and does `basePriceCents + BaseFeeCents` —
    again ₹1 + base fee, no floor.
- **There is no price-floor guard in the RN client either.**
  `ServiceAboutScreen.tsx:88-93` `priceFor()` returns
  `Math.round(base*dur/min)` with no `Math.max`.

**Net:** the "placeholder ₹1 / no price floor" concern is REAL and
**high-severity / merge-blocking**: a customer can book Packing, Unpacking,
Fan Cleaning, or Pre+Post Party Clean for ₹1–₹3 (+ platform base fee), and the
server will honor that as the true charge. This is the kind of finding the top
of any "BLOCKER" list should carry.

### A2. Fixed-90 / `duration_step_minutes = 0` handling — any divide/loop by step? → CONFIRMED SAFE

- Pre+Post Party is seeded `min=90, max=90, step=0`
  (`migrations/112_…up.sql:50`; reconcile comment lines 6-7).
- RN `buildDurations()` (`ServiceAboutScreen.tsx:76-86`) guards first:
  `if (step <= 0 || max <= min) return [min];` — for `90/90/0` this returns
  `[90]`, a single fixed block; the `for (... d += step)` loop is only reached
  when `step > 0`, so **no infinite loop, no `d += 0`.**
- Price never divides by step: `priceFor` divides by `min_duration_minutes`
  (`ServiceAboutScreen.tsx:92`), and server `GetServicePrice` divides by
  `minDuration` with its own `if (minDuration <= 0) minDuration = 30` guard
  (`cart/repository.go:186-189`). **No divide-by-`duration_step_minutes`
  anywhere.**
- UI renders the fixed chip, not a toggle, when `durations.length === 1`
  (`ServiceAboutScreen.tsx:123, 264-268`).

**Net:** the step=0 path is handled correctly. No divide/loop-by-zero risk.

### A3. Go ↔ RN `faqs` shape match → CONFIRMED MATCH (end to end)

- DB: `service_faqs(question, answer, display_order)`
  (`migrations/113_create_service_faqs.up.sql:13-20`) and
  `faq_items(question, answer, display_order, is_active)`
  (`migrations/006_create_banners.up.sql:35-41`).
- Go query reads exactly those columns
  (`internal/services/repository.go:234, 259`) into
  `ServiceFaq{Question, Answer, DisplayOrder}` (`model.go:53-57`), serialized as
  `{question, answer, display_order}`.
- RN interface matches field-for-field: `ServiceFaq { question; answer;
  display_order }` and `ServiceDetails.faqs: ServiceFaq[]`
  (`api/services.ts:52-64`); rendered in `ServiceAboutScreen.tsx:370-384`.

**Net:** shape match is correct. The server-side FAQ union + per-question
override (globals first, per-service appended, global suppressed when a
per-service FAQ shares the same `question`) is implemented in
`repository.go:228-288` and exercised by the Pre+Post Party price override row
(`migrations/114_…up.sql:387-388`, display_order 2, question
"How is the price worked out?"). Logic is internally consistent. One cosmetic
nit: the doc comment at `repository.go:282` says "Non-overridden globals … first,
then per-service," which matches the code (`append(globals, perService...)`,
line 283) — no bug, just worth noting the narration in lines 232 and 282 reads
slightly contradictorily.

### A4. "B-A / B-B / B-C status" → CANNOT VERIFY (no source artifact)

These identifiers appear nowhere in the codebase. The booking golden tests use a
**different** scheme — `B-1` and `audit C-8 / B5-D7`:
- `internal/booking/cart_pricing_golden_test.go:15, 60-67` locks the integer-
  truncation "bug B-1" (e.g. `2500*37/30 = 3083`, truncated).
- `cmd/migrate/main.go:17` references "Audit C-8 / B5-D7."

Whatever B-A/B-B/B-C were meant to track, there is no in-repo evidence of their
status, and the report that defines them is missing. **Unverifiable.**

---

## B. Citations-checked table

Because the report is absent, this table records the **claims the report should
have made** (per the task brief) re-checked against source, with my independent
finding.

| # | Claim re-checked | File:line | Accurate? | Correction / note |
|---|---|---|---|---|
| 1 | 4 new services seeded at ₹1 placeholder | `migrations/112_…up.sql:42-51` | YES | base_price_cents=100, mrp_cents=100, is_active=true |
| 2 | Placeholder services are active → in catalog | `internal/services/repository.go:23-33` | YES | `List` filters is_active=true |
| 3 | No client price floor | `ServiceAboutScreen.tsx:88-93` | YES | plain Math.round, no Math.max |
| 4 | Server re-derives price, ignores client value | `internal/cart/service.go:45-55` | YES | uses GetServicePrice, client price unused |
| 5 | Server price = base*dur/min, no floor | `internal/cart/repository.go:169-190` | YES | only guard is min<=0→30 |
| 6 | Single-service booking = base+fee, no floor | `internal/booking/service.go:403-426` | YES | basePriceCents + BaseFeeCents |
| 7 | Cart booking sums ci.price_cents | `internal/booking/service.go:764, 1075-1084` | YES | ₹1 propagates to total |
| 8 | step=0 returns single duration | `ServiceAboutScreen.tsx:76-86` | YES | `if (step<=0 || max<=min) return [min]` |
| 9 | Pre+Post Party seeded 90/90/0 | `migrations/112_…up.sql:50` | YES | FIXED 90 |
| 10 | No divide-by-step in price | `ServiceAboutScreen.tsx:92` / `cart/repository.go:186-189` | YES | divides by min_duration only |
| 11 | service_faqs columns | `migrations/113_…up.sql:13-20` | YES | question/answer/display_order |
| 12 | faq_items has is_active | `migrations/006_create_banners.up.sql:35-41` | YES | matches Go query |
| 13 | Go ServiceFaq struct | `internal/services/model.go:53-57` | YES | 3 fields |
| 14 | Go faqs query columns | `internal/services/repository.go:234, 259` | YES | matches both tables |
| 15 | RN ServiceFaq / ServiceDetails.faqs | `api/services.ts:52-64` | YES | field-for-field match |
| 16 | FAQ union + per-question override | `internal/services/repository.go:228-288` | YES | globals + per-service, suppress on same question |
| 17 | Pre+Post Party price-FAQ override row | `migrations/114_…up.sql:387-388` | YES | display_order 2, overrides global price FAQ |
| 18 | Global FAQs seeded once | `migrations/114_…up.sql:363-366` | YES | 2 rows in faq_items |
| 19 | Step icons set to step-1..step-4 | `migrations/115_…up.sql:11` | YES | `'step-' || step_number` |
| 20 | RN numeral map keys step-1..step-4 | `ServiceAboutScreen.tsx:47-52` | YES | maps to 1.png..4.png |
| 21 | Numeral assets present | `assets/icons/1.png`–`4.png` | YES | all 4 added in branch diff |
| 22 | 17 active / 5 deactivated | `migrations/112_…up.sql:54-63` | YES | 5 deactivated ids (…011,013,015,016,017) |
| 23 | Deactivations preserve ids/FKs | `migrations/112_…up.sql:53-63` | YES | is_active=false only, no delete |
| 24 | Duplicate migration 109 | `migrations/109_cap_promo_discount_value.up.sql` + `109_payroll_admin_audit.up.sql` | YES | both present on branch |
| 25 | Migration 111 gap (110→112) | `migrations/` listing | YES | no 111 file exists |
| 26 | down.sql added for 112-115 | branch diff | YES | 4 .down.sql files (policy is forward-only) |
| 27 | Forward-only policy | `cmd/migrate/main.go:8` | YES | "there are no .down.sql files" |
| 28 | Cart pricing golden test = base*dur/min, no surge | `internal/booking/cart_pricing_golden_test.go:16-145` | YES | locks B-1 truncation, no-surge guard |
| 29 | Detail endpoint now returns faqs[] | `internal/services/repository.go:209-220` (GetDetails) | YES | faqs wired into ServiceDetails |
| 30 | audit_diff.md referenced by golden tests | `cart_pricing_golden_test.go:10` | BROKEN REF | `audit_diff.md` does not exist in repo |

---

## C. Material gaps (things any adequate report MUST have flagged)

1. **BLOCKER — duplicate migration version 109 makes the catalog migrations
   un-appliable.** `migrations/109_cap_promo_discount_value.up.sql` and
   `migrations/109_payroll_admin_audit.up.sql` both exist on the branch. The
   runner is `golang-migrate/migrate/v4` with the `source/file` driver
   (`cmd/migrate/main.go:27-29`), which **rejects two files sharing the same
   version number** — `migrate.New()` / `m.Up()` will fail before 112-115 ever
   run. The branch's own Step-4 doc (`docs/service-catalog-step4-bottom-sheet.md:61`)
   acknowledges this as a "pre-merge rebase item," but it is a hard blocker, not
   a footnote: **none of the new catalog content reaches any DB until 109 is
   de-duplicated.** (Pre-existing from merged PRs, not introduced by the catalog
   steps — but it blocks this merge regardless.)

2. **HIGH — four active services priced at the ₹1 placeholder are fully
   bookable at ₹1.** (See A1.) The migration comment says real pricing is "a
   separate decision," but nothing prevents these from shipping live. Either set
   real prices in this branch, or set `is_active=false` until priced, or add a
   minimum-order/price-floor guard. Shipping as-is is a revenue/abuse hole.

3. **MEDIUM — orphaned `audit_diff.md` reference.** Both golden test files
   (`cart_pricing_golden_test.go:10`, `service_pricing_golden_test.go:7`)
   instruct "update audit_diff.md before merging," but no `audit_diff.md` exists
   anywhere in the repo. Dead instruction / missing artifact.

4. **MEDIUM — migration 115 is unscoped.** `UPDATE service_steps SET icon =
   'step-' || step_number` (`migrations/115_…up.sql:11`) rewrites **every**
   `service_steps` row, not just the 17 reconciled services. Harmless given the
   current data (steps are 1-4), but it silently mutates rows for the 5
   deactivated services too. Worth a `WHERE service_id IN (…)` for surgical
   intent, or at least a noted decision.

5. **LOW — migration numbering gap (110 → 112, no 111).** Not fatal for
   golang-migrate (it tolerates gaps), but combined with the dup-109 it signals
   the migration sequence on this branch was not rebased clean. Flag for the
   rebase that fixes 109.

6. **LOW / nice-to-have — no golden test covers the ₹1 placeholder services.**
   The pricing golden tests (cart + service) lock the 30/60/90 math for priced
   services but never assert anything about the placeholder rows, so the ₹1
   exposure is invisible to CI. A regression test asserting the 4 placeholder
   services are either inactive or above a floor would close the loop.

7. **PROCESS gap — verification is self-admittedly incomplete.**
   `docs/service-catalog-step4-bottom-sheet.md:57-58` states the dev DB is still
   at migration 111, so the seeded content "won't appear until 112-115 are
   applied," and runtime visuals / gestures / both-theme rendering were **not**
   exercised. No sim/device pass has been done. A merge decision that relies on
   "✅ (dev-DB clone)" rows should treat those as unverified-in-CI.

---

## D. Severity I would assign / re-rank

Since there is no report to re-rank against, here is my independent ranking:

| Severity | Item | Why |
|---|---|---|
| **BLOCKER** | Duplicate migration 109 | Catalog migrations 112-115 cannot apply; deploy fails at migrate step |
| **BLOCKER / HIGH** | ₹1 placeholder on 4 active, bookable services | Real revenue/abuse hole; server treats ₹1 as authoritative price |
| MEDIUM | Orphaned `audit_diff.md` ref in golden tests | Dead merge instruction; missing artifact |
| MEDIUM | Migration 115 unscoped UPDATE | Mutates deactivated-service step rows too |
| LOW | 111 gap / unrebased sequence | Cosmetic but corroborates 109 problem |
| LOW | No test covering placeholder pricing | CI blind spot |
| INFO | down.sql vs forward-only policy | Files self-document as tooling-only (`112…down.sql:1-2`); contained, not a runner break — do NOT over-rank this as a blocker |

I would explicitly **down-rank** the `.down.sql` policy deviation: although the
project CLAUDE.md and `cmd/migrate/main.go:8` say "there are no .down.sql files,"
the four added down files carry headers stating they exist "for tooling
completeness only; do not run as part of normal rollback"
(`112_…down.sql:1-2`), and the runner only invokes `m.Up()`. It is a
consistency nit, not a merge blocker.

---

## E. Recommended corrections (NOT applied — REPORT.md was not edited)

1. **Re-run / actually produce the sweep.** The named deliverable
   `.audit/2026-06-07-catalog-premerge-sweep/REPORT.md` was never written. Any
   downstream merge gate citing it is gated on a nonexistent file. Generate the
   report (or correct the path the orchestrator expects).

2. **Before merge, rebase to de-duplicate migration 109** (e.g. renumber
   `109_payroll_admin_audit` → `111_payroll_admin_audit`, filling the 111 gap),
   then re-run `make preflight` so the migrate step actually executes 112-115.

3. **Resolve the ₹1 placeholder** for Packing / Unpacking / Fan Cleaning /
   Pre+Post Party before shipping: set real `base_price_cents`, OR set
   `is_active=false` until priced, OR add a minimum-price floor in
   `GetServicePrice` / booking creation.

4. **Either create `audit_diff.md` or drop the stale references** in the two
   golden test headers.

5. **Scope migration 115's UPDATE** to the 17 reconciled service ids (or
   document that the global rewrite is intentional).

6. **Do a sim/device pass** after migrations apply (Pre+Post Party fixed-90 +
   price override, duration toggles, expand, dark/light) — currently unverified.

---

## Bottom line

The report I was asked to verify **does not exist**, so it cannot be judged
accurate or complete; on that axis the deliverable has failed. My independent
sweep confirms the two highest-stakes concerns are REAL — duplicate migration
109 (blocks the migrations entirely) and the ₹1 placeholder on four active,
bookable services with no price floor on either client or server. The fixed-90
step=0 path and the Go↔RN `faqs` shape are both correct and safe. **Do not merge
until 109 is de-duplicated and the ₹1 placeholder is resolved.**
