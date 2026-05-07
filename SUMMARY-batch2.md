# Overnight batch 2 summary — 2026-05-07

Anchor tag (local + pushed): `pre-fix-run-2` at `255d458`.

Items landed: **8 commits across 6 of 8 items** (Items 7a / 8 deferred).

## Commits (pre-fix-run-2..HEAD)

```
348cb2b perf(insights): pipeline NearbyStats EXISTS calls (audit D3-F2)
5d295ae perf(matching): reduce inviteSinglePro poll frequency 2s -> 5s (audit D3-F5)
8669d6c fix(webhooks): jittered retry/backoff on dispatch failures (audit D4-N2)
5db8199 fix(ratelimit): bound sweep work to cap mutex hold time (audit D2-5)
e55e0b0 fix(api): redact err.Error() from response bodies (audit B2-05)
d229e33 fix(crm): gate /admin/_stub/:module enumerator behind env (audit E2-4)
91ddc80 test(booking): assert helper_id integrity invariant (audit B5-D5)
4c6d070 fix(bff): correct column name in user.first_name source (audit D1-1)
```

## Landed

- [✓] **Item 1** (D1-1) — `internal/bff/sources.go:145` `SELECT first_name` → `SELECT split_part(coalesce(name, ''), ' ', 1)`. Closes the runtime 500 hidden in BFF.
- [✓] **Item 2** (B5-D5) — Schema-invariant test in `internal/booking/schema_invariants_test.go`. Skips when `TEST_DATABASE_URL` unset; CI integration job will exercise it.
- [✓] **Item 3** (E2-4) — `/admin/_stub/:module` route now gated behind `ENABLE_STUB_ENUMERATOR=1`. Default off in prod.
- [✓] **Item 4** (B2-05) — Three err.Error() leaks closed: tracking_ws WebSocket, helper UpdateLocality, auth verifyOTP default branch. Each gets log.Warn/Error + structured response with discriminator code. zop tool-executor sites left unchanged (LLM-internal, not user-facing).
- [✓] **Item 5** (D2-5) — Ratelimit map sweeps bounded to 2000 entries per insert. Caps mutex hold time under sustained botnet traffic. Both maps (localBuckets + localLimiterBuckets) covered.
- [✓] **Item 6** (D4-N2) — `deliverWithRetry` wrapper: 3 attempts, jittered exp backoff (500ms/1s/2s + 0–50% jitter). 4xx not retried. Each attempt persists its own delivery row.
- [✓] **Item 7c** (D3-F5) — `pollInterval` 2s → 5s in matching dispatch. RTTs drop from ~390 to ~150 per 30-pro chain.
- [✓] **Item 7b** (D3-F2) — NearbyStats EXISTS calls pipelined. 50 round-trips → 1 per LivePill poll. Pipeline error falls back to GEOSEARCH-only filter.

## Skipped — see NEEDS_REVIEW-batch2.md

- [ ] **Item 7a** (D3-F1) — `validateInviteIDs` function does not exist in current code; only the audit doc references it. Either renamed since the audit or never landed. Investigate when awake.
- [ ] **Item 8** (NEW-A5-001) — RequirePermission on CRM GET routes. Mechanical addition (~32 LOC), but choosing the role floor for read perms (RoleViewer vs RoleSupport) is a design call about which CRM tier sees PII drawers. Needs Aditya's call.

## Test status

- `go build ./...` — clean
- `go vet ./...` — clean
- `go test ./... -short -race` — all 15 packages pass; no DATA RACE

## Diff size

176 insertions, 26 deletions across 10 files. 8 commits.

## Push

`pre-fix-run-2..HEAD` pushed to `origin/feature/sdui`. Commit range
`255d458..348cb2b`.

## Rollback

```
git reset --hard pre-fix-run-2
git push --force-with-lease origin feature/sdui
```

Or selective:

```
git revert <sha>
```

## Notes for review

- Item 4 (B2-05): zop/service.go has 17+ `errorJSON(err.Error())` sites. Skipped because errorJSON is the tool-executor return path (LLM consumes the messages, not the user); replacing with bland strings would degrade LLM behaviour. If you want them sanitised, that's a separate design pass on the LLM tool error contract.
- Item 5 (D2-5): The original audit framed the maps as "unbounded" — they already had hard caps. The actual issue was the unbounded sweep work under the mutex; that's now bounded.
- Item 6 (D4-N2): 4xx classification uses `dlv.ResponseStatus >= 400 && < 500`. Network errors / timeouts are persisted as `ResponseStatus = 0` so they DO retry (intentional).
- Item 7c (D3-F5): `pollInterval` lives in `internal/matching/dispatch.go:42`. Real fix is event-driven; this is the cheap mechanical win.
- Item 7b (D3-F2): NearbyStats pipeline rewrite includes a fallback path when pipe.Exec errors (graceful degradation rather than fail-closed to "0 pros").
