# DevOps & Operational Readiness — Subagent 11

Scope: infra, CI/CD, env hygiene, monitoring, runtime ops for the ZopMop
backend (`App/househelp-api`), mobile app (`App/zopmop-app`), and CRM
(`App/zopmop-crm`).

Counts:
- Critical: 2
- High: 6
- Medium: 9
- Low: 4
- Nit: 3

Cross-refs: `AUDIT_2025_2026-05-03.md`, `security_audit_report.md`,
`.audit/FINAL_REPORT.md`, prior memory entry
`project_prod_migration_incident_2026_05_14`.

---

## 1. ENV HYGIENE — `.env.example` completeness

[SEVERITY: High]
[FILE: App/househelp-api/.env.example:1-76]
[CATEGORY: DevOps / env-hygiene]
Finding:
`.env.example` is missing 13 env vars that the Go code reads at runtime.
The repo CLAUDE.md explicitly mandates: "New `os.Getenv("FOO")` call? Add
`FOO=` to BOTH `.env.example` (real defaults) AND `.env.local.example`."
Diff (read by code, absent from `.env.example`):

- `APP_ENV` (`pkg/config/config.go:81`) — primary env switch, falls back to `ENV`.
- `ALLOWED_WEBHOOK_DOMAINS` (`pkg/config/config.go:132`) — domain allowlist
  for outbound webhook dispatcher; empty = "any non-private". Operationally
  load-bearing for SSRF posture.
- `ENABLE_PPROF` (`cmd/api/main.go:127`) — opens a pprof port if `=1`.
- `ENABLE_STUB_ENUMERATOR` (`cmd/crm-api/main.go:392`) — exposes a stub-route
  enumerator in the CRM API.
- `ALLOW_PROD_SIM` (`cmd/sim/main.go:106`) — disables sim's prod-URL guard.
- `LOADTEST_JWT_HOURS` (`cmd/loadseed/main.go:52`) — JWT TTL for load-test
  fixtures.
- `TEST_DATABASE_URL` — referenced in `.env.local.example:14` but never
  surfaced for non-Docker users.
- `CRM_JWT_SECRET`, `CRM_JWT_PREVIOUS_SECRETS`, `CRM_REFRESH_COOKIE_DOMAIN`,
  `CRM_ALLOWED_ORIGINS`, `CRM_DATABASE_READ_URL` (all in
  `pkg/crmconfig/config.go:69-96`) — the `cmd/crm-api` binary cannot start
  without `CRM_JWT_SECRET`. The crm-api binary is built into the same image
  by `RUN go build ./...` cf. `Dockerfile:7-9` (binary at line 9 only builds
  api+migrate; crm-api requires a separate image — see Finding 6).
- `APP_API_URL` (`pkg/crmconfig/config.go:87`) — CRM health-metrics back-call.

Impact: a fresh clone following `cp .env.example .env` will boot `cmd/api`
fine but cannot exercise CRM (`cmd/crm-api` panics on missing
`CRM_JWT_SECRET`), and operators are given no hint that `ALLOWED_WEBHOOK_DOMAINS`
or `ENABLE_PPROF` exist. Misconfiguration risk: webhooks fan out to private
networks (no allowlist), pprof port left open silently.
Fix:
1. Append the 13 vars above to `App/househelp-api/.env.example` with safe
   defaults (empty / `0` / sandbox values) and inline comments mirroring
   `.env.local.example`.
2. Add a CI step that diffs `grep -rn 'os.Getenv' --include="*.go" |
   awk -F'"' '{print $2}' | sort -u` against the keys present in
   `.env.example` and fails if any code-referenced key is missing (treat
   `db-url` flag-default and ad-hoc cmd binaries as exceptions).
Evidence:
- Code-read vars: `cmd/api/main.go:127,318,489`,
  `pkg/config/config.go:82-132`, `pkg/crmconfig/config.go:69-96`,
  `cmd/sim/main.go:106`, `cmd/loadseed/main.go:52`,
  `cmd/crm-api/main.go:392`.
- `.env.example` does not contain any of these strings.

---

[SEVERITY: Medium]
[FILE: App/zopmop-app/.env.example:1-25]
[CATEGORY: DevOps / env-hygiene]
Finding:
The mobile `.env.example` is missing two vars that `app.config.js` reads
at build time: `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. The active
`.env` (`App/zopmop-app/.env:4-5`) contains them, which means the only
way a new dev learns these exist is by reading `app.config.js:47-48` or
`src/config/posthog.ts:6-7`. `GOOGLE_MAPS_API_KEY` is documented (line 9)
but the file does not warn that `app.config.js` injects it for the
*native* build only — a fresh dev who omits it will silently get
non-functional maps in EAS production builds.
Impact: PostHog analytics ship as "NOT SET" in any build the dev
forgot to copy real values for; if a release build is produced without
the env vars, telemetry is permanently disabled for that binary (no
runtime way to enable later because they are baked at build time).
Fix:
- Add `POSTHOG_PROJECT_TOKEN=` and `POSTHOG_HOST=https://us.i.posthog.com`
  to `.env.example` with a comment that EAS Production builds must
  receive these via EAS secrets (env injection in `eas.json` is empty
  for the production profile).
- Document the GOOGLE_MAPS native-only injection path explicitly.
Evidence:
- `App/zopmop-app/app.config.js:47-48` — reads both PostHog vars.
- `App/zopmop-app/src/config/posthog.ts:6-7,21-23` — emits a warning at
  runtime when token is not set.
- `App/zopmop-app/.env.example` does not mention POSTHOG_* at all.

---

## 2. DOCKER

