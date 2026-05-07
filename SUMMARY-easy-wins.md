# Easy-win chunk summary — 2026-05-07

3 commits landed on `feature/sdui`. Pushed to origin.

## Commits

```
255d458 docs: extract paise rename TODOs to tracking doc (audit NEW-C2-001)
0742809 fix(matching): log errors from best-effort cleanup Execs (audit NEW-B1-003)
b483337 docs: document compliance & retention in README (audit NEW-C5-001)
```

## Items

- [✓] **Item 1** (NEW-C5-001) — README "Compliance & retention" section added between Migrations and Tech Debt. Documents retention worker, anonymization hooks, /me/export, scheduling pointer.
- [✓] **Item 2** (NEW-B1-003) — `internal/matching/stealth_dispatch.go:99` and `rebook_scanner.go:81,96` — three `_, _ = db.Exec(...)` sites converted to logged WARN on error. SQL unchanged.
- [✓] **Item 3** (NEW-C2-001) — 14 inline paise-rename TODOs across 8 files removed; `App/househelp-api/docs/jsontag-rename-tracking.md` created with migration plan; README Tech Debt entry points to it. JSON tags themselves unchanged.
- [✓] **Item 4** (NEW-D1-003) — verified `idx_bookings_helper_id`, `idx_user_addresses_user_id`, `idx_cart_user_id`, `idx_booking_services_booking_id` all present in migrations 004, 009, 012, 014. Audit's claim correct. **No commit needed.**

## Test status

- `go build ./...` — clean
- `go vet ./...` — clean
- `go test ./... -short -race` — all 15 packages OK, no DATA RACE

## Push

Pushed `feature/sdui`: `c9751b6..255d458`.

## Rollback

```
git reset --hard c9751b6
git push --force-with-lease origin feature/sdui
```

Or selective:

```
git revert <sha>
```
