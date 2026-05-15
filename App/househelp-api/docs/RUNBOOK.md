# ZopMop Backend Runbook

Operational playbook for prod incidents and routine maintenance.
Last updated 2026-05-15.

---

## 1. Production topology

| Component | Where | Owner |
|---|---|---|
| API (Go/Fiber) | Railway service `ZopMop`, branch `main`, region Southeast Asia | this repo |
| Postgres + PostGIS | Railway service `PostGIS` (NOT the sibling `Postgres` service) | Railway-managed image `postgis/postgis:16-3.4-alpine` |
| Redis | Railway service `Redis` | Railway-managed |
| Mobile binary | EAS Build → TestFlight / Play | EAS |
| CRM web app | (separate deploy — see `App/zopmop-crm/`) | TBD |
| Marketing website | GoDaddy cPanel → `zopmop.com` | static |

Health endpoints:
- `https://zopmop-production.up.railway.app/health` (no DB hit)
- `https://zopmop-production.up.railway.app/ready` (pings DB + Redis)

---

## 2. Backups

### Postgres / PostGIS

Railway provides automatic daily snapshots for the PostGIS service.
Retention and PITR window depend on the Railway plan tier — verify
current values via the Railway dashboard → PostGIS service → Backups
tab. As of 2026-05-15 this has not been load-tested with a real
restore drill — **schedule one before launch**.

#### Take a logical snapshot on demand

```bash
PGPASSWORD=$RAILWAY_POSTGIS_PASSWORD pg_dump \
  -h turntable.proxy.rlwy.net -p 47710 \
  -U postgres -d railway \
  --format=custom --no-owner --no-privileges \
  --file="zopmop-$(date +%Y%m%d-%H%M%S).dump"
```

Replace the host/port with the current Railway public TCP proxy
values (Railway dashboard → PostGIS → Variables tab,
`RAILWAY_TCP_PROXY_DOMAIN` + `RAILWAY_TCP_PROXY_PORT`).

Store the file in encrypted long-term storage (drive vault).

#### Restore drill (do this BEFORE you need it)

1. Spin up a throwaway local Postgres:
   ```bash
   docker run --rm -d --name pg-restore-test \
     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=zopmop_restore \
     -p 15432:5432 postgis/postgis:16-3.4-alpine
   ```
2. Restore the dump:
   ```bash
   PGPASSWORD=test pg_restore -h localhost -p 15432 \
     -U postgres -d zopmop_restore \
     --no-owner --no-privileges --jobs=4 \
     zopmop-YYYYMMDD-HHMMSS.dump
   ```
3. Boot a local api against it:
   ```bash
   DATABASE_URL="postgres://postgres:test@localhost:15432/zopmop_restore?sslmode=disable" \
     go run ./cmd/api
   ```
4. Smoke test critical endpoints (`/health`, `/ready`,
   `/api/v1/services`). Confirm record counts match the prod
   snapshot timestamp.
5. Tear down: `docker rm -f pg-restore-test`.

Document the duration in this runbook the first time you run the
drill so the team has a real RTO number to quote.

### Redis

Redis is **NOT** durable storage. Everything in Redis is either
ephemeral (rate-limit counters, in-flight invites, GEO sets) or a
cache (zone metadata). After a Redis flush:
- Rate limits reset (benign).
- In-flight invite chains lose their accept window (booking falls
  back to the dispatcher; customer sees a brief "searching" state).
- Cached config rehydrates on next request.

**Do not** treat Redis as a system of record. Anything that must
survive restart goes in Postgres.

---

## 3. Migrations

Forward-only by policy. See `cmd/migrate/main.go:9` for the rule
and the May 14 incident memory for what happens when this is
violated.

### Apply a new migration

1. Write the `.up.sql` and (optional tooling-only) `.down.sql` file
   in `migrations/NNN_short_name.{up,down}.sql`.
2. `make migrate` locally to confirm it applies cleanly.
3. Open PR. Once merged to `main`, Railway's `preDeployCommand`
   (`/usr/local/bin/migrate up`, declared in `railway.json`) runs
   it on a single instance before the api boots.

### Emergency: dirty migration on prod

If `migrate up` fails partway, `schema_migrations.dirty = true` blocks
future runs.

1. Inspect:
   ```sql
   SELECT version, dirty FROM schema_migrations;
   ```
2. Identify the actual schema state by diffing pg_dump's `--schema-only`
   output against the expected state for that version.
3. Recover:
   ```bash
   docker compose run --rm migrate force --version <last-good>
   ```
   (or directly via `railway run --service ZopMop /usr/local/bin/migrate force --version N`)
4. Write a corrective forward migration that gets the schema to the
   intended state without re-running the broken one.

### Anti-pattern: in-image untracked migrations

The Docker image's `COPY migrations /app/migrations` will silently
include any `.sql` files in the working tree at build time, even if
they're untracked. Always rebuild fresh from a clean tree before
running prod ops with a locally-built image. See the May 14
incident memory.