[SEVERITY: Low]
[FILE: App/househelp-api/Dockerfile:11-20]
[CATEGORY: DevOps / docker]
Finding:
Multi-stage Dockerfile is otherwise solid (build → `alpine:3.19`, non-root
`app` UID 10001, trimpath + stripped binaries) but ships a complete
`migrations/` directory (`Dockerfile:17`) including the on-disk `.down.sql`
files that repo policy says must never be executed (cmd/migrate enforces
forward-only). The runtime image therefore contains attack-relevant SQL
that a compromised `app` user could pipe back through `migrate force` /
external psql; small, but unnecessary.
Impact: minor — `migrate` binary has its own forward-only enforcement,
but the down files are present in the prod container filesystem.
Fix: in the build stage, exclude `*.down.sql` when copying:
`COPY --from=build /src/migrations /app/migrations` after a build-stage
prune (`RUN rm -f /src/migrations/*.down.sql`). Alternatively, accept
the cost and document the rationale in `Dockerfile`.
Evidence:
- `App/househelp-api/Dockerfile:17` — copies migrations whole.
- `App/househelp-api/migrations/` contains `*.down.sql` files for
  080-095 per REPO_MAP §"No `.down.sql` migrations".

---

[SEVERITY: Medium]
[FILE: App/househelp-api/Dockerfile:1-20]
[CATEGORY: DevOps / docker]
Finding:
Dockerfile does not pin the `golang:1.26-alpine` and `alpine:3.19` images
by digest. The image tag floats: `alpine:3.19` will resolve to whatever
`3.19.x` Alpine has pushed most recently, and `golang:1.26-alpine`
resolves to the most recent `1.26-alpine` patch. This breaks
build-reproducibility and means a CVE published in Alpine's musl could
land in a Railway redeploy without any change in our SHA.
Impact: a force-redeploy in 6 months may produce a substantially
different binary; supply-chain attack window is open.
Fix: pin by sha256 digest (`FROM golang:1.26-alpine@sha256:…`) and
update via dependabot or a quarterly cron. The same applies to
`alpine:3.19` and the compose images
(`postgis/postgis:16-3.4-alpine`, `redis:7-alpine`).
Evidence: `App/househelp-api/Dockerfile:2,11`,
`App/househelp-api/docker-compose.yml:57,79`.

---

[SEVERITY: Low]
[FILE: App/househelp-api/Dockerfile:1-20]
[CATEGORY: DevOps / docker]
Finding:
No `HEALTHCHECK` directive in the Dockerfile. Compose handles it for dev
(`docker-compose.yml:48-54`) but Railway does not parse compose; Railway
relies on the configured "Healthcheck Path" in its dashboard or the
`startCommand` exit code. The repo's `railway.json` does not declare a
healthcheck either.
Impact: Railway can roll a broken image into production before any
endpoint check rejects it. Documented "Don't add HEALTHCHECK" rule in
`App/househelp-api/CLAUDE.md` is a deliberate choice but trades safety
for image purity; Railway can be configured via `railway.json` instead.
Fix: add a `healthcheckPath: "/health"` to `railway.json` under `deploy`
so a startup-failure causes the deployment to be rolled back. Validated
by curl in `scripts/preflight.sh:85-94` already.
Evidence:
- `App/househelp-api/railway.json:7-12` — no healthcheck declared.
- Compose has one: `docker-compose.yml:48-54`.

---

[SEVERITY: Medium]
[FILE: App/househelp-api/docker-compose.yml:42]
[CATEGORY: DevOps / docker]
Finding:
The `backend` service mounts `./secrets:/app/secrets:ro`, which is good,
but the host `secrets/` dir is gitignored (`/.gitignore:2`) and there is
no provisioning script or check during `make up` to ensure
`secrets/firebase-adminsdk.json` actually exists. A new dev running
`make up` will get a container that boots but `internal/auth/firebase.go`
silently degrades because `FIREBASE_CREDENTIALS_JSON` may resolve to a
non-existent path.
Impact: phone-auth fails with a runtime error long after compose reports
"healthy"; new-dev friction.
Fix: have `make check-env` (or a new `make check-secrets`) error out if
`secrets/firebase-adminsdk.json` is missing, with a link to the Firebase
download instructions. Add the check as a preflight gate.
Evidence:
- `App/househelp-api/docker-compose.yml:40-42`
- `App/househelp-api/Makefile:26-32` — only `.env.local` is enforced.

---

## 3. CI/CD

[SEVERITY: High]
[FILE: .github/workflows/ci.yml:3-4]
[CATEGORY: DevOps / ci]
Finding:
The `push` trigger of `ci.yml` lists `main, wip-stash-restore,
audit-fixes`. The Railway production deploy branch is `main`
(`App/househelp-api/CLAUDE.md`, REPO_MAP §"Backend deploy"). CI runs on
push to `main` but does not gate Railway's deploy — Railway auto-deploys
the moment a push to `main` lands, *concurrently* with the CI job. If
CI later fails (vet / test / govulncheck), production is already
serving the bad commit.
Impact: a broken commit pushed to `main` ships to prod regardless of
CI. The `.githooks/pre-push` blocks direct pushes to main, but a merged
PR bypasses it. There is no required-status-check enforcement
(unverifiable from repo files alone, but no `branch_protection.yml` or
ruleset is committed).
Fix:
- Configure GitHub branch protection on `main`: require the four
  `ci.yml` jobs to be green before merge, dismiss stale reviews, no
  bypass for admins on prod deploys.
- Alternatively, decouple deploy: tag a release (`v*.*.*`) and have
  Railway deploy from tags rather than `main` HEAD.
Evidence:
- `App/househelp-api/railway.json:6-12` — no env/branch filter.
- `App/househelp-api/.githooks/pre-push:5-22` — local-only guard,
  bypassable via PR-merge.

---

[SEVERITY: Medium]
[FILE: .github/workflows/ci.yml:25-28,40-44,75-79]
[CATEGORY: DevOps / ci]
Finding:
Three security checks are configured as `continue-on-error: true`:
backend `govulncheck`, CRM `npm audit`, and mobile `npm audit`. The
inline comments explicitly say "promote to failing once known issues
are addressed". This means the CI surface CURRENTLY tolerates known
CVEs — operators will only see them in the GH Actions UI, not as a
red merge gate. No tracking issue / dashboard is referenced for
follow-up.
Impact: known-vulnerable dependencies can sit in `main` indefinitely.
Fix: 
- Snapshot the current baseline of `npm audit` and `govulncheck`
  output, file as issue NEW-A4-001 in the issue tracker.
