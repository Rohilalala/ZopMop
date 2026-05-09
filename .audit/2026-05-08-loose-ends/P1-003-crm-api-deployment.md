# P1-003 — cmd/crm-api deployment undefined

**Severity:** P1
**Category:** OPS
**Surfaced by:** System walkthrough Part 4
**Date:** 2026-05-08

## Summary

`cmd/crm-api` is fully implemented as a separate Go binary on port 8090,
but the Dockerfile only builds `cmd/api` (and `cmd/migrate`). No
`Dockerfile.crm`, no `railway.toml`, no CI config covers the CRM. As of
today the CRM API runs nowhere. Blocks P1-002 (CRM frontend) — frontend
needs an API to call. Fix: extend Dockerfile to build crm-api binary, add
new Railway service pointing to same repo with crm start command. ~1 hr.

## Finding

The Go backend repo has two distinct API binaries:
- `cmd/api/main.go` — user-facing API (port 8080, deployed at zopmop-production.up.railway.app)
- `cmd/crm-api/main.go` — admin API (port 8090, deployed nowhere)

Both share the same Postgres database, same Redis, same domain models. They
are deployed separately so user-facing rate limits + scaling don't bleed
into admin operations.

The current Dockerfile (after today's fixes):

```dockerfile
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate
```

Notice: no build for `cmd/crm-api`. The CRM binary literally does not exist
in any deployed image.

## Evidence

```bash
cat App/househelp-api/Dockerfile | grep "go build"
# Returns 2 lines: api and migrate. No crm-api.

ls App/househelp-api/cmd/
# Confirms cmd/crm-api/ exists in source

# Search for any deploy config
find App/househelp-api -name "railway.*" -o -name "Procfile" -o -name ".railwayignore"
# Empty
```

## Blast Radius

- **CRM is unreachable today.** No admin can do anything via API.
- **Blocks P1-002.** Building a CRM frontend without a deployed API is
  pointless.
- **No incident response capability.** If something goes wrong with a
  user-side action that needs admin remediation, you have no admin tools
  to fix it.

Today the impact is theoretical because there are no real users. But this
must be solved before launch.

## Reproduction

```bash
curl https://zopmop-crm.up.railway.app/health
# DNS will fail — no service exists by that name
```

## Fix Plan

### Step 1: Extend Dockerfile to build crm-api binary

Edit `App/househelp-api/Dockerfile`:

```dockerfile
# In the build stage, after the api + migrate builds:
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/crm-api ./cmd/crm-api

# In the runtime stage, after the existing COPYs:
COPY --from=build /out/crm-api /usr/local/bin/crm-api
```

The single Dockerfile now builds 3 binaries: `api`, `migrate`, `crm-api`.
Same image, different ENTRYPOINT per Railway service.

### Step 2: Create new Railway service for CRM API

In Railway dashboard:
1. Click + Add → GitHub Repo (same repo)
2. Service name: "ZopMopCRM" or similar
3. Root directory: `App/househelp-api/`
4. Custom start command: `/usr/local/bin/crm-api`
5. Or: set environment variable `RAILWAY_DOCKERFILE_PATH` and override
   ENTRYPOINT via railway.toml

Railway auto-builds from the same repo, same Dockerfile, but starts
`crm-api` instead of `api`.

### Step 3: Configure environment variables

CRM service needs (likely subset of what user API has):
- `DATABASE_URL` → `${{PostGIS.DATABASE_PRIVATE_URL}}` (same DB)
- `REDIS_URL` → `${{Redis.REDIS_URL}}` (same Redis)
- `JWT_SECRET` (admin sessions; consider separate from user JWT_SECRET for
  blast-radius isolation — discussed below)
- `JWT_PREVIOUS_SECRETS` for rotation
- `PORT` = 8090 (or whatever Railway assigns)
- `CRM_ALLOWED_ORIGINS` for the CRM frontend domain
- `APP_ENV` = production
- `FIREBASE_CREDENTIALS_JSON` (if CRM uses Firebase for FCM sends to users)

### Step 4: Verify

```bash
curl https://zopmop-crm.up.railway.app/health
# Should return 200

# Try TOTP login flow — won't work yet without a seeded admin user, but
# should reach the handler:
curl -X POST https://zopmop-crm.up.railway.app/api/v1/admin/auth/login \
  -d '{"email":"...","password":"..."}'
# Should return 401 or 422, NOT 404 or DNS failure
```

### Step 5: Seed the first superadmin

This is a separate operation, similar to user seeding. Document a one-shot
SQL or Go command to create the initial admin record:

```sql
INSERT INTO crm_admins (email, password_hash, role, is_active, created_at)
VALUES (
  'aditya@zopmop.com',
  crypt('<initial-strong-password>', gen_salt('bf', 12)),
  'superadmin',
  true,
  NOW()
);
```

Then the admin signs in, gets prompted to enroll TOTP on first login.

## Architectural Decision: Shared vs separate JWT_SECRET

**Option A (shared):** Both user API and CRM API use the same `JWT_SECRET`.
Simpler. But: a token forged for the user API could be replayed against
CRM API claiming admin role.

**Option B (separate):** CRM API uses `CRM_JWT_SECRET`, distinct from user
`JWT_SECRET`. User tokens cannot be replayed as admin tokens.

**Recommendation: Option B.** Separation matters because the CRM has
elevated privilege. A bug or exposure on the user side (e.g., a JWT secret
leak in logs) shouldn't compromise admin auth.

Implementation: ensure `cmd/crm-api/main.go` reads from `CRM_JWT_SECRET`
env var, not `JWT_SECRET`. Verify in code review.

## Recommendation

Step 1 + 2 + 3 + 4: same-day work, ~1 hour.
Step 5: separate operational task, 15 min.
Architectural decision: implement Option B before public launch.

## Effort

- Dockerfile edit + commit + push: 15 min (Railway auto-rebuilds)
- New Railway service creation + env vars: 30 min
- Verification: 15 min
- Initial admin seed: 15 min

**Total: ~1.5 hr.**

## Dependencies

- P0-003 (postgres password rotation) should land first so any future
  CRM-side leaks aren't compounded
- Decision on JWT_SECRET separation
- Domain decision: `crm.zopmop.com` vs `admin.zopmop.com` vs Railway
  default URL for now

## Acceptance Criteria

- `curl https://zopmop-crm.up.railway.app/health` returns 200
- `crm-api` binary exists in deployed Docker image (verify with Railway
  shell or by hitting an endpoint)
- Initial superadmin can complete login + TOTP enrollment via curl
- Audit log row exists for that first login

## Related

- Unblocks P1-002 (CRM frontend can now be built against a real API)

## Anchor

Pre-fix tag: `pre-deploy-crm-api`
