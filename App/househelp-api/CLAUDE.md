## Backend deploy gate

**`main` is the Railway-watched production branch.** Railway auto-deploys on every push/merge. NEVER:
- commit directly to `main`
- push directly to `main`
- merge to `main` without running `make preflight` first

**Branch flow: `feature/*` → `develop` → `main`.**

- Feature work always cuts from `develop` (never from `main`).
- PRs go to `develop` for integration / end-to-end testing.
- When `develop` is stable, merge `develop` → `main` — that's the prod deploy.
- **Never cut feature branches from `main`. Always from `develop`.**
- **Hotfix exception:** for a critical prod bug, cut from `main`, fix, then merge
  to **both** `main` and `develop` to keep them in sync.

`main` remains the production gate — Railway deploys it. `make preflight` still
gates every merge that lands on `main`.

> Switched from `feature/sdui` → `main` on 2026-05-15. Added `develop`
> integration tier on 2026-05-18. The old `feature/sdui` branch may still
> exist on origin but is no longer auto-deployed.

## Local testing

Full workflow is in `BACKEND_TESTING.md`. TL;DR:

```bash
make new-feature name=<thing>     # cut feature branch from develop
make up                           # build + start postgres+redis+backend, run migrations
make logs                         # tail backend
make preflight                    # vet + tests + compose + smoke (gate before PR)
```

Activate the pre-push hook once per clone:
```bash
git config core.hooksPath .githooks
```

## Things to remember when editing backend code

- **Migrations are not auto-run on boot** (see `cmd/migrate/main.go:13` for rationale). After adding a new `migrations/NNN_*.up.sql`, run `make migrate` locally before testing.
- **New `os.Getenv("FOO")` call?** Add `FOO=` to BOTH `.env.example` (real defaults) AND `.env.local.example` (compose-network defaults).
- **Compose service hostnames** — when running inside the `backend` container, postgres is at `postgres:5432`, redis at `redis:6379`. NOT localhost.
- **Firebase service-account** lives at `/app/secrets/firebase-adminsdk.json` inside the container (mounted ro from host `secrets/`).
- **Go toolchain** is `go1.26.3` (`go.mod` line 5). Dockerfile pins `golang:1.26-alpine` to match.
- **Health endpoints**: `/health` (no DB hit), `/ready` (pings DB + Redis). Auth-protected routes under `/api/v1/*`.

## Things NOT to do

- Don't change `Dockerfile` for local-dev concerns — use compose overrides instead. Prod image must stay clean.
- Don't add `HEALTHCHECK` to the Dockerfile — compose handles it for dev; Railway doesn't need it baked in.
- Don't bypass `make preflight` — the smoke test catches DB/Redis init failures `go test` won't.
- Don't write `.down.sql` migrations — repo policy is forward-only (see `cmd/migrate/main.go:9`).
