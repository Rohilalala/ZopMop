# Overnight fix run summary — 2026-05-07

Anchor tag (local): `pre-fix-run-2026-05-07` at `af6fd22`.

Items landed: **14 / 16** (Items 9 + parts of 6/16 deferred to NEEDS_REVIEW.md).

## Commits added (pre-fix-run-2026-05-07..HEAD)

```
c9751b6 fix(crm): audit-on-read for single-record GET handlers (audit NEW-A1-002 partial)
99e36bb fix(refunds): WARN log on invalid status during CAS (audit NEW-B3-001)
3396427 fix(security): SSRF denylist for webhook dispatcher (audit NEW-A2-001)
e002c20 chore(docker): expand .dockerignore (audit NEW-E3-002)
4321693 ci: add npm audit + govulncheck steps (audit NEW-A4-001)
2de2638 ci: add -race flag, CRM job, bump Go to 1.26 (audit NEW-E3-003/004, E3-1)
3630b03 fix(cron): wire Stop hooks for leave + roomies workers (audit NEW-B1-001)
9b0c597 fix(webhooks): pre-acquire semaphore before spawn (audit NEW-B1-002)
0960b92 fix(crm-growth): capture stack on cron panic for observability (audit NEW-B2-001)
3b3635b fix(notification): redact FCM payload from logs (audit NEW-F1-001/F1-D3)
fe4acc7 feat(deploy): retention-worker CronJob manifest (audit F2D-2)
42a95fc fix(security): gate pprof blank import behind build tag (audit E3D-2/NEW-F3-002)
98e9a09 fix(notification): serialize tests to close fixture race (audit NEW-B1-007)
9c4a632 fix(server): add fiber.Recover() middleware to both apps (audit B2-01)
```

## Landed

- [✓] Item 1: `fiber.Recover()` middleware on cmd/api + cmd/crm-api.
- [✓] Item 2: notification test-fixture race serialised. `go test -race -short` now passes the package (verified).
- [✓] Item 3: pprof blank import moved to `cmd/api/pprof_dev.go` behind `//go:build pprof`.
- [✓] Item 4: `App/househelp-api/deploy/retention-cronjob.yaml` + README. Schedule `0 3 * * *`, Forbid concurrency.
- [✓] Item 5: `internal/notification/service.go:558` — Interface("data", data) replaced with shape-only fields.
- [✓] Item 6 (partial): growth cron panic captures stack now; re-panic deferred (would unwind serial supervisor — see NEEDS_REVIEW.md).
- [✓] Item 7: webhook dispatcher acquires semaphore BEFORE goroutine spawn.
- [✓] Item 8: leave + roomies cron rewritten as `*Worker` with Start/Stop, wired into cmd/api shutdown.
- [✓] Item 10: CI gets `-race` flag, CRM job (typecheck + build), Go bumped 1.22 → 1.26.
- [✓] Item 11: CI npm audit (RN + CRM, continue-on-error).
- [✓] Item 12: CI govulncheck step (continue-on-error).
- [✓] Item 13: `.dockerignore` extended (bin/, loadtest/, sim, report/, *.test, .audit/, deploy/).
- [✓] Item 14: webhook dispatcher SSRF denylist (`internal/webhooks/ssrf.go`) + caller gate in `deliver`.
- [✓] Item 15: refund `lockForApproval` WARN log on unrecognised post-CAS status.
- [✓] Item 16 (partial): audit-on-read added to `crm/users.Get` + `crm/workers.Get`. List/jobs/notes intentionally NOT audited (volume).

## Skipped — see NEEDS_REVIEW.md

- [ ] Item 9: paise TODO comment cleanup. JSON tags still legacy; removing TODOs without renaming or filing tracking issue destroys context.
- [ ] Item 6 partial: growth cron re-panic. Supervisor is serial Tick loop; re-panic blocks Wait() in Stop(). Stack-trace observability fix landed instead.
- [ ] Item 16 partial: orders + refunds GET audit-on-read deferred — those handlers don't expose the same `h.audit` helper signature, mechanical pattern would diverge.

## Test status

- `go build ./...` — pass
- `go vet ./...` — pass
- `go test ./... -short -race` — pass (15 packages with tests, all OK; 56 untested — pre-existing gap, see audit C4-T1)

## Rollback

```
git reset --hard pre-fix-run-2026-05-07     # full revert
git revert <sha>                            # selective per-commit revert
```

Anchor tag is local-only (not pushed). If you push the tag for shared-repo rollback, do it manually:
```
git push origin pre-fix-run-2026-05-07
```

## Diff size

```
$ git diff pre-fix-run-2026-05-07..HEAD --stat | tail -1
```
14 commits, ~370 LOC across ~15 files. Largest single change is Item 8 (Worker pattern: 132 LOC across leave/cron.go + roomies/cron.go + cmd/api/main.go shutdown).

## Notes for review

- Item 1 (Recover) and Item 2 (-race) together unblock the CI gate the audit recommended turning on. After this run lands, `go test -race` is meaningful again.
- Item 4 (CronJob) is paper only — verify against the actual K8s cluster (or whichever scheduler you're using) before applying.
- Item 14 (SSRF) intentionally does NOT defend against DNS rebinding. The follow-up is a network-policy at the cluster level; comment in ssrf.go calls this out.
- Item 16 was the riskiest item per the instruction. Stuck to two safest endpoints; orders/refunds GETs deferred.
