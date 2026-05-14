# Backend local testing & deploy workflow

This doc covers the safe loop for changing the Go backend without breaking the
Railway auto-deploy. Read it once, then refer back when something bites.

## Branch model

- **`feature/sdui`** is the production branch. **Railway watches this branch
  and auto-deploys on every push or merge.** Treat it as protected. Never
  commit directly. Never push directly. The `.githooks/pre-push` hook blocks
  this if you enable it (see below).
- **`feature/<thing>`** is where every change lives until it's verified.
- **`chore/<thing>`** is for tooling / infra changes (this doc was created on
  one such branch).

> **Heads-up.** Earlier versions of this workflow referred to the deploy
> branch as `sdui`. It's actually `feature/sdui` in this repo. Anywhere a
> tool, script, or doc says "deploy branch", read `feature/sdui`.

## The loop

```
                  ┌───────────────────────────────┐
                  │  feature/sdui  (Railway prod) │
                  └───────────────┬───────────────┘
                                  │  git pull
                                  ▼
                  ┌───────────────────────────────┐
                  │  feature/<name>               │
                  │  (your work)                  │
                  └───────────────┬───────────────┘
                                  │  edit code
                                  ▼
                  ┌───────────────────────────────┐
                  │  make up                      │
                  │  Docker stack on localhost    │
                  │  (postgres + redis + backend) │
                  └───────────────┬───────────────┘
                                  │  iterate, hit endpoints
                                  ▼
                  ┌───────────────────────────────┐
                  │  make preflight               │
                  │  vet + tests + smoke          │
                  └───────────────┬───────────────┘
                                  │  passes
                                  ▼
                  ┌───────────────────────────────┐
                  │  push, open PR → feature/sdui │
                  └───────────────┬───────────────┘
                                  │  review + merge
                                  ▼
                  ┌───────────────────────────────┐
                  │  Railway auto-deploys         │
                  └───────────────────────────────┘
```

## One-time setup

From `App/househelp-api/`:

```bash
# Enable the pre-push hook that blocks pushes to feature/sdui.
git config core.hooksPath .githooks

# Copy the env template and fill in real secrets.
cp .env.local.example .env.local
$EDITOR .env.local

# Drop your Firebase service-account JSON into secrets/ on the host.
# The path inside the container is /app/secrets/firebase-adminsdk.json,
# already set in .env.local.example.
mkdir -p secrets
cp /path/to/firebase-adminsdk.json secrets/firebase-adminsdk.json
```

Generate a real JWT secret instead of the placeholder:

```bash
openssl rand -base64 48
```

## Starting and stopping the stack

```bash
make up        # build images, start postgres+redis, run migrations, start backend
make logs      # tail backend logs
make ps        # show container status + healthcheck state
make migrate   # re-run pending migrations (after adding a new .up.sql)
make down      # stop everything (volumes preserved)
```

Backend is at `http://localhost:8080`. Health: `http://localhost:8080/health`.

**Migrations are not auto-run on boot** by `cmd/api` — this is a deliberate
policy (see comment at top of `cmd/migrate/main.go`). `make up` runs them as
an explicit step via the `migrate` service in `docker-compose.yml` (profile
`tools`, one-shot). After adding a new migration, run `make migrate`.

## Pointing your Expo app at it

Inside the iOS simulator or on a physical phone, `localhost` resolves to the
phone itself, not your laptop. You must use the laptop's LAN IP.

```bash
make lan-ip
# prints e.g. 192.168.1.42
```

Set your Expo client's API base URL to `http://192.168.1.42:8080`. Phone and
laptop must be on the same Wi-Fi network. If your LAN router does client
isolation, switch networks.

## Cutting a new feature branch

```bash
make new-feature name=helper-bonus
# equivalent to:
# git checkout feature/sdui && git pull && git checkout -b feature/helper-bonus
```

## Preflight (gate before opening a PR)

```bash
make preflight
```

The script:
1. Refuses to run if you're on `feature/sdui`.
2. Runs `go vet ./...`.
3. Runs `go test ./...`.
4. Builds and starts the full docker compose stack.
5. Waits for `/health` to return 200.
6. Asserts `/ready` is 200 and an auth-protected endpoint correctly rejects
   anonymous requests (401/403).
7. Tears the stack down.

If anything fails, the script exits non-zero. Don't open the PR until it
passes.

## Database housekeeping

```bash
make psql            # interactive psql shell into the local postgres
make redis-cli       # interactive redis-cli
make reset-db        # destroys the postgres volume after a yes/no prompt
```

After `make reset-db`, the volume is gone and the new postgres is empty.
Run `make migrate` to reapply all migrations before starting the backend, or
run `make up` which does both.

## Things that bite you