- Add an allowlist file (e.g. `.govulnignore`) and flip the
  `continue-on-error` to `false` once baseline is clean.
- Set up Dependabot (or Renovate) on both `package.json` files and
  on `go.mod` so backlog isn't created faster than it's drained.
Evidence:
- `.github/workflows/ci.yml:24-28` — govulncheck, non-blocking.
- `.github/workflows/ci.yml:42-44` — CRM npm audit, non-blocking.
- `.github/workflows/ci.yml:77-79` — RN npm audit, non-blocking.

---

[SEVERITY: High]
[FILE: .github/workflows/ci.yml:66-79]
[CATEGORY: DevOps / ci]
Finding:
The mobile job runs `tsc --noEmit` and `npm audit` only — no ESLint,
no unit tests, no Detox / Maestro / Jest, no `eas build --no-publish`
type-check on native config, no patch-package verification. The
backend job runs `-race -short` which skips the integration tests
(see CI inline note "audit NEW-E3-003"). Neither job runs
`scripts/preflight.sh` despite it being the documented PR-gate
(`Makefile:95-96`, `App/househelp-api/CLAUDE.md`).
Impact: a PR can land in `main` having only proven that the code
type-checks and builds. Real regressions land at runtime in Railway.
Fix:
- Add a CI job that runs `scripts/preflight.sh` (it already orchestrates
  postgres + redis via compose — GitHub runners support this with
  `docker compose`).
- Add `eslint App/zopmop-app/src` and `jest` (introduce a baseline
  test if none exists) to the mobile job.
- Add `npm test` to the CRM job if any tests exist.
Evidence:
- `.github/workflows/ci.yml:18-20` — `-short -race` skips
  testcontainers tests.
- `.github/workflows/ci.yml:66-79` — mobile job has no test / lint
  step.
- `App/househelp-api/scripts/preflight.sh:34` — runs `go test ./...`
  (no `-short`), and only the preflight catches DB / Redis init bugs.

---

## 4. DB BACKUP / RESTORE STRATEGY

[SEVERITY: Critical]
[FILE: <none>]
[CATEGORY: DevOps / backup-restore]
Finding:
No documented backup or restore plan exists for the production
PostGIS database. `App/househelp-api/docs/` contains
`migrations.md`, `logging.md`, `privacy-notes.md`, etc., but no
`RUNBOOK.md`, `DISASTER_RECOVERY.md`, or `BACKUP.md`. `docs/AUDIT.md`
top-level does not cover restore either. Railway provides
auto-backups for Postgres, but:

- Retention window, frequency, and PITR availability are not
  documented anywhere in-repo.
