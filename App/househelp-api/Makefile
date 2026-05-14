# Local backend testing helpers.
# Run all targets from App/househelp-api/.

DEPLOY_BRANCH := feature/sdui
COMPOSE       := docker compose

.PHONY: help check-env up down restart migrate logs ps psql redis-cli reset-db lan-ip new-feature preflight test vet

help:
	@echo "Backend local testing targets:"
	@echo "  make up                       build + start full stack + run migrations"
	@echo "  make down                     stop stack (preserves volumes)"
	@echo "  make restart                  rebuild + restart backend only"
	@echo "  make migrate                  run pending DB migrations (cmd/migrate up)"
	@echo "  make logs                     tail backend logs"
	@echo "  make ps                       show container status + health"
	@echo "  make psql                     psql shell into postgres"
	@echo "  make redis-cli                redis-cli into redis"
	@echo "  make reset-db                 DROP postgres volume and recreate (asks first)"
	@echo "  make lan-ip                   print this machine's LAN IP for Expo client config"
	@echo "  make new-feature name=foo     cut feature/foo from $(DEPLOY_BRANCH)"
	@echo "  make preflight                run scripts/preflight.sh (gate before PR into $(DEPLOY_BRANCH))"
	@echo "  make vet                      go vet ./..."
	@echo "  make test                     go test ./..."

check-env:
	@if [ ! -f .env.local ]; then \
	  echo ".env.local is missing. Copy the template and fill it in:"; \
	  echo "    cp .env.local.example .env.local"; \
	  echo "    \$$EDITOR .env.local"; \
	  exit 1; \
	fi

up: check-env
	$(COMPOSE) up --build -d postgres redis
	@echo "==> waiting for postgres + redis healthchecks"
	@$(COMPOSE) ps
	$(COMPOSE) run --rm migrate up
	$(COMPOSE) up --build -d backend
	@echo "Stack up. Tail with: make logs"
	@echo "Backend reachable at http://localhost:8080/health once healthy."

migrate: check-env
	$(COMPOSE) run --rm migrate up

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) up -d --build backend
	@echo "Backend rebuilt. Tail with: make logs"

logs:
	$(COMPOSE) logs -f --tail=200 backend

ps:
	$(COMPOSE) ps

psql:
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-househelp} -d $${POSTGRES_DB:-househelp_db}

redis-cli:
	$(COMPOSE) exec redis redis-cli

reset-db:
	@printf 'This will DROP the postgres volume and ALL local data. Type "yes" to continue: '; \
	read ans; \
	if [ "$$ans" = "yes" ]; then \
	  $(COMPOSE) down -v; \
	  $(COMPOSE) up -d postgres redis; \
	  echo "Postgres and Redis recreated. Run 'make up' to start backend."; \
	else \
	  echo "Aborted."; \
	fi

lan-ip:
	@if command -v ipconfig >/dev/null 2>&1; then \
	  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "could not detect (try: ifconfig | grep 'inet ')"; \
	else \
	  ip route get 1 | awk '{print $$7; exit}'; \
	fi
	@echo ""
	@echo "Point your Expo app's API base URL at http://<that-ip>:8080"
	@echo "Do NOT use localhost — the simulator/device cannot reach your host that way."

new-feature:
ifndef name
	@echo "Usage: make new-feature name=<branch-suffix>"; exit 1
endif
	git checkout $(DEPLOY_BRANCH)
	git pull --ff-only
	git checkout -b feature/$(name)
	@echo "On feature/$(name). Build, test, then run 'make preflight' before opening a PR."

preflight:
	./scripts/preflight.sh

vet:
	go vet ./...

test:
	go test ./...
