#!/usr/bin/env bash
# Preflight gate before opening a PR into the Railway deploy branch.
# Refuses to run from the deploy branch itself.
set -euo pipefail

DEPLOY_BRANCH="${DEPLOY_BRANCH:-feature/sdui}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/health}"
COMPOSE="${COMPOSE:-docker compose}"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

cd "$(dirname "$0")/.."

# 1. Branch guard.
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" = "$DEPLOY_BRANCH" ]; then
  red "REFUSING TO RUN ON DEPLOY BRANCH ($DEPLOY_BRANCH)."
  red "Preflight is for feature branches only. Cut a feature branch first:"
  red "    git checkout -b feature/<name>"
  exit 1
fi
bold "==> branch: $current_branch (deploy branch is $DEPLOY_BRANCH)"

# 2. go vet.
bold "==> go vet ./..."
go vet ./...
green "    vet ok"

# 3. go test.
bold "==> go test ./..."
go test ./...
green "    tests ok"

# 4. Require .env.local.
if [ ! -f .env.local ]; then
  red ".env.local is missing — copy .env.local.example and fill it in."
  exit 1
fi

# 5. Spin up infra, run migrations, then backend.
bold "==> docker compose up -d postgres redis (build)"
$COMPOSE up -d --build postgres redis

cleanup() {
  bold "==> tearing down stack"
  $COMPOSE down
}
trap cleanup EXIT

bold "==> docker compose run --rm migrate up"
$COMPOSE run --rm migrate up

bold "==> docker compose up -d backend (build)"
$COMPOSE up -d --build backend

# 6. Wait for backend health.
bold "==> waiting for $HEALTH_URL"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS -o /dev/null "$HEALTH_URL"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    red "    backend did not become healthy within 120s"
    $COMPOSE logs --tail=100 backend || true
    exit 1
  fi
  sleep 2
done
green "    backend healthy"

# 7. Smoke endpoints.
bold "==> smoke: GET $HEALTH_URL"
code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL")"
if [ "$code" != "200" ]; then red "    /health returned $code"; exit 1; fi
green "    /health 200"

bold "==> smoke: GET /ready"
ready_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8080/ready" || echo 000)"
if [ "$ready_code" != "200" ]; then red "    /ready returned $ready_code"; exit 1; fi
green "    /ready 200"

bold "==> smoke: auth-required endpoint must reject unauthenticated requests"
# Hit a JWT-protected route under /api/v1 — expect 401/403, NOT 500.
auth_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8080/api/v1/me" || echo 000)"
case "$auth_code" in
  401|403) green "    unauthenticated request correctly rejected ($auth_code)" ;;
  404)     yellow "    /api/v1/me 404 — route path may have changed; update preflight" ;;
  *)       red   "    expected 401/403 for unauthenticated request, got $auth_code"; exit 1 ;;
esac

echo
green "PASS  Preflight passed. Safe to open PR into $DEPLOY_BRANCH."