---

## 4. Deploy + rollback

### Deploy a change

1. Cut a `feature/<name>` branch from `main`.
2. Make changes; `make preflight` locally.
3. Open PR to `main`. Don't merge until CI green.
4. Merge. Railway picks up the push via GitHub App webhook
   (the auto-deploy link broke once before — see Q9 in
   `audit/OPEN_QUESTIONS.md` and the troubleshooting section
   below).
5. Pre-deploy stage runs `migrate up`.
6. New api binary boots; old one is replaced.

### Rollback

Railway's Deployments tab lists every prior build. To roll back:

1. Identify the last-known-good deployment.
2. Click `⋯` → **Redeploy** on that row.
3. Note: this re-runs the OLD binary against the CURRENT schema. If
   the schema has moved past what the old binary supports (e.g.
   migrations 094 + 095 were applied), the old binary will start
   500ing. In that case, the correct rollback is a forward fix:
   ship a new code change that's compatible with the current
   schema.

### "Railway didn't deploy on push" troubleshooting

If a push to `main` doesn't trigger a Railway build:

1. **Activity sidebar** in the Railway dashboard — look for new
   "Deployment successful" or "Deployment failed" rows.
2. **GitHub App link status** — Railway dashboard → ZopMop →
   Settings → Source → look for "Auto deploy unavailable" warning.
   Hover the ⓘ icon for the reason.
3. **Webhook delivery** — `https://github.com/Rohilalala/ZopMop/settings/hooks`
   (Railway uses the GitHub App, not classic webhooks; the App
   appears at `https://github.com/settings/installations`).
4. **Force a build via CLI** — `railway up --service ZopMop --detach`
   uploads local source and bypasses GitHub entirely.

The 2026-05-14 incident's auto-deploy break was caused by the
Railway user account not being linked to a GitHub identity. Fix:
sign in to Railway via "Continue with GitHub" or trigger a
project-creation flow that prompts the GitHub OAuth handshake.

---

## 5. Common incidents

### "Everyone's bookings are failing"

1. `/health` and `/ready` first — confirm api is up.
2. Tail logs: `railway logs --service ZopMop`. Look for a recurring
   error.
3. Most common cause historically: schema-vs-code drift after a
   migration deploy without the corresponding code change (or
   vice-versa). Cross-reference the booking + cart audit findings.
4. Check `schema_migrations.version` and compare to the git tag of
   the deployed binary.

### "Sign-in is broken"

1. `/api/v1/me/referral` should return HTTP 401 unauth (with the
   error body `authentication required`). If it returns 500, the
   auth middleware itself is breaking.
2. Firebase status — `firebase status` console or the Google Cloud
   Status dashboard. Phone OTP delivery is via Firebase.
3. Tail logs filtered to the auth module:
   `railway logs --service ZopMop | grep auth`.

### "Push notifications stopped"

1. `aps-environment` entitlement must match the build profile (dev
   vs production). EAS production builds use `production`; debug
   builds use `development`. Mismatch = silent failure.
2. APNs key uploaded to Firebase Console → Cloud Messaging → iOS
   app configuration. Check that the key is still valid (Apple
   keys can be revoked).
3. FCM token rotation — check `device_tokens` table for active
   rows for the affected user.

### Postgres connection exhaustion

1. Symptom: `acquire conn: timeout` log lines, 503 on
   DB-bound routes.
2. Confirm pool size: `DB_POOL_MAX_CONNS` env var (default 80).
3. Confirm Railway's plan-level connection cap. The pool plus
   `DB_BOUND_MAX_INFLIGHT=600` queue depth across N replicas must
   stay under that cap.
4. If autoscale-related: see `WORKERS.md` for the worker
   extraction plan. Single-replica today; the extraction is
   prereq to ever scaling api beyond 1 replica.

---

## 6. On-call / alerts

⚠ Pending — no alerting wired up as of 2026-05-15. See
`audit/findings/devops.md` Critical-#2 (no APM / error tracking).

**Plan to wire (open question Q44 in `audit/OPEN_QUESTIONS.md`):**
- Sentry on both backend (`sentry-go`) and mobile (`@sentry/react-native`).
- Sentry → Slack integration for unhandled errors above a threshold.
- Railway → email or Slack on deploy failure (Q24 open).
- UptimeRobot or equivalent hitting `/health` every 60 s.

---

## 7. Routine maintenance

- Quarterly: rotate `JWT_SECRET` using the documented rotation env
  (`JWT_PREVIOUS_SECRETS`). See `.env.example` for the format.
- Quarterly: rotate Google Maps API key (in EAS secrets;
  `GOOGLE_MAPS_API_KEY`) — confirm restrictions in GCP Console.
- Monthly: spot-check `schema_migrations` against the current
  binary's migration directory.
- Monthly: review Railway plan usage; right-size before usage
  spikes hit the next pricing tier.