### 1. Postgres / PostGIS version drift
The local stack uses `postgis/postgis:16-3.4-alpine`. **Railway's version may
differ.** Before relying on local results, verify production:

- Railway dashboard → Postgres service → check the image tag, OR
- `railway run --service <pg> psql -c 'SELECT version(); SELECT
  PostGIS_Version();'`

If Railway is on a different major (e.g. 15 or 17), bump the local image to
match before you trust any extension- or planner-sensitive change.

### 2. Env var drift
`.env.local.example` was generated by grepping the codebase for `os.Getenv`
calls at a point in time. New code may add new vars. If a service crashes on
boot complaining about a missing env, regenerate the list:

```bash
grep -rEn 'os\.Getenv\(' --include='*.go' | grep -oE '"[A-Z_][A-Z0-9_]*"' | sort -u
```

…and add anything new to both `.env.local.example` and `.env.example`.

### 3. Firebase service-account path
Railway loads the service account from a path baked into its env. Locally the
file lives on the host at `App/househelp-api/secrets/firebase-adminsdk.json`
and is mounted read-only into the container at `/app/secrets/`. The path in
`.env.local.example` (`FIREBASE_CREDENTIALS_JSON`) reflects the **container**
path, not the host path. Don't paste your Railway value here.

### 4. FCM in dev vs prod
Dev push notifications go to whatever Firebase project the local service
account points at. **It is trivially easy to send a test push to production
devices** if you reuse the prod service account in local dev. Either use a
separate Firebase project for local, or accept that test pushes will reach
real users.

### 5. The big one: accidental push to `feature/sdui`
Railway deploys on every push. A `git push origin feature/sdui` from your
laptop while you have local changes uncommitted on top of a stale base is
catastrophic. Defences, in order:

- `git config core.hooksPath .githooks` (blocks the push locally)
- Don't `git checkout feature/sdui` to "just check something" — use a
  worktree or `git stash`
- Treat `feature/sdui` as receive-only: it only changes via PR merge

### 6. Cashfree webhooks won't reach localhost
`PUBLIC_BASE_URL` must be reachable from the public internet for Cashfree
webhooks to land. Use `ngrok http 8080` and paste the https URL into
`PUBLIC_BASE_URL` in `.env.local`. Restart the backend so it picks up the
change.

## Railway pre-deploy migrations

`railway.json` declares a `preDeployCommand` of `/usr/local/bin/migrate up`.
Railway runs that command on a single instance before booting `api`, so every
deploy applies pending migrations automatically.

Implications:

- **Migration files MUST be committed to `feature/sdui` before pushing code that
  depends on them.** If a migration is only on disk and the dependent code ships,
  Railway will boot the new api against an unmigrated DB and the new code will
  500. Stage migrations + code together in the same PR.
- **Down migrations are not run** — forward-only per `cmd/migrate/main.go:9`.
- **Local `make up` and `make migrate` keep working** — they go through the
  one-shot `migrate` compose service and ignore `railway.json` entirely.
- Older Railway projects may need `preDeployCommand` set in the dashboard
  (Service → Settings → Deploy) if they don't auto-pick up `railway.json`.
  Verify in the dashboard after the first deploy that uses this file.

## Rolling back a bad deploy

If something slips through preflight and breaks production:

1. Identify the merge commit on `feature/sdui` that introduced the regression:

   ```bash
   git log --oneline --first-parent feature/sdui | head -10
   ```

2. Revert it (creates a new commit; does not rewrite history):

   ```bash
   git checkout feature/sdui
   git pull --ff-only
   git revert -m 1 <merge-sha>
   git push origin feature/sdui
   ```

   The `-m 1` keeps the first parent (the previous deploy branch state).

3. Railway redeploys automatically on the new commit. Confirm via the Railway
   dashboard → Deployments tab.

4. If Railway didn't trigger (e.g. push happened before its hook reconnected),
   force a redeploy from the dashboard: select the latest commit → Redeploy.

5. Fix the bug on a fresh feature branch. Don't push the fix back to
   `feature/sdui` directly.

## File reference

| File                          | Purpose |
|-------------------------------|---------|
| `Dockerfile`                  | Multi-stage build for the Go API (pre-existing) |
| `docker-compose.yml`          | Backend + postgres + redis with healthchecks |
| `.env.local.example`          | Template for `.env.local`. Hostnames target compose service names |
| `.dockerignore`               | What's excluded from the image build context (pre-existing) |
| `Makefile`                    | Convenience targets for the local loop |
| `scripts/preflight.sh`        | PR gate. Runs vet, tests, stack, smoke |
| `.githooks/pre-push`          | Blocks accidental pushes to `feature/sdui` |
| `BACKEND_TESTING.md`          | This document |