- No tested restore procedure (i.e. "spin up a fresh DB, restore
  yesterday's snapshot, point staging at it, run a smoke query")
  has ever been exercised — at least, no script or runbook exists.
- The 2026-05-14 hybrid-schema incident
  (`project_prod_migration_incident_2026_05_14` in memory) was
  recovered via in-place migrations 094/095, not a restore — and
  there is no record of whether a snapshot from before the bad
  migrations was actually available.

Impact: in a destructive-write incident (accidental TRUNCATE, ransomware
of the Railway DB, accidental `DROP COLUMN`, or a Cashfree-related
chargeback wave that requires evidence reconstruction), the team has no
documented path back to a known-good state. This is the single biggest
operational gap for a production-traffic system that handles money
(wallet, bookings, helper payouts).
Fix:
1. Document the Railway backup retention and PITR in
   `App/househelp-api/docs/RUNBOOK.md` with the exact restore-from-snapshot
   click-path.
2. Run a restore drill quarterly: dump Railway prod → restore to a
   throwaway DB → run `migrate up` + smoke tests → record duration
   in the runbook.
3. Also set up an independent off-Railway backup (e.g. `pg_dumpall`
   nightly to S3 / Backblaze) — Railway's outage or account compromise
   is otherwise a single point of failure.
4. Document the restore SLO (e.g. RPO ≤ 24 h, RTO ≤ 2 h).
Evidence:
- `App/househelp-api/docs/` listing — none of migrations.md,
  logging.md, privacy-notes.md, privacy-policy-prep.md cover restore.
- `docs/` top-level — AUDIT.md, BUSINESS.md, SDUI.md, crmv2plan.md;
  no backup doc.
- REPO_MAP.md does not mention backups.

---

## 5. MONITORING / ALERTING

[SEVERITY: Critical]
[FILE: <none>]
[CATEGORY: DevOps / monitoring]
Finding:
No error-tracking or APM is wired up anywhere in the stack.
- Backend: no `sentry-go`, `datadog-go`, OTel exporter, or Honeycomb
  beeline in `go.mod`. The only reference to "Sentry" in the codebase
  is a TODO comment (`internal/leave/notify.go:15`).
- Mobile: no `@sentry/react-native`, no Firebase Crashlytics in
  `App/zopmop-app/package.json`. The native Firebase deps installed
  are `@react-native-firebase/{app,auth,messaging}` — Crashlytics
  is conspicuously absent.
- CRM: no Sentry/Bugsnag in `App/zopmop-crm/package.json` (not deeply
  inspected, but no setup file or `.env` token surfaced).
- The only telemetry is PostHog product analytics (`posthog-react-native`
  on mobile, `internal/analytics` aggregations on the backend). PostHog
  is **not** an error tracker.

Logging is via `zerolog` writing to stdout (Railway captures container
stdout). No structured log shipper to a long-term store (Loki, Datadog
Logs, Better Stack). Logs are retained only as long as Railway's
container console keeps them (typically days, not months).

Impact:
- A 500 in prod is invisible until a user complains. No paging, no
  alerts.
- A mobile crash on a customer device is invisible — the team has no
  way to learn that 5 % of TestFlight users are crashing on launch
  until App Store Connect or the Play Console reports it (and those
  reports are post-facto and incomplete).
- The compliance audit (DSAR exports, payment disputes) requires log
  retrieval beyond Railway's window — currently impossible.

Fix:
1. Install Sentry on backend (`github.com/getsentry/sentry-go`) and
   wire it into the Fiber error handler. Use the SENTRY_DSN env var.
2. Install `@sentry/react-native` on mobile (and CRM with `@sentry/react`).
   Configure dist tags by release channel (preview / production).
3. Install Firebase Crashlytics via `@react-native-firebase/crashlytics`
   — it ships alongside the existing Firebase deps and re-uses the
   `GoogleService-Info.plist` / `google-services.json` already wired.
   Optional if Sentry is installed but strongly recommended for native
   crashes that JS Sentry won't catch.
4. Ship logs to a retained store: BetterStack or Datadog free tier,
   wired into Railway's "Log Drains" feature.
5. Define paging policy: PagerDuty / OpsGenie / Slack-only? At minimum,
   a Slack webhook on Sentry severity ≥ error.
Evidence:
- `App/househelp-api/go.mod` — no sentry / datadog / otel imports.
- `App/zopmop-app/package.json:14-58` — no sentry / crashlytics.
- `App/househelp-api/internal/leave/notify.go:15` — "Loki/Sentry"
  mentioned only as a TODO.
- `App/zopmop-app/src/config/posthog.ts` — PostHog *only*, not an
  error tracker.

---

## 6. HEALTH CHECKS

[SEVERITY: Low]
[FILE: App/househelp-api/cmd/api/main.go:234-252]
[CATEGORY: DevOps / health]
Finding:
The `/health` and `/ready` endpoints are correctly split:

- `/health` (line 234) returns 200 unconditionally → liveness only.
- `/ready` (line 242) pings DB (1 s timeout) + Redis → readiness.

Both endpoints are wrapped in `publicLimiter`. The rate-limit on
`/health` is operationally annoying: cluster/load-balancer health
probes from many sources can hit the limit and cause flapping. Most
load balancers expect health probes to never rate-limit.
Impact: minor in current single-instance Railway deploy, but if scaled
to multiple replicas behind a LB, the LB's own health probes plus
the customer-side `BackendDownScreen` poll (mobile) plus uptime
monitors will quickly saturate `publicLimiter`'s bucket. The result
is the LB declaring the pod unhealthy and restarting it for the wrong
reason.
Fix: register `/health` and `/ready` *before* the rate-limit middleware
chain, or whitelist the limiter for those paths. Cf. the same code at
line 234, the limiter is applied per-route which is fine to remove.
Evidence: `App/househelp-api/cmd/api/main.go:234,242`.

---

[SEVERITY: Medium]
[FILE: App/househelp-api/cmd/api/main.go:242-252]
[CATEGORY: DevOps / health]
Finding:
`/ready` returns a 503 with `{"status":"db_unreachable"}` or
`{"status":"redis_unreachable"}`, but it does not include the
deploy version, build SHA, or migration version. There is no
`/version` endpoint either.
Impact: during an incident, the only way to confirm "is the new
build live?" is to read Railway's UI. If two deploys are racing or
a rollback is in flight, this is fragile. Migration state is
particularly important — the 2026-05-14 hybrid-schema incident
would have been spotted earlier with an endpoint that exposed
`schema_migrations.version`.
Fix: add a `/version` endpoint (admin-only or signed token) that
returns build SHA (compiled in via `-ldflags '-X main.Version='`),
`schema_migrations.version`, `started_at`, and the active feature
flag set. Lock behind `mw.RequirePermission(admin.PermViewAnalytics)`.
Evidence: `cmd/api/main.go:242-252` — only "ready" / "*_unreachable"
responses; `pkg/database/postgres.go` (not shown) does not expose
version.

---

## 7. GRACEFUL SHUTDOWN

[SEVERITY: Low]
[FILE: App/househelp-api/cmd/api/main.go:742-774]
[CATEGORY: DevOps / shutdown]
Finding:
Shutdown sequence is good in shape (signal.Notify → ShutdownWithContext
→ drain webhookDispatcher → drain leaveWorker + roomiesWorker) but
several background workers are NOT drained:

- `rollupWorker` (`main.go:330`) — `analytics` rollup; only
  `.Start()` shown, no stop.
- `reengagementWorker` (`main.go:337`) — similar.
- `segmentWorker` (`main.go:343`) — similar.
- `outboxWorker` (`main.go:353`) — uses `defer outboxWorker.Stop()`
  which runs only on normal function return — works in practice but
  is the wrong place because `Shutdown` happens first.
- The four `matching.NewScheduledDispatcher/NewStealthDispatcher/
  NewRebookScanner/NewPendingActionSweeper` goroutines (`main.go:577-580`)
  receive a `cronCtx` that is `WithCancel`'d at `main.go:575` but the
  `cancelCrons()` call site is not shown in the shutdown block at
  `main.go:742-774`. Either it's missing or it's elsewhere.

Impact: workers may issue partial writes during shutdown; in the
worst case an outbox event is half-processed (claim taken, work not
done) and is left in "processing" state until the next deploy boots
and the row's lease expires. Audit NEW-B1-001 (referenced inline)
covers leaveWorker + roomiesWorker but leaves the others.
Fix: every `.Start()` should be paired with a `.Stop(ctx)` in the
shutdown block, in dependency order (outbox last so other workers
can flush events). Verify `cancelCrons()` is invoked. Add a test that
asserts no goroutines outlive `main()` (use `goleak` or similar).
Evidence:
- `cmd/api/main.go:330,337,343,353,575-580,742-774`.
- Grep shows `outboxWorker.Stop` only at line 354 (the `defer`).

---

## 8. CRON / BACKGROUND JOBS — MULTI-INSTANCE SAFETY

[SEVERITY: High]
[FILE: App/househelp-api/cmd/api/main.go:330-353,575-615,724-731]
[CATEGORY: DevOps / scheduling]
Finding:
The backend runs at least 9 long-lived background workers in the same
process as the HTTP API:

- `rollupWorker`, `reengagementWorker`, `segmentWorker`, `outboxWorker`,
  `matchBatcher` (line 310),
- 4 cron loops (`ScheduledDispatcher`, `StealthDispatcher`,
  `RebookScanner`, `PendingActionSweeper`),
- `leaveWorker`, `roomiesWorker`.

Railway can scale to multiple replicas. None of these workers
coordinate across replicas (no leader-election, no SELECT FOR UPDATE
SKIP LOCKED at the loop level — only at row-claim level). The current
single-replica deploy hides this, but the moment a second replica
boots, every cron fires twice and every "monthly leave reset" runs
N times.

The `outbox` worker is the exception — it claims rows with SKIP LOCKED,
so duplication is safe. `matching.*Dispatcher` and `roomies.Worker` and
`leave.Worker` need verification.

Impact: silent double-billing, duplicate notifications, duplicate
helper-balance refills, race-condition payouts when Railway is asked
to scale. Already a known operational hazard in the architecture; not
mitigated.
Fix:
1. Either (a) declare the API service "single-replica" in Railway
   config and document it, OR (b) extract the workers into a separate
   `cmd/worker` binary deployed on a 1-replica service while the API
   itself horizontally scales.
2. For (b), the existing `cmd/retention-worker` pattern (k8s manifest
   in `deploy/`) is a good template — but note Finding 12 about it
   not being built into the Docker image.
3. Add a runtime check at startup that logs a WARN if `REPLICAS > 1`
   when ENV is production AND `WORKER_ROLE != "worker-only"`.
Evidence: list of worker `Start()` calls above; no leader-election
imports; `railway.json` does not pin replica count.

---

## 9. SECRETS MANAGEMENT

[SEVERITY: Medium]
[FILE: App/zopmop-app/app.json:40,94]
[CATEGORY: DevOps / secrets]
Finding:
`app.json` hard-codes a Google Maps API key
(`AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0`) in two places (iOS config
line 40, react-native-maps plugin line 94). The repo policy
(`app.config.js:4-9`) is "Never hardcode API keys here", and
`app.config.js` is the dynamic config that should be the only place
the key flows from `process.env`. With `app.json` also containing the
key, the dynamic-config branch is effectively bypassed — Expo merges
the two and the static value wins on iOS config / native plugin
config.

REPO_MAP §"Known issues" already flags this as Critical for
secrets-in-source and asks for rotation verification. Prior audit
memory says it was rotated, but the static config still contains a
real-looking key.
Impact: any clone of the repo (CI, contractor, etc.) has the key in
its working tree. The key needs Google Cloud Console restrictions
(referrer / bundle / SHA1) to be safe. Currently unverifiable from
the repo alone.
Fix:
1. Replace the literal in `app.json:40,94` with a placeholder
   (`"YOUR_GOOGLE_MAPS_API_KEY"`) and rely on `app.config.js` to
   inject from `process.env`. The `app.config.js` already does this at
   line 29, 41, 55, 56 — the static `app.json` value is now redundant
   and dangerous.
2. Confirm in GCP Console the key is restricted to bundle ID
   `com.zopmop.app` + Android package + SHA1 fingerprint.
3. Rotate again if any leak window since the last rotation is
   uncertain. Track in a `SECRETS_INVENTORY.md`.
Evidence:
- `App/zopmop-app/app.json:40` — `"apiKey": "AIzaSyCYCxpNia7E01j…"`
- `App/zopmop-app/app.json:94` — same key under react-native-maps plugin
- `App/zopmop-app/app.config.js:29,41,55,56` — env-driven path.

---

[SEVERITY: Medium]
[FILE: App/zopmop-app/.env:2,4-5]
[CATEGORY: DevOps / secrets]
Finding:
`App/zopmop-app/.env` is committed to the repo (status output and
`ls` confirm — only `*.env` matches the gitignore but it must be a
tracked-history exception, or it never was ignored on the mobile side
because the file is referenced as plain `.env`). The file contains:

- `EXPO_PUBLIC_API_URL=http://192.168.1.44:8080/api/v1` — leaks LAN IP
- `POSTHOG_PROJECT_TOKEN=phc_w6WWrvJjvho2yuoghBJSoidBrtG8UWWFGqD8V2xc4d6h`
  — PostHog project token (project_token, not personal_api_key, so
  rotation impact is limited but still a secret).

The mobile `.gitignore` (`App/zopmop-app/.gitignore`, not read here but
short per `ls -la`) does not appear to ignore `.env`. The backend
`.gitignore` does (`*.env` line 6).
Impact: PostHog project token is visible to anyone with repo access.
LAN IP is innocuous but reveals developer network layout.
Fix:
1. `git rm --cached App/zopmop-app/.env`.
2. Add `.env` to `App/zopmop-app/.gitignore` (and `.env.local`,
   `.env.production.local`).
3. Rotate the PostHog project token (Settings → Project → Reset).
4. Update `App/zopmop-app/.env.example` to reflect the rotated values'
   shape (already partially done).
Evidence:
- `App/zopmop-app/.env` exists at the path and is readable. Its
  contents were captured during this audit (see Read tool output for
  `App/zopmop-app/.env`).
- Both `git status` and `ls -la` list it as tracked.

---

[SEVERITY: High]
[FILE: App/zopmop-app/eas.json:14-23]
[CATEGORY: DevOps / secrets]
Finding:
The `preview` and `production` EAS profiles both have `env: {}` — no
inline env injection. This means EAS Production builds rely on EAS
Secrets being configured server-side via `eas secret:create`. If those
secrets do not exist, the production build will compile with
`EXPO_PUBLIC_API_URL=undefined` (default `http://localhost:8080/api/v1`
per `src/api/config.ts:6`) and `GOOGLE_MAPS_API_KEY=undefined` and
`POSTHOG_PROJECT_TOKEN=undefined`. The `src/api/config.ts:21` guard
will throw at startup in production builds — which is the right safety
net for the API URL — but maps and analytics will silently degrade.

There is no in-repo evidence (a `eas.json` env block, a script, or a
README pointer) that proves the secrets *are* configured server-side.
Impact: the next production build can ship without maps and analytics
without anyone noticing until users report it.
Fix:
1. Document the required EAS Secrets in `App/zopmop-app/README.md` (or
   a new `EAS_SETUP.md`) — list every secret name and which build
   profile uses it.
2. Add a startup assert that logs (or throws in `__DEV__ === false`)
   if `GOOGLE_MAPS_API_KEY` or `POSTHOG_PROJECT_TOKEN` resolves
   undefined in a production build. PostHog already warns
   (`src/config/posthog.ts:21`); apply the same pattern to maps.
3. Run `eas secret:list` and capture the output into the runbook
   (not the repo).
Evidence:
- `App/zopmop-app/eas.json:14-23` — empty env on preview/production.
- `App/zopmop-app/src/api/config.ts:6` — fallback to localhost.

---

## 10. MOBILE OTA / RELEASE CHANNELS

[SEVERITY: Medium]
[FILE: App/zopmop-app/eas.json:6-23, App/zopmop-app/app.json:116-121]
[CATEGORY: DevOps / mobile-ota]
Finding:
`expo-updates` is configured with `runtimeVersion: { policy:
"appVersion" }` and three channels: `development`, `preview`,
`production`. Production has `autoIncrement: true` (good — version
codes won't collide). However, there is no documented rollback
procedure:

- `eas update --branch production --message "Rollback to <prev>"` is
  the supported path but is not codified.
- No staged rollout configuration (e.g. `--rollout-percentage 5`).
- Runtime version policy `appVersion` means only OTA updates with the
  SAME native bundle version can be delivered — a critical fix
  requires a full store-resubmit. Acceptable for now but worth
  flagging.
- No emergency "kill switch" for a broken update (e.g. an env-flag
  served by SDUI/config_manager that disables the update and falls
  back to the embedded binary).

Impact: a broken OTA ships to 100 % of users immediately; recovery is
manual.
Fix:
1. Document the rollback procedure in a `MOBILE_RUNBOOK.md`.
2. Set up staged rollouts via `eas update --branch production
   --rollout-percentage`.
3. Add an `update_kill_switch` toggle in `internal/config_manager`,
   read on app boot; if set, app skips OTA fetch this session.
4. Consider switching `runtimeVersion` to `{ policy: "fingerprint" }`
   once the team is comfortable — gives more flexibility (Expo SDK
   54 supports it).
Evidence:
- `App/zopmop-app/eas.json:11-23` — channels declared, no rollout
  config.
- `App/zopmop-app/app.json:116-121` — runtime policy `appVersion`,
  update URL set.

---

## 11. CRASHLYTICS — GAP

[SEVERITY: High]
[FILE: App/zopmop-app/package.json:14-58]
[CATEGORY: DevOps / monitoring]
Finding:
Firebase Auth + Messaging are installed (`@react-native-firebase/auth`,
`@react-native-firebase/messaging`) but `@react-native-firebase/crashlytics`
is absent. Native crashes (JNI / Obj-C / RN bridge fatals that bypass
the JS engine's error handler) are therefore not reported anywhere.
This compounds Finding 5 (no Sentry).
Impact: a fatal native crash on user devices produces no telemetry to
the team. App Store Connect / Play Console only show high-level
crash-free percentages with very limited stack traces.
Fix: install `@react-native-firebase/crashlytics`, add the Gradle / Pod
config per the official guide, wire `setCrashlyticsCollectionEnabled`
behind a feature flag for staged rollout, and verify
`google-services.json` / `GoogleService-Info.plist` already declare
the Crashlytics module (they do — both are present in the repo per
REPO_MAP §"Mobile dependencies").
Evidence:
- `App/zopmop-app/package.json:18-20` — only `app`, `auth`, `messaging`.
- No `@react-native-firebase/crashlytics` import anywhere in `src/`.

---

## 12. RETENTION-WORKER NOT BUILT INTO IMAGE

[SEVERITY: Medium]
[FILE: App/househelp-api/Dockerfile:8-9, App/househelp-api/deploy/retention-cronjob.yaml:25-27]
[CATEGORY: DevOps / build]
Finding:
The k8s manifest at `deploy/retention-cronjob.yaml:25-27` expects a
binary at `/app/bin/retention-worker` inside image `zopmop/api:latest`.
The Dockerfile builds only `cmd/api` (line 8) and `cmd/migrate` (line 9)
and copies them to `/usr/local/bin/`, NOT `/app/bin/`. Its `deploy/README.md`
claims `RUN go build ./...` produces both binaries — that's not what
the Dockerfile actually does. So:

- The retention CronJob, if ever deployed, will fail at startup with
  "exec: 'retention-worker' not found".
- Railway does not run the k8s CronJob at all (Railway has its own
  cron primitive), so currently NO retention sweep is running in
  production. That's a DPDP compliance gap — `crm_audit_log`,
  `crm_login_attempts`, `helper_status_log`, etc. accumulate
  indefinitely beyond the retention windows declared in
  `internal/compliance/policies.go`.

Impact: legal/compliance — DPDP §11 access-to-erasure requires demonstrable
deletion. Operationally — DB tables grow without bound.
Fix:
1. Either (a) build the retention-worker into the Dockerfile (`RUN go
   build -o /out/retention-worker ./cmd/retention-worker`) and copy to
   `/app/bin/`, AND set up a Railway-cron service that invokes it daily,
   OR (b) inline the retention sweep into the existing API process as
   another `Worker.Start()` (acceptable since the API is single-replica
   today).
2. Update `deploy/README.md` to reflect reality (it currently
   misrepresents the Dockerfile).
3. Add a smoke test in CI that boots the image and `exec`s
   `/app/bin/retention-worker --help` to assert the binary exists.
Evidence:
- `Dockerfile:8-9` — only api + migrate built.
- `deploy/retention-cronjob.yaml:25-27,40` — references binary that
  doesn't exist in the image.
- `deploy/README.md:39-42` — claims `./...` builds both, false.

---

## 13. API VERSIONING / DEPRECATION

[SEVERITY: Medium]
[FILE: App/zopmop-app/src/api/config.ts:6, multiple route prefixes]
[CATEGORY: DevOps / api-versioning]
Finding:
The backend uses `/api/v1` as a single, unversioned-after-the-1 prefix.
There is no deprecation header, no `Sunset` header, no `Deprecation`
header per RFC 8594, and no documented "supported clients" matrix.
Mobile clients in the wild are not enforced to a minimum app version;
the only mechanism shown is `EXPO_PUBLIC_API_URL` and the `expo-updates`
runtime version policy. A breaking schema change to a v1 endpoint will
break all in-flight TestFlight + Play installs.

The home screen has a `BackendDownScreen` (REPO_MAP §"Customer mobile
app") which handles total unreachability but not a min-version mismatch.

Impact: deploying a breaking change to any `/api/v1/*` endpoint can
break old binaries silently. No A/B path forward for new endpoint
shapes.
Fix:
1. Add a `X-App-Min-Version` response header from the backend (read
   from `config_manager`) and have the mobile app force-upgrade if its
   own version is below it. Implement in `src/api/config.ts`'s fetch
   wrapper.
2. Introduce a `/api/v2` prefix for any new breaking endpoint going
   forward. Treat `/api/v1` as frozen.
3. Document the deprecation policy in `docs/API_VERSIONING.md`.
Evidence:
- `App/zopmop-app/src/api/config.ts:6` — base URL hardcoded to `/api/v1`.
- No `Deprecation:` or `Sunset:` headers visible in
  `cmd/api/main.go` middleware chain.

---

## 14. CI WORKFLOW SCOPE — CRM TESTS

[SEVERITY: Nit]
[FILE: .github/workflows/ci.yml:29-44]
[CATEGORY: DevOps / ci]
Finding:
The CRM job runs `typecheck` and `build` but not lint or tests. The
CRM is the admin/internal tool (per REPO_MAP §"CRM admin web app") that
handles dispute resolution, manual refunds, wallet adjustments — i.e.
high-trust operations. A regression in the CRM that lets an admin
double-refund is invisible to CI.
Impact: low immediate, high-leverage gap because CRM operations touch
money.
Fix: add `npm run lint` and `npm test` (introduce a baseline test if
none exists). Add a Playwright smoke against a staging instance.
Evidence: `.github/workflows/ci.yml:34-44`.

---

## 15. NON-`.env.example` SECRET LEAKAGE

[SEVERITY: Low]
[FILE: App/househelp-api/.env.example:26,28]
[CATEGORY: DevOps / env-hygiene]
Finding:
`.env.example:26` ships a clearly-placeholder `JWT_SECRET=
change-this-to-a-random-64-char-string-in-production` and
`.env.example:28` ships `JWT_SECRET_ID=active-2026-04`. The placeholder
secret is OK as a hint; the SECRET_ID happens to be a real-looking
"active-YYYY-MM" identifier and may match the production rotation if
the team copied it forward verbatim. Verify it does not.
Impact: only an issue if the SECRET_ID *is* the prod-active id — JWT
KID alignment is operationally relevant for rotation.
Fix: change the placeholder to `JWT_SECRET_ID=local-dev-active-yyyy-mm`
to make it obviously not-real.
Evidence: `App/househelp-api/.env.example:26-28`.

---

## 16. `*.md` IN `.dockerignore`

[SEVERITY: Nit]
[FILE: App/househelp-api/.dockerignore:9]
[CATEGORY: DevOps / docker]
Finding:
`.dockerignore` excludes `*.md`. Good for image size. However, it does
NOT exclude `docs/` (line 8 excludes `docs/`, OK), and it excludes
`.env.*` (line 5) which is correct. But it also excludes `deploy/`
(line 19) — yet `deploy/retention-cronjob.yaml` references the image,
not the other way round, so this is fine. The one cost is that no
markdown ends up in the image, which means future runbook bundling
(if planned) requires a config change. Worth flagging as a
forward-looking note, not a bug.
Impact: negligible.
Fix: none required. Document the intent in `.dockerignore`'s top
comment.
Evidence: `App/househelp-api/.dockerignore:8,9,19`.

---

## 17. NO COMPOSE OVERRIDE PATTERN

[SEVERITY: Nit]
[FILE: App/househelp-api/docker-compose.yml:1-101]
[CATEGORY: DevOps / docker]
Finding:
Compose has no `docker-compose.override.yml` template, no `dev` /
`test` profile that runs a fresh test DB on a different port, and no
way to bring up the stack with `pgAdmin` or `redis-commander` attached
for debugging. The Makefile provides `psql` and `redis-cli` exec
targets which mitigate this.
Impact: minor — developer ergonomics only.
Fix: optional — ship a `docker-compose.override.yml.example` for
debugging tooling. Lower priority than the rest.
Evidence: `App/househelp-api/docker-compose.yml`.

---

## 18. CI DOES NOT EXERCISE MIGRATION DOWN FILES

[SEVERITY: Low]
[FILE: .github/workflows/ci.yml:45-65]
[CATEGORY: DevOps / ci]
Finding:
The migrations CI job validates filename patterns only (regex
`^[0-9]{3}_[a-z0-9_]+\.(up|down)\.sql$`). It does NOT:

- Run `migrate up` against a fresh Postgres in CI.
- Verify each `.down.sql` is forward-only (i.e. contains only the
  policy-mandated "do not run" comment).
- Verify SQL syntax of each `.up.sql` (e.g. by `psql --dry-run` or
  by actually running them).

The 2026-05-14 incident — caused by running migrations that the team
believed were not authorized — would not have been caught by this job.
Impact: CI cannot catch a bad migration before it lands. Preflight on
the dev's laptop is the only gate.
Fix:
1. Spin up a `services: postgres:` container in the migrations job
   and run `migrate up` → `migrate down 1` → `migrate up` round-trip.
2. Cat each `.down.sql` and assert it contains the forward-only
   sentinel comment.
Evidence: `.github/workflows/ci.yml:45-65`.

---

## 19. RAILWAY RESTART POLICY

[SEVERITY: Low]
[FILE: App/househelp-api/railway.json:11-12]
[CATEGORY: DevOps / deploy]
Finding:
`railway.json` sets `restartPolicyType: "ON_FAILURE"` and
`restartPolicyMaxRetries: 3`. After 3 failed boots, Railway gives up
and the service stays down. There is no alerting wired to detect this
state (cf. Finding 5 — no monitoring).
Impact: if a config push breaks boot, the API is down with no
notification beyond Railway's own dashboard.
Fix:
1. Add an uptime monitor (e.g. UptimeRobot, BetterStack, or a
   Cloudflare Health Check) that pings `/health` every 60 s and
   pages on 3 consecutive failures.
2. Consider `restartPolicyType: "ALWAYS"` with a backoff if you'd
   rather Railway keep trying forever; tradeoff is restart-loop noise.
Evidence: `App/househelp-api/railway.json:10-12`.

---

## 20. WEBSITE DEPLOY — MANUAL / UNAUDITED

[SEVERITY: Medium]
[FILE: website/.well-known/, REPO_MAP.md:191-199]
[CATEGORY: DevOps / deploy]
Finding:
The marketing site (zopmop.com) is deployed via cPanel FTP/SFTP per
REPO_MAP. Only `.well-known/apple-app-site-association` +
`.well-known/assetlinks.json` are tracked in git — the rest of the
site is gitignored. This means:

- No CI deploys the site.
- AASA / assetlinks changes ship via manual SFTP. If the dev forgets
  to upload after editing the in-repo copy, universal links silently
  break for new app installs.
- No content-type validation runs in CI (the `.htaccess` adds
  `application/json` for AASA but only by manual deploy).

The `assetlinks.json` still contains the DEBUG SHA-256 per REPO_MAP
§"Known issues" — a real release-key SHA must replace it before
Play Store launch.
Impact: universal-link auto-verify (`autoVerify: true` in
`AndroidManifest.xml:53-65`) will fail at install time on real Play
Store binaries until the release SHA-256 is published.
Fix:
1. Track the AASA + assetlinks content in CI: a job that GETs
   `https://zopmop.com/.well-known/apple-app-site-association` and
   asserts the content matches `website/.well-known/...` byte-for-byte
   and returns `application/json`.
2. Replace the DEBUG SHA-256 in `assetlinks.json` with the release
   keystore SHA-256 BEFORE the first Play Store upload, then commit
   AND deploy in lockstep.
3. Document the SFTP deploy command in a `WEBSITE_DEPLOY.md`.
Evidence:
- REPO_MAP §"Marketing website" and §"Known issues already documented
  in user memory".
- `website/.well-known/assetlinks.json` (tracked).

---

## SUMMARY

Critical (2):
- No backup/restore runbook for the production Postgres DB.
- No error tracking or APM anywhere in the stack (backend, mobile, CRM).

High (6):
- `.env.example` missing 13 env vars.
- `main` branch CI is concurrent with prod deploy, no required-status
  enforcement visible.
- Mobile + CRM CI jobs are too shallow (no lint, no tests).
- Multi-replica safety not enforced for 9 in-process workers.
- EAS production builds depend on undocumented EAS Secrets.
- Crashlytics not installed despite Firebase being wired.

Medium (9):
- Mobile `.env.example` missing PostHog vars.
- Dockerfile not pinned by digest.
- Docker compose secrets check missing.
- `/ready` does not expose version / migration state.
- `app.json` hardcodes Google Maps API key.
- `App/zopmop-app/.env` committed with PostHog token.
- Retention worker not built into image — DPDP compliance gap.
- No API versioning / deprecation policy.
- Marketing-site `.well-known` deploy is manual + unaudited.

Low (4):
- Down-SQL files shipped in image.
- Dockerfile lacks `HEALTHCHECK` (intentional, but railway.json could
  declare one).
- Shutdown does not drain all 9 workers explicitly.
- CI doesn't roundtrip migrations.

Nit (3):
- JWT_SECRET_ID placeholder is too realistic.
- `*.md` blanket exclusion in `.dockerignore`.
- No compose override pattern for dev tooling.

---

## QUESTIONS FOR ADITYA

1. Is Railway PostGIS automatic backup retention configured? What's
   the retention window and PITR availability? Has a restore drill
   ever been performed?
2. Are EAS Secrets actually configured for the production build
   profile (`GOOGLE_MAPS_API_KEY`, `POSTHOG_PROJECT_TOKEN`,
   `POSTHOG_HOST`)? `eas secret:list` output is not in the repo.
3. Is the Google Maps API key in `app.json:40,94` the
   post-rotation key? Is it restricted by bundle ID + SHA1 in GCP?
4. Is the `App/zopmop-app/.env` checked-in PostHog token a project
   token (public) or personal API key (sensitive)? If sensitive, it
   must be rotated.
5. Will the API service ever run with >1 replica on Railway? If yes,
   we need to extract workers into a separate single-replica binary
   before that scaling event.
6. Is there a Slack / PagerDuty / email integration for Railway
   deploy failures? Nothing is wired in-repo.
7. Has anyone actually invoked the retention worker against prod?
   The k8s manifest is dead code unless a Railway cron is running
   it via a different command path.
