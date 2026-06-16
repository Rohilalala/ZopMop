# ZopMop CRM — Manual Test Plan

> Auto-generated 2026-06-14 from a full read of every CRM page, API module, and Go handler. **491 flows** across **18 domains**. Internal ops CRM (React+Vite SPA on :5174 → crm-api on :8090). CRM is NOT deployed to prod.

## Contents
1. [How to run the stack locally](#1-how-to-run-the-stack-locally)
2. [Testing method](#2-testing-method)
3. [Test flows by domain](#3-test-flows-by-domain)

## 1. How to run the stack locally

### Bring-up steps
1. cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api
2. Ensure compose env file exists: cp .env.local.example .env.local (then edit per env-vars below). .env.local is consumed by every compose service via env_file.
3. Start ONLY datastores via compose (crm-api is run natively, not in compose): docker compose up -d postgres redis
4. Wait for both healthchecks to pass: docker compose ps  (postgres + redis must show 'healthy'; postgis image start_period is 30s)
5. Run DB migrations through the one-shot migrate service (migrations are NOT auto-run on boot): docker compose run --rm migrate up
6. Because docker-compose.override.yml publishes host ports 5433->postgres and 6380->redis (host 5432/6380 are taken by another project), a natively-run crm-api must point at THOSE host ports, not 5432/6379.
7. Create a CRM-only env file for the native binary at App/househelp-api/.env.crm (godotenv loads ./.env from the binary's CWD; using a dedicated file avoids clobbering the user-api .env). Put DATABASE_URL/REDIS_URL/CRM_* from the env-vars section into it.
8. Build the crm-api binary: go build -o ./crm-api ./cmd/crm-api/  (Go toolchain is go1.25.0 per go.mod)
9. Seed the first admin BEFORE starting crm-api or at least before first login — see seedData section (generate bcrypt hash via the bootstrap helper, then INSERT into crm_admins).
10. Start crm-api on :8090 loading the CRM env: env $(grep -v '^#' .env.crm | xargs) ./crm-api    OR simpler: cp .env.crm .env && ./crm-api    (it will log '[crm] server starting addr=:8090')
11. Smoke the API directly (see smokeChecks) before touching the SPA: curl -s http://localhost:8090/health and curl -s http://localhost:8090/ready
12. Set up the CRM SPA env: cd /Users/adityarohilla/Documents/ZopMop/App/zopmop-crm ; cp .env.example .env ; then OPEN .env and COMMENT OUT / REMOVE the VITE_CRM_API_URL line (see gotchas) so the SPA uses the same-origin vite proxy. The proxy in vite.config.ts forwards /admin/* to VITE_CRM_API_URL or, if unset there, to http://localhost:8091 — so ALSO export VITE_CRM_API_URL=http://localhost:8090 for the vite process ONLY (proxy target), not as a value the browser bundle reads. Cleanest: in .env set nothing for VITE_CRM_API_URL and instead start vite with the proxy target inline (next step).
13. Install SPA deps (Node v26 present): cd /Users/adityarohilla/Documents/ZopMop/App/zopmop-crm && npm install
14. Start the SPA with the proxy pointed at the native crm-api on 8090, while keeping the browser baseURL empty so cookies stay same-origin: cd /Users/adityarohilla/Documents/ZopMop/App/zopmop-crm && VITE_CRM_API_URL=http://localhost:8090 npm run dev  -- but ONLY if .env does NOT also define VITE_CRM_API_URL (env var sets BOTH the proxy target AND import.meta.env). To guarantee same-origin cookies, instead leave VITE_CRM_API_URL unset everywhere and edit vite.config.ts apiTarget fallback to 8090, OR run crm-api on 8091 to match the vite default. RECOMMENDED simplest path: run crm-api on CRM_API_PORT=8091 and start the SPA with a plain `npm run dev` (no env), letting the vite proxy default (http://localhost:8091) work and baseURL stay ''.
15. Open http://localhost:5174 in the browser. Log in with the seeded admin email + password.
16. First login returns otpauth_url (TOTP NOT yet enrolled). The SPA renders a QR code — scan it with Google Authenticator, OR compute a code from the secret manually (see seedData). Enter the 6-digit code at the TOTP step to complete enrolment and get the access token + HttpOnly refresh cookie. Subsequent logins skip the QR and just ask for the current 6-digit code.

### Required env (crm-api process)
| Var | Value | Why |
|---|---|---|
| `ENV` | development | crmconfig defaults ENV to 'production' (NOT development). In production mode a weak/short CRM_JWT_SECRET is fail-closed and the recover middleware hides stack traces. Set development so weak secrets warn instead of abort and you get readable panics. Required in the crm-api process env. |
| `DATABASE_URL` | postgres://househelp:localdev123@localhost:5433/househelp_db?sslmode=disable | crm-api shares the user-app schema. Native (non-docker) crm-api must use the HOST-published port 5433 (docker-compose.override.yml maps 5433->postgres:5432; host 5432 is taken by another project). Inside compose it would be postgres:5432, but you are running crm-api natively. |
| `REDIS_URL` | redis://localhost:6380 | Shared Redis for rate-limit buckets + CRM namespaced state. Override publishes redis on host 6380 (host 6379... note override maps 6380->6379). Native crm-api connects to localhost:6380. |
| `CRM_JWT_SECRET` | $(openssl rand -base64 64 | tr -d '\n')  -> use the produced ~88-char string, e.g. 'k7Qe2...64+chars...zX9' | Required. Must be >=64 chars, visible ASCII only, >=10 unique chars, and MUST differ from JWT_SECRET (validate() rejects equality outright, even in dev). Must not contain blocked substrings (changeme, mysecret, jwtsecret, default-secret, etc.). openssl rand -base64 64 satisfies all rules. |
| `JWT_SECRET` | (any value DIFFERENT from CRM_JWT_SECRET; e.g. openssl rand -base64 48). Can be left unset entirely. | crmconfig compares CRM_JWT_SECRET against os.Getenv("JWT_SECRET") and fails if equal. If JWT_SECRET is unset it is empty-string and the comparison passes (as long as CRM_JWT_SECRET is non-empty). Only set it if your env already exports it; just ensure it never equals CRM_JWT_SECRET. |
| `CRM_API_PORT` | 8090 | Listen port the README + SPA .env.example assume. crmconfig default is 8090. NOTE: docker-compose's crm-api service and the vite proxy DEFAULT both use 8091 — pick one consistently (see gotchas). For the README/SPA-documented flow, use 8090 and point the vite proxy at 8090. |
| `CRM_REFRESH_COOKIE_SECURE` | false | Default is true. Over local http:// a Secure cookie is dropped by the browser, so the refresh cookie never persists and you get logged out on every reload. Must be false for local http dev. |
| `CRM_REFRESH_COOKIE_DOMAIN` | (leave empty / unset) | Empty domain => host-only cookie for localhost, which is what you want. Do NOT set 'localhost' explicitly with a leading dot or a non-matching domain or the cookie won't be sent. The compose .env.local.example sets it to 'localhost' which is harmless for the SPA-on-localhost case but unnecessary. |
| `CRM_ALLOWED_ORIGINS` | http://localhost:5174 | CORS allow-list. Strictly only needed if the browser talks cross-origin to crm-api. In the recommended same-origin-proxy setup the browser only ever hits localhost:5174 (vite), so CORS is not exercised — but set it to the SPA origin anyway so a direct/cross-origin fallback still works. |
| `CRM_LOCKOUT_THRESHOLD` | 1000 | Optional but recommended for testing. Default is 5 failed logins -> 15-min lockout. A high threshold stops you locking yourself out while fumbling the TOTP code. (docker-compose.override.yml already does this for the compose crm-api; replicate it for the native binary.) |
| `CRM_LOGIN_RATELIMIT_MAX` | 1000 | Optional. Default 5 login attempts / 15 min per IP returns 429 quickly during manual testing. Raise it locally. The override file sets this for the compose service; set it on the native binary too. |
| `CRM_DATABASE_READ_URL` | (leave empty) | Falls back to DATABASE_URL when unset, which is correct for local single-instance Postgres. Analytics/dashboard read queries then hit the same DB. |
| `APP_API_URL` | http://localhost:8080 | Optional. Used only by the CRM dashboard health strip to probe the user-facing API. Empty => probe returns 'unknown'. Set it if you also run cmd/api locally and want the health widget green. |

### Seed data (first admin / TOTP)
- Migrations 039_crm_core.up.sql creates crm_admins (empty). Columns: id uuid (gen_random_uuid), email CITEXT UNIQUE, password_hash TEXT, display_name TEXT, avatar_url, role CHECK(superadmin|admin|support|viewer) default 'admin', permissions JSONB default '[]', totp_secret, totp_enrolled_at, failed_login_count, locked_until, last_login_at, is_active default TRUE. There is NO seed row; you must insert the first admin by hand.
- Generate the bcrypt hash + SQL with the bootstrap helper (bcrypt cost 12; password must be >=12 chars): cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api && go run ./cmd/crm-api/bootstrap -email you@zopmop.com -name 'You' -password 'somethingStrong12' -role superadmin   -> prints an INSERT statement to stdout.
- Pipe that INSERT into the running Postgres. Through compose: go run ./cmd/crm-api/bootstrap -email you@zopmop.com -name 'You' -password 'somethingStrong12' | docker compose exec -T postgres psql -U househelp -d househelp_db   (or use `make psql`).
- Equivalent raw SQL if you generate the hash yourself: INSERT INTO crm_admins (email, password_hash, display_name, role, permissions, is_active) VALUES ('you@zopmop.com', '<bcrypt-cost-12-hash>', 'You', 'superadmin', '["*"]'::jsonb, TRUE);
- TOTP CANNOT be skipped — there is no dev-bypass flag in the CRM auth code (OTP_DEV_MODE / '999999' applies ONLY to the customer phone-OTP gateway, not CRM TOTP). The first login response (POST /admin/auth/login) returns otpauth_url because totp_enrolled_at is NULL; the SPA shows a QR. Scan it in Google Authenticator (SHA1, 6 digits, 30s period, issuer 'Zopmop CRM') then enter the 6-digit code to finish enrolment.
- To get a code WITHOUT a phone: after the first login call has run once (it persists a generated secret), read the secret and compute the code locally. Read it: docker compose exec -T postgres psql -U househelp -d househelp_db -tAc "SELECT totp_secret FROM crm_admins WHERE email='you@zopmop.com';"  -> returns the base32 secret.
- Compute the current 6-digit TOTP from that base32 secret with Python stdlib (no pyotp needed): python3 -c "import base64,hmac,hashlib,struct,time; s='PASTE_BASE32_SECRET'; k=base64.b32decode(s+'='*((8-len(s)%8)%8)); c=struct.pack('>Q',int(time.time())//30); h=hmac.new(k,c,hashlib.sha1).digest(); o=h[19]&0xf; print('%06d'%((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000))"  -> enter that 6-digit code at the TOTP step (valid for ~30s, +-1 period skew allowed).
- Note: the secret only exists AFTER the first POST /admin/auth/login (it is generated and stored at that point). So the order is: log in once (password) -> secret now in DB -> read it -> compute code -> submit code. The SPA does the login call for you when you submit email+password, so just read+compute between the password step and the TOTP step.

### Gotchas that break bring-up
- ⚠️ PORT MISMATCH (the big one): README/crmconfig default + SPA .env.example say crm-api=8090, but docker-compose.yml runs crm-api on 8091 AND vite.config.ts proxy fallback target is http://localhost:8091. If you run the native binary on 8090 but start vite with no VITE_CRM_API_URL, the proxy points at 8091 and every /admin call 502s. Fix: either run crm-api on CRM_API_PORT=8091 (matches vite default, simplest) OR start vite with VITE_CRM_API_URL=http://localhost:8090 so the proxy targets 8090.
- ⚠️ SAME-ORIGIN COOKIE TRAP: src/api/client.ts sets baseURL = import.meta.env.VITE_CRM_API_URL ?? ''. The SPA .env.example sets VITE_CRM_API_URL=http://localhost:8090. If that var is present in the SPA .env, the BROWSER bundle reads it and calls crm-api cross-origin (5174 -> 8090), and the refresh cookie is SameSite=Strict so it is NOT sent cross-site -> infinite login loop. For local dev leave VITE_CRM_API_URL OUT of the SPA .env (baseURL='') so all /admin calls go through the vite same-origin proxy. The same env var ALSO controls the proxy target in vite.config.ts, so set it ONLY as a shell var for the vite process if you need to retarget the proxy, never in .env.
- ⚠️ crm-api is NOT started by `make up` or `docker compose up` by default reasoning — it has no host-network advantage when native. The native binary must use HOST ports 5433 (pg) and 6380 (redis) from docker-compose.override.yml, NOT 5432/6379, because another project already holds 5432/6379 on this machine.
- ⚠️ ENV defaults to 'production' in crmconfig (not 'development'). Forgetting ENV=development makes a too-short or reused CRM_JWT_SECRET fail-closed at startup ('CRM_JWT_SECRET must be at least 64 characters' / blocked-value errors) instead of warning.
- ⚠️ CRM_JWT_SECRET == JWT_SECRET aborts startup unconditionally (even in dev). If your shell already exports JWT_SECRET for cmd/api, make sure the CRM secret is different. Also ensure no leading/trailing whitespace and visible-ASCII only (base64 output is fine).
- ⚠️ Migrations are forward-only and NOT auto-run on boot. A fresh DB without `docker compose run --rm migrate up` has no crm_admins table -> crm-api boots but every login 500s. Run migrate first.
- ⚠️ godotenv loads ./.env relative to the crm-api process CWD. If you keep both the user-api .env and a CRM .env in the repo root, the binary will pick up whichever is named .env — keep CRM vars in their own file and either copy to .env before running or inject via env so you don't accidentally load user-api JWT_SECRET that collides.
- ⚠️ Login rate limit (default 5 / 15min per IP) and lockout (default 5 fails -> 15min) will bite during manual TOTP fumbling. Raise CRM_LOCKOUT_THRESHOLD and CRM_LOGIN_RATELIMIT_MAX for the native binary (the override file only relaxes these for the COMPOSE crm-api, which you are not using).
- ⚠️ TOTP secret is generated lazily on the FIRST /admin/auth/login, not at seed time. You cannot precompute a code before that first login call runs. Read totp_secret only after the password step has executed once.
- ⚠️ Rate-limit middleware is fail-closed when Redis is unreachable: if REDIS_URL is wrong/down, /login returns 429/500, not a clear 'redis down' message. Verify /ready returns redis-ok first.

### Smoke checks (run before testing)
- [ ] docker compose ps -> postgres AND redis both show 'healthy' (postgis start_period is 30s, give it time).
- [ ] Migrations applied: docker compose exec -T postgres psql -U househelp -d househelp_db -tAc "SELECT to_regclass('public.crm_admins');" -> returns 'crm_admins' (not blank).
- [ ] Admin row exists: docker compose exec -T postgres psql -U househelp -d househelp_db -tAc "SELECT email, role, is_active FROM crm_admins;" -> shows your seeded superadmin, is_active=t.
- [ ] crm-api liveness: curl -s http://localhost:8090/health -> {"status":"ok","service":"crm-api"} (use 8091 if you chose that port).
- [ ] crm-api readiness (pings DB + Redis): curl -s http://localhost:8090/ready -> {"status":"ready"}. If it returns db_unreachable or redis_unreachable, fix DATABASE_URL/REDIS_URL host ports (5433/6380) before going further.
- [ ] Login endpoint reachable + returns a challenge: curl -s -X POST http://localhost:8090/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"you@zopmop.com","password":"somethingStrong12"}' -> JSON with challenge_token and (first time) otpauth_url + totp_enrolled:false. A 401 means bad creds/no admin row; 500 means missing migration.
- [ ] SPA dev server up: curl -s -o /dev/null -w '%{http_code}' http://localhost:5174 -> 200, and the page loads at http://localhost:5174.
- [ ] Proxy wiring (same-origin path): curl -s -X POST http://localhost:5174/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"you@zopmop.com","password":"somethingStrong12"}' -> SAME JSON as hitting crm-api directly. If this 502s, the vite proxy target port is wrong (8090 vs 8091).
- [ ] End-to-end auth: complete the QR/TOTP step in the browser, then confirm GET (DevTools) /admin/auth/me returns your admin and that a 'crm_refresh_token' cookie was set (Application -> Cookies, localhost:5174). If the cookie is missing, CRM_REFRESH_COOKIE_SECURE is not false or you are on a cross-origin baseURL.

## 2. Testing method

**Roles:** create at least 3 CRM admins at different roles (e.g. `viewer`, `support`/`ops`, `admin`/`superadmin`) so RBAC flows are runnable. Each `rbac` flow expects a lower role to be blocked with a 403 `insufficient_permissions` toast naming required vs your role.

**Order of execution:**
1. Run all **P0** flows first (auth, money, state-machine, data-loss). A P0 failure blocks release.
2. Then **P1**, then **P2**.
3. Within a domain run `happy` → `edge`/`negative` → `rbac` → `money`/`concurrency`/`idempotency`.

**For each flow log:** flow id, role used, PASS/FAIL, actual vs expected, screenshot/Network capture on FAIL, and the audit-log row id if the action is a write (every CRM write must appear on `/audit`).

**Concurrency flows:** reproduce with two browser tabs (or two `curl` posts) firing the same mutation as simultaneously as possible — the SPA `isPending` button-disable hides most single-tab races, so the real test is two clients.

**Flow kinds:** `happy` · `edge` · `negative` · `rbac` · `money` · `concurrency` · `idempotency`

## 3. Test flows by domain

### auth-rbac  <sub>(30 flows — P0:19 P1:8 P2:3)</sub>

CRM admin authentication and RBAC. Two-step login (email+password to a 5-min challenge JWT, then 6-digit TOTP) yields an in-memory access token (4h) plus an HttpOnly SameSite=Strict refresh cookie (30d). Account locks after 5 failed attempts for 15 min; a separate per-IP login limiter caps /login + /totp/verify at 5/15min. The SPA does silent single-flight refresh (proactive on near-expiry + reactive on 401 with one retry), handles the multi-tab 409 rotation race, and uses a logout epoch so an in-flight refresh started just before sign-out is discarded. RBAC is role-rank based (viewer<support<admin<superadmin) enforced server-side by RequirePermission/RequireRole and mirrored client-side by Can/usePermission. Sessions can be listed and individually revoked.

**Pages:** `/login` · `/sessions` · `(global) src/api/client.ts` · `(global) src/App.tsx` · `(global) src/components/shell/Topbar.tsx` · `(global) src/store/auth.ts` · `(global) src/auth/Can.tsx + usePermission.ts + permissions.ts`

**Test data:** crm_admins row: superadmin (is_active=true, totp_enrolled_at set, known totp_secret, bcrypt password) — full-access baseline.; crm_admins row: admin role (is_active=true, enrolled) — for superadmin-gate denial tests (AUTH-22).; crm_admins row: support role (is_active=true, enrolled) — for admin-gate denial + refunds full/partial split (AUTH-21, AUTH-24).; crm_admins row: viewer role (is_active=true, enrolled) — for read-only / sensitive-read denial tests (AUTH-23).; crm_admins row: fresh admin with totp_enrolled_at NULL and totp_secret NULL — for first-time QR enrolment (AUTH-01).; crm_admins row: is_active=false — for inactive-login test (AUTH-27).; A way to compute current TOTP codes from a known secret (Google Authenticator or oathtool) for the enrolled accounts.; Known bcrypt password hashes for each seeded admin (or a seed script that sets them).; At least 2 concurrent browser sessions for the same admin (for sessions list/revoke and multi-tab race AUTH-13/16/17).; DB access to crm_admin_sessions, crm_admins (locked_until, failed_login_count), crm_login_attempts, and audit_logs to assert side effects.; Redis running (rate limiters are fail-closed; if Redis is down, /login and authed routes will 429/fail).; Env for local: CRM_REFRESH_COOKIE_SECURE=false; optionally raise CRM_LOGIN_RATELIMIT_MAX and lower CRM_ACCESS_TOKEN_TTL_MINUTES to exercise refresh/lockout flows quickly.; A second admin (admin B) plus knowledge of B's session id for the IDOR revoke test (AUTH-19).; Seeded refund rows (one eligible for full, one for partial) and a suspendable user/order for RBAC write tests (AUTH-21/23/24).

#### `AUTH-01` Happy path: login + first-time TOTP enrolment  — **P0** · _happy_
- **Pre:** A seeded crm_admins row that is_active=true, totp_enrolled_at IS NULL, totp_secret NULL, known password. Backend env CRM_REFRESH_COOKIE_SECURE=false for local HTTP. Browser at http://localhost:5174.
- **Steps:**
  1. Open http://localhost:5174 -> redirected to /login
  2. In Email field type the admin email, in Password field type the correct password
  3. Click 'Continue'
  4. On the TOTP step, a QR code + otpauth URL is shown (first-time enrolment); scan it into Google Authenticator (or compute the current code from the otpauth secret)
  5. Type the current 6-digit code into the code field (auto-submits at 6 digits)
- **API:** `POST /admin/auth/login`, `POST /admin/auth/totp/verify`
- **Expect:** Login returns 200 with challenge_token + otpauth_url + totp_enrolled=false. totp/verify returns 200 with access_token, expires_at, admin; Set-Cookie crm_refresh_token (HttpOnly, SameSite=Strict). SPA navigates to / (Dashboard). DB: crm_admins.totp_enrolled_at now set, failed_login_count=0; one crm_admin_sessions row created; crm_login_attempts has password_ok_pending_totp then ok; audit_logs has auth.login.

#### `AUTH-02` Happy path: returning login (TOTP already enrolled, no QR)  — **P0** · _happy_
- **Pre:** Admin with totp_enrolled_at set and a known totp_secret. CRM_REFRESH_COOKIE_SECURE=false locally.
- **Steps:**
  1. Go to /login
  2. Enter email + correct password, click 'Continue'
  3. Confirm NO QR code is shown (only the code input)
  4. Enter the current 6-digit TOTP code
- **API:** `POST /admin/auth/login`, `POST /admin/auth/totp/verify`
- **Expect:** login returns totp_enrolled=true and NO otpauth_url; QR block is absent. totp/verify succeeds, lands on Dashboard. A new session row appears.

#### `AUTH-03` Invalid password surfaces error + shake, no lockout yet  — **P0** · _negative_
- **Pre:** Valid active admin email; wrong password. Fresh IP (no prior failures this 15-min window).
- **Steps:**
  1. Go to /login
  2. Enter valid email + WRONG password
  3. Click 'Continue'
- **API:** `POST /admin/auth/login`
- **Expect:** 401, inline red text 'invalid credentials', form shakes, stays on creds step. DB: failed_login_count incremented by 1, crm_login_attempts reason=bad_password success=false. No challenge issued.

#### `AUTH-04` Account lockout after 5 failed password attempts (423)  — **P0** · _edge_
- **Pre:** Valid active admin. CRM_LOCKOUT_THRESHOLD=5, CRM_LOCKOUT_DURATION_MINUTES=15. IMPORTANT: per-IP login limiter is ALSO 5/15min, so the 5th attempt may 429 before 423 — to observe 423 cleanly, raise CRM_LOGIN_RATELIMIT_MAX or run attempts from different IPs, or assert the account is locked on a subsequent attempt.
- **Steps:**
  1. Go to /login
  2. Submit valid email + wrong password 5 times (clicking 'Continue' each time)
  3. Attempt a 6th login with the CORRECT password
- **API:** `POST /admin/auth/login (x6)`
- **Expect:** After 5 failures DB locked_until is set ~15min in the future. The next login (even with correct password) returns 423; UI shows 'account locked — try again later'. crm_login_attempts has reason=locked. The lock check happens BEFORE bcrypt.

#### `AUTH-05` Login rate-limit 429 (per-IP, 5/15min) on /login  — **P0** · _negative_
- **Pre:** CRM_LOGIN_RATELIMIT_MAX=5, window 15min, Redis up. Use a non-existent email so account-lockout does not also fire (no admin row to lock).
- **Steps:**
  1. Go to /login
  2. Submit a NON-EXISTENT email + any password 6 times rapidly
- **API:** `POST /admin/auth/login (x6)`
- **Expect:** First 5 return 401 invalid credentials; the 6th returns 429 (limiter fail-closed, headers suppressed). UI shows a generic error toast / 'invalid credentials' (status!==423). audit_logs has ratelimit.exceeded with target_type=ip. Limiter must trip BEFORE bcrypt.

#### `AUTH-08` Silent proactive refresh near access-token expiry (no 401)  — **P0** · _happy_
- **Pre:** Logged-in admin. To observe quickly, set CRM_ACCESS_TOKEN_TTL_MINUTES low (e.g. 2) so the 60s skew window is reached fast.
- **Steps:**
  1. Log in
  2. Wait until current time is within 60s of access-token expiry (or just keep navigating)
  3. Navigate to any authed page (e.g. click Active Sessions) to fire a request
- **API:** `POST /admin/auth/refresh`, `GET /admin/auth/sessions`
- **Expect:** On the next request a single POST /admin/auth/refresh fires BEFORE the protected request (request interceptor), mints a new access token + rotates the cookie, the protected request succeeds with the new bearer. No 401 occurs; UI does not flash /login.

#### `AUTH-09` Reactive 401 -> silent refresh -> single retry succeeds  — **P0** · _happy_
- **Pre:** Logged-in admin whose in-memory access token is expired but whose refresh cookie is still valid (e.g. hard-reload the SPA after the access token TTL passed, OR clear the in-memory token).
- **Steps:**
  1. Reload the SPA after access token has expired (memory token gone; bootstrapAuth runs)
  2. OR trigger a protected request whose bearer is stale
  3. Observe network: the protected request 401s once, then a /refresh, then the request retried
- **API:** `POST /admin/auth/refresh`, `GET /admin/auth/sessions (or any authed GET)`
- **Expect:** The 401 is caught, silentRefresh runs once (original._retry guards against loops), new token attached, original request replayed and returns 200. No visible error to the user. On full reload, bootstrapAuth's refresh hydrates the store from the refresh response (admin object included).

#### `AUTH-10` Single-flight: concurrent 401s share ONE refresh call  — **P0** · _concurrency_
- **Pre:** Logged-in admin with an expired in-memory access token but valid cookie. A page that fires several authed requests at once (e.g. Dashboard, or open Notifications + navigate).
- **Steps:**
  1. Force the in-memory access token to be expired (reload right at expiry, or several queries fire together)
  2. Trigger multiple authed requests simultaneously (e.g. land on Dashboard which fans out queries)
  3. Inspect Network tab
- **API:** `POST /admin/auth/refresh (expect exactly 1)`, `multiple GET /admin/...`
- **Expect:** Exactly ONE POST /admin/auth/refresh is sent even though multiple requests 401 / need refresh concurrently (refreshInFlight dedupe). All in-flight requests then succeed with the single new token. No burst of /refresh hitting the refresh limiter.

#### `AUTH-11` Refresh failure (401/403 cookie invalid) evicts to /login  — **P0** · _negative_
- **Pre:** Logged-in admin. Invalidate the refresh cookie server-side (revoke the session via Sessions page from another device, or DB-set revoked_at), so the next /refresh returns 401.
- **Steps:**
  1. From another browser/session revoke this device's session OR mark the session revoked in DB
  2. Back in the target tab, wait for / trigger a request that needs refresh (or reload)
- **API:** `POST /admin/auth/refresh`, `any authed request`
- **Expect:** /refresh returns 401 'session expired'; client calls useAuth.clear(); the SPA routes to /login. The refresh cookie is cleared server-side (clearRefreshCookie). No infinite retry loop.

#### `AUTH-12` Refresh 429 / 5xx does NOT log the user out (fail-soft)  — **P0** · _edge_
- **Pre:** Logged-in admin. Make /refresh return 429 (hammer the refresh limiter past 60/min) or 5xx, while the access token is near expiry.
- **Steps:**
  1. Drive >60 /refresh calls in a minute from this IP (or otherwise force 429/5xx on /refresh)
  2. Trigger a request that needs refresh
- **API:** `POST /admin/auth/refresh (429/5xx)`
- **Expect:** silentRefresh retries with exponential backoff (2s,4s,8s) on 429/5xx/network and NEVER clears the session. After retries exhaust it returns null and the caller fails soft; the user stays logged in and a subsequent request recovers. Verify the store is NOT cleared and the user is not bounced to /login.

#### `AUTH-13` Multi-tab refresh race returns 409 and both tabs stay logged in  — **P0** · _concurrency_
- **Pre:** Same admin logged in in two browser tabs sharing the refresh cookie. Force both tabs to refresh at nearly the same instant (e.g. both near access-token expiry; reload both).
- **Steps:**
  1. Open the CRM in two tabs, logged in as the same admin
  2. Bring access tokens of both tabs near expiry
  3. Reload / trigger refresh in both tabs simultaneously
- **API:** `POST /admin/auth/refresh (two near-simultaneous)`
- **Expect:** One tab wins the rotation (200, fresh cookie); the loser gets 409 rotation_race. The client retries the 409 once after 500ms, picks up the freshly-rotated cookie, and succeeds (or fails soft and recovers on the next request). NEITHER tab is logged out. Within the 5s grace window the loser is treated as a benign race, not replay; the family is NOT revoked.

#### `AUTH-14` Refresh-token replay outside grace window kills the session family  — **P0** · _negative_
- **Pre:** Ability to capture a refresh-token plaintext (DB access: read crm_admin_sessions, or intercept). Refresh once so the captured token becomes rotated_at, then wait > RefreshGraceWindow (default 5s).
- **Steps:**
  1. Capture the current refresh cookie value for a session
  2. Trigger a legitimate refresh (rotates the token; old hash now has rotated_at)
  3. Wait more than 5 seconds
  4. Replay the OLD captured refresh token to POST /admin/auth/refresh (e.g. via curl with that cookie)
- **API:** `POST /admin/auth/refresh (replayed old token)`
- **Expect:** Returns 401 'session expired'. handleReplay revokes the ENTIRE family (all live rows for family_id get revoked_at + replay_detected_at) and writes an audit_logs row action=auth.session_replay_detected with before/after JSON. The legitimate device is now also logged out on its next request (family killed) — confirm it lands on /login.

#### `AUTH-15` Logout: epoch discards an in-flight refresh, cookie cleared  — **P0** · _happy_
- **Pre:** Logged-in admin. To exercise the epoch race, trigger a refresh and click Sign Out almost simultaneously (or just verify normal logout clears state).
- **Steps:**
  1. Click the admin avatar (top-right), then 'Sign Out'
  2. (Race variant) Just before signing out, trigger a request that starts a /refresh, then immediately click Sign Out
- **API:** `POST /admin/auth/logout`, `POST /admin/auth/refresh (race variant)`
- **Expect:** markLoggedOut bumps logoutEpoch; POST /admin/auth/logout returns {ok:true} and clears crm_refresh_token cookie (server) + clears the store; navigates to /login. If a /refresh resolved after logout, its result is discarded (logoutEpoch != startedEpoch) so the user is NOT silently re-authenticated. DB: the session's revoked_at is set.

#### `AUTH-16` Sessions list happy path + current-session marking  — **P0** · _happy_
- **Pre:** Admin logged in on >=2 devices/browsers (so multiple active session rows exist).
- **Steps:**
  1. Log in on a second browser to create a second session
  2. On the first browser open the admin menu -> 'Active Sessions' (/sessions)
- **API:** `GET /admin/auth/sessions`
- **Expect:** 200 with a list of active sessions (UA, IP, last-used localized). Exactly the session bound to the current access token shows the green 'current' pill and a disabled revoke (Trash2) button. Rotated/revoked/expired legs are NOT listed.

#### `AUTH-17` Revoke another session (confirm modal) immediately invalidates it  — **P0** · _happy_
- **Pre:** Two active sessions (two browsers) for the same admin.
- **Steps:**
  1. On browser A open /sessions
  2. Click the Trash2 revoke button on browser B's session row
  3. In the ConfirmModal click 'Revoke'
  4. Switch to browser B and trigger any authed request / reload
- **API:** `DELETE /admin/auth/sessions/{id}`, `GET /admin/auth/sessions (invalidated refetch)`
- **Expect:** DELETE returns {ok:true}; success toast 'Session revoked.'; the list refetches and the row disappears. audit_logs has auth.revoke_session. On browser B the next request 401s, /refresh returns 401 (cookie session revoked), and B is bounced to /login.

#### `AUTH-19` Revoke nonexistent / non-owned session -> 404, IDOR-safe  — **P0** · _negative_
- **Pre:** Two admins (A and B). Obtain a session id belonging to admin B. Log in as admin A.
- **Steps:**
  1. As admin A, call DELETE /admin/auth/sessions/{B's session id} (or a random UUID) directly (curl with A's bearer)
- **API:** `DELETE /admin/auth/sessions/{foreign-or-fake-id}`
- **Expect:** 404 'session not found' (RevokeSession only revokes rows belonging to the caller; a foreign id is indistinguishable from missing). B's session remains active. No information leak about whether the id exists.

#### `AUTH-21` RBAC: lower-role admin blocked on an admin-gated write (insufficient_permissions toast)  — **P0** · _rbac_
- **Pre:** A 'support'-role admin logged in. A route gated by an admin-min permission, e.g. POST /admin/users/{id}/suspend (users.suspend = admin) or PUT /admin/promos (promos.update = admin).
- **Steps:**
  1. Log in as a support-role admin
  2. Navigate to a page exposing an admin-only action (Users/Promos)
  3. Note that Can-gated buttons may be hidden client-side; to test the server gate, call the admin-gated endpoint directly with the support bearer (curl)
- **API:** `POST /admin/users/{id}/suspend (users.suspend, requires admin)`
- **Expect:** 403 with body {error:'insufficient_permissions', required_role:'admin', your_role:'support'}. The axios interceptor surfaces the precise toast 'Insufficient permissions. Requires admin; you are support.' and does NOT show the generic toast. Required role = admin; insufficient = support/viewer.

#### `AUTH-22` RBAC: superadmin-only route blocked for admin  — **P0** · _rbac_
- **Pre:** An 'admin'-role admin logged in. A superadmin-gated route, e.g. PUT /admin/flags/{key} (flags.update = superadmin) or webhooks.create.
- **Steps:**
  1. Log in as an admin-role user
  2. Directly call PUT /admin/flags/{key} (or POST /admin/webhooks) with the admin bearer
- **API:** `PUT /admin/flags/{key} (flags.update, requires superadmin)`
- **Expect:** 403 insufficient_permissions, required_role=superadmin, your_role=admin. Toast surfaces 'Requires superadmin; you are admin'. Confirm a superadmin succeeds on the same route.

#### `AUTH-26` Local dev cookie: Secure flag breaks refresh over plain HTTP  — **P0** · _edge_
- **Pre:** Backend started WITHOUT setting CRM_REFRESH_COOKIE_SECURE=false (default true). Frontend on http://localhost:5174.
- **Steps:**
  1. Start crm-api with default config (CRM_REFRESH_COOKIE_SECURE unset -> true)
  2. Log in fully at http://localhost:5174
  3. Reload the page (forces bootstrapAuth -> /refresh)
- **API:** `POST /admin/auth/totp/verify (Set-Cookie Secure)`, `POST /admin/auth/refresh`
- **Expect:** Over plain HTTP a Secure cookie is not stored/sent by the browser, so /refresh after reload returns 401 'no session' and the user is bounced to /login (looks like 'login does not persist'). Setting CRM_REFRESH_COOKIE_SECURE=false fixes it. This documents the local-testing landmine (suspectedBug AUTH-BUG-5).

#### `AUTH-06` Invalid TOTP code rejected + toast; repeated bad codes lock account  — **P1** · _negative_
- **Pre:** Admin past the password step holding a valid challenge_token. CRM_LOGIN_RATELIMIT_MAX raised so the limiter does not mask the behaviour.
- **Steps:**
  1. Login with correct password to reach the TOTP step
  2. Enter a wrong 6-digit code (auto-submits)
  3. Observe error + shake + toast; field clears
  4. Repeat with wrong codes until 5 cumulative failures across this account's counter
- **API:** `POST /admin/auth/totp/verify (multiple)`
- **Expect:** Each bad code returns 401 'invalid code', shows inline error + a toast, clears the input, shakes. DB: each bad TOTP increments failed_login_count via IncrementFailedLogin; once it crosses 5, locked_until is set. crm_login_attempts reason=bad_totp.

#### `AUTH-07` Challenge token expiry (5 min) -> 'challenge expired'  — **P1** · _edge_
- **Pre:** Admin reaches TOTP step. Ability to wait >5 minutes (challenge JWT TTL is hard-coded 5m).
- **Steps:**
  1. Login with correct password to reach TOTP step
  2. Wait more than 5 minutes without entering a code
  3. Enter the current valid 6-digit code
- **API:** `POST /admin/auth/totp/verify`
- **Expect:** totp/verify returns 401 'challenge expired' (ErrInvalidChallenge). UI shows error/toast. User must click Back and re-enter password.

#### `AUTH-18` Cannot revoke the current session (foot-gun guard)  — **P1** · _edge_
- **Pre:** Logged-in admin on /sessions.
- **Steps:**
  1. Open /sessions
  2. Locate the row with the 'current' pill
  3. Attempt to click its revoke button
- **API:** `(none expected)`
- **Expect:** The revoke button on the current session is disabled (opacity-30, disabled attr); clicking does nothing. No DELETE is sent. The user is told to use 'Sign out' instead (per page copy).

#### `AUTH-23` RBAC: viewer can read but not write; Can hides write controls  — **P1** · _rbac_
- **Pre:** A 'viewer'-role admin logged in.
- **Steps:**
  1. Log in as viewer
  2. Open Orders / Users / Refunds list pages (orders.read/users? note: users.read=support, so viewer is blocked from Users)
  3. Confirm read-only pages load and write buttons gated by <Can perm=...> are hidden
  4. Attempt a write endpoint directly with the viewer bearer
- **API:** `GET /admin/orders (orders.read=viewer, allowed)`, `GET /admin/users (users.read=support, expect 403 for viewer)`, `POST /admin/orders/{id}/cancel (orders.cancel=admin, expect 403)`
- **Expect:** Viewer can load viewer-level read pages; sensitive reads (users.read/workers.read/refunds.read require support) return 403 for a viewer. Write buttons are not rendered (Can returns null). Direct write calls return 403 insufficient_permissions. This confirms FE Can-gating and BE RequirePermission agree.

#### `AUTH-24` RBAC frontend/backend parity spot-check (refunds full vs partial)  — **P1** · _rbac_
- **Pre:** A 'support'-role admin. Refund approval endpoints: refunds.approve_full=support, refunds.approve_partial=admin.
- **Steps:**
  1. Log in as support
  2. On the Refunds page approve a FULL refund
  3. Attempt to approve a PARTIAL refund
- **API:** `POST /admin/refunds/{id}/approve (full -> 200)`, `POST /admin/refunds/{id}/approve (partial -> 403)`
- **Expect:** Full-refund approval succeeds for support (refunds.approve_full=support). Partial-refund approval returns 403 (refunds.approve_partial=admin) with required_role=admin. Confirms the per-action role split and that the FE Can map matches the BE permissions map.

#### `AUTH-25` Idempotency/replay: same challenge token + TOTP code can mint multiple sessions  — **P1** · _idempotency_
- **Pre:** Admin reaches TOTP step holding a single challenge_token; a currently-valid TOTP code. Ability to replay the verify request (curl/devtools) within 5 min and within the 30s code window.
- **Steps:**
  1. Login to reach TOTP step and capture the challenge_token from the /login response
  2. Compute the current TOTP code
  3. POST /admin/auth/totp/verify with that challenge_token + code
  4. Immediately POST the SAME challenge_token + SAME code again (and again) within the 30s/5min windows
- **API:** `POST /admin/auth/totp/verify (repeated, same token+code)`
- **Expect:** OBSERVE whether each replay returns 200 and creates a NEW crm_admin_sessions row. The code does not mark the challenge token consumed nor the TOTP code used, so replays are expected to succeed and stack sessions. This is the verification of suspectedBug AUTH-BUG-1 / AUTH-BUG-2.

#### `AUTH-27` Inactive account cannot log in  — **P1** · _negative_
- **Pre:** An admin row with is_active=false but valid password.
- **Steps:**
  1. Go to /login
  2. Enter the inactive admin's email + correct password, click 'Continue'
- **API:** `POST /admin/auth/login`
- **Expect:** 403 'account inactive' (ErrInactive). UI shows the error message. crm_login_attempts reason=inactive. No challenge token issued; bcrypt is not run (early return).

#### `AUTH-29` Double-submit guard on credential + TOTP forms  — **P1** · _concurrency_
- **Pre:** Admin at /login.
- **Steps:**
  1. Enter email + password and double-click 'Continue' rapidly
  2. At the TOTP step, double-click 'Verify' (or paste the 6th digit twice)
- **API:** `POST /admin/auth/login`, `POST /admin/auth/totp/verify`
- **Expect:** busy flag short-circuits the second submit (if (busy) return), so only one /login and one /totp/verify go out per click burst. No duplicate challenge / duplicate session from a single double-click.

#### `AUTH-20` Sessions empty state  — **P2** · _edge_
- **Pre:** Hard to hit naturally (the current session always exists). Simulate by stubbing GET /admin/auth/sessions to return {sessions:[]} (e.g. devtools override), or inspect the EmptyState rendering logic.
- **Steps:**
  1. Force GET /admin/auth/sessions to return an empty array
  2. Open /sessions
- **API:** `GET /admin/auth/sessions`
- **Expect:** The Card renders the EmptyState titled 'No sessions' instead of a row list; no crash.

#### `AUTH-28` Boundary: TOTP input only accepts 6 digits, strips non-numerics  — **P2** · _edge_
- **Pre:** Admin at TOTP step.
- **Steps:**
  1. At the TOTP step type letters and symbols (e.g. 'ab12cd34')
  2. Then paste/type a 7+ digit string
- **API:** `POST /admin/auth/totp/verify (only when exactly 6 digits)`
- **Expect:** Non-digits are stripped, value is capped at 6 digits; verify auto-fires only when exactly 6 digits present. The 'Verify' button is disabled unless length===6. Backend also rejects len!=6 with 400 'code must be 6 digits' if bypassed.

#### `AUTH-30` Logout audit row carries no admin identity (public route gap)  — **P2** · _negative_
- **Pre:** Logged-in admin; DB access to audit_logs.
- **Steps:**
  1. Sign Out via the admin menu
  2. Inspect the newest audit_logs row with action=auth.logout
- **API:** `POST /admin/auth/logout`
- **Expect:** OBSERVE that the auth.logout audit row has empty admin_id and admin_email (logout is a PUBLIC route with no JWT middleware, so c.Locals('crmAdminID') is never set). This verifies suspectedBug AUTH-BUG-4 — logout actions are not attributable to an admin.

### orders  <sub>(48 flows — P0:15 P1:18 P2:15)</sub>

CRM orders area is a read-mostly booking-lifecycle surface: a filterable/paginated order list (/orders) and a per-order detail page (/orders/:id) showing status, timeline, customer, assigned pro/worker, services breakdown, and admin notes. Detail page also exposes write actions gated by role: assign/reassign pro, mark completed, cancel booking, add admin note, and issue refund (which crosses into the refunds money flow via POST /admin/refunds/from-order/:orderId). All endpoints sit under /admin behind a CRM JWT plus per-permission role checks.

**Pages:** `/orders` · `/orders/:id` · `n/a (API layer)` · `n/a (backend handler)` · `n/a (backend handler)`

**Test data:** A CRM admin account per role to test RBAC: viewer, support, admin, superadmin (roleRank viewer<support<admin<superadmin). Need valid CRM JWTs for each.; Bookings in every status: pending, searching, accepted, arrived, in_progress, completed, cancelled (bookings.status). Need at least one accepted/in_progress for reassign/complete happy paths.; An unassigned order (helper_id NULL) in accepted/in_progress to test Assign; and an assigned one to test Reassign.; >25 bookings total to exercise pagination (multiple pages); plus a filtered subset that yields a partial last page.; A booking with booking_services rows (multi-service) and one WITHOUT (legacy/pre-Phase-10) to test the services breakdown empty state.; A booking with a promo_code and discount_paise>0, one with discount_paise=0, one with amount_paise=0, and one with a very large amount_paise (e.g. 100000000) for money-rendering boundaries.; A booking with real lat/lng (map renders) and one with lat=0,lng=0 (map hidden).; Redis running with helpers:locations GEO entries for several helpers near a test order's lat/lng. Helpers must vary: approved+available+idle+offers-category (eligible); plus unapproved / unavailable / wrong-category / busy(on accepted|in_progress job) helpers to test reassign rejections.; helpers + users rows: helper.approval_status='approved', helper.is_available=true, helper.services TEXT[] containing the order's service_category name; users.name/phone populated; users.deleted_at NULL.; service_categories rows so sc.name resolves for category filter and helper.services name-matching.; Bookings with various payment_method (cod, upi, card, wallet) and some with payment_id set / null to exercise the refund gateway branches (manual vs gateway vs wallet credit).; An order that already has an active pending_refunds row (status pending/approved/processed) to test the duplicate-refund guard.; admin_booking_notes seed rows for an order to test the notes list ordering (newest-first) and admin_email join; crm_admins rows so the email join resolves.; A soft-deleted customer/helper (users.deleted_at set) to confirm the LEFT JOIN deleted_at filter shows '(deleted)' phone / null name without crashing.

#### `ORD-AUTH-001` All order endpoints require auth (no JWT = 401)  — **P0** · _rbac_
- **Pre:** No CRM JWT (logged out / cleared token).
- **Steps:**
  1. With devtools, clear the auth token
  2. Call GET /admin/orders and GET /admin/orders/:id directly
- **API:** `GET /admin/orders (expect 401)`, `GET /admin/orders/:id (expect 401)`
- **Expect:** Routes sit on the authed group (jwtMW). Missing/invalid token → 401 from the JWT middleware before any handler runs. The SPA axios interceptor should redirect to login / surface the 401.

#### `ORD-CANCEL-001` Cancel an in-flight booking (happy path, admin+)  — **P0** · _happy_
- **Pre:** Logged in as admin+ (orders.cancel=admin). An order with status NOT in completed/cancelled.
- **Steps:**
  1. Open the order detail
  2. In Admin actions, click 'Cancel booking'
  3. In the confirm modal, type a reason in the textarea
  4. Click 'Cancel booking' (destructive confirm)
- **API:** `POST /admin/orders/:id/cancel`
- **Expect:** 200 {ok:true}; toast 'Booking cancelled.'; detail invalidates and re-renders status=cancelled with a 'Cancelled' timeline row and cancelled_by='admin:<email>'. crm_audit_log gets action 'order.cancel' with the reason. Note: NO refund is auto-issued (modal warns about this).

#### `ORD-CANCEL-004` Cancel RBAC: viewer/support blocked  — **P0** · _rbac_
- **Pre:** Logged in as support (orders.cancel=admin NOT satisfied).
- **Steps:**
  1. As support, open a non-terminal order detail
  2. Confirm the 'Cancel booking' button is hidden (usePermission('orders.cancel') false)
  3. Direct call POST /admin/orders/:id/cancel with a reason
- **API:** `POST /admin/orders/:id/cancel (expect 403)`
- **Expect:** Button hidden for support. Direct call → 403 required_role:'admin', your_role:'support'. Required = admin; insufficient = support/viewer.

#### `ORD-COMPLETE-001` Mark completed (happy path, admin+)  — **P0** · _happy_
- **Pre:** admin+ (orders.complete=admin). Order in accepted/in_progress/arrived/en_route.
- **Steps:**
  1. Open the order detail
  2. In Admin actions, click 'Mark completed' (success-tone)
  3. Confirm the ConfirmModal impact text mentions earnings + rating prompt
  4. Click 'Mark completed'
- **API:** `POST /admin/orders/:id/complete`
- **Expect:** 200 {ok:true}; toast 'Booking marked completed.'; detail invalidates, status=completed, completed_at set. crm_audit_log action 'order.complete_manual'.

#### `ORD-COMPLETE-004` Complete RBAC: support blocked  — **P0** · _rbac_
- **Pre:** Logged in as support.
- **Steps:**
  1. As support, open a completable order detail
  2. Confirm 'Mark completed' button is hidden
  3. Direct POST /admin/orders/:id/complete
- **API:** `POST /admin/orders/:id/complete (expect 403)`
- **Expect:** 403 required_role:'admin', your_role:'support'. Required = admin.

#### `ORD-DET-001` Open order detail (happy path + view audit)  — **P0** · _happy_
- **Pre:** Logged in (viewer+). A valid booking id.
- **Steps:**
  1. From /orders, click a row
  2. Confirm navigation to /orders/:id
  3. Observe header (id, status pill, amount, discount line if any), Timeline, Services, Notes, Customer, Pro cards
- **API:** `GET /admin/orders/:id`, `GET /admin/orders/:id/notes`
- **Expect:** Detail renders. Backend writes a crm_audit_log row action 'order.view' module 'orders' (single-order PII read is audited; list is intentionally not). Timeline dots fill for non-null timestamps; cancelled adds a danger 'Cancelled' row.

#### `ORD-LIST-001` Order list loads and renders rows (happy path)  — **P0** · _happy_
- **Pre:** Logged in as a viewer (or higher). At least 1 booking exists.
- **Steps:**
  1. Navigate to http://localhost:5174/orders
  2. Observe the table renders with columns Order / Customer-Worker / Category / Amount / Status / Created
  3. Confirm the footer reads '1–N of TOTAL' and 'Page 1 of M'
- **API:** `GET /admin/orders?limit=25&offset=0`
- **Expect:** Rows render with 8-char order ids, customer name or phone, worker name or 'unassigned', category, ₹ amount (price_paise/100), a status pill, and a localized created timestamp. Footer counts match returned total_count.

#### `ORD-NOTE-003` Add-note RBAC: viewer cannot see or use the form  — **P0** · _rbac_
- **Pre:** Logged in as viewer (orders.read=viewer satisfied, orders.add_note=support NOT satisfied).
- **Steps:**
  1. As viewer, open an order detail
  2. Confirm the Admin notes card shows existing notes but NO 'Add note' textarea/button (usePermission('orders.add_note') false)
  3. Attempt the write directly: POST /admin/orders/:id/notes with a body
- **API:** `GET /admin/orders/:id/notes`, `POST /admin/orders/:id/notes (expect 403)`
- **Expect:** UI hides the add-note form for viewer. Direct POST returns 403 {error:'insufficient_permissions', required_role:'support', your_role:'viewer'}. Required role = support; insufficient = viewer.

#### `ORD-REASSIGN-001` Assign pro to unassigned order (happy path)  — **P0** · _happy_
- **Pre:** admin+ (orders.reassign=admin). Redis configured with helpers:locations geo data. Order in accepted/in_progress with no helper, lat/lng set, and at least one approved+available+idle helper offering the category within radius.
- **Steps:**
  1. Open the order detail (Pro card shows 'Unassigned')
  2. Click 'Assign pro' in Admin actions
  3. Pick a search radius (5/10/20/50 km)
  4. Optionally filter by name
  5. Select a worker row (check mark appears)
  6. Enter a reason >=5 chars
  7. Click 'Assign'
- **API:** `GET /admin/orders/:id/available-workers?radius_km=5`, `POST /admin/orders/:id/reassign`
- **Expect:** available-workers returns candidates sorted by distance; selecting + reason>=5 enables the Assign button; POST returns 200 {ok:true}; toast 'Assigned to <name>.'; detail invalidates and Pro card shows the new worker. crm_audit_log action 'order.reassign'. Note: backend Reassign requires status accepted/in_progress — an unassigned 'pending' order will 400.

#### `ORD-REASSIGN-010` Reassign RBAC: support/viewer blocked  — **P0** · _rbac_
- **Pre:** Logged in as support.
- **Steps:**
  1. As support, open an order — confirm the Assign/Reassign button is hidden
  2. Direct POST /admin/orders/:id/reassign
- **API:** `POST /admin/orders/:id/reassign (expect 403)`
- **Expect:** 403 required_role:'admin', your_role:'support'. Note: GET available-workers requires only orders.read (viewer), so a viewer CAN enumerate nearby pro names+distance (HIGH PII, audited as 'order.candidates.list') even though they cannot reassign — verify this is intended.

#### `ORD-REFUND-001` Issue full refund from order detail (money, happy path)  — **P0** · _money_
- **Pre:** support+ (refunds.approve_full=support). A non-terminal order with the ActionsCard, OR a completed/cancelled order with the RefundOnlyCard. Order has amount_paise and known discount_paise; no existing active refund.
- **Steps:**
  1. Open the order detail
  2. Click 'Issue refund' (Admin actions or Post-booking card)
  3. Confirm the amount field defaults to full = (price_paise - discount_paise)/100 rupees
  4. Enter a reason >=5 chars
  5. Click 'Issue refund'
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** amount_paise = Math.round(amount*100); backend caps amount<=NetPaise (amount_paise - discount_paise). 200 {ok:true, refund_id, status}; toast 'Refund created (<id8>).'; detail invalidates. A pending_refunds row is created and the gateway runs (COD/no-payment-id → processed_manual; wallet → wallet credit; card/upi → gateway). crm_audit_log via refunds module.

#### `ORD-REFUND-002` Partial refund requires admin (refunds.approve_partial)  — **P0** · _rbac_
- **Pre:** Logged in as SUPPORT (has approve_full, NOT approve_partial which is admin).
- **Steps:**
  1. As support, open Issue refund modal
  2. Lower the amount below full (e.g. half)
  3. Enter reason>=5, click 'Issue refund'
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** Because amount < NetPaise, backend gates on refunds.approve_partial (admin). Support gets 403 {required_role:'admin', your_role:'support'}; interceptor toast. A FULL refund by the same support user succeeds. Confirms the partial-permission split.

#### `ORD-REFUND-003` Refund amount exceeding order total rejected  — **P0** · _money_
- **Pre:** admin+ (so partial gate passes). Order with known NetPaise.
- **Steps:**
  1. Open Issue refund modal
  2. Try to type an amount greater than the displayed full amount — note the input has max=fullRupees and the button disables when amount>fullRupees
  3. Bypass the client by calling the API directly with amount_paise > NetPaise
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** Client: button disabled when amount<=0 or amount>fullRupees or reason<5. Server: 400 {error:'amount exceeds order total'} when amount_paise>NetPaise. Verify the cap uses NET (gross minus discount), not gross amount_paise.

#### `ORD-REFUND-005` Duplicate refund for same order blocked  — **P0** · _idempotency_
- **Pre:** admin+. An order that already has an active (pending/approved/processed) refund.
- **Steps:**
  1. Issue a refund on an order successfully
  2. Without changing anything, open Issue refund again and submit a second refund
- **API:** `POST /admin/refunds/from-order/:orderId (x2)`
- **Expect:** Second call: backend findActiveRefundForBooking finds the existing row and returns 400 {error:'refund already processed for this order [on YYYY-MM-DD]', duplicate_refund_id:<id>}. Prevents paying the customer twice.

#### `ORD-REFUND-006` Refund double-submit / concurrent submit (TOCTOU)  — **P0** · _concurrency_
- **Pre:** admin+. An order with NO existing refund. Two tabs (or a fast double-click that bypasses the in-flight disable).
- **Steps:**
  1. Open the same order in two tabs
  2. In both, enter the same full amount + reason
  3. Click 'Issue refund' in both as close to simultaneously as possible
- **API:** `POST /admin/refunds/from-order/:orderId (x2 racing)`
- **Expect:** Single-click path is guarded (mutation isPending disables the button). Risk: CreateFromOrder checks findActiveRefundForBooking THEN inserts without a row lock around the check+insert; two truly-simultaneous requests could both pass the dup check and create two pending_refunds rows → double money movement. Verify whether a unique constraint or lock prevents this; if two refunds are created, this is a P0 money bug.

#### `ORD-AUTH-002` Read RBAC: viewer can read list+detail  — **P1** · _rbac_
- **Pre:** Logged in as viewer (orders.read min role = viewer).
- **Steps:**
  1. As viewer, open /orders and an order detail
- **API:** `GET /admin/orders`, `GET /admin/orders/:id`, `GET /admin/orders/:id/notes`
- **Expect:** Viewer can list and view orders (orders.read=viewer). All write buttons (assign/complete/cancel/note/refund) are hidden because their usePermission checks fail. Required read role = viewer.

#### `ORD-CANCEL-002` Cancel reason 'min 5 chars' is not actually enforced  — **P1** · _negative_
- **Pre:** admin+ on a cancellable order.
- **Steps:**
  1. Open Cancel booking modal
  2. Leave the reason empty and click 'Cancel booking'
  3. Observe result
  4. Then enter a single character 'x' and click confirm again
- **API:** `POST /admin/orders/:id/cancel`
- **Expect:** Empty reason: backend returns 400 {error:'reason required'}; ConfirmModal stays open, toast surfaces. Single char 'x': SUCCEEDS (backend only checks non-empty; the modal placeholder 'min 5 chars' is cosmetic and confirmDisabled is not wired). This is a validation gap to flag — verify min-length is not enforced anywhere.

#### `ORD-CANCEL-003` Cannot cancel a completed/cancelled order  — **P1** · _negative_
- **Pre:** admin+. An order already completed or cancelled.
- **Steps:**
  1. Note: for terminal orders the ActionsCard is not rendered (only RefundOnlyCard).
  2. To exercise the guard, take an order, cancel it, then replay POST /admin/orders/:id/cancel directly with a reason
- **API:** `POST /admin/orders/:id/cancel (second call)`
- **Expect:** Repo Cancel UPDATE has WHERE status NOT IN (completed,cancelled); RowsAffected()==0 → 400 {error:'order is completed or already cancelled'}. Idempotency: a duplicate cancel does not re-stamp cancelled_at/cancelled_by.

#### `ORD-CANCEL-005` Cancel double-click / double-submit  — **P1** · _concurrency_
- **Pre:** admin+ on a cancellable order.
- **Steps:**
  1. Open Cancel modal, type a reason
  2. Rapidly double-click the 'Cancel booking' confirm button
- **API:** `POST /admin/orders/:id/cancel (x1 expected)`
- **Expect:** ConfirmModal.go() has a busy guard (if(busy)return) and disables the button while working, so only one POST fires. Even if two raced, the WHERE status guard makes the second a no-op 400. No double state mutation.

#### `ORD-COMPLETE-002` Mark-completed button disabled for non-completable statuses  — **P1** · _edge_
- **Pre:** admin+. An order with status pending or searching (not in accepted/in_progress/arrived/en_route).
- **Steps:**
  1. Open such an order
  2. Hover the 'Mark completed' button
- **API:** `(none — button disabled client-side)`
- **Expect:** Button disabled with title 'Only available when accepted / in_progress / arrived / en_route'. Note: backend MarkComplete allows ANY non-terminal status (no status whitelist), so completing a 'pending' order via direct API would succeed and skip the lifecycle — flag this client/server divergence.

#### `ORD-COMPLETE-003` Complete already-completed order (idempotency)  — **P1** · _idempotency_
- **Pre:** admin+. A completed order (use direct API; UI hides the action for terminal orders).
- **Steps:**
  1. POST /admin/orders/:id/complete on an order already completed
- **API:** `POST /admin/orders/:id/complete`
- **Expect:** Repo MarkComplete WHERE status NOT IN (completed,cancelled); RowsAffected()==0 → 400 {error:'order is already completed or cancelled'}. completed_at not re-stamped.

#### `ORD-DET-002` Detail 404 / not-found state  — **P1** · _negative_
- **Pre:** Any logged-in role.
- **Steps:**
  1. Manually navigate to /orders/00000000-0000-0000-0000-000000000000
  2. Observe the page
- **API:** `GET /admin/orders/00000000-0000-0000-0000-000000000000`
- **Expect:** Backend returns 404 {error:'order not found'}; the page shows the 'Booking not found' EmptyState with a 'Back to orders' link (q.isError branch). No white screen.

#### `ORD-LIST-002` Status filter narrows results and resets to page 1  — **P1** · _happy_
- **Pre:** Bookings exist in at least two statuses (e.g. completed and pending).
- **Steps:**
  1. On /orders, click Next a few times to land past page 1
  2. Select 'Completed' in the status dropdown
  3. Observe the list refetches and offset resets to 0 (footer shows '1–…')
  4. Confirm URL gains ?status=completed
- **API:** `GET /admin/orders?status=completed&limit=25&offset=0`
- **Expect:** Only completed orders show; pagination footer resets to page 1; URL is shareable/bookmarkable with status=completed.

#### `ORD-LIST-003` Search by order id / customer / worker  — **P1** · _happy_
- **Pre:** A known booking whose id prefix, customer name, or worker name is known.
- **Steps:**
  1. On /orders, type a fragment of the order id (or customer/worker name) into the search box
  2. Wait for the debounced query to fire (it fires on each keystroke via URL update)
  3. Observe matching rows
- **API:** `GET /admin/orders?search=<fragment>&limit=25&offset=0`
- **Expect:** Backend LOWER(...) LIKE matches on b.id::text, customer name/phone, or helper name. Only matching rows show. Empty match shows the 'No orders match' empty state.

#### `ORD-LIST-004` Date-range filter (IST day boundaries)  — **P1** · _edge_
- **Pre:** Bookings created on a known IST date.
- **Steps:**
  1. On /orders, set the From date picker to a date
  2. Set the To date picker to the same date
  3. Observe the list filters to that IST day
- **API:** `GET /admin/orders?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=25&offset=0`
- **Expect:** Backend parseFilterDate interprets bare YYYY-MM-DD as 00:00:00 IST (from) and 23:59:59.999999999 IST (to). A booking created at 23:30 IST on the selected day is INCLUDED; one created 00:30 IST next day is EXCLUDED. Verifies the inclusive end-of-day boundary.

#### `ORD-LIST-006` Pagination next/prev and boundary disabling  — **P1** · _edge_
- **Pre:** More than 25 bookings exist (so >1 page).
- **Steps:**
  1. On /orders, confirm Prev is disabled on page 1
  2. Click Next; confirm offset increments by 25 and URL gains ?offset=25
  3. Page to the last page; confirm Next becomes disabled
  4. Click Prev back to page 1
- **API:** `GET /admin/orders?limit=25&offset=0`, `GET /admin/orders?limit=25&offset=25`
- **Expect:** page = floor(offset/limit)+1; pages = ceil(total/limit). Prev disabled when page===1, Next disabled when page>=pages. Footer range '(offset+1)–min(offset+itemsLen,total) of total' stays correct on every page including a partial last page.

#### `ORD-MONEY-001` Amount/discount render integrity (paise, not cents)  — **P1** · _money_
- **Pre:** An order with a non-trivial amount and a discount + promo_code (e.g. amount_paise=149900, discount_paise=20000, promo_code=SAVE20).
- **Steps:**
  1. View the order in the list and on detail
  2. Compare displayed ₹ to amount_paise/100
- **API:** `GET /admin/orders`, `GET /admin/orders/:id`
- **Expect:** Both views use price_paise/100 with en-IN locale (₹1,499). Discount line shows −₹200 SAVE20. The wire field is price_paise (not _cents) — a regression to _cents renders NaN. Verify no NaN/₹0 for valid rows.

#### `ORD-NOTE-001` Add admin note (happy path, support+)  — **P1** · _happy_
- **Pre:** Logged in as support, admin, or superadmin (orders.add_note min role = support). Valid order.
- **Steps:**
  1. Open an order detail
  2. In Admin notes card, type a note >=3 chars in the textarea
  3. Click 'Add note'
- **API:** `POST /admin/orders/:id/notes`, `GET /admin/orders/:id/notes`
- **Expect:** 201 Created; toast 'Note added.'; the textarea resets; the note list re-queries and shows the new note with the admin email and relative timestamp. crm_audit_log gets action 'order.note.add'.

#### `ORD-REASSIGN-002` Reassign already-assigned order  — **P1** · _happy_
- **Pre:** admin+. Order accepted/in_progress with a current helper; a different eligible idle helper available.
- **Steps:**
  1. Open the order (Pro card shows current worker)
  2. Click 'Reassign pro'
  3. Select a DIFFERENT worker, enter reason>=5
  4. Click 'Reassign'
- **API:** `GET /admin/orders/:id/available-workers?radius_km=5`, `POST /admin/orders/:id/reassign`
- **Expect:** available-workers excludes the current helper ($3 = h.id filter). POST commits inside a tx with FOR UPDATE on the booking; helper_id updated. Old + new pros and the customer get best-effort FCM notifications; webhook EventOrderReassigned dispatched. Toast 'Reassigned to <name>.'

#### `ORD-REASSIGN-004` Reassign to ineligible worker (not approved / not available / wrong category / busy)  — **P1** · _negative_
- **Pre:** admin+. A helper that is unapproved, unavailable, lacks the category, or is on another active job.
- **Steps:**
  1. Call POST /admin/orders/:id/reassign directly with the ineligible new_worker_id + reason>=5 (UI only lists eligible ones)
- **API:** `POST /admin/orders/:id/reassign`
- **Expect:** Backend tx validates and returns 400 with the specific message: 'new worker is not approved' / 'new worker is not available' / 'new worker does not offer this category' / 'new worker is busy with another active booking'. No state change.

#### `ORD-REASSIGN-005` Reassign on non-accepted/in_progress status  — **P1** · _negative_
- **Pre:** admin+. Order in pending/searching/arrived/completed/cancelled.
- **Steps:**
  1. Direct POST /admin/orders/:id/reassign with a valid worker + reason
- **API:** `POST /admin/orders/:id/reassign`
- **Expect:** 400 {error:'order is <status> — only accepted/in_progress orders can be reassigned'}. Note 'arrived' is NOT reassignable here even though it is completable — confirm this status-guard inconsistency vs the available-workers endpoint which allows any non-terminal status.

#### `ORD-REASSIGN-009` Reassign concurrency / double-submit (row lock)  — **P1** · _concurrency_
- **Pre:** admin+. Two browser tabs open on the same order, two distinct eligible workers.
- **Steps:**
  1. In tab A, pick worker X + reason, click Assign
  2. Immediately in tab B, pick worker Y + reason, click Assign
  3. Observe both responses
- **API:** `POST /admin/orders/:id/reassign (x2)`
- **Expect:** Repo.Reassign serializes via FOR UPDATE on the booking row. Whichever commits first wins; the second sees the updated helper. The 'new worker is busy' / 'already assigned' guards prevent inconsistent double assignment. Final helper_id is deterministic (last committed). No lost-update.

#### `ORD-REFUND-004` Refund amount zero / negative rejected  — **P1** · _money_
- **Pre:** admin+.
- **Steps:**
  1. In the refund modal set amount to 0 — confirm button disabled
  2. Call API directly with amount_paise=0 and -100
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** Client disables submit at amount<=0. Server: 400 {error:'amount_paise must be greater than zero'} for <=0. No negative refund row created.

#### `ORD-DET-003` Detail with invalid (non-UUID) id  — **P2** · _negative_
- **Pre:** Any logged-in role.
- **Steps:**
  1. Navigate to /orders/not-a-uuid
  2. Observe behavior
- **API:** `GET /admin/orders/not-a-uuid`
- **Expect:** Backend casts $1::uuid; an invalid uuid raises a query error caught as 500 internal error (NOT 404) — see suspected bug. The page still renders the 'Booking not found' EmptyState. Verify the toast/status is sane and no white screen.

#### `ORD-DET-004` Services breakdown empty (legacy booking)  — **P2** · _edge_
- **Pre:** A booking with no booking_services rows (pre-Phase-10).
- **Steps:**
  1. Open such an order's detail
  2. Scroll to Services breakdown card
- **API:** `GET /admin/orders/:id`
- **Expect:** Card shows 'No service breakdown available (pre-Phase-10 booking)'. No table rendered, no crash.

#### `ORD-DET-005` Map renders only when lat/lng present  — **P2** · _edge_
- **Pre:** One booking with lat/lng=0,0 and one with real coords.
- **Steps:**
  1. Open the 0,0 booking — confirm no map block in Customer card
  2. Open the real-coords booking — confirm the Google map with a marker renders
- **API:** `GET /admin/orders/:id`
- **Expect:** Map only renders when lat!==0 && lng!==0. Verify a legitimate booking exactly on the equator/prime-meridian edge case is acceptable (it would be hidden — note as data-quirk).

#### `ORD-EDGE-001` Hidden filters reachable only via URL (min_cents/max_cents/category/customer_id/worker_id/sort)  — **P2** · _edge_
- **Pre:** Logged in. Orders across categories/amounts/workers.
- **Steps:**
  1. Manually craft a URL like /orders?category=Cleaning&min_cents=50000&max_cents=200000&worker_id=<uuid>&sort_by=price&sort_dir=asc
  2. Load it and observe results
- **API:** `GET /admin/orders?category=Cleaning&min_cents=50000&max_cents=200000&worker_id=<uuid>&sort_by=price&sort_dir=asc`
- **Expect:** Backend honors all of these (category by sc.name, min/max on amount_paise GROSS, worker_id=helper_id, sort_by in {created_at,price,status}, sort_dir asc/desc). The OrdersPage reads/writes them in URL state but exposes NO UI controls for category/amount/customer/worker/sort — so they are admin-only via URL. Confirm they filter correctly and flag the missing UI as a usability gap. Note min_cents/max_cents filter gross amount_paise, while money elsewhere is net — potential confusion.

#### `ORD-LIST-005` Empty state when no orders match  — **P2** · _edge_
- **Pre:** Any state.
- **Steps:**
  1. On /orders, set status to a value with zero rows (or search a nonsense string like zzzzzz)
  2. Observe the table body
- **API:** `GET /admin/orders?search=zzzzzz&limit=25&offset=0`
- **Expect:** Single full-width row showing the 'No orders match' EmptyState. Footer shows '1–0 of 0' and 'Page 1 of 1'. Prev and Next both disabled.

#### `ORD-LIST-007` Clear filters button  — **P2** · _happy_
- **Pre:** At least one filter active.
- **Steps:**
  1. On /orders, apply a status + date filter
  2. Confirm a 'Clear' button appears (only when a filter is active)
  3. Click Clear
  4. Confirm all filters reset and the URL query string is emptied
- **API:** `GET /admin/orders?limit=25&offset=0`
- **Expect:** hasFilters gates the Clear button; clicking it sets an empty URLSearchParams and reloads the unfiltered first page.

#### `ORD-MONEY-002` Large / zero amount boundaries  — **P2** · _money_
- **Pre:** One order with amount_paise=0 and one very large (e.g. 100000000 = ₹10,00,000).
- **Steps:**
  1. View both in list + detail
  2. For the ₹0 order open the refund modal
- **API:** `GET /admin/orders`, `GET /admin/orders/:id`
- **Expect:** ₹0 renders as ₹0, no discount line. Large amount renders with correct Indian grouping. For ₹0 order, refund full = ₹0 → submit disabled (amount<=0) and server would 400. No overflow/locale glitch.

#### `ORD-NOTE-002` Add-note validation (client min/max)  — **P2** · _negative_
- **Pre:** support+ on an order detail.
- **Steps:**
  1. Type a 2-char note
  2. Confirm inline error 'min 3 characters' and the submit is blocked
  3. Paste a 2001-char note
  4. Confirm 'max 2000 characters' error
- **API:** `(none — blocked client-side by zod resolver, mode onChange)`
- **Expect:** zod noteSchema enforces trim min 3 / max 2000; the form does not POST until valid. Note: the backend only checks non-empty after trim (no max), so the max is client-only — exercise an oversized note via direct API to confirm backend behavior.

#### `ORD-NOTE-004` Add note to non-existent order  — **P2** · _negative_
- **Pre:** support+.
- **Steps:**
  1. POST /admin/orders/<random-valid-uuid>/notes with body 'test'
- **API:** `POST /admin/orders/<unknown-uuid>/notes`
- **Expect:** Backend AddNote does an EXISTS check first and returns 404 {error:'order not found'} before inserting a dangling note row.

#### `ORD-REASSIGN-003` Reassign to the same worker is rejected  — **P2** · _negative_
- **Pre:** admin+. Order with a current helper.
- **Steps:**
  1. Open Reassign modal
  2. (The list excludes the current helper, so to exercise the guard, call the API directly with new_worker_id == current helper_id and a reason)
- **API:** `POST /admin/orders/:id/reassign`
- **Expect:** 400 {error:'worker is already assigned to this order'}.

#### `ORD-REASSIGN-006` Reassign reason minimum (client 5 vs server 2)  — **P2** · _negative_
- **Pre:** admin+.
- **Steps:**
  1. In the Assign modal, enter a 4-char reason — confirm the Assign button stays disabled (client requires >=5)
  2. Then call the API directly with a 2-char reason
- **API:** `POST /admin/orders/:id/reassign`
- **Expect:** Client disables Assign until reason.trim().length>=5. Backend only requires non-empty (validate tag min=2 is not run because handler uses BodyParser + manual non-empty check, not the validator). So a 1-char reason via API succeeds. Flag the validation divergence.

#### `ORD-REASSIGN-007` available-workers when Redis not configured  — **P2** · _negative_
- **Pre:** admin+. Backend started WITHOUT Redis (or SetRedis not called).
- **Steps:**
  1. Open Assign modal on an order
- **API:** `GET /admin/orders/:id/available-workers?radius_km=5`
- **Expect:** Repo returns error 'redis not configured'; handler maps it to 400 {error:'redis not configured'} (NOT 503 as the SetRedis doc comment claims). Modal shows the standard interceptor toast. Flag wrong status code (doc says 503).

#### `ORD-REASSIGN-008` available-workers radius clamp + empty radius  — **P2** · _edge_
- **Pre:** admin+. Redis configured.
- **Steps:**
  1. In Assign modal pick 50km (max UI option)
  2. Then call API directly with radius_km=999
- **API:** `GET /admin/orders/:id/available-workers?radius_km=50`, `GET /admin/orders/:id/available-workers?radius_km=999`
- **Expect:** Backend clamps any radius_km>50 to 50 before the geo call. radius_km<=0 or non-numeric falls back to default 10. Response echoes radius_km. Empty geo result → modal shows 'No available pros within Nkm. Increase the radius.'

#### `ORD-REFUND-007` Refund reason required  — **P2** · _negative_
- **Pre:** admin+.
- **Steps:**
  1. Open Issue refund modal, leave reason blank
  2. Confirm submit disabled; then call API with empty reason
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** Client disables submit when reason.trim().length<5. Server requires non-empty trimmed reason → 400 {error:'reason required'}. Note: server min is effectively 1 char, client min is 5 — divergence.

#### `ORD-REFUND-008` Refund on non-existent order  — **P2** · _negative_
- **Pre:** admin+.
- **Steps:**
  1. POST /admin/refunds/from-order/<unknown-uuid> with amount+reason
- **API:** `POST /admin/refunds/from-order/<unknown-uuid>`
- **Expect:** loadBookingForRefund → ErrNotFound → 404 {error:'order not found'}.

### payouts-payroll  <sub>(24 flows — P0:12 P1:7 P2:5)</sub>

Two distinct money surfaces share the "payouts" name. (1) LEGACY manual disbursements: the Payouts page (/payouts) lists crm_payouts rows by status tab (pending/paid/failed) and lets an admin mark-paid (records UTR/external_ref) or mark-failed; backed by /admin/payouts* in payouts.go. (2) PAYROLL ENGINE: the Worker drawer's "Payouts" and "Targets & flags" tabs show cron-generated payout rows per worker with lifetime-paid + current-cycle cards, and let an admin mark-paid / mark-failed (reversal, preserves paid_at/paid_by) / recompute a single row against live shift data; backed by /admin/workers/:id/payroll-payouts, /admin/workers/:id/performance, /admin/payroll/payouts/:id/{mark-paid,mark-failed,recompute}, /admin/payroll/flags/:id/review. All money is int64 paise. Read needs role viewer; every mutation needs role admin. Payroll mutations write a payout_audit_log row inside the same DB transaction; the legacy page records audit best-effort outside the transaction.

**Pages:** `/payouts` · `/workers (drawer → Payouts tab)` · `/workers (drawer → Targets & flags tab)` · `n/a (api layer)` · `n/a (api layer)`

**Test data:** crm_admins rows for each tested role: one viewer, one support, one admin (and ideally superadmin). Login credentials for each so RBAC flows (PP-07, PR-11) can be executed in the real UI.; Legacy crm_payouts rows: at least one each in status 'pending', 'paid', 'failed'; plus a batch of >100 pending rows for the pagination edge (PP-04); plus rows with amount_cents = 0,1,99,100,1234567890 for money formatting (PP-08). worker_id must reference a non-deleted users row so the name/phone join renders.; A users row with role 'pro' AND a matching helpers row (id = user id) with effective_start_date set — required by both the worker drawer and WorkerPerformance (helpers.effective_start_date / deactivated_at).; payouts (payroll-engine) rows for that pro: one in 'pending_manual_payout' whose cycle window contains today (for the current-cycle card and PR-02/05), one 'paid' (for PR-03/06), one 'failed' with a non-null failure_reason (for PR-07/10). Use distinct cycle_start values (UNIQUE on pro_id,cycle_start).; shift_commitments + shift_sessions (with offline_at set, online_minutes/job_minutes populated) inside the payout's cycle window so recompute (PR-05/07) produces non-zero, verifiable numbers (e.g. 120 online / 60 job).; dispatched_jobs rows for the pro within the current cycle to exercise acceptance-rate states in PR-15: zero rows (na), a mix below 85%, and a mix at/above 85% (with pro_was_online_at_offer true and pro_on_another_job_at_offer false).; helper_flags rows for the pro: at least one status='open' for the current cycle (PR-13) and one already-reviewed (PR-14).; An invalid worker uuid string and a valid-but-nonexistent worker uuid for PR-16.

#### `PP-01` Legacy: mark a pending payout paid with external ref  — **P0** · _happy_
- **Pre:** Logged in as role=admin. At least one crm_payouts row in status 'pending'.
- **Steps:**
  1. Navigate to Payouts via the sidebar (Banknote icon)
  2. Confirm you are on the 'pending' tab (default)
  3. Find the target row; click 'Mark paid'
  4. In the confirm modal, type a UTR/txn id into the 'External ref (UTR, txn id)' field
  5. Click the 'Mark paid' confirm button
- **API:** `POST /admin/payouts/:id/paid`
- **Expect:** Success toast 'Marked paid.'; modal closes; the row disappears from the pending tab and appears under the 'paid' tab with status pill 'paid' and the external_ref shown in monospace next to the status.

#### `PP-02` Legacy: mark a pending payout failed with a cause note  — **P0** · _happy_
- **Pre:** Logged in as admin. A crm_payouts row in status 'pending'.
- **Steps:**
  1. Go to Payouts → pending tab
  2. Click 'Failed' on the target row
  3. Enter a cause in the 'Notes (cause)' field
  4. Click the destructive 'Mark failed' confirm button
- **API:** `POST /admin/payouts/:id/failed`
- **Expect:** Success toast 'Marked failed.'; row leaves pending tab and shows under 'failed' tab with a danger status pill.

#### `PP-05` Legacy: double-click Mark paid (idempotency / 409)  — **P0** · _idempotency_
- **Pre:** Admin. One pending crm_payouts row. Use browser devtools Network throttling or replay the request.
- **Steps:**
  1. Open Payouts → pending → click 'Mark paid', confirm
  2. Immediately (before list refetch) replay POST /admin/payouts/:id/paid for the same id (devtools 'Replay' or curl)
- **API:** `POST /admin/payouts/:id/paid`, `POST /admin/payouts/:id/paid`
- **Expect:** First call 200 {ok:true}; second call 409 with body {error:'payout not found or already paid/failed'} (UPDATE ... WHERE status IN ('pending','processing') matches 0 rows). Money is not double-marked. Note: the UI hides the button after refetch so the realistic repro is request replay.

#### `PP-07` Legacy: RBAC — viewer/support blocked from mark-paid  — **P0** · _rbac_
- **Pre:** Two logins: role=viewer (or support) and role=admin. A pending crm_payouts row. Required role for payouts.mark_paid = admin.
- **Steps:**
  1. Log in as viewer/support
  2. Open Payouts → pending tab
  3. Observe the 'Mark paid' and 'Failed' buttons
  4. Click 'Mark paid'
- **API:** `GET /admin/payouts`, `POST /admin/payouts/:id/paid (only if button somehow enabled)`
- **Expect:** Buttons are disabled with title 'Insufficient permissions'; clicking shows an error toast 'Insufficient permissions' and fires no request. Even if forced, backend returns 403 {error:'insufficient_permissions', required_role:'admin', your_role:'viewer'}. A viewer CAN still load the list (payouts.read = viewer).

#### `PR-01` Payroll: open worker drawer Payouts tab and read summary  — **P0** · _happy_
- **Pre:** Admin (or viewer for read). A worker (pro) with at least one payouts row written by the cron.
- **Steps:**
  1. Go to Workers, open the target worker's drawer
  2. Click the 'Payouts' tab
  3. Read the 'Lifetime paid' and 'Current cycle' cards and the Recent payouts table
- **API:** `GET /admin/workers/:id/payroll-payouts`
- **Expect:** Lifetime paid = SUM(net_pay_paise) of paid rows; current-cycle card shows the pending row whose cycle window contains today (or 'No pending payout'); Recent payouts lists up to 12 cycles newest-first with hours and net pay. Empty worker shows 'No payout rows yet'.

#### `PR-02` Payroll: mark a pending_manual_payout row paid  — **P0** · _happy_
- **Pre:** Admin. A payouts row in status 'pending_manual_payout' for the worker.
- **Steps:**
  1. Open worker drawer → Payouts tab
  2. On the pending row click 'Mark paid'
  3. Optionally type a bank-transfer ref into the notes textarea (max 500)
  4. Click 'Mark paid' in the modal
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** Toast 'Payout marked paid.'; query invalidates and refetches; row status becomes 'paid'; backend set paid_at, paid_by_admin_id = current admin, and wrote one payout_audit_log row in the same tx. Lifetime-paid card increases by net_pay_paise.

#### `PR-03` Payroll: mark-failed reversal of a paid row preserves paid_at/paid_by  — **P0** · _money_
- **Pre:** Admin. A payouts row already in status 'paid' (run PR-02 first).
- **Steps:**
  1. Open worker drawer → Payouts tab
  2. On the paid row click 'Reverse (mark failed)'
  3. Enter a required reason (1–500 chars)
  4. Click 'Mark failed'
- **API:** `POST /admin/payroll/payouts/:id/mark-failed`
- **Expect:** Toast 'Payout marked failed.'; status becomes 'failed'; failure_reason set; paid_at and paid_by_admin_id are PRESERVED (verify via DB or recompute audit). A second payout_audit_log row (action mark_failed) is written. Lifetime-paid card no longer counts this row.

#### `PR-05` Payroll: recompute a pending row against live shift data (money correctness, C1 formula)  — **P0** · _money_
- **Pre:** Admin. A pending_manual_payout payouts row. Seed the worker's shift_sessions (offline_at set) + shift_commitments inside the row's cycle, e.g. 120 online min + 60 job min.
- **Steps:**
  1. Open worker drawer → Payouts tab
  2. On the pending row click 'Recompute'
  3. Confirm in the ConfirmModal
- **API:** `POST /admin/payroll/payouts/:id/recompute`
- **Expect:** Toast 'Payout recomputed.'; online/working minutes update to the aggregated values; base_pay = online_min*8000/60, work_bonus = working_min*8000/60, gross = base+bonus (e.g. 120/60 → 16000 + 8000 = 24000 paise = ₹240), net = gross − deductions clamped ≥0. Status stays pending. One audit row written. NOTE the engine uses 8000 paise/hr for BOTH base and bonus, so every working minute is effectively paid twice (base+bonus) — verify against expected business pay (audit C1 divergence).

#### `PR-06` Payroll: recompute on a paid row is forbidden (403)  — **P0** · _negative_
- **Pre:** Admin. A payouts row in status 'paid'.
- **Steps:**
  1. Open worker drawer → Payouts tab on a worker with a paid row
  2. Note the paid row offers only 'Reverse (mark failed)', not Recompute
  3. Force POST /admin/payroll/payouts/:id/recompute for the paid id via devtools/curl
- **API:** `POST /admin/payroll/payouts/:id/recompute`
- **Expect:** 403 {error:'paid rows are immutable; mark-failed first'}; row unchanged. Confirms paid rows can't be silently overwritten. UI never exposes Recompute on paid rows.

#### `PR-08` Payroll: double mark-paid conflict (idempotency / 409)  — **P0** · _idempotency_
- **Pre:** Admin. A pending_manual_payout row.
- **Steps:**
  1. Open Payouts tab → Mark paid → confirm
  2. Before the refetch completes, replay POST /admin/payroll/payouts/:id/mark-paid for the same id (devtools Replay)
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`, `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** First 200 with updated Payout JSON; second 409 with body {error:'invalid status transition: action=mark_paid allowed_from=pending_manual_payout current=paid'}. The FOR UPDATE snapshot + status-gated UPDATE prevent a second paid transition. No double payment recorded.

#### `PR-09` Payroll: concurrent mark-paid vs recompute on same row  — **P0** · _concurrency_
- **Pre:** Admin. A pending_manual_payout row. Use two parallel requests (curl & or two devtools tabs).
- **Steps:**
  1. Fire POST /admin/payroll/payouts/:id/mark-paid and POST /admin/payroll/payouts/:id/recompute as close to simultaneously as possible for the same id
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`, `POST /admin/payroll/payouts/:id/recompute`
- **Expect:** Both take FOR UPDATE on the row so they serialize. One wins; the loser sees the other's committed state: if mark-paid commits first, recompute returns 403 (paid immutable); if recompute commits first, mark-paid still succeeds (still pending). No interleaved partial write, no lost update.

#### `PR-11` Payroll: RBAC — viewer can read, cannot mutate; support also blocked  — **P0** · _rbac_
- **Pre:** Logins for role=viewer and role=support. A pending payouts row. payouts.read=viewer; mark_paid/mark_failed/recompute=admin.
- **Steps:**
  1. Log in as viewer; open a worker drawer → Payouts tab
  2. Confirm cards + table render (read allowed)
  3. Confirm Mark paid / Recompute / Mark failed buttons are absent (wrapped in <Can perm=...>)
  4. Repeat as support — same result
  5. Force POST /admin/payroll/payouts/:id/mark-paid via curl with a support token
- **API:** `GET /admin/workers/:id/payroll-payouts`, `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** Viewer/support see read-only data and no mutation buttons. A forced mutation returns 403 {error:'insufficient_permissions', required_role:'admin', your_role:'support'} and the client surfaces toast 'Insufficient permissions. Requires admin; you are support.'

#### `PP-03` Legacy: tab switching and empty states  — **P1** · _edge_
- **Pre:** Admin. crm_payouts has rows in some statuses but at least one status (e.g. 'failed') is empty.
- **Steps:**
  1. Open Payouts
  2. Click each tab: pending, paid, failed
  3. Observe the empty tab
- **API:** `GET /admin/payouts?status=pending&limit=100`, `GET /admin/payouts?status=paid&limit=100`, `GET /admin/payouts?status=failed&limit=100`
- **Expect:** Each tab fires a fresh list call with its status. An empty tab renders EmptyState 'No <status> payouts'. The Actions column header only appears on the pending tab.

#### `PP-06` Legacy: mark-failed cannot reverse a paid row (state-machine gate)  — **P1** · _negative_
- **Pre:** Admin. A crm_payouts row already in status 'paid'.
- **Steps:**
  1. Note the paid row's id (it is on the 'paid' tab, which has NO action buttons)
  2. Manually issue POST /admin/payouts/:id/failed with that id (devtools/curl) since the UI offers no control on the paid tab
- **API:** `POST /admin/payouts/:id/failed`
- **Expect:** 409 {error:'payout not found or already paid/failed'} — the legacy module cannot reverse a paid row (WHERE status IN ('pending','processing')). Confirm a paid legacy payout is effectively immutable from the UI (no reversal path exists), unlike the payroll-engine surface.

#### `PP-08` Legacy: money formatting at zero and large values  — **P1** · _money_
- **Pre:** Admin. Seed crm_payouts rows with amount_cents = 0, 1, 99, 100, and a large value like 1234567890.
- **Steps:**
  1. Open Payouts
  2. Locate the seeded rows
  3. Read the Amount column for each
- **API:** `GET /admin/payouts`
- **Expect:** Amounts render as ₹ with no decimals (maximumFractionDigits:0): 0→₹0, 1→₹0, 99→₹1 (rounds), 100→₹1, 1234567890→₹1,23,45,679 (Indian grouping). Confirm no NaN/undefined; null amount renders ₹0. Note rounding hides sub-rupee paise — acceptable for display only.

#### `PR-04` Payroll: mark-failed requires a non-empty reason  — **P1** · _negative_
- **Pre:** Admin. A pending_manual_payout row.
- **Steps:**
  1. Open Payouts tab → click 'Mark failed' on the pending row
  2. Leave the reason textarea empty
  3. Observe the confirm button
  4. (Optional) submit only-whitespace via request to confirm backend trim
- **API:** `POST /admin/payroll/payouts/:id/mark-failed`
- **Expect:** The 'Mark failed' button is disabled while reason.trim().length < 1. If forced with whitespace-only, backend trims and returns 400 {error:'reason: required'}. >500 chars returns 400 {error:'reason: max 500 chars'} (textarea also caps maxLength=500).

#### `PR-07` Payroll: recompute a failed row flips it back to pending and clears failure_reason  — **P1** · _happy_
- **Pre:** Admin. A payouts row in status 'failed' with a non-null failure_reason. Seed shift data so recompute writes non-zero numbers.
- **Steps:**
  1. Open worker drawer → Payouts tab
  2. On the failed row click 'Recompute' (the only action shown for failed rows)
  3. Confirm
- **API:** `POST /admin/payroll/payouts/:id/recompute`
- **Expect:** Status returns to 'pending_manual_payout'; failure_reason cleared (red text disappears); hours/pay updated from live data; the now-pending row shows Mark paid / Recompute / Mark failed again. Audit row records before.status='failed' → after.status='pending_manual_payout'.

#### `PR-10` Payroll: mark-paid on a failed row is rejected (state machine)  — **P1** · _negative_
- **Pre:** Admin. A payouts row in status 'failed'.
- **Steps:**
  1. Open Payouts tab — note the failed row offers only Recompute
  2. Force POST /admin/payroll/payouts/:id/mark-paid for the failed id via devtools/curl
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** 409 {error:'invalid status transition: action=mark_paid allowed_from=pending_manual_payout current=failed'}. A failed row must be recomputed back to pending before it can be paid (UI enforces this by only showing Recompute on failed).

#### `PR-13` Payroll: review a performance flag (reviewed/dismissed/escalated)  — **P1** · _happy_
- **Pre:** Admin (flags.review=admin). A helper_flags row in status 'open' for the worker's current cycle.
- **Steps:**
  1. Open worker drawer → 'Targets & flags' tab
  2. Locate an open flag (hours_target_missed or acceptance_below_threshold)
  3. Choose an action (reviewed / dismissed / escalated)
  4. Enter optional notes (≤500) and confirm
- **API:** `GET /admin/workers/:id/performance`, `POST /admin/payroll/flags/:id/review`
- **Expect:** Flag transitions out of 'open' (status updates, reviewed_by_admin_id + reviewed_at set); it leaves the open-flags list on refetch. A general audit log entry (payroll_flag.<action>) is recorded.

#### `PP-04` Legacy: list caps at 100 rows (no pagination UI)  — **P2** · _edge_
- **Pre:** Admin. Seed >100 crm_payouts rows in status 'pending'.
- **Steps:**
  1. Open Payouts → pending tab
  2. Scroll the table to the bottom
  3. Count rows / compare against DB count
- **API:** `GET /admin/payouts?status=pending&limit=100`
- **Expect:** Exactly 100 rows render; there is NO next-page control, so rows beyond 100 are invisible. Confirm this is the known limitation (the page never sends offset). Flag if a tester expects all rows.

#### `PR-12` Payroll: missing admin identity surfaces as 401 not 500  — **P2** · _negative_
- **Pre:** Ability to send a request that passes RequirePermission but lacks crmAdminID local (hard to hit normally; document expected behavior).
- **Steps:**
  1. Inspect mapErr handling for ErrMissingRequired
  2. If reproducible (e.g. token with role but no admin id claim), POST a mark-paid
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** Backend returns 401 {error:'admin identity not established'} rather than 500, and logs a middleware-bug error. Verify no audit row and no status change occurred.

#### `PR-14` Payroll: review an already-reviewed flag is rejected  — **P2** · _negative_
- **Pre:** Admin. A helper_flags row NOT in status 'open' (already reviewed).
- **Steps:**
  1. Force POST /admin/payroll/flags/:id/review with action 'dismissed' for a non-open flag id
- **API:** `POST /admin/payroll/flags/:id/review`
- **Expect:** 409 {error:'invalid status transition'} (UPDATE ... WHERE status='open' matches 0 rows → ErrInvalidTransition). No second review recorded.

#### `PR-15` Payroll: performance tab proration, acceptance threshold and N/A states  — **P2** · _edge_
- **Pre:** Admin. Workers with: (a) acceptance 0 dispatched, (b) acceptance just below 85%, (c) just at/above 85%, (d) effective_start_date after cycle end (zero overlap).
- **Steps:**
  1. Open each worker's 'Targets & flags' tab
  2. Read Target hours, online/working hours, hours status, acceptance rate + status
- **API:** `GET /admin/workers/:id/performance`
- **Expect:** Acceptance: 0 dispatched → status 'na', no rate; <0.85 → 'below_threshold'; ≥0.85 → 'ok' (verify boundary exactly at 0.85 reads 'ok'). Hours: target=0 (no overlap) → 'na'; online<target → 'behind'; else 'on_track'. Target uses ceil(80/14*days) proration.

#### `PR-16` Payroll: invalid worker id returns clean error not crash  — **P2** · _negative_
- **Pre:** Admin.
- **Steps:**
  1. Request GET /admin/workers/not-a-uuid/payroll-payouts via devtools/curl
- **API:** `GET /admin/workers/:id/payroll-payouts`
- **Expect:** 500 {error:'internal error'} (uuid cast fails in query) — confirm it does not leak SQL and the UI shows an error/skeleton rather than white-screening. Compare against a valid-but-nonexistent worker uuid (returns empty summary, lifetime 0, no rows).

### promos  <sub>(29 flows — P0:11 P1:13 P2:5)</sub>

CRM promos area lets admins create, edit, activate/deactivate, and view stats for discount promo codes used at booking time by the user app. The backend enforces discount caps (percent 1..100, fixed 1..1,000,000 paise) and a future-expiry check on create; money is integer paise throughout. Reads require role viewer; create/update/toggle require role admin.

**Pages:** `/promos` · `(api) /Users/adityarohilla/Documents/ZopMop/App/zopmop-crm/src/api/all.ts` · `(backend) /admin/promos`

**Test data:** CRM admin accounts at each role: viewer, support, admin, superadmin (to exercise RBAC flows). Role is read from JWT claims into crmAdminRole.; Several promotions rows: one active with expires_at NULL; one is_active=false; one is_active=true with expires_at in the past (for status-filter test PROMO-EDGE-02).; One promotion created with audience='specific' and a non-empty audience_user_ids array, plus a non-empty categories array (DB insert; editor has no UI for these) for the no-wipe edit test PROMO-HAPPY-03.; 60+ promotions rows to trigger pagination/limit edge cases (PROMO-EDGE-05/06).; bookings rows referencing a promo_code: mix of status='completed' and status='cancelled', with amount_paise and discount_paise set, and varied customer_id, for stats tests PROMO-HAPPY-06 / PROMO-MONEY-02.; A crm_webhook subscriber row subscribed to event 'admin.promo.created' (to observe the un-guarded webhook fire in PROMO suspectedBug verification).; Access to the audit log table (crm_audit_log or equivalent) or the audit UI to verify promo.create/update/activate/deactivate/view entries.; An existing promo code (e.g. SAVE10) to test duplicate-code rejection (PROMO-NEG-03).

#### `PROMO-CONC-01` Double-click Save does not create two promos  — **P0** · _concurrency_
- **Pre:** admin role; New promo with valid fields; throttle network in devtools to widen the window.
- **Steps:**
  1. Fill a valid new promo. Click 'Save' to open ConfirmModal.
  2. Rapidly double-click the 'Create' button in the ConfirmModal.
- **API:** `POST /admin/promos`
- **Expect:** ConfirmModal.go() guards with busy flag (returns early if busy) and disables the button while busy ('Working…'). Only ONE POST /admin/promos fires; only one promo created. Verify list shows a single row.

#### `PROMO-EDGE-03` Discount cap boundary values (percent 100 and 101; fixed 1,000,000 and +1)  — **P0** · _edge_
- **Pre:** admin role; New promo modal.
- **Steps:**
  1. Percent type, Value = 100 — Save/Create. Expect success.
  2. New promo, Percent, Value = 101 — Save/Create. Expect 400.
  3. New promo, Fixed, Value = 1000000 — expect success.
  4. New promo, Fixed, Value = 1000001 — expect 400.
- **API:** `POST /admin/promos`
- **Expect:** 100% and 1,000,000 paise accepted (200). 101% rejected with toast 'percent discount_value must be 1..100'. 1,000,001 rejected with toast 'fixed discount_value must be 1..1000000 paise (₹10,000 max)'. ConfirmModal stays open on 400.

#### `PROMO-EDGE-04` Zero and negative discount value rejected  — **P0** · _edge_
- **Pre:** admin role; New promo modal.
- **Steps:**
  1. Percent, Value = 0 — note the input has min=1 so you may need to type then clear; if 0/empty reaches backend it sends discount_value 0. Save/Create.
  2. Try Value = -5 (type into number field). Save/Create.
- **API:** `POST /admin/promos`
- **Expect:** 0 and negative both rejected by validateCreateRequest (DiscountValue<=0). 400 with toast 'percent discount_value must be 1..100'. The HTML min=1 is only a hint; verify backend enforces it (it does).

#### `PROMO-HAPPY-01` Create a valid percent promo end-to-end  — **P0** · _happy_
- **Pre:** Logged in as admin role. CRM at http://localhost:5174, backend :8090. No existing promo with the code you choose.
- **Steps:**
  1. Open /promos.
  2. Click the 'New promo' button (top-right; only visible with promos.create).
  3. In the CODE field type SAVE10 (auto-uppercases), or click 'Generate' (calls generate-code).
  4. Internal name: 'Spring 10%'. Description: 'Save 10 percent'.
  5. Discount type select = 'Percent (%)'. Value field = 10.
  6. Min order (₹ × 100) = 50000 (₹500). Max total uses = 100. Max per user = 1. Audience = 'All users'.
  7. Set 'Expires at' to a datetime ~1 month in the future.
  8. Click 'Save', then in the ConfirmModal click 'Create'.
- **API:** `GET /admin/promos/generate-code`, `POST /admin/promos`, `GET /admin/promos (refetch on invalidate)`
- **Expect:** Success toast 'Promo created.'; modal closes; row SAVE10 appears in list with discount '10%', Used '0 / 100', active StatusPill. POST returns 200 with the created promo JSON.

#### `PROMO-HAPPY-02` Create a valid fixed-amount promo (paise)  — **P0** · _money_
- **Pre:** admin role. Code free.
- **Steps:**
  1. /promos > New promo.
  2. Code = FLAT200. Discount type = 'Fixed (paise)'. Value (paise) = 20000 (= ₹200).
  3. Confirm the ConfirmModal impact line shows 'Discount: ₹200' (fmt divides by 100).
  4. Save > Create.
- **API:** `POST /admin/promos`
- **Expect:** Toast 'Promo created.'. List row shows discount rendered via fmt as '₹200' (discount_value 20000 paise / 100). No float in payload — discount_value is the integer 20000.

#### `PROMO-HAPPY-03` Edit an existing promo without wiping audience/categories  — **P0** · _happy_
- **Pre:** admin role. A promo exists that was created with audience='specific' and a non-empty audience_user_ids array (insert via DB — the editor has no UI for it).
- **Steps:**
  1. /promos > click the promo row to open Edit modal.
  2. Change only Max per user from 1 to 3.
  3. Save > Save.
- **API:** `PUT /admin/promos/:id`, `GET /admin/promos`
- **Expect:** Toast 'Promo updated.'. Re-open the promo (or query DB): audience_user_ids and categories are unchanged because PromosPage.tsx:132-133 echoes promo.audience_user_ids/categories back into the PUT body. Confirms the no-wipe safeguard.

#### `PROMO-HAPPY-04` Activate / deactivate toggle from edit modal  — **P0** · _happy_
- **Pre:** admin role. An active promo exists.
- **Steps:**
  1. Open the active promo's Edit modal.
  2. Click 'Deactivate' (bottom-left, warning colored).
  3. In ConfirmModal read impact 'Code ... will stop working immediately. Past orders are unaffected.' Click 'Deactivate'.
  4. Re-open the same promo and click 'Activate', confirm.
- **API:** `POST /admin/promos/:id/deactivate`, `POST /admin/promos/:id/activate`
- **Expect:** Toast 'Status updated.' each time; list StatusPill flips active<->inactive. Each call returns {ok:true}.

#### `PROMO-MONEY-01` Fixed discount stored exactly as paise integer (no float drift)  — **P0** · _money_
- **Pre:** admin role.
- **Steps:**
  1. Create a fixed promo with Value (paise) = 12345 (i.e. ₹123.45).
  2. Re-open and inspect; also query DB promotions.discount_value.
- **API:** `POST /admin/promos`, `GET /admin/promos/:id`
- **Expect:** discount_value persists as exactly 12345 (int). UI fmt renders ₹123 (maximumFractionDigits:0 truncates display but stored value is exact). No float anywhere in the path — confirms int64 paise invariant.

#### `PROMO-NEG-04` Negative min_order / max_uses / max_per_user reach DB unvalidated  — **P0** · _negative_
- **Pre:** admin role.
- **Steps:**
  1. Via API: POST /admin/promos with code='NEG1', discount_type='percent', discount_value=10, min_order_paise=-100, max_uses=-5, max_per_user=-1.
  2. Also try via UI: type -5 into 'Max total uses'.
- **API:** `POST /admin/promos`
- **Expect:** validateCreateRequest does NOT check these fields (only code + discount). They pass to the INSERT. If no DB CHECK exists, a negative-min-order or negative-max-uses promo is created (200). This contradicts the code comment 'basic non-negativity'. Flag (suspectedBug). Pass criterion: confirm whether DB rejects (then 400) or accepts (then bug).

#### `PROMO-RBAC-01` Viewer cannot see 'New promo' button or create  — **P0** · _rbac_
- **Pre:** Logged in as role 'viewer' (required for create is 'admin'). promos.read is allowed for viewer.
- **Steps:**
  1. Open /promos as viewer — confirm the list loads (read permitted).
  2. Confirm the 'New promo' button is absent (wrapped in <Can perm='promos.create'>).
  3. Open an existing promo (row click still works — GET /:id is read). In the editor, confirm 'Save' is disabled with title 'Insufficient permissions'.
  4. Click 'Save' anyway (it's disabled) and also attempt POST /admin/promos directly via API as viewer.
- **API:** `GET /admin/promos`, `GET /admin/promos/:id`, `POST /admin/promos`
- **Expect:** List + detail load (200). 'New promo' hidden; 'Save'/'Deactivate' disabled. Direct POST returns 403 {error:'insufficient_permissions', required_role:'admin', your_role:'viewer'}; interceptor toast 'Insufficient permissions. Requires admin; you are viewer.' Required role: admin. Insufficient: viewer/support.

#### `PROMO-RBAC-02` Support role blocked from update and toggle  — **P0** · _rbac_
- **Pre:** Logged in as role 'support' (rank 1; create/update/toggle need admin rank 2).
- **Steps:**
  1. Open /promos as support; open an existing promo.
  2. Confirm 'Save' and 'Deactivate' buttons are disabled (canUpdate/canToggle false).
  3. Directly call PUT /admin/promos/:id and POST /admin/promos/:id/deactivate as support.
- **API:** `PUT /admin/promos/:id`, `POST /admin/promos/:id/deactivate`, `POST /admin/promos/:id/activate`
- **Expect:** Both direct calls return 403 insufficient_permissions required_role 'admin' your_role 'support'. UI buttons disabled. Confirms toggle (deactivate/activate) is admin-gated, not support.

#### `PROMO-AUDIT-01` Writes produce audit-log entries  — **P1** · _happy_
- **Pre:** admin role. Audit recorder wired (non-nil). Access to crm_audit_log table or audit UI.
- **Steps:**
  1. Create a promo, then update it, then deactivate, then activate.
  2. Open the same promo detail (GET /:id).
  3. Inspect audit log filtered by module='promos'.
- **API:** `POST /admin/promos`, `PUT /admin/promos/:id`, `POST /admin/promos/:id/deactivate`, `POST /admin/promos/:id/activate`, `GET /admin/promos/:id`
- **Expect:** Audit entries: promo.create (after=req), promo.update (after=req), promo.deactivate, promo.activate, promo.view (on GET /:id). Each has admin id/email, IP, user-agent. NOTE: update/deactivate/activate record before=nil (no pre-state snapshot) so the diff trail lacks the prior values — verify and flag if before-state is expected.

#### `PROMO-CONC-02` Concurrent activate/deactivate from stale snapshot  — **P1** · _concurrency_
- **Pre:** admin role. Open the same active promo in two browser tabs.
- **Steps:**
  1. Tab A: Edit modal open, promo is active. Tab B: same, active.
  2. Tab A: Deactivate > confirm (now inactive in DB).
  3. Tab B (still thinks promo is active): click Deactivate > confirm.
- **API:** `POST /admin/promos/:id/deactivate`
- **Expect:** Tab B's toggle uses promo.is_active from its stale snapshot, so it calls deactivate AGAIN. SetActive does an unconditional UPDATE ... SET is_active=false (no compare); RowsAffected=1 so it returns {ok:true} even though already inactive — a no-op success. No error, but verify the resulting state is correct (inactive). Documents the stale-toggle behavior.

#### `PROMO-EDGE-01` Empty list / no-results states  — **P1** · _edge_
- **Pre:** admin role. Either zero promos in DB, or a search that matches nothing.
- **Steps:**
  1. Open /promos with an empty promotions table — observe table body.
  2. With promos present, type a code in 'Search code…' that matches nothing (e.g. ZZZZZZ).
- **API:** `GET /admin/promos?search=ZZZZZZ&status=&limit=50&offset=0`
- **Expect:** EmptyState 'No promos' rendered in a single full-width row. No JS errors. Search debounce: each keystroke re-queries (offset reset to 0).

#### `PROMO-EDGE-02` Status filter: active / inactive / expired semantics  — **P1** · _edge_
- **Pre:** admin role. Seed 3 promos: (A) is_active=true, expires_at NULL; (B) is_active=false; (C) is_active=true, expires_at in the past.
- **Steps:**
  1. Select status = 'Active' — expect A only (active AND (expires NULL OR expires>now)).
  2. Select 'Inactive' — expect B only (is_active=false).
  3. Select 'Expired' — expect C (expires_at <= now), regardless of is_active.
  4. Select 'All' — expect all three.
- **API:** `GET /admin/promos?status=active`, `GET /admin/promos?status=inactive`, `GET /admin/promos?status=expired`, `GET /admin/promos?status=`
- **Expect:** Each filter returns exactly the matching rows per the SQL conds in promos.go:84-91. Note an active-but-expired promo (C) shows under 'Expired' not 'Active' — verify it's excluded from Active.

#### `PROMO-EDGE-05` Large list pagination unreachable from UI  — **P1** · _edge_
- **Pre:** admin role. Seed 60+ promos so total_count > limit (50).
- **Steps:**
  1. Open /promos with default filters.
  2. Scroll the table; look for any next/prev page control.
- **API:** `GET /admin/promos?limit=50&offset=0`
- **Expect:** Only the first 50 promos render. There is NO pagination UI (params.offset is never changed in PromosPage). Promos beyond row 50 are unreachable except via search. Flag as a usability/data-visibility gap (see suspectedBugs).

#### `PROMO-EDGE-07` Expiry-in-the-past rejected on CREATE but check is missing on UPDATE  — **P1** · _edge_
- **Pre:** admin role. One existing valid promo.
- **Steps:**
  1. New promo, fill valid fields, set 'Expires at' to yesterday. Save > Create — expect 400.
  2. Now open an EXISTING promo's Edit modal, set 'Expires at' to yesterday, Save > Save — observe.
- **API:** `POST /admin/promos`, `PUT /admin/promos/:id`
- **Expect:** CREATE returns 400 'expires_at must be in the future' (promos.go:203). UPDATE has NO such check (promos.go Update) — it returns 200 'Promo updated.' with a past expiry, unless a DB constraint blocks it. Document the discrepancy (suspectedBug).

#### `PROMO-EDGE-09` IST <-> UTC datetime round-trip correctness  — **P1** · _edge_
- **Pre:** admin role. Browser timezone irrelevant (offset is hardcoded +5:30).
- **Steps:**
  1. Create a promo with 'Expires at' = 2026-12-31T23:30 (IST wall clock).
  2. Save > Create. Re-open the promo's Edit modal.
- **API:** `POST /admin/promos`, `GET /admin/promos/:id`
- **Expect:** istInputToUTC stores 2026-12-31T18:00:00Z (subtracts 5:30). On re-open utcToISTInput adds 5:30 back, refilling the field as 2026-12-31T23:30. Round-trip must be lossless. Confirm no off-by-5:30 drift.

#### `PROMO-HAPPY-06` View promo redemption stats  — **P1** · _money_
- **Pre:** admin/viewer role. A promo whose code appears as promo_code on some bookings rows (at least one with status='completed').
- **Steps:**
  1. Trigger the stats call (note: PromosPage UI does not appear to render stats; exercise via the API or wherever stats is surfaced). GET /admin/promos/:id/stats.
  2. Inspect response.
- **API:** `GET /admin/promos/:id/stats`
- **Expect:** JSON {redemptions, unique_users, discount_paise, revenue_paise}. revenue_paise only sums bookings with status='completed' (FILTER clause); discount_paise sums all rows with that promo_code. All money is int64 paise.

#### `PROMO-MONEY-02` Stats revenue counts only completed bookings  — **P1** · _money_
- **Pre:** viewer+ role. A promo code with 3 bookings: 2 status='completed' (amount_paise 50000 each), 1 status='cancelled' (amount_paise 30000). Each booking has discount_paise=5000.
- **Steps:**
  1. GET /admin/promos/:id/stats for that promo.
  2. Inspect revenue_paise and discount_paise and redemptions.
- **API:** `GET /admin/promos/:id/stats`
- **Expect:** redemptions=3 (all rows), unique_users=distinct customer_id, discount_paise=15000 (sum of all 3), revenue_paise=100000 (only the 2 completed, FILTER WHERE status='completed'). Verify the cancelled booking's amount is excluded from revenue but its discount IS counted — confirm this is the intended business rule.

#### `PROMO-NEG-01` Invalid discount_type rejected  — **P1** · _negative_
- **Pre:** admin role.
- **Steps:**
  1. Via API (UI select only offers percent/fixed): POST /admin/promos with discount_type='bogus', discount_value=10, code='X1'.
- **API:** `POST /admin/promos`
- **Expect:** 400 with body {error:"discount_type must be 'percent' or 'fixed'"}. Toast surfaces that exact message.

#### `PROMO-NEG-02` Missing code rejected  — **P1** · _negative_
- **Pre:** admin role; New promo modal.
- **Steps:**
  1. Leave CODE empty. Fill Percent, Value=10. Save > Create.
- **API:** `POST /admin/promos`
- **Expect:** 400 {error:'code required'}; toast 'code required'; ConfirmModal stays open so user can fix.

#### `PROMO-NEG-03` Duplicate code rejected (DB unique constraint)  — **P1** · _negative_
- **Pre:** admin role. A promo with code SAVE10 already exists.
- **Steps:**
  1. New promo, CODE = save10 (lowercase; UI uppercases to SAVE10). Valid discount. Save > Create.
- **API:** `POST /admin/promos`
- **Expect:** Backend uppercases via strings.ToUpper and the INSERT hits the unique constraint -> Create wraps it as 'create promo: ...' -> 400. Toast shows the wrapped DB error. Verify the message is reasonable (not a raw 500). Note: a duplicate is currently surfaced as 400 from Create's catch-all, exposing the wrapped error string.

#### `PROMO-RBAC-03` Admin and superadmin both allowed (hierarchy)  — **P1** · _rbac_
- **Pre:** Test once as 'admin', once as 'superadmin'.
- **Steps:**
  1. As admin: create, edit, deactivate a promo — all succeed.
  2. As superadmin: repeat — all succeed (inherits via roleRank).
- **API:** `POST /admin/promos`, `PUT /admin/promos/:id`, `POST /admin/promos/:id/deactivate`
- **Expect:** All succeed (200) for both roles. Confirms superadmin (rank 3) inherits admin (rank 2) permissions.

#### `PROMO-EDGE-06` Backend limit clamp (limit>200 or <=0 falls back to 50)  — **P2** · _edge_
- **Pre:** admin role.
- **Steps:**
  1. Call GET /admin/promos?limit=99999&offset=0 directly.
  2. Call GET /admin/promos?limit=0.
  3. Call GET /admin/promos?offset=-5.
- **API:** `GET /admin/promos?limit=99999`, `GET /admin/promos?limit=0`, `GET /admin/promos?offset=-5`
- **Expect:** Repository.List clamps: limit>200 or <=0 becomes 50; offset<0 becomes 0. Response echoes the RAW requested limit/offset in the JSON (it returns the parsed limit/offset, not the clamped values) — verify the items count matches the clamp (<=50), even though the echoed limit may be 99999.

#### `PROMO-EDGE-08` starts_at after expires_at accepted  — **P2** · _edge_
- **Pre:** admin role.
- **Steps:**
  1. New promo, valid discount, set 'Starts at' = next month, 'Expires at' = next week (start after expiry).
  2. Save > Create.
- **API:** `POST /admin/promos`
- **Expect:** No ordering validation exists — backend accepts it (200) unless a DB CHECK rejects. This creates a promo that can never be valid. Flag (suspectedBug).

#### `PROMO-HAPPY-05` Generate-code button yields a unique 8-char code  — **P2** · _happy_
- **Pre:** admin role; New promo modal open.
- **Steps:**
  1. Click 'Generate' next to the CODE field.
  2. Observe the CODE field fills with 8 uppercase chars from set ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I/O/0/1).
  3. Click 'Generate' a few more times.
- **API:** `GET /admin/promos/generate-code`
- **Expect:** Each click returns a different 8-char code; none collide with an existing promo (backend checks EXISTS before returning).

#### `PROMO-NEG-05` Update non-existent promo returns 404-equivalent  — **P2** · _negative_
- **Pre:** admin role.
- **Steps:**
  1. Via API: PUT /admin/promos/00000000-0000-0000-0000-000000000000 with a valid body.
- **API:** `PUT /admin/promos/:id`
- **Expect:** Repository.Update returns ErrNotFound when RowsAffected()==0, but the handler maps ALL Update errors to 400 (not 404). So you get 400 {error:'promo not found'}. Note the wrong status code (should be 404) — flag (suspectedBug).

#### `PROMO-NEG-06` Malformed JSON body rejected  — **P2** · _negative_
- **Pre:** admin role.
- **Steps:**
  1. Via API: POST /admin/promos with a non-JSON or broken body.
- **API:** `POST /admin/promos`
- **Expect:** 400 {error:'invalid body'} from BodyParser failure. Toast surfaces it.

### workers  <sub>(36 flows — P0:10 P1:15 P2:11)</sub>

The Workers area manages "Pro" (helper) accounts: a filterable/sortable/paginated list (WorkersPage), a 6-tab detail Drawer (Profile w/ KYC + lifecycle actions, Performance, Targets & flags, Actions, Deductions, Payouts), and a 5-step admin-driven create wizard (WorkerNewPage). Status is a rollup derived server-side from users.banned_at / is_suspended and helpers.approval_status (active|pending|rejected|suspended|banned). KYC (Aadhaar, bank account, IFSC) is stored and returned in plaintext to any admin >= support role with no role masking and no reveal-audit (open audit item C7).

**Pages:** `/workers` · `/workers?id=<uuid>` · `/workers/new` · `n/a (api module)` · `n/a (backend)` · `n/a (backend)`

**Test data:** Admin CRM account with role 'admin' (full workers write access) and TOTP set up for login; Separate CRM accounts with role 'support' (read-only PII) and 'viewer' (should be blocked from workers.read) to exercise RBAC flows; At least one worker in EACH status: active (approved, not suspended), pending (helpers.approval_status='pending'), rejected, suspended (users.is_suspended), banned (users.banned_at); One worker with KYC fully populated (aadhaar_number 12 digits, bank_account_number, bank_ifsc, bank_account_holder_name) to test PII reveal/masking and C7; One worker that is is_available=TRUE with helpers.last_location_at within 90s AND a booking in accepted/arrived/in_progress (for online dot, live-job warning, and force-offline-with-active-job); One worker with is_available=TRUE but a stale last_location_at (>90s) to test the Online-only filter exclusion; At least 26 pro accounts total so list pagination has a 2nd page; and a filter that yields exactly 25 for the boundary test; Active rows in the localities table (for locality edit dropdown + canonical resolution) and at least one active zone (for create wizard Zone select); A user with role='customer' on a known 10-digit phone and NO helpers row (to test customer->pro promotion on create); A user already role='pro'/'admin' on a known phone (to test 409 phone-in-use); A worker with admin_pro_deductions rows (some reversed) to test deduction history; and one with zero deductions for the empty state; A worker with payroll payout rows in pending_manual_payout, paid, and failed states (for mark-paid/mark-failed/recompute money flows); A worker with at least one open helper performance flag (hours_target_missed and/or acceptance_below_threshold) for the Targets & flags review flow; An existing leave balance row for a worker (to test leave grant/deduct and balance display)

#### `WRK-CREATE-001` Create a new Pro end-to-end (happy path)  — **P0** · _happy_
- **Pre:** Logged in as admin; an active locality exists; phone not already a pro.
- **Steps:**
  1. Click 'New Pro' on /workers
  2. Step Personal: enter name (>=2 chars), optional DOB (age 18-80), gender, languages; click Next
  3. Step Contact: enter a valid 10-digit phone (6-9 start); click Next
  4. Step Work: pick a locality, pick >=1 category, leave hours at 80; click Next
  5. Step KYC: optionally enter 12-digit Aadhaar, 9-18 digit account, valid IFSC; click Next
  6. Step Review: verify masked KYC; click Submit
- **API:** `GET /admin/localities`, `GET /admin/zones`, `POST /admin/workers`
- **Expect:** 201 Created; success toast naming +91<phone>; navigates to /workers?id=<newId> opening the new worker's drawer. start_active unchecked => approval_status 'pending' (in_training); checked => 'approved'. Requires workers.create (admin).

#### `WRK-DEDUCT-001` Apply a manual deduction (money correctness)  — **P0** · _money_
- **Pre:** Worker open in drawer; logged in as admin (workers.deduct).
- **Steps:**
  1. Actions tab, Manual Deduction card
  2. Enter Amount 250.50, Reason 'uniform cost'
  3. Optionally set a Fortnight start date
  4. Click 'Apply deduction'
  5. Open Deductions tab and verify the row
- **API:** `POST /admin/workers/:id/deductions {amount_paise, reason, fortnight_start?}`, `GET /admin/workers/:id/deductions`
- **Expect:** FE converts rupees to paise via Math.round(amount*100) => 25050 paise; success toast '₹250.5 applied'. Deduction row shows ₹250.50 exact. Backend rejects amount_paise<=0 or empty reason with 400. Verify a value like 99999.99 round-trips to 9999999 paise with no float drift.

#### `WRK-DETAIL-001` Open drawer shows full profile + tabs  — **P0** · _happy_
- **Pre:** A worker exists with name, phone, locality, categories, KYC populated.
- **Steps:**
  1. On /workers click any row
  2. Observe header (name, status pill, phone, locality) + 6 tabs
  3. Click through Profile, Performance, Targets & flags, Actions, Deductions, Payouts
- **API:** `GET /admin/workers/:id`, `GET /admin/workers/:id/jobs`, `GET /admin/workers/:id/active-job`, `GET /admin/workers/:id/payroll-payouts`, `GET /admin/workers/:id/performance`, `GET /admin/leaves/balances?pro_id=:id`, `GET /admin/workers/:id/deductions`
- **Expect:** Drawer opens, URL gets ?id=. GET /admin/workers/:id returns and a 'worker.view' audit row is written. Each tab lazily fires its own query. Browser Back closes the drawer (popstate clears ?id=).

#### `WRK-LIFECYCLE-APPROVE-001` Approve a pending worker  — **P0** · _happy_
- **Pre:** Worker in 'pending' status (helpers.approval_status='pending').
- **Steps:**
  1. Open the pending worker, Profile tab
  2. Click 'Approve' (only shown when status is pending)
  3. In the confirm modal click 'Confirm'
  4. Observe success toast and status pill flips to Active
- **API:** `POST /admin/workers/:id/approve`
- **Expect:** approval_status -> 'approved', linked user promoted to role 'pro', status pill becomes Active, webhook EventAdminWorkerApproved fires, audit 'worker.approve' written. Requires workers.approve (admin).

#### `WRK-LIFECYCLE-SUSPEND-001` Suspend an active worker with reason  — **P0** · _happy_
- **Pre:** Worker in 'active' status.
- **Steps:**
  1. Open an active worker, Profile tab
  2. Click 'Suspend'
  3. Type a reason (>=3 chars)
  4. Click 'Confirm'
- **API:** `POST /admin/workers/:id/suspend {reason:"..."}`
- **Expect:** users.is_suspended=TRUE, suspend_reason stored, status pill -> Suspended, webhook EventAdminWorkerSuspended fires, audit 'worker.suspend' written. Requires workers.suspend (admin). Suspend button only renders for active status.

#### `WRK-LIST-001` List loads with default sort and pagination  — **P0** · _happy_
- **Pre:** Logged in as admin (or any role >= support). >=26 pro accounts exist so a 2nd page exists.
- **Steps:**
  1. Navigate to /workers via sidebar
  2. Observe table loads with workers sorted by Joined desc
  3. Read the footer range text e.g. '1-25 of N'
  4. Click 'Next →'
  5. Observe footer shows '26-... of N' and 'Page 2 of X'
  6. Click '← Prev'
- **API:** `GET /admin/workers?sort_by=joined_at&sort_dir=desc&limit=25&offset=0`, `GET /admin/workers?...&offset=25`
- **Expect:** First load shows up to 25 rows newest-first. Next sends offset=25 and shows the next page; Prev returns to offset=0. Page counter and range text match total_count. Prev disabled on page 1, Next disabled on last page.

#### `WRK-PAYOUT-001` Mark a pending payout paid (money)  — **P0** · _money_
- **Pre:** Worker has a payout row in pending_manual_payout; role admin (payouts.mark_paid) and payouts.read.
- **Steps:**
  1. Payouts tab
  2. On a Pending row click 'Mark paid'
  3. Enter a transfer reference in notes
  4. Click 'Mark paid'
- **API:** `GET /admin/workers/:id/payroll-payouts`, `POST /admin/payroll/payouts/:id/mark-paid {notes?}`
- **Expect:** Row moves to Paid, lifetime_paid_paise increases by exactly the net_pay_paise, success toast. Modal shows the exact rupee amount (formatRupeesExact). Verify lifetime total matches sum of paid rows.

#### `WRK-PII-001` Aadhaar / bank reveal toggle (C7 plaintext)  — **P0** · _happy_
- **Pre:** Worker with aadhaar_number and bank_account_number populated; logged in as support role.
- **Steps:**
  1. Open the worker drawer, Profile tab
  2. In the 'PII — handle carefully' box note Aadhaar shows XXXX-XXXX-<last4>
  3. Click the eye icon next to Aadhaar
  4. Observe full 12-digit number revealed
  5. Click the eye next to Bank account
- **API:** `GET /admin/workers/:id`
- **Expect:** Masked by default; reveal shows full plaintext value. CRITICAL AUDIT FINDING (C7): GET /admin/workers/:id returns full plaintext aadhaar_number and bank_account_number to ANY role >= support, with NO role-based masking server-side and NO audit log on reveal (only the page-load worker.view is logged). The on-screen note even admits 'no audit endpoint yet'. Verify a support-role token receives the same plaintext as superadmin.

#### `WRK-RBAC-001` Viewer/support role cannot see write actions or PII drawer fully  — **P0** · _rbac_
- **Pre:** A 'viewer' account and a 'support' account. workers.read requires support; all write actions require admin.
- **Steps:**
  1. Log in as viewer; navigate to /workers
  2. Observe whether the list loads at all (workers.read = support)
  3. Log in as support; open a worker drawer
  4. Confirm 'New Pro' button is hidden, and Suspend/Approve/Reject/Force-offline/Deduction/Leave cards are hidden (Can gates)
  5. Attempt the actions directly via API with the support token
- **API:** `GET /admin/workers (support OK, viewer 403)`, `POST /admin/workers/:id/suspend (support 403)`, `POST /admin/workers (support 403)`
- **Expect:** Viewer (rank 0) gets 403 insufficient_permissions on GET /admin/workers (requires support). Support (rank 1) can read incl. plaintext PII but every admin-gated write returns 403 with required_role/your_role; the interceptor shows 'Insufficient permissions. Requires admin; you are support.' FE also hides the buttons via <Can>.

#### `WRK-RBAC-002` Direct API write bypassing hidden buttons is blocked server-side  — **P0** · _rbac_
- **Pre:** Support-role access token.
- **Steps:**
  1. With the support token, POST /admin/workers/:id/approve
  2. POST /admin/workers/:id/deductions with a valid body
  3. PATCH /admin/workers/:id/locality
- **API:** `POST /admin/workers/:id/approve`, `POST /admin/workers/:id/deductions`, `PATCH /admin/workers/:id/locality`
- **Expect:** All return 403 insufficient_permissions (approve/deduct require admin; locality piggy-backs on workers.suspend=admin). Confirms the server enforces RBAC independent of the hidden UI controls.

#### `WRK-CREATE-002` Per-step validation gates Next  — **P1** · _negative_
- **Pre:** On /workers/new.
- **Steps:**
  1. Personal: leave name blank, click Next (blocked, shows 'min 2 characters')
  2. Enter name, Next to Contact
  3. Contact: enter '12345' as phone, click Next (blocked)
  4. Enter a 10-digit number starting with 5 (blocked: must start 6-9)
  5. Set alt phone equal to primary (blocked: 'alt phone must differ')
  6. Work: leave categories empty, click Next (blocked: 'select at least one')
  7. KYC: enter 11-digit Aadhaar (blocked: 'must be 12 digits'); enter bad IFSC like 'abcd123' (blocked)
- **Expect:** Each invalid step blocks Next and renders the field-level error; no POST fires until all steps pass. DOB outside 18-80 blocks. weekly_hours_target outside 40-168 blocks.

#### `WRK-CREATE-003` Duplicate phone -> typed 409 handling  — **P1** · _negative_
- **Pre:** A user already exists as a pro/admin with phone +91XXXXXXXXXX (so it cannot be promoted from customer).
- **Steps:**
  1. Start New Pro, fill all steps using that existing pro's phone
  2. Submit
- **API:** `POST /admin/workers (409)`
- **Expect:** Backend returns 409 'phone already in use'; FE catches PhoneInUseError, jumps back to the Contact step, sets a manual 'this phone is already registered' error on the phone field, focuses it, and shows an error toast. No worker created.

#### `WRK-CREATE-006` Double-click Submit does not create two workers  — **P1** · _concurrency_
- **Pre:** On Review step with a valid never-used phone.
- **Steps:**
  1. Click 'Submit'
  2. Immediately click 'Submit' again (rapid double-click)
- **API:** `POST /admin/workers`
- **Expect:** Submit button is disabled while submit.isPending, so only one POST fires. Confirm exactly one worker is created (one users+helpers row for the phone). Note: backend has NO idempotency key; the only guard is the FE disabled state — verify via DB that no duplicate exists.

#### `WRK-DEDUCT-002` Deduction validation (negative / zero / short reason)  — **P1** · _negative_
- **Pre:** Worker open; admin role.
- **Steps:**
  1. Actions tab: enter Amount 0, valid reason, Submit (blocked: 'must be greater than 0')
  2. Enter Amount -5 (blocked)
  3. Enter Amount 10 with reason 'ab' (blocked: 'at least 5 characters')
- **API:** `POST /admin/workers/:id/deductions (only when FE passes)`
- **Expect:** FE zod blocks amount<=0 and reason<5 chars before any POST. If bypassed via API, backend returns 400 'amount_paise > 0 and reason required'.

#### `WRK-EDIT-CAT-001` Edit service categories  — **P1** · _happy_
- **Pre:** Worker open in drawer.
- **Steps:**
  1. Profile tab, Work Info, click 'Edit' next to Categories
  2. Toggle several category pills on/off
  3. Click 'Save'
  4. Verify toast 'Categories updated' and chips reflect new set
  5. Re-open Edit and click 'Cancel' to confirm draft resets
- **API:** `PUT /admin/workers/:id/categories {categories:[...]}`
- **Expect:** Save PUTs the full category array (overwrite semantics) and refetches detail. Cancel restores the original set without a call. Requires workers.set_categories (admin).

#### `WRK-EDIT-LOC-001` Edit locality against active localities  — **P1** · _happy_
- **Pre:** At least one active locality row exists; worker open in drawer.
- **Steps:**
  1. Profile tab, Work Info, click 'Edit' next to Locality
  2. Pick a locality from the dropdown
  3. Observe toast 'Locality set to <canonical>'
  4. Re-open Edit and choose '— Clear —'
- **API:** `GET /admin/localities (activeOnly)`, `PATCH /admin/workers/:id/locality {locality:"..."}`
- **Expect:** Selecting a value PATCHes and on success shows the canonical (case-corrected) name; detail refetches. Choosing Clear sends empty string and nulls the locality (toast 'Locality set to —'). Requires workers.suspend permission (locality piggy-backs on it).

#### `WRK-FORCE-OFFLINE-001` Force a worker offline while they have an active job  — **P1** · _edge_
- **Pre:** Worker currently is_online AND has a booking in accepted/arrived/in_progress.
- **Steps:**
  1. Open the online worker; confirm Performance tab shows 'Currently working — view active order'
  2. Back on Profile tab click 'Force offline'
  3. Confirm in the modal
- **API:** `GET /admin/workers/:id/active-job`, `POST /admin/workers/:id/force-offline`
- **Expect:** is_available set FALSE. SUSPECTED BUG: the force-offline confirm modal does NOT check or warn about the active job even though the active-job endpoint and the repo comment ('used before force-offline to surface a warning') exist; the active booking is left in-flight (force-offline does not cancel it), risking a stranded job. Confirm the active booking still exists afterwards.

#### `WRK-LEAVE-001` Grant and deduct leave days  — **P1** · _money_
- **Pre:** Worker open; admin role (workers.update); existing leave balance visible.
- **Steps:**
  1. Actions tab, Leave Adjustment card; note current balance
  2. Enter Days 2, Reason 'goodwill credit', Apply (positive -> direct)
  3. Observe toast 'New balance: N days'
  4. Enter Days -1, Reason 'unapproved absence', Apply
  5. Observe the deduct confirm modal showing projected balance; Confirm
- **API:** `GET /admin/leaves/balances?pro_id=:id`, `POST /admin/leaves (allocate, days +/-)`
- **Expect:** Positive days apply directly; negative days require a confirm modal (and backend leaves.deduct permission on top of workers.update). New balance toast and the balance line both update. Days=0 blocked ('Days cannot be 0').

#### `WRK-LIFECYCLE-REJECT-001` Reject a pending worker with reason  — **P1** · _happy_
- **Pre:** Worker in 'pending' status.
- **Steps:**
  1. Open the pending worker, click 'Reject'
  2. Try Confirm with a reason under 3 chars (button disabled)
  3. Type a >=3 char reason
  4. Click 'Confirm'
- **API:** `POST /admin/workers/:id/reject {reason:"..."}`
- **Expect:** FE blocks reason <3 chars; BE requires non-empty reason (400 otherwise). On success status pill -> Rejected, audit 'worker.reject' stores the reason. NOTE (suspectedBug): the reason is NOT persisted to the worker record — repo Reject ignores it; only the audit log captures it despite UI copy implying it is stored.

#### `WRK-LIFECYCLE-UNSUSPEND-001` Reactivate a suspended worker  — **P1** · _happy_
- **Pre:** Worker in 'suspended' status.
- **Steps:**
  1. Open the suspended worker
  2. Click 'Reactivate'
  3. Confirm in the modal
- **API:** `POST /admin/workers/:id/unsuspend`
- **Expect:** is_suspended=FALSE, suspend_reason cleared, status pill -> Active (or back to pending/rejected if approval_status not approved). Audit 'worker.unsuspend' written. Requires workers.unsuspend (admin).

#### `WRK-LIST-002` Search by name / phone / email  — **P1** · _happy_
- **Pre:** A worker named e.g. 'Asha' with a known phone exists.
- **Steps:**
  1. On /workers type 'Asha' in the search box
  2. Wait for results to refetch
  3. Clear and type the last digits of a known phone
  4. Clear and type a known email substring
- **API:** `GET /admin/workers?search=Asha&...&offset=0`
- **Expect:** Each search resets offset to 0 and returns only matching rows (server does case-insensitive LIKE over phone/name/email). Result count in footer reflects matches.

#### `WRK-LIST-003` Status filter values map correctly  — **P1** · _happy_
- **Pre:** At least one worker in each of active/pending/rejected/suspended/banned states.
- **Steps:**
  1. Select 'Pending approval' in the status dropdown
  2. Verify only pending-status pills appear
  3. Repeat for Active, Rejected, Suspended, Banned
  4. Select 'All statuses'
- **API:** `GET /admin/workers?status=pending&...`, `GET /admin/workers?status=active&...`, `GET /admin/workers?status=suspended&...`
- **Expect:** Each filter returns rows whose StatusPill matches the selected filter. 'All statuses' clears the filter. Note (see suspectedBugs): a suspended/banned worker who still has approval_status='pending' can be returned by the Pending filter while its pill renders suspended/banned — flag any such mismatch.

#### `WRK-LIST-007` Deep-link with bad ?id= is ignored  — **P1** · _negative_
- **Pre:** None.
- **Steps:**
  1. Open /workers?id=not-a-uuid in the address bar
  2. Observe the drawer does NOT open and no GET /workers/<garbage> fires
  3. Open /workers?id=<valid-but-nonexistent-uuid>
- **API:** `GET /admin/workers/<valid-uuid> (only for well-formed uuid)`
- **Expect:** Malformed id (fails UUID_RE) is dropped silently, drawer stays closed, no network call. A well-formed but nonexistent uuid triggers GET and the drawer shows 'Worker not found' (404 handled).

#### `WRK-PAYOUT-002` Mark payout failed and recompute  — **P1** · _money_
- **Pre:** Worker has a pending or paid payout row; admin role.
- **Steps:**
  1. Payouts tab, on a Pending row click 'Mark failed'
  2. Try Confirm with empty reason (button disabled)
  3. Enter a reason, confirm
  4. On the now-Failed row click 'Recompute'
  5. Confirm the recompute modal
- **API:** `POST /admin/payroll/payouts/:id/mark-failed {reason}`, `POST /admin/payroll/payouts/:id/recompute`
- **Expect:** Mark-failed requires a non-empty reason (FE disables Confirm until len>=1); status -> Failed with the reason shown. Recompute (allowed only on pending/failed) re-runs the calc, moves failed->pending and clears failure_reason. A paid row offers 'Reverse (mark failed)' which preserves paid_at for audit.

#### `WRK-PAYOUT-003` Double-click Mark paid does not double-pay  — **P1** · _concurrency_
- **Pre:** A pending payout row; admin.
- **Steps:**
  1. Open the Mark paid modal
  2. Click 'Mark paid' then immediately click again
- **API:** `POST /admin/payroll/payouts/:id/mark-paid`
- **Expect:** Confirm button disabled while paidMut.isPending so only one POST fires. Verify lifetime_paid_paise increased by net_pay only once (the row is no longer pending so a stale second click would have nothing to act on / be rejected by backend state guard).

#### `WRK-CREATE-004` Promote an existing customer phone to pro  — **P2** · _edge_
- **Pre:** A user exists with role='customer' on phone +91XXXXXXXXXX and has NO helpers row.
- **Steps:**
  1. Create New Pro using that customer's phone and a name
  2. Submit
- **API:** `POST /admin/workers (201)`
- **Expect:** Backend promotes the existing customer row to role 'pro' (keeping a user-set name over the admin-supplied one) and inserts the helpers row in the same tx. 201 returned. If that user already had a helpers row, the helpers_pkey conflict surfaces as 409 phone-in-use.

#### `WRK-CREATE-005` Unsaved-changes guard on back / reload  — **P2** · _edge_
- **Pre:** On /workers/new with at least one field edited.
- **Steps:**
  1. Type a name to dirty the form
  2. Click the back arrow (top-left)
  3. Observe 'Discard unsaved changes?' modal; click 'Stay'
  4. Click back arrow again, click 'Discard and leave'
  5. Re-dirty and try a browser refresh
- **Expect:** In-app back is intercepted with the discard modal while dirty. Browser hard-reload triggers the native beforeunload prompt. After a successful submit the form is reset (keepValues) so the guard no longer blocks navigation to the new worker.

#### `WRK-DEDUCT-003` Deduction history empty + capped display  — **P2** · _edge_
- **Pre:** One worker with zero deductions; one with >0.
- **Steps:**
  1. Open the zero-deduction worker, Deductions tab
  2. Observe empty state
  3. Open the worker with deductions and read the table footer note
- **API:** `GET /admin/workers/:id/deductions`
- **Expect:** Empty: 'No deductions recorded for this pro'. Populated: rows newest-first, reversed rows dimmed with '(reversed)'. Footer notes server caps at 200; applied-by shows admin UUID prefix only (no email join).

#### `WRK-EDIT-LOC-002` Set locality to an unknown name returns 400  — **P2** · _negative_
- **Pre:** Worker open; an inactive or nonexistent locality name.
- **Steps:**
  1. Use a REST client or temporarily craft a value not in active localities (the dropdown only lists active ones, so drive this via API)
  2. PATCH /admin/workers/:id/locality with {locality:"NoSuchArea"}
- **API:** `PATCH /admin/workers/:id/locality`
- **Expect:** Backend returns 400 with error 'unknown locality'; FE toast surfaces it (generic interceptor toast). No DB change.

#### `WRK-FLAG-001` Review / dismiss / escalate a performance flag  — **P2** · _happy_
- **Pre:** Worker has an open flag (hours_target_missed or acceptance_below_threshold); role admin (flags.review) and payouts.read.
- **Steps:**
  1. Targets & flags tab
  2. On an open flag click 'Mark reviewed' (add optional notes), Confirm
  3. On another open flag click 'Escalate', Confirm
- **API:** `GET /admin/workers/:id/performance`, `POST /admin/payroll/flags/:id/review {action, notes?}`
- **Expect:** Flag transitions out of Open per the chosen action; toast 'Flag updated'; the cycle metrics card refreshes. Flags never auto-deactivate a pro (admin-review only).

#### `WRK-IDEMPOTENT-001` Re-approve / repeat lifecycle action has no harmful effect  — **P2** · _idempotency_
- **Pre:** A worker already approved/active; admin role.
- **Steps:**
  1. Approve an already-approved worker via API: POST /admin/workers/:id/approve twice
  2. Suspend an already-suspended worker twice with different reasons
- **API:** `POST /admin/workers/:id/approve`, `POST /admin/workers/:id/suspend {reason}`
- **Expect:** Approve is idempotent (UPDATE sets approval_status='approved' again, role stays pro; RowsAffected>0 so returns 200). Note: there is NO state-machine guard — approve will run against rejected or active rows too (see suspectedBug). Suspend twice overwrites suspend_reason with the latest. No duplicate side effects beyond a second webhook/audit row.

#### `WRK-LIST-004` Category filter + Online-only toggle  — **P2** · _edge_
- **Pre:** Worker with services containing 'laundry'; one worker is_available with a location ping <90s old; one is_available but with no recent ping.
- **Steps:**
  1. Type 'laundry' in the Category box
  2. Verify rows include only workers with that category
  3. Check the 'Online only' checkbox
  4. Observe only workers with a green online dot remain
- **API:** `GET /admin/workers?category=laundry&only_online=true&...`
- **Expect:** Category does an exact ANY(services) match (slug must match stored slug, e.g. 'laundry' not 'Laundry'). Online-only returns only is_available AND last_location_at within 90s — a worker who is available but has a stale ping is excluded even though their list dot logic agrees.

#### `WRK-LIST-005` Empty state and no-match state  — **P2** · _edge_
- **Pre:** Either an empty DB, or a search string matching nothing.
- **Steps:**
  1. Type a nonsense search like 'zzzznomatch'
  2. Observe the empty state
  3. Clear search on an empty workers DB
- **API:** `GET /admin/workers?search=zzzznomatch&...`
- **Expect:** With a search term: 'No matches for "zzzznomatch"' + 'Try a different search term.' With no term and no data: 'No workers' + signup hint. Pagination footer hidden when 0 rows.

#### `WRK-LIST-006` Sort toggling on Rating/Jobs/Joined  — **P2** · _happy_
- **Pre:** >=3 workers with varied ratings and job counts.
- **Steps:**
  1. Click the 'Rating' column header
  2. Observe a down chevron and desc order
  3. Click 'Rating' again
  4. Observe up chevron and asc order
  5. Click 'Jobs' then 'Joined'
- **API:** `GET /admin/workers?sort_by=rating&sort_dir=desc&...`, `GET /admin/workers?sort_by=rating&sort_dir=asc&...`
- **Expect:** First click on a column sorts desc; second click flips to asc. Switching columns resets to desc. Offset resets to 0 on every sort change. Backend only honors sort_by in {joined_at,total_jobs,rating,name}; anything else falls back to created_at desc.

#### `WRK-PAGE-BOUNDARY-001` Pagination boundary with exactly PAGE_SIZE rows  — **P2** · _edge_
- **Pre:** Exactly 25 matching workers.
- **Steps:**
  1. Filter so the result is exactly 25
  2. Observe footer '1-25 of 25' and 'Page 1 of 1'
  3. Confirm Next is disabled
- **API:** `GET /admin/workers?...&limit=25&offset=0`
- **Expect:** With total==25, pages computed as ceil(25/25)=1, Next disabled, no empty second page. Confirm no off-by-one that enables Next.

#### `WRK-PUSH-001` Send a push to a single worker  — **P2** · _happy_
- **Pre:** Worker open; role with push.send (support+).
- **Steps:**
  1. Actions tab, Send Push Notification card
  2. Enter a Title (<=80) and Body (<=240)
  3. Click 'Send to this worker'
- **API:** `POST /admin/push (createPush, target specific user)`, `POST /admin/push/:id/send`
- **Expect:** Two-call flow: create then send. Success toast 'Push sent'. If send fails after create, toast says campaign created but send failed (retry from Push page) — surfacing the partial-failure state.

### push  <sub>(20 flows — P0:10 P1:6 P2:4)</sub>

The Push Notifications area lets ops admins compose, target (users/pros/both), schedule, send, cancel, and retry push notifications to the mobile apps via FCM. The CRM only writes/queues rows in crm_push_messages; actual FCM dispatch happens server-side in internal/crm/growth (SendPush) using the shared notification.Service, with a 30s background Scheduler draining due scheduled pushes and a claim-CAS (status->'sending') guarding against double-delivery. Dev safety relies on FCM client being nil (no FIREBASE_CREDENTIALS_JSON) rather than an explicit IsProduction() guard.

**Pages:** `/push` · `n/a (API module)` · `n/a (backend handler)` · `n/a (backend scheduler)` · `n/a (FCM layer)`

**Test data:** A crm_admins / admin account with role='support' (or higher) — required to create and send pushes (push.create, push.send minimum = RoleSupport).; A second admin account with role='viewer' — for RBAC tests (can read list via growth.read, blocked from create/send/reach).; users rows with role='customer' and role='pro', deleted_at IS NULL, is_suspended=FALSE, banned_at IS NULL, and non-empty fcm_token (legacy path) and/or device_tokens rows (resolver path) — so estimateReach and PushReach return non-zero and token collection has recipients.; For the large-batch test: >500 device tokens for one role (e.g. ~1200 customers) to exercise the 500-token FCM batching.; For the zero-recipient test: a target role with all tokens removed/suspended so collectTargetTokens returns empty.; Seeded crm_push_messages rows in each status: 'draft', 'scheduled' (future and past scheduled_at), 'sent', 'failed' (with error_message set), 'cancelled' — to exercise list rendering, the action buttons, and negative/idempotency flows.; Backend running with FCM mocked (FIREBASE_CREDENTIALS_JSON unset) for safe dev testing; and a separate run WITH valid Firebase creds to demonstrate the missing IsProduction() guard (PUSH-20 / suspected bug). Run migrations through at least 128 so the 'sending' status and count/error_message columns exist.; Ability to send SIGTERM to the local crm-api process (for the scheduler drain-on-shutdown flow).

#### `PUSH-01` Save a draft push (no schedule)  — **P0** · _happy_
- **Pre:** Logged into CRM at http://localhost:5174 as an admin with role support or higher. Backend on :8090 with FCM mocked (FIREBASE_CREDENTIALS_JSON unset).
- **Steps:**
  1. Open /push.
  2. In the Compose card type a Title (<=60 chars) and Body (<=180 chars).
  3. Leave Image URL, Deep link, and the datetime-local Schedule field empty.
  4. Leave target tab on 'users' (default).
  5. Click 'Save draft'.
  6. In the ConfirmModal ('Save draft?') click 'Save'.
- **API:** `POST /admin/growth/push`, `GET /admin/growth/push`, `GET /admin/growth/push/reach?target=users`
- **Expect:** Success toast 'Push drafted.' Compose fields reset. The Sent/scheduled list shows a new row with status pill 'draft' (neutral), the target_kind 'users', the ~estimated_reach, and a 'Send now' button. POST returns 200 with the created PushMsg.

#### `PUSH-02` Schedule a push for a future time  — **P0** · _happy_
- **Pre:** Logged in as support+ . Estimated reach endpoint reachable.
- **Steps:**
  1. Open /push.
  2. Enter Title and Body.
  3. Set the Schedule datetime-local field to ~5 minutes in the future (Asia/Kolkata local).
  4. Confirm the primary button label changes from 'Save draft' to 'Schedule'.
  5. Click 'Schedule', then in the modal ('Schedule push?') verify it shows 'Scheduled for <time>' and click 'Schedule'.
- **API:** `POST /admin/growth/push`, `GET /admin/growth/push`
- **Expect:** Toast 'Push scheduled.' New row shows status pill 'scheduled' (info) and a countdown pill 'Sends in 4m 5s' that ticks down (refreshes every 30s via the page clock). scheduled_at is sent as an ISO string (new Date(scheduled).toISOString()).

#### `PUSH-03` Scheduler auto-sends a due scheduled push  — **P0** · _happy_
- **Pre:** A scheduled push exists with scheduled_at <= now (create one scheduled ~40s out, or insert a row with scheduled_at in the past). Backend scheduler running (Start called in main; interval 30s).
- **Steps:**
  1. Create or have a scheduled push whose time has passed.
  2. Wait up to ~30s for one scheduler Tick.
  3. Observe the list (it polls every 15s; also force a refresh).
- **API:** `GET /admin/growth/push`
- **Expect:** Row transitions scheduled -> sending -> sent without any manual click. Status pill becomes 'sent' (success). Backend log shows '[crm.push.cron] tick complete' and '[crm.push] dispatched'. With FCM mocked, log shows '[notif] multicast mocked (FCM offline)'. NOTE: per-row Sent/Delivered/Failed counts will NOT render in the UI (see SUSPECTED BUG: list endpoint omits the count fields).

#### `PUSH-04` Send a draft immediately via 'Send now'  — **P0** · _happy_
- **Pre:** A draft push exists. Logged in as support+ (push.send).
- **Steps:**
  1. Open /push.
  2. On a 'draft' row click 'Send now'.
  3. In the modal ('Send push now?', impact 'The push is dispatched immediately. There is no recall.') click 'Send'.
- **API:** `POST /admin/growth/push/{id}/send`, `GET /admin/growth/push`
- **Expect:** Toast 'Push sent.' Row status flips to 'sent' (success pill). 'Send now' button disappears (row no longer draft/scheduled). Backend records sent_count/delivered_count/failed_count and sent_at, and writes an audit entry action='growth.push.send'.

#### `PUSH-06` Cancel a scheduled push before it fires  — **P0** · _happy_
- **Pre:** A 'scheduled' push exists, scheduled comfortably in the future. Logged in as support+ (push.create gates the Cancel button via <Can perm="push.create">).
- **Steps:**
  1. Open /push.
  2. On the scheduled row click 'Cancel'.
  3. In the destructive modal ('Cancel scheduled push?') click 'Cancel push'.
- **API:** `POST /admin/growth/push/{id}/cancel`, `GET /admin/growth/push`
- **Expect:** Toast 'Scheduled push cancelled.' Row status becomes 'cancelled' (warning pill). The countdown and Cancel button disappear. Scheduler no longer picks it up (Tick selects status='scheduled' only). Audit entry action='growth.push.cancel'.

#### `PUSH-10` Reject scheduling in the past  — **P0** · _negative_
- **Pre:** Logged in as support+.
- **Steps:**
  1. Open /push.
  2. Enter Title and Body.
  3. Set the Schedule datetime-local to a time more than 1 minute in the past.
  4. Click 'Schedule', confirm in modal.
- **API:** `POST /admin/growth/push`
- **Expect:** Backend returns 400 'scheduled_at must not be in the past' (CreatePush rejects ScheduledAt before now-1min). EXPOSES A BUG: the create mutation has no onError handler, so NO error toast is shown and the modal's onConfirm rejects silently (the confirm modal stays open / closes with no feedback, fields NOT reset). Verify whether any toast appears.

#### `PUSH-11` Send/cancel/retry error surfacing (4xx handling)  — **P0** · _negative_
- **Pre:** A push that is already 'sent'. Obtain its id.
- **Steps:**
  1. Via DB or a second tab, ensure a push is in 'sent' state.
  2. Trigger POST /admin/growth/push/{id}/cancel for that id (e.g. with a crafted request, since the UI hides Cancel on sent rows).
  3. Separately, in the UI click 'Send now' on a row that another tab already sent (stale list).
- **API:** `POST /admin/growth/push/{id}/cancel`, `POST /admin/growth/push/{id}/send`
- **Expect:** Backend returns 400 with body error ('push not cancellable...' / 'push is <status>, cannot resend' / 'push already claimed by another dispatcher'). EXPOSES A BUG: the send/cancel/retry mutations have no onError handler, so 4xx is swallowed with NO error toast — the operator sees nothing and the row silently stays unchanged. Confirm absence of any failure toast.

#### `PUSH-12` RBAC: viewer is read-only, cannot create/send  — **P0** · _rbac_
- **Pre:** Two CRM accounts: one role=viewer, one role=support. push.create and push.send require RoleSupport (min). growth.read (list) requires RoleViewer.
- **Steps:**
  1. Log in as the viewer.
  2. Open /push — confirm the list loads (growth.read=viewer).
  3. Note the primary compose button has title 'Insufficient permissions' and is disabled (canCreate=usePermission('push.create') is false).
  4. Attempt clicking the disabled button; also try 'Send now' on a draft row (button disabled for !canSend).
- **API:** `GET /admin/growth/push`, `POST /admin/growth/push`, `POST /admin/growth/push/{id}/send`
- **Expect:** Viewer can see the list and reach is hidden as '—' (reach endpoint requires push.create -> 403; UI shows reach '—' on 403). Compose button disabled with tooltip 'Insufficient permissions'; clicking shows error toast 'Insufficient permissions' and makes no API call. Send/Cancel/Retry buttons disabled/hidden. Direct POST as viewer returns 403 from RequirePermission('push.create'/'push.send'). Required role: support; insufficient: viewer.

#### `PUSH-14` Concurrency: double-click 'Send now' / send racing the scheduler  — **P0** · _concurrency_
- **Pre:** A scheduled push whose time just became due (so the scheduler Tick may fire ~same moment an admin clicks Send now). Logged in as support+.
- **Steps:**
  1. Open /push.
  2. On a due/draft row, click 'Send now' and confirm 'Send' rapidly twice (or open two tabs and confirm both).
  3. Alternatively, let the scheduler tick at the same time you confirm send.
- **API:** `POST /admin/growth/push/{id}/send`
- **Expect:** Exactly one dispatch occurs. The winning request claims the row via CAS (status IN (draft,scheduled) -> sending); the loser gets RowsAffected==0 and returns 400 'push already claimed by another dispatcher'. No device receives the push twice. Final status is 'sent' once. (The losing 400 is silently swallowed in the UI per the no-onError bug, but correctness — single delivery — must hold.)

#### `PUSH-20` Dev safety: no real FCM fires without credentials  — **P0** · _negative_
- **Pre:** Backend started WITHOUT FIREBASE_CREDENTIALS_JSON (or with an invalid value) so notification.NewService logs 'firebase init failed — notifications will be mocked' and fcmClient is nil.
- **Steps:**
  1. Confirm at boot the log '[notif] firebase init failed — notifications will be mocked' (or FCM client init failed).
  2. Create + Send a push.
  3. Inspect backend logs.
- **API:** `POST /admin/growth/push`, `POST /admin/growth/push/{id}/send`
- **Expect:** No real FCM call. Logs show '[notif] multicast mocked (FCM offline)'. Row still flips to 'sent'. IMPORTANT: this guard is fcmClient==nil ONLY — there is NO IsProduction() gate, so a dev/staging box that DOES have valid FIREBASE_CREDENTIALS_JSON set WILL fire real pushes to real devices (see SUSPECTED BUG).

#### `PUSH-05` Estimated reach updates when switching target tabs  — **P1** · _happy_
- **Pre:** Token resolver wired (device_tokens table present). users + pros with device tokens exist so counts differ.
- **Steps:**
  1. Open /push.
  2. Note 'Estimated reach: N devices' under the target tabs (target=users).
  3. Click the 'pros' tab; wait ~250ms (debounce).
  4. Click the 'both' tab.
- **API:** `GET /admin/growth/push/reach?target=users`, `GET /admin/growth/push/reach?target=pros`, `GET /admin/growth/push/reach?target=both`
- **Expect:** Reach number refetches per target (debounced 250ms, staleTime 30s). 'both' >= max(users, pros). Value renders as a localized number (toLocaleString). Briefly shows '…' while loading.

#### `PUSH-07` Retry a failed push  — **P1** · _happy_
- **Pre:** A push in 'failed' status exists (force by sending with FCM client present but a guaranteed-bad token, or manually UPDATE a row to status='failed'). Logged in as support+ (push.send).
- **Steps:**
  1. Open /push.
  2. On the 'failed' row click 'Retry Now'.
  3. In the modal ('Retry sending push?', 'This will fire immediately.') click 'Retry now'.
- **API:** `POST /admin/growth/push/{id}/retry`, `GET /admin/growth/push`
- **Expect:** Toast 'Push retry queued.' Backend resets row failed -> draft (clearing error_message, sent_at) then immediately calls SendPush; on success row ends 'sent'. Audit entry action='growth.push.retry'. NOTE: the failed row's error_message is NOT shown in the UI before retry (see SUSPECTED BUG).

#### `PUSH-09` Title/Body length boundaries and required-field gating  — **P1** · _edge_
- **Pre:** Logged in as support+.
- **Steps:**
  1. Open /push.
  2. Leave Title empty, type a Body -> observe the primary button.
  3. Type exactly 60 chars in Title (maxLength=60 enforced by input) and exactly 180 in Body (maxLength=180).
  4. Try to type a 61st Title char / 181st Body char.
  5. Click 'Save draft' with both fields filled.
- **API:** `POST /admin/growth/push`
- **Expect:** Primary button is disabled when title OR body is empty (disabled={!title || !body || !canCreate}). Inputs hard-cap at 60/180 chars (cannot exceed). At exactly 60/180 the save succeeds. Backend also rejects empty title/body/target_kind with 400 'title, body, target_kind required'.

#### `PUSH-13` RBAC: reach endpoint 403 for insufficient role renders graceful dash  — **P1** · _rbac_
- **Pre:** Logged in as viewer (push.create denied).
- **Steps:**
  1. Open /push as viewer.
  2. Observe the 'Estimated reach' line under the target tabs.
  3. Switch target tabs.
- **API:** `GET /admin/growth/push/reach?target=users`
- **Expect:** Reach query receives 403; the react-query retry function returns false on 403 (no retry storm). UI shows 'Estimated reach: —'. No crash, no error toast spam.

#### `PUSH-15` Idempotency: re-cancel an already-cancelled push  — **P1** · _idempotency_
- **Pre:** A push already in 'cancelled' status.
- **Steps:**
  1. Trigger POST /admin/growth/push/{id}/cancel twice for a cancelled row (UI hides Cancel on cancelled rows, so use repeated API calls or DB-seeded state).
- **API:** `POST /admin/growth/push/{id}/cancel`
- **Expect:** CancelPush WHERE status IN ('draft','scheduled','cancelled') makes re-cancel idempotent: second call still matches the row (status='cancelled') and returns 200 ok. No error. Status stays 'cancelled'.

#### `PUSH-16` Scheduler drain on shutdown (no double-send, no wedged sends lost)  — **P1** · _concurrency_
- **Pre:** Local backend you can SIGTERM. A scheduled push due now so a Tick is in flight at shutdown.
- **Steps:**
  1. Seed a due scheduled push.
  2. Send SIGTERM/SIGINT to crm-api while a Tick is dispatching (or right after boot's first 30s tick).
  3. Observe backend logs and the row state after restart.
- **API:** `GET /admin/growth/push`
- **Expect:** Logs '[crm] shutting down' then push scheduler Stop waits up to 30s for the in-flight Tick to finish ('[crm.push.cron] scheduler stopped cleanly'), then dispatcher drain. A push already sent in that Tick is 'sent'; one not yet claimed stays 'scheduled' and is reprocessed after restart. If killed between claim and terminal update, row is wedged in 'sending' (documented: needs manual requeue) — verify it is NOT double-delivered.

#### `PUSH-08` Empty list state  — **P2** · _edge_
- **Pre:** crm_push_messages has zero rows.
- **Steps:**
  1. Open /push.
  2. Observe the Sent/scheduled card.
- **API:** `GET /admin/growth/push`
- **Expect:** EmptyState 'No pushes yet' renders. No skeleton stuck. No console errors.

#### `PUSH-17` Large reach / 500-token FCM batching  — **P2** · _edge_
- **Pre:** Seed >500 device tokens for the target role (e.g. 1200 customers with device_tokens). FCM mocked is fine to observe batching counts.
- **Steps:**
  1. Create a draft targeting 'users' (estimated reach >500).
  2. Click 'Send now' and confirm.
- **API:** `POST /admin/growth/push/{id}/send`, `GET /admin/growth/push`
- **Expect:** SendPush chunks tokens into 500-token batches (fcmBatchSize=500). sent_count == total tokens; delivered/failed summed across batches. Row ends 'sent'. With mocked FCM each batch logs a mock multicast line. (Counts persist to DB but are NOT shown in the UI — see SUSPECTED BUG.)

#### `PUSH-18` Zero-recipient send (target has no tokens)  — **P2** · _edge_
- **Pre:** Target role has zero usable FCM tokens (e.g. all suspended/banned, or empty device_tokens for that role).
- **Steps:**
  1. Create a draft targeting a role with no live tokens.
  2. Click 'Send now' and confirm.
- **API:** `POST /admin/growth/push/{id}/send`, `GET /admin/growth/push`
- **Expect:** SendPush proceeds, logs '[crm.push] no FCM tokens for target — push has no recipients', marks row 'sent' with sent_count=0/delivered=0/failed=0. Toast 'Push sent.' No FCM call. Operator gets no on-screen signal that reach was zero (counts not surfaced).

#### `PUSH-19` Pagination/limit: list caps at 50 by default  — **P2** · _edge_
- **Pre:** Seed >60 push rows.
- **Steps:**
  1. Open /push.
  2. Scroll the Sent/scheduled list (max-h-420px, overflow-y-auto).
- **API:** `GET /admin/growth/push`
- **Expect:** listPush sends no limit param; backend defaults limit to 50 (ListPush clamps <=0 or >200 to 50). Only the 50 most-recent (created_at DESC) rows appear. There is NO pagination UI — rows beyond 50 are simply not loadable from this page. Confirm the newest 50 show and the list scrolls.

### refunds  <sub>(22 flows — P0:9 P1:10 P2:3)</sub>

The Refunds area lets ops admins decide on pending customer refunds (approve full/partial, reject), retry failed gateway calls, and create ad-hoc refunds from an order id. Money is int64 paise end-to-end; approval flips a row through a CAS-locked state machine (pending → approved-lock → processed / processed_manual / gateway_error) and either fires the payment gateway (Cashfree), credits the closed-loop wallet, or marks the row for manual ops settlement. IMPORTANT for local testing: in cmd/crm-api/main.go the gateway is hardwired to ManualGateway (Cashfree not wired), so every non-COD, non-wallet refund that has a payment_id resolves to status processed_manual rather than processed.

**Pages:** `/refunds` · `n/a (API client)` · `n/a (backend handler)`

**Test data:** A CRM admin account for each role to test RBAC: viewer, support, admin (or superadmin). JWT obtained via the CRM login flow; sessions must be active (crm_admin_sessions row, not revoked, not expired).; users rows for refund customers (id, phone, role); at least one with deleted_at set to test the '(deleted)' phone placeholder.; pending_refunds rows covering each status: pending, approved, processed, processed_manual, gateway_error, rejected (and optionally cancelled to expose the missing-tab bug). Key columns: id, user_id, amount_cents (paise), source, source_ref, status, payment_method, payment_id, booking_id, partial_amount_cents, error_message.; A pending row with payment_method='upi' + non-empty payment_id (drives the gateway path → processed_manual locally).; A pending row with payment_method='cod' (drives processed_manual via COD short-circuit).; A pending row with payment_method='upi' and NULL payment_id (drives the FE missing-payment-ref block).; A gateway_error row with payment_method='wallet' and a booking_id for the wallet idempotency/retry flow (wallet service is wired locally).; Two pending rows tied to the SAME booking_id (or same source_ref UUID with source like 'booking_%') to exercise the duplicate-refund guard.; A bookings row (id, customer_id, amount_paise, discount_paise, payment_method, payment_id) with NO active refund, for CreateFromOrder; plus one booking that already has an active refund for the from-order duplicate guard.; One large-amount refund (e.g. 999999900 paise) and a zero/edge boundary to test formatting and validation.; >100 pending refund rows to test the FE limit=100 cap and backend limit clamping/pagination.; crm_audit_log table available so audit rows (refund.approve, refund.reject, refund.view, refund.manual_create, refund.gateway_error*, refund.post_gateway_db_write_failed) can be verified.; Note: locally the gateway is ManualGateway (cmd/crm-api/main.go:290), so 'processed' (real gateway ref) cannot be reached via UPI/card paths — only via the wallet path. To test a true gateway_error / processed-with-ref, either seed the row in those states directly or wire a Cashfree sandbox gateway.

#### `RF-P0-01` Approve a full pending refund (manual gateway → processed_manual)  — **P0** · _money_
- **Pre:** Logged in as support or higher. At least one pending_refunds row with status='pending', a valid users row, payment_method='upi' and a non-empty payment_id, source like 'booking_*' or booking_id set. Local backend uses ManualGateway (main.go:290).
- **Steps:**
  1. Open http://localhost:5174 and navigate to Refunds in the sidebar
  2. Stay on the default 'pending' tab; confirm the seeded row is listed with the user, amount (₹ formatted), method badge UPI, and Created timestamp
  3. Click the green 'Approve' button on the row
  4. In the 'Approve refund?' modal leave the 'Partial amount in ₹' field blank
  5. Type a reason (e.g. 'customer cancelled') in the Reason field
  6. Click the 'Approve' button in the modal footer and watch for the 'Processing refund…' spinner
- **API:** `GET /admin/refunds?status=pending&limit=100`, `POST /admin/refunds/:id/approve`
- **Expect:** 200 returned with {ok:true,status:'processed_manual'}. A warning toast 'Refund of ₹X marked for manual processing. Handle offline.' appears. Modal closes; list refetches; the row leaves the pending tab and appears under processed_manual with a 'Manual refund required' pill. DB: pending_refunds.status='processed_manual', settled_at set, partial_amount_cents = full amount, error_message NULL, an audit row action='refund.approve' in crm_audit_log.

#### `RF-P0-02` Approve a partial refund as admin (money correctness, paise math)  — **P0** · _money_
- **Pre:** Logged in as admin or superadmin (partial requires refunds.approve_partial = admin). A pending row with amount_paise = 100000 (₹1000), payment_method upi + payment_id present.
- **Steps:**
  1. Go to Refunds, pending tab, locate the ₹1000 row
  2. Click 'Approve'
  3. Enter 250 in 'Partial amount in ₹' (note the field strips non-digits, so only whole rupees are accepted)
  4. Confirm the modal 'Refund amount' line now shows ₹250 (partial)
  5. Enter a reason and click 'Approve'
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** Request body carries amount_paise=25000 (250×100). 200 with status='processed_manual'. DB row partial_amount_cents=25000 while amount_cents stays 100000. List row shows ₹250 with sub-text 'of ₹1,000'. Audit after-payload amount_cents=25000. No float anywhere; value equals exactly 25000 paise.

#### `RF-P0-03` Partial refund attempt by support is blocked (RBAC: required admin, support insufficient)  — **P0** · _rbac_
- **Pre:** Logged in as a support-role admin (has refunds.approve_full but NOT refunds.approve_partial). A pending row with amount > 1.
- **Steps:**
  1. Go to Refunds, pending tab
  2. Click 'Approve' on a row (button is enabled because support has approve_full)
  3. Enter a partial amount less than the full amount (e.g. 50 on a ₹1000 row)
  4. Enter a reason; observe the modal 'Approve' button becomes disabled (canApproveNow=false because isPartial && !canApprovePartial)
  5. If you bypass the UI by POSTing directly with amount_paise < amount_cents and reason
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** UI: footer Approve button disabled for the partial case; clicking does nothing (FE also toasts 'Insufficient permissions' on the guard). Direct API: 403 with {error:'insufficient_permissions', required_role:'admin', your_role:'support'}. No DB state change, no gateway/manual processing, no audit 'refund.approve' row.

#### `RF-P0-04` Reject a pending refund  — **P0** · _happy_
- **Pre:** Logged in as support or higher (refunds.reject = support). A row with status='pending'.
- **Steps:**
  1. Refunds, pending tab, click the red 'Reject' button on the row
  2. In the 'Reject refund?' confirm modal type a reason in the Reason field
  3. Click 'Reject'
- **API:** `POST /admin/refunds/:id/reject`
- **Expect:** 200 {ok:true}. Success toast 'Refund rejected.' Row moves to the 'rejected' tab. DB: status='rejected', settled_at set. Audit row action='refund.reject' with the reason in the after field.

#### `RF-P0-05` Concurrency: double-click Approve fires the gateway exactly once (CAS lock)  — **P0** · _concurrency_
- **Pre:** Logged in with approve_full. One pending row with payment_method upi + payment_id. Use browser devtools or a script to fire two POST /approve in parallel (or rapidly double-click the modal Approve before the spinner — note the modal disables the button via approve.isPending, so use parallel requests/curl for a true race).
- **Steps:**
  1. Seed one pending refund row
  2. Issue 5-10 concurrent POST /admin/refunds/:id/approve with the same id and a reason body
  3. Inspect all response codes and the final DB row
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** Exactly one response is 200; all others are 409 ('refund already in progress or settled') or 400 ('refund is approved/processed, not pending'); zero 5xx. Final DB status is a single terminal state (processed_manual locally / processed with a real gateway). The gateway/manual settlement happens once — no double money movement (regression net: refunds_test.go TestApprove_ConcurrentDoubleClick asserts gw.calls==1).

#### `RF-P0-06` Idempotency: retry a gateway_error wallet refund does not double-credit  — **P0** · _idempotency_
- **Pre:** Logged in with approve_full. A row with status='gateway_error', payment_method='wallet', a booking_id, a valid user. Wallet service wired (it is in main.go:283). The refund row UUID is the wallet credit idempotency reference.
- **Steps:**
  1. Go to Refunds, 'gateway_error' tab, find the wallet row
  2. Click the orange 'Retry' button
  3. In the 'Retry gateway refund?' modal click 'Retry'
  4. If the first retry already credited the wallet, retry again (re-enter via gateway_error if applicable) to confirm idempotency
- **API:** `POST /admin/refunds/:id/retry`
- **Expect:** Wallet.Credit is called with reference=refund row UUID. First retry credits the wallet once and sets status='processed' (gateway_refund_id 'wallet:<bookingId>'). A duplicate credit attempt returns ErrWalletDuplicate which is treated as success (status processed) — the wallet_transactions table gets exactly ONE refund_credit row for that reference (partial unique index enforces it). No second balance increase.

#### `RF-P0-07` Duplicate-refund guard blocks a second refund against the same booking  — **P0** · _negative_
- **Pre:** Logged in with approve_full. Two pending_refunds rows that resolve to the SAME booking_id (or same source_ref UUID with source like 'booking_*'); the first already processed/approved/pending.
- **Steps:**
  1. Approve or have an active refund on booking B (row 1)
  2. Go to the second pending row that targets booking B and click 'Approve', enter reason, submit
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** 400 with {error:'refund already processed for this order[ on YYYY-MM-DD]', duplicate_refund_id:<id>}. FE surfaces the error via the axios interceptor toast. No gateway call, no second money movement, the second row stays pending (it was never locked).

#### `RF-P0-08` Unauthenticated / no-token access is rejected  — **P0** · _rbac_
- **Pre:** No valid CRM JWT (logged out, or expired/revoked session).
- **Steps:**
  1. Call GET /admin/refunds with no Authorization header (or an expired bearer token)
  2. Repeat for POST /admin/refunds/:id/approve
- **API:** `GET /admin/refunds`, `POST /admin/refunds/:id/approve`
- **Expect:** 401 {error:'authentication required'} on every refunds endpoint (middleware.JWT runs before RequirePermission). A revoked/expired session row also yields 401 via sessionStillActive.

#### `RF-P0-09` Viewer role is blocked from reading and acting on refunds  — **P0** · _rbac_
- **Pre:** Logged in as a viewer-role admin (refunds.read requires support).
- **Steps:**
  1. Navigate to the Refunds page as viewer
  2. Observe the list query result
  3. Attempt approve/reject via direct API if the page renders
- **API:** `GET /admin/refunds`, `POST /admin/refunds/:id/approve`, `POST /admin/refunds/:id/reject`
- **Expect:** GET /admin/refunds returns 403 {error:'insufficient_permissions', required_role:'support', your_role:'viewer'} → page shows ErrorState 'Could not load refunds'. approve_full/reject also 403. Viewer cannot see customer PII or amounts.

#### `RF-P1-10` Approve a COD refund routes to manual  — **P1** · _money_
- **Pre:** Logged in with approve_full. A pending row with payment_method='cod'.
- **Steps:**
  1. Refunds, pending tab, click 'Approve' on the COD row
  2. Observe the yellow COD warning banner 'COD order — refund will be marked as Manual'
  3. Enter a reason and click 'Approve'
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** 200 status='processed_manual' (runGateway short-circuits for MethodCOD regardless of configured gateway). Warning toast about manual processing. Row moves to processed_manual tab with the 'Manual refund required' pill.

#### `RF-P1-11` Approve disabled when non-COD refund has no payment reference  — **P1** · _edge_
- **Pre:** Logged in with approve_full. A pending row with payment_method='upi' (or card) but payment_id NULL/empty.
- **Steps:**
  1. Refunds, pending tab, click 'Approve' on the row missing payment ref
  2. Observe the red banner 'Original payment reference missing. Cannot process automatic refund.'
  3. Note the modal footer 'Approve' button is disabled (missingPaymentRef=true)
- **Expect:** FE blocks submission entirely (button disabled). If forced via direct API, runGateway with empty payment_id returns processed_manual (200). Either way no automatic gateway reversal is attempted against a missing reference.

#### `RF-P1-12` Retry only valid on gateway_error rows  — **P1** · _negative_
- **Pre:** Logged in with approve_full. A row currently in 'processed' or 'pending'.
- **Steps:**
  1. Directly POST /admin/refunds/:id/retry for a row whose status is not gateway_error
  2. Also confirm the FE only shows the 'Retry' button on the gateway_error tab rows
- **API:** `POST /admin/refunds/:id/retry`
- **Expect:** 400 {error:'refund is <status>, retry only valid for gateway_error'}. No gateway call, no state change. FE: Retry button is absent except on gateway_error rows.

#### `RF-P1-13` Approve a non-pending refund is rejected  — **P1** · _negative_
- **Pre:** Logged in with approve_full. A row already in processed / rejected / approved.
- **Steps:**
  1. POST /admin/refunds/:id/approve with a reason for a non-pending row (or click Approve on a stale list cached before another admin acted)
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** 400 {error:'refund is <status>, not pending'}. No gateway call. FE surfaces the 4xx via the axios interceptor toast.

#### `RF-P1-14` Approve with empty/whitespace reason is rejected  — **P1** · _negative_
- **Pre:** Logged in with approve_full. A pending row.
- **Steps:**
  1. Click 'Approve', leave Reason blank, observe the modal 'Approve' button stays disabled (!reason.trim())
  2. Bypass via direct API: POST approve with body {"reason":"  "}
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** FE: submit blocked. API: 400 {error:'reason required'} (handler trims reason). Same for reject (400 reason required) and from-order. No state change.

#### `RF-P1-15` Partial amount exceeding original is rejected  — **P1** · _negative_
- **Pre:** Logged in as admin (so partial gate passes). A pending row with amount_paise=50000 (₹500).
- **Steps:**
  1. Click 'Approve', enter 600 in partial (₹600 > ₹500)
  2. Note: in the UI, partial 600 > original makes isPartial false (partialCents not < amount), so it is treated as a FULL refund of ₹500 by the FE
  3. To exercise the backend guard, POST approve directly with amount_paise=60000
- **API:** `POST /admin/refunds/:id/approve`
- **Expect:** Direct API: 400 {error:'partial amount exceeds original'}. FE path silently downgrades an over-amount to a full refund (see suspected bug). No money moves on the 400.

#### `RF-P1-16` Create a refund from an order id (CreateFromOrder happy path)  — **P1** · _money_
- **Pre:** Logged in with approve_full. A bookings row with id O, customer_id, amount_paise, payment_method+payment_id, no existing active refund. There is no UI button for this in RefundsPage — exercise via API (refundsApi.fromOrder exists in all.ts).
- **Steps:**
  1. POST /admin/refunds/from-order/O with body {amount_paise:<= net (amount_paise - discount_paise)>, reason:'goodwill'}
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** 200 {ok:true, refund_id, status, gateway_refund_id}. A new pending_refunds row is inserted (source='manual_crm', booking_id=O) then immediately settled by runGateway → processed_manual locally. Audit action='refund.manual_create'. The refund cap is NET (amount_paise - discount_paise), not gross.

#### `RF-P1-17` CreateFromOrder rejects amount above net order total and unknown order  — **P1** · _negative_
- **Pre:** Logged in with approve_full. A booking O with net total ₹400; plus a random non-existent UUID.
- **Steps:**
  1. POST /admin/refunds/from-order/O with amount_paise=50000 (₹500 > ₹400 net)
  2. POST /admin/refunds/from-order/<random-uuid> with a valid amount
  3. POST /admin/refunds/from-order/O with amount_paise=0
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** Over-amount → 400 {error:'amount exceeds order total'}. Unknown order → 404 {error:'order not found'}. Zero/negative amount → 400 {error:'amount_paise must be greater than zero'}. No row inserted in any case.

#### `RF-P1-18` CreateFromOrder duplicate guard blocks second refund on same order  — **P1** · _idempotency_
- **Pre:** Logged in with approve_full. A booking O that already has an active refund (pending/approved/processed/processed_manual/gateway_error).
- **Steps:**
  1. POST /admin/refunds/from-order/O with a valid amount and reason
- **API:** `POST /admin/refunds/from-order/:orderId`
- **Expect:** 400 {error:'refund already processed for this order[ on date]', duplicate_refund_id:<existing>}. No new row inserted, no second money movement.

#### `RF-P1-19` Tab navigation and empty states across all status tabs  — **P1** · _edge_
- **Pre:** Logged in with refunds.read. DB has at least one status with zero rows (e.g. no rejected rows).
- **Steps:**
  1. Click through each tab: pending, approved, processed, processed_manual, gateway_error, rejected
  2. Confirm each tab issues a fresh list query filtered by status
  3. Land on a tab with no rows
- **API:** `GET /admin/refunds?status=pending&limit=100`, `GET /admin/refunds?status=approved&limit=100`, `GET /admin/refunds?status=processed&limit=100`, `GET /admin/refunds?status=processed_manual&limit=100`, `GET /admin/refunds?status=gateway_error&limit=100`, `GET /admin/refunds?status=rejected&limit=100`
- **Expect:** Each tab fetches status-scoped data (limit=100). Empty tab shows EmptyState 'No <status> refunds'. Action buttons (Approve/Reject) only render on the pending tab; Retry only on gateway_error rows. Note there is NO 'cancelled' tab even though the type/status tone supports it (see suspected bug).

#### `RF-P2-20` Pagination boundary / large list (limit clamp)  — **P2** · _edge_
- **Pre:** Logged in with refunds.read. >100 pending refund rows seeded.
- **Steps:**
  1. Open the pending tab (FE requests limit=100, no offset control in the UI)
  2. Directly call GET /admin/refunds?status=pending&limit=500&offset=0
  3. Directly call GET /admin/refunds?status=pending&limit=0
  4. Directly call GET /admin/refunds?status=pending&offset=-5
- **API:** `GET /admin/refunds?status=pending&limit=100`, `GET /admin/refunds?status=pending&limit=500`, `GET /admin/refunds?limit=0`
- **Expect:** Backend clamps limit>200 and limit<=0 to 50; negative offset to 0 (List, refunds.go:82-87). Response includes total_count, limit, offset. FE shows only the first 100 with no further-page control, so rows beyond 100 are invisible in the UI (operational limitation to note).

#### `RF-P2-21` Deleted user shows phone placeholder, large amount formats correctly  — **P2** · _edge_
- **Pre:** Logged in with refunds.read. A refund whose user has deleted_at set (or missing), and a refund with a very large amount (e.g. 999999900 paise = ₹99,99,999).
- **Steps:**
  1. View the refunds list containing the deleted-user row and the large-amount row
- **API:** `GET /admin/refunds?status=pending&limit=100`
- **Expect:** Deleted/missing user shows phone '(deleted)' (COALESCE in SQL) and user_name null. Large amount renders with en-IN grouping (₹99,99,999) via toLocaleString. No overflow/NaN.

#### `RF-P2-22` Get single refund records a PII-view audit entry  — **P2** · _happy_
- **Pre:** Logged in with refunds.read. A valid refund id.
- **Steps:**
  1. GET /admin/refunds/:id directly (no dedicated detail page in the UI)
- **API:** `GET /admin/refunds/:id`
- **Expect:** 200 with the full Item JSON. An audit row action='refund.view' is written (PII read audit). Unknown id → 404 {error:'refund not found'}.

### localities-maps  <sub>(36 flows — P0:9 P1:17 P2:10)</sub>

Two CRM admin surfaces: (1) Localities CRUD at /localities — a flat name+city table backing the helper/booking operational-area picker, where a rename cascades by plain-text name into helpers.locality and bookings.locality inside one tx; and (2) the Live Map at /map — a Google-Maps view of currently-online workers polled every 10s from /admin/workers/live, colored by job_status. A backend zones/surge module (service_zones circles + crm_surge_rules multipliers under /admin/zones) exists and is mounted, but has NO frontend page in this build — it is API-only.

**Pages:** `/localities` · `/map` · `(no UI) /admin/zones, /admin/zones/surge`

**Test data:** CRM admin accounts at each role for RBAC: one viewer, one support, one admin (and ideally one superadmin). Each needs a valid, non-revoked, non-expired row in crm_admin_sessions to pass JWT middleware.; localities rows: at least 3-4 across 2 cities (e.g. Gurugram + Delhi) to verify sort (city then name); one duplicate-target pair in the same city for the 409 tests; one fresh-name slot for create.; For the rename-cascade test (LOC-06): a locality 'OldName'/'Gurugram', at least one helpers row with locality='OldName', and at least one bookings row with locality='OldName'.; Live-map workers: helpers joined to users where users.role='pro', deleted_at NULL, banned_at NULL, is_suspended FALSE, helpers.approval_status='approved', is_available TRUE, current_lat/current_lng non-null, last_location_at within 90 seconds. Need: 1 idle (no active booking), 1 en_route (active booking with en_route_at set, status accepted), 1 on_job (booking status in_progress with active_booking_id).; A negative live-map worker: same valid live fields but flip one of is_suspended/banned_at/approval_status/deleted_at to verify exclusion (MAP-08).; A bookings row in status accepted/arrived/in_progress linked to a live helper so the InfoWindow shows an Active booking link to /orders/:id.; Optional clustering test: ~120 valid online helpers to cross the 100-pin CLUSTER_THRESHOLD (MAP-10); note query LIMIT 1000.; service_zones rows (PostGIS table; here used as lat/lon/radius circles): 1-2 existing zones for update/toggle; a known random UUID not present for 404/error tests.; crm_surge_rules: 1 existing rule for delete/idempotency; an existing zone_id for create; a random non-existent zone_id for the FK-violation test.; Env: VITE_GOOGLE_MAPS_API_KEY set in App/zopmop-crm/.env for happy-path map tests, and a way to blank/invalidate it for MAP-02/MAP-03. Backend crm-api running on :8090, CRM on :5174.; Webhook dispatcher observable (logs or a test sink) to verify admin.surge.activated fires on surge create (ZONE-04).

#### `AUTH-01` Unauthenticated / expired session blocked everywhere  — **P0** · _negative_
- **Pre:** No Authorization header, or a token whose crm_admin_sessions row is revoked/expired.
- **Steps:**
  1. Call GET /admin/localities, GET /admin/workers/live, GET /admin/zones/ with no/invalid/expired token
- **API:** `GET /admin/localities`, `GET /admin/workers/live`, `GET /admin/zones/`
- **Expect:** 401 {"error":"authentication required"} from crm JWT middleware (also rejects if the bound session is revoked or past expires_at, even with a structurally valid token). Frontend redirects to /login.

#### `LOC-01` Add a new locality (happy path)  — **P0** · _happy_
- **Pre:** Logged in as an admin-role (>=admin) CRM user. On /localities.
- **Steps:**
  1. Type a unique name e.g. 'Sector 14' in the Name field
  2. Leave City as default 'Gurugram' (or type a city)
  3. Click the 'Add' button
- **API:** `POST /admin/localities`
- **Expect:** 201; row appears in the table (sorted by city then name), Name field clears but City retains its value, green toast 'Locality added'. New row shows Active badge (green) and today's date in Created.

#### `LOC-05` Delete locality via confirm modal  — **P0** · _happy_
- **Pre:** A deletable locality exists; admin role.
- **Steps:**
  1. Click the rose 'Delete' link on a row
  2. Read the ConfirmModal impact text ('<name> will no longer be selectable... Existing bookings keep their snapshot')
  3. Click 'Delete' in the modal
- **API:** `DELETE /admin/localities/:id`
- **Expect:** 200 {"ok":true}; row removed from table, modal closes, green toast 'Locality removed'. Backend returns 404 if id already gone.

#### `LOC-06` Rename cascades to helpers and bookings  — **P0** · _money_
- **Pre:** Locality 'OldName'/'Gurugram' exists; at least one helper row with helpers.locality='OldName' and one bookings row with bookings.locality='OldName'. Admin role. (Edit must be triggered via PATCH — note the UI's toggle only sends the current name, so rename is exercised via API or a future edit field.)
- **Steps:**
  1. Issue PATCH /admin/localities/:id with body {name:'NewName', city:'Gurugram', active:true}
  2. Query helpers and bookings for locality='OldName' vs 'NewName'
- **API:** `PATCH /admin/localities/:id`
- **Expect:** 200; in ONE transaction localities.name -> 'NewName', AND every helpers.locality='OldName' and bookings.locality='OldName' is rewritten to 'NewName'. If the cascade is skipped, pros in that area silently stop matching new bookings (dispatcher matches by name ILIKE). Verify zero rows still hold 'OldName'.

#### `LOC-13` RBAC: viewer can READ but not WRITE localities  — **P0** · _rbac_
- **Pre:** Two CRM admin logins: one role=viewer, one role=admin. (localities.read=viewer; create/update/delete=admin.)
- **Steps:**
  1. Log in as viewer, open /localities — confirm list renders
  2. As viewer, attempt POST /admin/localities (or click Add)
  3. As viewer, attempt PATCH and DELETE
  4. Repeat the writes as admin
- **API:** `GET /admin/localities`, `POST /admin/localities`, `PATCH /admin/localities/:id`, `DELETE /admin/localities/:id`
- **Expect:** Viewer: GET 200; POST/PATCH/DELETE all 403 {"error":"insufficient_permissions","required_role":"admin","your_role":"viewer"} surfaced as error toast. Admin (required role): writes succeed. NOTE: frontend does NOT hide the Add/Delete buttons by role — viewer sees them and only gets blocked on submit.

#### `MAP-01` Live map renders online workers (happy path)  — **P0** · _happy_
- **Pre:** VITE_GOOGLE_MAPS_API_KEY set in App/zopmop-crm/.env. At least 1 helper that is approved, role=pro, not banned/suspended/deleted, is_available=TRUE, current_lat/lng set, last_location_at within 90 seconds. Role >= support.
- **Steps:**
  1. Open /map
  2. Wait for the map to load
  3. Observe markers and the top-left legend
- **API:** `GET /admin/workers/live`
- **Expect:** Map fits bounds to all pins once; legend shows 'N workers online' and per-status counts (Idle/En route/On job). Markers colored: idle=teal, en_route=amber, on_job=red. Marker title = name or phone.

#### `MAP-08` Suspended/banned/unapproved worker never appears  — **P0** · _negative_
- **Pre:** A helper with is_available=TRUE, fresh location, BUT one of: is_suspended=TRUE, banned_at set, deleted_at set, approval_status != 'approved', or role != 'pro'.
- **Steps:**
  1. Ensure such a helper exists with otherwise valid live criteria
  2. Open /map / inspect GET /admin/workers/live response
- **API:** `GET /admin/workers/live`
- **Expect:** That worker is absent from the pins array (LivePins WHERE excludes them) — confirms suspended/banned/pending pros don't leak onto the ops map even with stale availability flags.

#### `MAP-09` RBAC: viewer is BLOCKED from the Live Map  — **P0** · _rbac_
- **Pre:** Two logins: role=viewer and role=support. (/admin/workers/live is gated on workers.read = support.)
- **Steps:**
  1. Log in as viewer, navigate to /map
  2. Observe network call to GET /admin/workers/live
  3. Log in as support, repeat
- **API:** `GET /admin/workers/live`
- **Expect:** Viewer: 403 insufficient_permissions required_role=support your_role=viewer; map shows no pins and stays in '0 workers online' / loading — note the page has NO 403 toast/handler, so a viewer just sees a silently empty map (confusing). Support (required min) and above: pins load. RBAC gap-ish UX: the /map sidebar link is shown to viewers even though they can't fetch data.

#### `ZONE-04` Create surge rule (money multiplier) + webhook  — **P0** · _money_
- **Pre:** Admin token; an existing zone id. (surge.create=admin.)
- **Steps:**
  1. POST /admin/zones/surge with {zone_id, multiplier:1.5, starts_at, ends_at, reason}
  2. GET /admin/zones/surge to confirm
  3. Inspect outbound webhook / dispatcher logs for admin.surge.activated
- **API:** `POST /admin/zones/surge`, `GET /admin/zones/surge`
- **Expect:** 200 {id}; rule listed with multiplier stored. Webhook EventAdminSurgeActivated fired with multiplier/zone/admin_id. NOTE: multiplier is float64 across the wire and DB (zones.go) — surge pricing is float-based; per ZopMop money rules this is a float-in-money smell (the multiplier feeds price math elsewhere). Verify whether downstream price application keeps paise integer.

#### `LOC-02` Add button disabled until both fields non-blank  — **P1** · _edge_
- **Pre:** On /localities.
- **Steps:**
  1. Clear the City field entirely
  2. Type only a Name
  3. Observe the Add button
- **Expect:** Add button is disabled (no request fires). submitNew also early-returns on whitespace-only input. Re-enabling requires both Name and City non-blank after trim.

#### `LOC-03` Duplicate (name, city) rejected with 409  — **P1** · _negative_
- **Pre:** A locality 'Sector 14' / 'Gurugram' already exists.
- **Steps:**
  1. Type the exact same Name 'Sector 14' and City 'Gurugram'
  2. Click 'Add'
- **API:** `POST /admin/localities`
- **Expect:** 409 Conflict with body {"error":"already exists for that city"}; red error toast surfaces that message (showToast reads e.response.data.error). No new row added.

#### `LOC-04` Toggle active <-> disabled  — **P1** · _happy_
- **Pre:** At least one locality row exists. Admin role.
- **Steps:**
  1. Click the green 'Active' badge in a row's Active column
  2. Observe the badge flip to gray 'Disabled'
  3. Click again to flip back
- **API:** `PATCH /admin/localities/:id`
- **Expect:** 200; the toggle sends {name,city,active:!active}. Badge state flips after list invalidation+refetch. No toast on success (silent), error toast on failure.

#### `LOC-07` Rename to a colliding (name, city) rejected  — **P1** · _negative_
- **Pre:** Two localities exist in 'Gurugram': 'A' and 'B'. Admin role.
- **Steps:**
  1. PATCH the 'A' row with body {name:'B', city:'Gurugram', active:true}
- **API:** `PATCH /admin/localities/:id`
- **Expect:** 409 Conflict {"error":"already exists for that city"}; transaction rolls back so NO partial cascade to helpers/bookings occurred. 'A' keeps its name.

#### `LOC-10` Empty / whitespace name rejected server-side  — **P1** · _negative_
- **Pre:** Admin role.
- **Steps:**
  1. POST /admin/localities with {"name":"   ","city":"Gurugram"} (bypassing the disabled button)
- **API:** `POST /admin/localities`
- **Expect:** 400 {"error":"name and city are required"} after server-side TrimSpace. Confirms server validates independently of the disabled UI button.

#### `LOC-14` support role blocked from locality writes (insufficient)  — **P1** · _rbac_
- **Pre:** CRM login role=support.
- **Steps:**
  1. As support, attempt POST/PATCH/DELETE on /admin/localities
- **API:** `POST /admin/localities`, `PATCH /admin/localities/:id`, `DELETE /admin/localities/:id`
- **Expect:** All 403 required_role=admin your_role=support. support is INSUFFICIENT for locality writes; admin is the required minimum. GET still 200 (support >= viewer).

#### `LOC-15` Audit log written on every locality write  — **P1** · _happy_
- **Pre:** Admin role; audit recorder wired (crm-api passes auditRecorder to localities.NewHandler).
- **Steps:**
  1. Create, then update, then delete a locality
  2. Open /audit (admin) or query the audit table filtered by module='localities'
- **API:** `POST /admin/localities`, `PATCH /admin/localities/:id`, `DELETE /admin/localities/:id`, `GET /admin/audit`
- **Expect:** Three audit entries: locality.create / locality.update / locality.delete, each with admin_id, admin_email, ip, target_id. NOTE: 'before' is always nil for update/delete (handler passes nil) — the prior state is NOT captured, so audit can't show what a rename changed from.

#### `LOC-16` Double-click Add (concurrency / dup submit)  — **P1** · _concurrency_
- **Pre:** Admin role; new unique name typed.
- **Steps:**
  1. Type a fresh name + city
  2. Double-click 'Add' rapidly
- **API:** `POST /admin/localities`
- **Expect:** Button disables while create.isPending so a second click is usually suppressed; if two requests do race, the unique (name,city) constraint makes the second return 409 -> error toast. End state: exactly one row. Confirm no duplicate row created.

#### `MAP-02` Missing Google Maps key shows graceful fallback  — **P1** · _edge_
- **Pre:** VITE_GOOGLE_MAPS_API_KEY blank/unset; restart Vite dev server.
- **Steps:**
  1. Open /map
- **Expect:** No map; an EmptyState 'Google Maps key missing / Set VITE_GOOGLE_MAPS_API_KEY in App/zopmop-crm/.env to render the map.' renders instead. App does not crash. (Same wrapper used by dashboard MiniWorkerMap.)

#### `MAP-04` Empty state — no workers online  — **P1** · _edge_
- **Pre:** Valid Maps key; zero helpers meeting the LivePins criteria (e.g. set all last_location_at older than 90s).
- **Steps:**
  1. Open /map
- **API:** `GET /admin/workers/live`
- **Expect:** Map still renders; centered overlay card 'No workers currently online'; legend shows '0 workers online'; 'Fit all workers' button is disabled (pins.length===0).

#### `MAP-05` Click marker opens InfoWindow detail card  — **P1** · _happy_
- **Pre:** At least one pin on the map, ideally one with an active booking (status accepted/arrived/in_progress).
- **Steps:**
  1. Click a worker marker
  2. Inspect the InfoWindow: name/phone, status pill, star rating, Active booking link
  3. Click the Active booking link
  4. Close the InfoWindow with the X
- **API:** `GET /admin/workers/live`
- **Expect:** InfoCard shows name (or phone), phone, status pill, rating.toFixed(2). If active_booking_id present, a link to /orders/<id> navigates to the order detail. X closes the window. NOTE: the 'Updated …' timestamp line never renders because the backend LivePins query never selects updated_at (always omitted) — flag.

#### `MAP-06` Auto-refresh every 10s without yanking the view  — **P1** · _edge_
- **Pre:** Valid key; pins present; ability to move a helper's current_lat/lng in DB.
- **Steps:**
  1. Open /map and pan/zoom away from the auto-fitted bounds
  2. Update a helper's current_lat/lng (and last_location_at=now())
  3. Wait up to ~10s for the next poll
- **API:** `GET /admin/workers/live`
- **Expect:** Marker moves to the new position WITHOUT the map re-fitting bounds (auto-fit guarded by didFitRef so it runs only on the first non-empty payload). Admin's pan/zoom is preserved. Status color updates if job_status changed.

#### `MAP-07` Stale-location worker drops off the map within 90s  — **P1** · _edge_
- **Pre:** One pin currently visible.
- **Steps:**
  1. Stop updating that helper's last_location_at (or set it >90s old)
  2. Wait for the next poll(s)
- **API:** `GET /admin/workers/live`
- **Expect:** Server filters last_location_at <= now()-90s, so the worker disappears from /admin/workers/live; the Markers diff drops its marker (setMap(null) + delete). Legend count decrements.

#### `ZONE-01` Create a service zone (circle) — API only  — **P1** · _happy_
- **Pre:** Admin role token. No frontend page — use curl/Postman. (zones.create=admin.)
- **Steps:**
  1. POST /admin/zones/ with {name,city,lat,lon,radius_km} e.g. radius_km=5
  2. GET /admin/zones/ to list
- **API:** `POST /admin/zones/`, `GET /admin/zones/`
- **Expect:** 200 {"id":...}; new zone appears in list (ordered created_at DESC) with is_active default. NOTE the route group registers Get('/') and Post('/') so the path requires a trailing slash: /admin/zones/.

#### `ZONE-02` Zone validation boundaries  — **P1** · _edge_
- **Pre:** Admin role token.
- **Steps:**
  1. POST /admin/zones/ with radius_km=0 -> expect reject
  2. POST with radius_km=100 -> expect accept (inclusive upper bound)
  3. POST with radius_km=100.1 -> expect reject
  4. POST with lat=0 and lon=0 -> expect reject ('lat / lon required')
  5. POST with blank name or city -> expect reject
- **API:** `POST /admin/zones/`
- **Expect:** 400 {"error":"radius_km must be (0, 100]"} for 0 and >100; 200 for exactly 100. lat==0 && lon==0 -> 400 'lat / lon required'. NOTE: a legitimate point on the equator/prime-meridian (lat=0 OR lon=0 individually is fine, but exactly 0,0 / and any zone genuinely at lat 0) is wrongly rejected — flag (Gulf of Guinea only, low real risk).

#### `ZONE-05` Surge multiplier boundary validation  — **P1** · _edge_
- **Pre:** Admin token; existing zone id.
- **Steps:**
  1. POST surge with multiplier=0 -> reject
  2. POST surge with multiplier=5 -> accept (inclusive)
  3. POST surge with multiplier=5.0001 -> reject
- **API:** `POST /admin/zones/surge`
- **Expect:** 400 {"error":"multiplier must be (0, 5]"} for 0 and >5; 200 for exactly 5. No upper-time validation (starts_at after ends_at is NOT checked) — flag: an end-before-start surge window is accepted.

#### `ZONE-06` RBAC: viewer reads zones/surge but cannot write  — **P1** · _rbac_
- **Pre:** viewer and admin tokens. (zones.read/surge.read=viewer; create/update/toggle/delete=admin.)
- **Steps:**
  1. As viewer: GET /admin/zones/ and GET /admin/zones/surge -> expect 200
  2. As viewer: POST /admin/zones/, PUT /admin/zones/:id, POST /admin/zones/:id/toggle, POST /admin/zones/surge, DELETE /admin/zones/surge/:id -> expect 403
  3. Repeat writes as admin
- **API:** `GET /admin/zones/`, `GET /admin/zones/surge`, `POST /admin/zones/`, `PUT /admin/zones/:id`, `POST /admin/zones/:id/toggle`, `POST /admin/zones/surge`, `DELETE /admin/zones/surge/:id`
- **Expect:** Viewer: reads 200, all writes 403 required_role=admin. Admin: writes succeed. Confirms viewer is insufficient, admin is required for all zone/surge mutations.

#### `LOC-08` Update non-existent locality returns 404  — **P2** · _negative_
- **Pre:** Admin role; know a random UUID not in the table.
- **Steps:**
  1. PATCH /admin/localities/<random-uuid> with valid body
- **API:** `PATCH /admin/localities/:id`
- **Expect:** 404 {"error":"not found"} (FOR UPDATE select returns pgx.ErrNoRows -> ErrNotFound).

#### `LOC-09` Malformed UUID in path  — **P2** · _negative_
- **Pre:** Admin role.
- **Steps:**
  1. PATCH /admin/localities/not-a-uuid with valid body, then DELETE /admin/localities/not-a-uuid
- **API:** `PATCH /admin/localities/:id`, `DELETE /admin/localities/:id`
- **Expect:** Cast 'not-a-uuid'::uuid fails in Postgres -> generic 500 {"error":"failed to update"/"failed to delete"} rather than a 400/404. Note as suspected bug: invalid id surfaces as 500, not a clean 4xx.

#### `LOC-11` Empty state on fresh DB  — **P2** · _edge_
- **Pre:** localities table empty.
- **Steps:**
  1. Open /localities
- **API:** `GET /admin/localities`
- **Expect:** Loading skeletons briefly, then EmptyState card 'No localities yet / Add one above to get started.' No table rendered. Add form still usable.

#### `LOC-12` Max-length boundary on Name/City  — **P2** · _edge_
- **Pre:** Admin role; on /localities.
- **Steps:**
  1. Paste >100 chars into Name (maxLength=100) and >80 into City (maxLength=80)
  2. Click Add
- **API:** `POST /admin/localities`
- **Expect:** UI clips Name to 100 and City to 80 via maxLength; the clipped values are sent. Verify no server-side length cap exists (server only trims/empties-checks) so DB column limits govern — exceeding a DB varchar limit would surface as 500.

#### `MAP-03` Invalid Maps key surfaces load-error state  — **P2** · _negative_
- **Pre:** VITE_GOOGLE_MAPS_API_KEY set to an invalid/expired key.
- **Steps:**
  1. Open /map and wait
- **Expect:** useJsApiLoader loadError -> EmptyState 'Map failed to load / Check your Google Maps API key.' No JS crash.

#### `MAP-10` Clustering toggles above 100 pins  — **P2** · _edge_
- **Pre:** Ability to seed >100 online helpers meeting LivePins criteria (note hard LIMIT 1000 in query).
- **Steps:**
  1. Seed ~120 valid online helpers
  2. Open /map
  3. Then reduce below 100 and wait for a refetch
- **API:** `GET /admin/workers/live`
- **Expect:** Above CLUSTER_THRESHOLD(100): MarkerClusterer engages (cluster bubbles). Dropping below 100: clusterer cleared and individual markers re-shown on the map. With >1000 valid workers, only 1000 pins ever return (LIMIT 1000) — legend count caps at 1000.

#### `MAP-11` Fit-all-workers button  — **P2** · _happy_
- **Pre:** Pins present; admin has panned away.
- **Steps:**
  1. Pan/zoom the map away from workers
  2. Click 'Fit all workers' in the legend
- **Expect:** Map re-fits bounds to all current pins (80px padding). Button disabled when map not loaded or 0 pins.

#### `ZONE-03` Update / toggle zone, 404 on missing  — **P2** · _negative_
- **Pre:** Admin token; one existing zone id and one random uuid.
- **Steps:**
  1. PUT /admin/zones/:id with valid body on existing id
  2. POST /admin/zones/:id/toggle {active:false} on existing id
  3. PUT and toggle a random (non-existent) uuid
- **API:** `PUT /admin/zones/:id`, `POST /admin/zones/:id/toggle`
- **Expect:** Existing: PUT 200 {ok:true}, toggle 200 {ok:true} (RowsAffected>0). Missing id: UpdateZone returns ErrNotFound but handler maps ALL errors to 400 {"error":"zone not found"} (not 404); toggle correctly returns 404. Flag the inconsistent status code on UpdateZone.

#### `ZONE-07` Surge create with non-existent zone_id  — **P2** · _negative_
- **Pre:** Admin token; a random uuid not in service_zones.
- **Steps:**
  1. POST /admin/zones/surge with zone_id=<random uuid>, multiplier=2
- **API:** `POST /admin/zones/surge`
- **Expect:** FK violation (crm_surge_rules.zone_id -> service_zones) surfaces as 400 {"error":"<pg error text>"}. Confirm the raw DB error text isn't leaking sensitive schema detail to the client — flag if verbose.

#### `ZONE-08` Delete surge rule + idempotency on repeat  — **P2** · _idempotency_
- **Pre:** Admin token; one existing surge rule id.
- **Steps:**
  1. DELETE /admin/zones/surge/:id once
  2. DELETE the same id again
- **API:** `DELETE /admin/zones/surge/:id`
- **Expect:** First: 200 {ok:true} + audit surge.delete. Second: RowsAffected==0 -> ErrNotFound, but handler maps to 400 {"error":"zone not found"} (not 404) — flag the status code. Not truly idempotent (second call errors rather than 200/204).

### sdui  <sub>(24 flows — P0:9 P1:8 P2:7)</sub>

Server-driven UI admin in the ZopMop CRM. Lets admins manage per-page SDUI config lifecycle (draft → stage → activate → archive, plus rollback), preview hydrated layouts, arm page/experiment kill switches, and maintain the action allowlist that gates which endpoints SDUI buttons may call. Backend reuses the internal/bff AdminHandler, mounted under /admin in crm-api (cmd/crm-api/sdui.go) with per-route RBAC (sdui.read/write/activate, all = RoleAdmin) and a locals bridge that maps the CRM admin identity onto the bff handler's userID/role expectations.

**Pages:** `/sdui` · `/sdui/:pageId` · `/sdui/allowed-actions`

**Test data:** A CRM admin account with role 'admin' (or higher) — required for ALL sdui routes incl. read.; A second CRM admin with role 'viewer' and one with 'support' — to exercise RBAC 403 flows.; Seed migration 035_sdui_tables + 036_seed_sdui_home applied: gives page_id 'home', version 'static-1.0', env 'production', status 'active' (run `make migrate`).; At least one row in sdui_allowed_actions (e.g. endpoint '/api/v1/cart/add' methods {POST}) to test stage validation passing and the delete-breaks-config flow; OR start empty to test the empty state.; A draft with experiment_id set (e.g. exp_123) to surface the ExperimentKillSwitch panel.; A config with a section action referencing a non-allowlisted endpoint, to trigger stage validation failure.; A page with >50 sdui_audit_log rows (generate by repeated create/stage/activate/preview) to test the audit limit=50 / 100-cap.; Redis reachable for kill-switch flows; a way to stop Redis to test the 'redis unavailable' 500 path.; A non-prod Postgres+Redis (docker-compose `make up`) — do NOT point the CRM at prod, since activate/rollback/kill-switch mutate shared state the user-app reads.

#### `sdui-activate-double-click` Double-click Activate does not double-promote or corrupt single-active invariant  — **P0** · _idempotency_
- **Pre:** Admin role. A staged config exists for the page.
- **Steps:**
  1. Click the green Activate button, and in the ConfirmModal click 'Activate' twice rapidly (or re-open and confirm again immediately)
  2. Watch the network tab for two PUT .../activate calls
- **API:** `PUT /admin/pages/<page>/configs/<version>/activate (If-Match) ×2`
- **Expect:** First call promotes (200); second call finds status no longer 'staged' and returns 409 'config not in staged state' (or 412 on stale ETag). Only one active row exists (sdui_single_active index enforces). No duplicate archive/activate. Second 409 surfaces as a toast.

#### `sdui-allowlist-add` Add an allowed action  — **P0** · _happy_
- **Pre:** Admin role (sdui.activate gates the write server-side; FE gates the Add button at sdui.write).
- **Steps:**
  1. Go to /sdui/allowed-actions, click 'Add action'
  2. Enter Endpoint '/api/v1/cart/add', check methods POST and GET
  3. Click 'Add' → toast 'Allowed action added.', new row appears with active status and the methods as pills
- **API:** `GET /admin/allowed-actions`, `POST /admin/allowed-actions (methods uppercased server-side)`
- **Expect:** 201; row shows endpoint + uppercased methods + 'active'; whitelist cache invalidated so subsequent stage validations accept the endpoint. Methods are uppercased server-side regardless of input case.

#### `sdui-allowlist-delete-breaks-configs` Delete an allowed action; dependent configs fail re-stage  — **P0** · _money_
- **Pre:** Admin role. An allowed action exists AND a config references it in a section action.
- **Steps:**
  1. On /sdui/allowed-actions click the red Trash on the referenced endpoint → ConfirmModal warns existing configs will fail validation; click 'Remove'
  2. Go back to the page that referenced it, edit/re-stage that config
- **API:** `DELETE /admin/allowed-actions/:id → 204`, `PUT /admin/pages/<page>/configs/<version>/stage → 400 (unknown endpoint)`
- **Expect:** Action removed; whitelist cache invalidated; re-staging a config that references the removed endpoint now fails validation with 'unknown endpoint'. Confirms the allowlist truly gates what SDUI buttons can call.

#### `sdui-happy-lifecycle` Full draft → stage → activate lifecycle for a page  — **P0** · _happy_
- **Pre:** Logged in as an admin (role >= admin). Seed page 'home' exists (migration 036, version static-1.0, active). At least one allowed action exists OR the draft references no api actions (starter config has empty sections, so no action check fails).
- **Steps:**
  1. Go to /sdui, click the 'home' row
  2. Click 'New draft' (top-right, requires sdui.write)
  3. In the modal, type Version '99' in the Version field; leave the starter config_json as-is (it has min_client_version 1.0.0, schema_version 1, empty sections)
  4. Click 'Create draft' — toast 'Draft created.', new row appears with status 'draft'
  5. On the draft row, click the Stage (upload) icon — toast 'v99 staged.', status pill flips to 'staged'
  6. Click the green 'Activate' button on the staged row → ConfirmModal; click 'Activate'
  7. Confirm toast 'v99 is live.', row status = 'active', and the previously-active static-1.0 row flips to 'archived'
- **API:** `GET /admin/pages`, `GET /admin/pages/home/configs?env=production`, `POST /admin/pages/home/configs`, `PUT /admin/pages/home/configs/99/stage`, `GET /admin/pages/home/configs/99?env=production`, `PUT /admin/pages/home/configs/99/activate (If-Match: <etag>)`
- **Expect:** v99 is the single active config; old active is archived; audit log shows created, staged, activated rows with the admin's id as actor. DB sdui_single_active partial unique index holds (only one active per page+env).

#### `sdui-killswitch-on-off` Page kill switch enable/disable  — **P0** · _happy_
- **Pre:** Admin role (sdui.activate). Redis up. Page 'home'.
- **Steps:**
  1. On /sdui/home find the 'Kill switch' card
  2. Click 'Enable kill switch' → ConfirmModal, click 'Enable'
  3. Observe toast 'Kill switch enabled.', card border turns danger, copy says clients fall back to safe/empty layout
  4. Click 'Disable' → toast 'Kill switch disabled.', card returns to normal
- **API:** `GET /admin/pages/home/kill-switch`, `POST /admin/pages/home/kill-switch`, `DELETE /admin/pages/home/kill-switch`
- **Expect:** Redis key sdui:kill:home is set (no TTL) then deleted; killStatus reflects state; audit rows action='kill_switch' note enabled/disabled. IMPORTANT cross-system effect: this same key is read by the user-app BFF, so enabling from CRM blanks the real home screen for production users (see suspectedBugs / preconditions on shared infra).

#### `sdui-rbac-viewer-read-blocked` Lower-role admin (viewer/support) is blocked from SDUI entirely  — **P0** · _rbac_
- **Pre:** A CRM admin with role 'viewer' or 'support' (required role for ALL sdui routes incl. read is 'admin'). Log in as that admin.
- **Steps:**
  1. Navigate directly to /sdui in the URL bar (the route is NOT route-guarded in App.tsx)
  2. Observe the page shell renders but the pages list query fails
  3. Check the toast
- **API:** `GET /admin/pages → 403 insufficient_permissions (required_role admin)`
- **Expect:** Backend returns 403; interceptor shows 'Insufficient permissions. Requires admin; you are viewer.' The list stays empty. RBAC: required = admin, insufficient = viewer/support. NOTE the FE route has no guard so the viewer reaches the page chrome — only the API enforces (see suspectedBug on missing route guard).

#### `sdui-rbac-write-blocked` Write/activate blocked for non-admin even if buttons were forced  — **P0** · _rbac_
- **Pre:** Admin with role below admin. (In practice they can't even read; this verifies defense-in-depth on a mutation route.)
- **Steps:**
  1. As a sub-admin, attempt POST /admin/pages/home/configs or PUT .../activate via devtools/curl with a valid sub-admin token
- **API:** `POST /admin/pages/home/configs → 403`, `PUT /admin/pages/home/configs/<v>/activate → 403`, `POST /admin/allowed-actions → 403 (requires sdui.activate)`
- **Expect:** Every mutation returns 403 insufficient_permissions; required_role 'admin'. Server-side RBAC is the real gate (FE Can/disabled buttons are cosmetic). Note allowlist create/delete require sdui.activate, not sdui.write.

#### `sdui-rollback` Rollback re-activates the most recently archived config  — **P0** · _happy_
- **Pre:** Page 'home' has one active config and at least one archived config (run sdui-happy-lifecycle first so static-1.0 is archived and v99 is active). Admin role.
- **Steps:**
  1. On /sdui/home, click 'Rollback' (top-right, warning-toned, requires sdui.activate)
  2. In the ConfirmModal read the impact text, click 'Rollback'
  3. Observe toast 'Rolled back to previous config.'
  4. Confirm the previously-active v99 is now 'archived' and static-1.0 is back to 'active'
- **API:** `PUT /admin/pages/home/configs/current/rollback?env=production`, `GET /admin/pages/home/configs?env=production`
- **Expect:** Active flips to the most-recently-archived config; the formerly-active is archived; an audit row action='rolled_back' is written. The :version path segment is the literal 'current' and is ignored server-side (rollback keys off env query param).

#### `sdui-stage-validation-fail` Stage surfaces schema/lint validation errors inline  — **P0** · _negative_
- **Pre:** Admin role. A draft whose config_json violates the validator: e.g. >20 sections, an unknown $ref, or a section action referencing an endpoint NOT in the allowlist.
- **Steps:**
  1. Create/edit a draft and paste config_json with a section that has actions:[{endpoint:'/api/v1/not-allowed', method:'POST'}] (endpoint not in allowlist)
  2. Save the draft
  3. Click the Stage (upload) icon on the draft row
  4. Observe toast 'Validation failed for v<version>.' and an inline red ValidationPanel listing the errors (e.g. 'unknown endpoint /api/v1/not-allowed')
- **API:** `PUT /admin/pages/<page>/configs/<version>/stage (returns 400 with {errors,warnings})`
- **Expect:** Backend returns 400; FE parses the {errors,warnings} body (sduiApi.stage catches 400 and returns ok:false) and renders the ValidationPanel; the config stays in 'draft'; Activate button never appears.

#### `sdui-allowlist-add-duplicate` Adding a duplicate endpoint returns 409  — **P1** · _negative_
- **Pre:** Admin role. An allowed action for '/api/v1/cart/add' already exists.
- **Steps:**
  1. Click 'Add action', enter the same endpoint '/api/v1/cart/add', any method
  2. Click 'Add'
- **API:** `POST /admin/allowed-actions → 409`
- **Expect:** 409 'an allowed action for this endpoint already exists'; toast surfaces it (endpoint column is UNIQUE; 23505 correctly mapped to ErrConflict here). Modal stays open.

#### `sdui-delete-active-409` Deleting an active/staged config is blocked server-side  — **P1** · _negative_
- **Pre:** Admin role. An active config exists. Use a direct API call (UI hides the delete button for active/staged).
- **Steps:**
  1. With devtools/curl, send DELETE /admin/pages/home/configs/static-1.0 while static-1.0 is active
- **API:** `DELETE /admin/pages/home/configs/static-1.0 → 409`
- **Expect:** Returns 409 'config not in draft state'; the active config is NOT deleted. Confirms DeleteDraft status guard.

#### `sdui-delete-draft` Delete a draft (and archived) config  — **P1** · _happy_
- **Pre:** Admin role. A draft and/or an archived config exist.
- **Steps:**
  1. On a draft row click the red Trash icon → ConfirmModal
  2. Click 'Delete' — toast 'Draft v<version> deleted.', row disappears
  3. Repeat on an archived row (archived rows also expose a delete button)
- **API:** `DELETE /admin/pages/<page>/configs/<version> → 204`
- **Expect:** Row removed (DeleteDraft allows status IN ('draft','archived')). An audit row action='deleted' is written. Attempting to delete a staged/active config would 409 (not reachable from UI since those rows show no delete button).

#### `sdui-duplicate-version-500` Creating a draft with an existing version returns a raw 500 (suspected bug)  — **P1** · _negative_
- **Pre:** Admin role. Page 'home' already has version 'static-1.0' in env production.
- **Steps:**
  1. On /sdui/home click 'New draft'
  2. Type Version 'static-1.0' (collides with the seeded row)
  3. Click 'Create draft'
  4. Observe the toast
- **API:** `POST /admin/pages/home/configs → 500 (raw pg unique-violation error text)`
- **Expect:** BUG: the toast shows a raw Postgres error ('... duplicate key value violates unique constraint ...') with status 500 instead of a clean 409 'version already exists'. Contrast with allowed-actions which correctly returns 409. See suspectedBugs.

#### `sdui-edit-etag-optimistic-lock` Editing a draft uses If-Match ETag; stale ETag is rejected  — **P1** · _concurrency_
- **Pre:** Admin role. One draft exists. Open the same draft's Edit modal in two browser tabs (both capture the same ETag via getConfig).
- **Steps:**
  1. Tab A: open Edit on draft v<version>, change Name, click 'Save draft' — success
  2. Tab B (still holding the old ETag): change config_json, click 'Save draft'
  3. Observe Tab B gets an error toast (etag mismatch / 412)
- **API:** `GET /admin/pages/<page>/configs/<version>?env=production (captures ETag header)`, `PATCH /admin/pages/<page>/configs/<version> (If-Match: <stale etag>) → 412`
- **Expect:** Tab B's PATCH returns 412 'etag mismatch'; the generic interceptor surfaces a 'Request failed (412)' / 'etag mismatch' toast; the draft is NOT silently overwritten. Verifies optimistic locking in Repository.UpdateDraft.

#### `sdui-experiment-killswitch` Experiment kill switch (per-config) enable then clear  — **P1** · _happy_
- **Pre:** Admin role. A config with a non-empty experiment_id (set experiment_id when creating/editing a draft, or edit an existing draft).
- **Steps:**
  1. Create/edit a draft, set 'Experiment ID' to e.g. exp_123, save
  2. On that config row an ExperimentKillSwitch panel appears
  3. Click 'Kill experiment' → ConfirmModal, click 'Kill' → toast 'Experiment kill switch enabled.'
  4. Click 'Clear' → toast 'Experiment kill switch disabled.'
- **API:** `POST /admin/experiments/exp_123/kill-switch`, `DELETE /admin/experiments/exp_123/kill-switch`
- **Expect:** Redis key sdui:kill:exp:exp_123 set then deleted; audit rows written under synthetic page_id '_experiment'. 'Clear' has no confirm and no status readback, so it's fire-and-forget (idempotent DEL).

#### `sdui-rollback-no-archived` Rollback with no archived config to restore  — **P1** · _negative_
- **Pre:** Admin role. A page that has an active config but NO archived configs (e.g. only ever activated once, never rolled).
- **Steps:**
  1. On such a page click 'Rollback' → confirm
- **API:** `PUT /admin/pages/<page>/configs/current/rollback?env=production → 404`
- **Expect:** Returns 404 'no archived config to roll back to'; toast surfaces it; active config unchanged.

#### `sdui-stage-warnings-only` Stage succeeds with non-blocking warnings  — **P1** · _edge_
- **Pre:** Admin role. Draft that passes schema but triggers warnings: e.g. no hero section (empty sections) → warning 'no hero section found'.
- **Steps:**
  1. Create a draft with the default starter config (empty sections)
  2. Click Stage
  3. Observe toast 'v<version> staged.' (success) AND an inline warning panel listing 'no hero section found (hero_carousel or greeting_hero)'
- **API:** `PUT /admin/pages/<page>/configs/<version>/stage (200 with warnings[])`
- **Expect:** Status flips to 'staged' despite warnings; warnings render in the yellow panel but do not block activation.

#### `sdui-allowlist-add-empty` Add action validation: empty endpoint or no methods blocked  — **P2** · _negative_
- **Pre:** Admin role.
- **Steps:**
  1. Open Add action modal, leave Endpoint blank → 'Add' button stays disabled
  2. Type an endpoint then uncheck every method → 'Add' button disabled again
- **Expect:** FE disables 'Add' until endpoint non-empty AND >=1 method. If bypassed via API, backend returns 400 'endpoint and methods required'.

#### `sdui-audit-log-limit` Audit log fetches 50 and respects backend cap  — **P2** · _edge_
- **Pre:** Admin role. A page with >50 audit rows (run create/stage/activate/preview several times, or seed).
- **Steps:**
  1. Open /sdui/<page> and scroll to the Audit log card
  2. Inspect the network call's limit param
- **API:** `GET /admin/pages/<page>/audit-log?limit=50`
- **Expect:** FE requests limit=50; backend caps anything <=0 or >500 to 100. Newest entries first (created_at DESC). Each row shows when (localized), action pill, actor id, note.

#### `sdui-empty-states` Empty states render across all three pages  — **P2** · _edge_
- **Pre:** Admin role. A fresh DB / a page_id with no configs / empty allowlist.
- **Steps:**
  1. Visit /sdui with no configured pages → 'No SDUI pages / No pages have configs yet.'
  2. Visit /sdui/<newPageWithNoConfigs> → 'No configs / Create a draft to get started.' and an empty audit log 'No audit entries'
  3. Visit /sdui/allowed-actions with empty table → 'No allowed actions / SDUI buttons can\'t call any endpoint until one is added.'
- **API:** `GET /admin/pages`, `GET /admin/pages/<page>/configs`, `GET /admin/pages/<page>/audit-log`, `GET /admin/allowed-actions`
- **Expect:** Each table shows its EmptyState rather than erroring; loading skeletons appear first.

#### `sdui-killswitch-redis-down` Kill switch when Redis is unavailable  — **P2** · _negative_
- **Pre:** Admin role. Redis stopped/unreachable.
- **Steps:**
  1. On the kill switch card click 'Enable kill switch' and confirm
- **API:** `POST /admin/pages/home/kill-switch → 500 'redis unavailable' (or set error)`
- **Expect:** Returns 500; toast surfaces the error; killStatus GET returns kill_switch:false when rdb is nil (degraded read). No crash.

#### `sdui-preview-as-other-user` Preview as another user_id is honored (role=admin bridge)  — **P2** · _edge_
- **Pre:** Admin role. A second real user_id to impersonate in preview.
- **Steps:**
  1. Open Preview on a config
  2. Enter another user's id in 'User ID'
  3. Run preview
- **API:** `GET /admin/pages/<page>/configs/<version>/preview?user_id=<other>`
- **Expect:** Hydration uses the supplied user_id (the locals bridge hardcodes role='admin' so the 'preview as another user' path is always taken). Audit note records 'preview as user=<other>'. QA: confirm impersonation is acceptable for any CRM admin since every CRM admin is treated as super-admin for preview.

#### `sdui-preview-hydrated` Preview renders hydrated page (visual + raw JSON)  — **P2** · _happy_
- **Pre:** Admin role. Any config (any status) exists. Insights/services sources reachable from crm-api's DB/Redis.
- **Steps:**
  1. On any config row click the Eye (Preview) icon
  2. In the PreviewModal optionally enter a User ID, Lat, Lon
  3. Click 'Run preview'
  4. Observe the phone-frame mock (SduiVisualPreview) on the left and resolved JSON on the right
- **API:** `GET /admin/pages/<page>/configs/<version>/preview?env=production&user_id=&lat=&lon=`
- **Expect:** 200 with the fully hydrated page (refs resolved). config_version equals the previewed version. NOTE: every preview writes an audit row action='previewed' (a GET mutating audit state — see suspectedBugs).

#### `sdui-unlink-experiment` Unlinking a draft from an experiment (empty string → NULL)  — **P2** · _edge_
- **Pre:** Admin role. A draft currently has experiment_id set.
- **Steps:**
  1. Edit the draft, clear the 'Experiment ID' field to empty
  2. Click 'Save draft'
  3. Reopen the config / re-list — the ExperimentKillSwitch panel for that row should disappear
- **API:** `PATCH /admin/pages/<page>/configs/<version> (body experiment_id:'') → experiment_id stored as NULL`
- **Expect:** experiment_id is cleared to NULL (FE deliberately sends '' on edit, mapped to NULL via nullableStr). Verifies the documented unlink behavior. NOTE: on CREATE the FE sends experiment_id: experimentId || undefined, so create-time clearing is fine; only edit can unlink.

### banners  <sub>(25 flows — P0:8 P1:8 P2:9)</sub>

Marketing home-screen banners CRUD with active toggle, audience targeting (all/new_users/vip/zone), CTA, scheduling (starts_at/ends_at in IST), external image URLs (no upload), and arrow-button reordering. Frontend is a single React page (BannersPage) hitting six Go/Fiber endpoints under /admin/banners; all writes require the 'admin' role, reads require 'viewer'. No money is involved, but reorder is a multi-row write with concurrency/idempotency risk.

**Pages:** `/banners` · `/banners (BannerEditor modal)`

**Test data:** CRM admins of each role for RBAC flows: one role='viewer', one role='support', one role='admin' (and ideally one 'superadmin'). Need their login credentials / TOTP to obtain Bearer tokens.; At least 3-4 banner rows with distinct display_order (0,1,2,3), mixed is_active true/false, at least one with subtitle, one with cta_label+cta_kind, one with starts_at/ends_at set, one with audience='zone' referencing a real service_zones id.; An empty banners table state (for BAN-02) — either a fresh DB or ability to delete all banner rows.; At least one active row in service_zones (created via /admin/zones) so the editor's zone picker is non-empty for BAN-04 (banners.audience_zone FK -> service_zones(id)).; A REST client (curl/Postman) with a valid admin Bearer token to exercise direct-API negative/edge cases the UI blocks (BAN-09..12, 16, 17, 21, 22, 24) and to send raw bodies.; A valid-format UUID known NOT to exist in banners (for 404/no-op tests).; Two browser sessions/tabs (or devtools network throttling) for the concurrency flows BAN-20 and the stale-edit flow.

#### `BAN-01` List banners (happy path, ordered)  — **P0** · _happy_
- **Pre:** Logged in as admin (or any role >= viewer). At least 3 banners exist with distinct display_order values (e.g. 0,1,2).
- **Steps:**
  1. Click 'Banners' in the left sidebar to open /banners.
  2. Observe the cards render top-to-bottom.
- **API:** `GET /admin/banners`
- **Expect:** Cards appear ordered by display_order ASC then created_at DESC. Each card shows thumbnail, title, active/inactive pill, and 'audience: <x> · order: <n>'. No console/network errors; 200 response with {items:[...]}.

#### `BAN-03` Create a banner (happy path, audience=all)  — **P0** · _happy_
- **Pre:** Logged in as admin (banners.create requires role 'admin').
- **Steps:**
  1. On /banners click 'New banner'.
  2. Fill Title = 'Summer Sale', Image URL = 'https://picsum.photos/600/300'.
  3. Leave audience = 'All users', Active checkbox checked.
  4. Click 'Save'.
  5. In the 'Create banner?' confirm modal click 'Create'.
- **API:** `POST /admin/banners`, `GET /admin/banners`
- **Expect:** Toast 'Banner created.'; modal closes; list refetches and shows the new banner with active pill. POST returns 200 with the created Banner JSON. An audit row action=banner.create module=banners is written.

#### `BAN-05` Edit an existing banner (toggle active, change subtitle)  — **P0** · _happy_
- **Pre:** Logged in as admin. At least one banner exists.
- **Steps:**
  1. Click 'Edit' on a banner card.
  2. Change Subtitle text and uncheck 'Active'.
  3. Click Save, then 'Save' in the 'Save changes?' confirm modal.
- **API:** `PUT /admin/banners/{id}`, `GET /admin/banners`
- **Expect:** Toast 'Banner updated.'; list refetches; the card pill flips to 'inactive' and subtitle updates. PUT returns 200 {ok:true}. Audit action=banner.update written.

#### `BAN-06` Reorder banners with up/down arrows  — **P0** · _happy_
- **Pre:** Logged in as admin (banners.reorder requires 'admin'). At least 3 banners present.
- **Steps:**
  1. On the second card, click the Up arrow.
  2. Observe the reorder.
  3. Reload the page (or wait for refetch).
- **API:** `POST /admin/banners/reorder`, `GET /admin/banners`
- **Expect:** Toast 'Order saved.'; the moved banner swaps position; after refetch the new order persists (display_order reassigned 0..n-1 in the sent sequence). POST body is {ids:[...all ids in new order...]}; returns 200 {ok:true}. Audit action=banner.reorder.

#### `BAN-07` Delete a banner (confirm modal)  — **P0** · _happy_
- **Pre:** Logged in as admin (banners.delete requires 'admin'). At least one banner exists.
- **Steps:**
  1. Click the red trash icon on a banner card.
  2. In the 'Delete banner?' confirm modal click 'Delete'.
- **API:** `DELETE /admin/banners/{id}`, `GET /admin/banners`
- **Expect:** Toast 'Banner deleted.'; card disappears after refetch. DELETE returns 200 {ok:true}. Audit action=banner.delete. Deleting a non-existent id returns 400 (see BAN-16).

#### `BAN-18` RBAC: viewer can read but cannot create/edit/delete/reorder  — **P0** · _rbac_
- **Pre:** Two CRM admins seeded: one role='viewer', one role='admin'. Log in as the VIEWER.
- **Steps:**
  1. Open /banners — confirm the list loads.
  2. Confirm the 'New banner' button is hidden (Can perm=banners.create).
  3. Confirm Up/Down arrows and the Delete trash icon are disabled (greyed, tooltip 'Insufficient permissions').
  4. Click 'Edit' on a card (Edit is always shown), then click 'Save' inside the editor.
- **API:** `GET /admin/banners`, `PUT /admin/banners/{id} (blocked)`
- **Expect:** GET /admin/banners succeeds (banners.read = viewer). No 'New banner' button. Arrows/Delete disabled. In the editor, Save is disabled for a viewer (canSave=canUpdate=false) and clicking it shows toast 'Insufficient permissions' without a network call. If a viewer bypasses the UI and PUTs directly, backend returns 403 {error:'insufficient_permissions', required_role:'admin', your_role:'viewer'} and the interceptor toasts 'Insufficient permissions. Requires admin; you are viewer.' Required role: admin for all writes; viewer for read.

#### `BAN-19` RBAC: support role blocked from all banner writes  — **P0** · _rbac_
- **Pre:** CRM admin with role='support'. Log in as support.
- **Steps:**
  1. Open /banners.
  2. Confirm 'New banner' hidden; arrows + Delete disabled.
  3. Via REST client with the support token: POST /admin/banners, PUT, DELETE, POST /reorder.
- **API:** `GET /admin/banners`, `POST /admin/banners`, `PUT /admin/banners/{id}`, `DELETE /admin/banners/{id}`, `POST /admin/banners/reorder`
- **Expect:** Read works. All four writes return 403 insufficient_permissions with required_role 'admin', your_role 'support'. UI controls are hidden/disabled identically to viewer (support rank 1 < admin rank 2). Required role: admin.

#### `BAN-25` Unauthenticated / expired token access  — **P0** · _negative_
- **Pre:** No valid session (logged out, or expired access + invalid refresh cookie).
- **Steps:**
  1. Directly navigate to /banners with no session.
  2. Or via REST client GET /admin/banners with no/garbage Bearer token.
- **API:** `GET /admin/banners`
- **Expect:** API returns 401; the SPA interceptor attempts a silent refresh and, on failure, clears session and routes to /login. Direct API call with bad token returns 401 (no banner data leaked).

#### `BAN-02` Empty state when no banners  — **P1** · _edge_
- **Pre:** Logged in as admin. banners table is empty (DELETE all rows or fresh DB).
- **Steps:**
  1. Open /banners.
  2. Wait for the skeleton to resolve.
- **API:** `GET /admin/banners`
- **Expect:** A Card containing the EmptyState 'No banners yet' renders. No card list, no JS error. Response is 200 with {items:[]}.

#### `BAN-04` Create banner targeting a zone  — **P1** · _happy_
- **Pre:** Logged in as admin. At least one active service_zone exists (created via /zones), so the zone picker is non-empty.
- **Steps:**
  1. Click 'New banner'.
  2. Set Title + Image URL.
  3. Change audience select to 'By zone' — confirm a second zone select appears.
  4. Pick a zone from the '— pick a zone —' dropdown.
  5. Click Save, then Create.
- **API:** `GET /admin/zones`, `POST /admin/banners`, `GET /admin/banners`
- **Expect:** Zone dropdown is populated by GET /admin/zones (service_zones). POST succeeds (audience='zone', audience_zone=<uuid>); the FK to service_zones resolves. Card shows 'audience: zone'. Toast 'Banner created.'

#### `BAN-08` Save disabled until required fields present (client validation)  — **P1** · _negative_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Click 'New banner'.
  2. Leave Title empty, leave Image URL empty.
  3. Observe the Save button.
  4. Type a Title only; observe Save still disabled.
  5. Add an Image URL; observe Save enabled.
- **Expect:** Save button is disabled (greyed) while !title || !image_url. No network call fires until both are filled. Enabling matches backend validate() which also requires title + image_url.

#### `BAN-09` Backend rejects blank/whitespace title or image_url  — **P1** · _negative_
- **Pre:** Logged in as admin. Use a REST client (curl/Postman) with a valid admin Bearer token to bypass the UI's disabled button.
- **Steps:**
  1. POST /admin/banners with body {"title":"   ","image_url":"https://x/y.png"}.
  2. POST /admin/banners with body {"title":"Hi","image_url":""}.
  3. POST /admin/banners with body {"title":"<201 chars>","image_url":"https://x/y.png"}.
- **API:** `POST /admin/banners`
- **Expect:** First two return 400 {"error":"title required"} / {"error":"image_url required"} (validate() trims). Third returns 400 {"error":"title too long"} (>200 chars). No row inserted. In the UI a malformed save surfaces an error toast via the interceptor.

#### `BAN-13` Scheduling round-trips in IST (starts_at/ends_at)  — **P1** · _edge_
- **Pre:** Logged in as admin. Browser timezone irrelevant (helpers force IST).
- **Steps:**
  1. Create or edit a banner; set starts_at via the datetime-local to e.g. 2026-07-01 09:00.
  2. Set ends_at to 2026-07-01 18:00. Save + confirm.
  3. Re-open the same banner in Edit.
- **API:** `POST /admin/banners or PUT /admin/banners/{id}`, `GET /admin/banners`, `GET /admin/banners/{id}`
- **Expect:** On reopen the datetime-local fields show the SAME IST wall-clock values (09:00 / 18:00), not shifted by 5h30m. istInputToUTC stores UTC; utcToISTInput renders IST back. Pass = no drift across save/reload.

#### `BAN-20` Reorder concurrency / double-click race (duplicate display_order)  — **P1** · _concurrency_
- **Pre:** Logged in as admin. At least 4 banners. Open the page in TWO browser tabs (or throttle network in devtools to widen the window).
- **Steps:**
  1. Tab A: click Up on banner #3.
  2. Immediately (before refetch) Tab B: click Up on banner #2 (Tab B still has the OLD order).
  3. Alternatively in one tab, rapidly double-click the Up arrow on the same card before the first reorder resolves.
  4. Reload and inspect display_order via GET /admin/banners or DB.
- **API:** `POST /admin/banners/reorder`, `POST /admin/banners/reorder`
- **Expect:** BUG EXPECTED: move() calls reorder.mutate with no disable-while-pending guard, so two overlapping reorder POSTs race. Reorder() sets display_order=index per id in a transaction but the two requests carry conflicting orderings; last-writer-wins can leave a non-sequential or surprising order. With stale lists across tabs, banners can end up with duplicate/skipped display_order. Pass criterion for QA: document the final order vs expected; flag any duplicate display_order values.

#### `BAN-21` Reorder with a partial / stale id list silently mis-orders  — **P1** · _idempotency_
- **Pre:** Logged in as admin. REST client with admin token. 3 banners exist with ids A,B,C.
- **Steps:**
  1. POST /admin/banners/reorder with body {"ids":["B"]} (only one id).
  2. GET /admin/banners and inspect display_order for A, B, C.
- **API:** `POST /admin/banners/reorder`, `GET /admin/banners`
- **Expect:** BUG EXPECTED: Reorder only updates the ids passed (B -> display_order 0) and leaves A and C untouched. If A previously had display_order 0, now A and B both have 0 -> duplicate ordering. Reorder does not validate the list covers all banners, nor that ids exist (a bogus id is a no-op, no error). Pass = QA confirms duplicate display_order is reachable; flag as data-integrity risk.

#### `BAN-23` Create/Save double-submit via confirm modal  — **P1** · _concurrency_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Open 'New banner', fill required fields, click Save.
  2. In the 'Create banner?' confirm modal, rapidly double-click 'Create'.
- **API:** `POST /admin/banners`
- **Expect:** Only ONE POST fires: ConfirmModal.go() sets busy=true and early-returns if busy, button shows 'Working…' and is disabled. Pass = single banner created, no duplicate. (Note: the editor's own 'Save' button only opens the confirm modal; the dedupe lives in ConfirmModal.)

#### `BAN-10` Title boundary: exactly 200 chars accepted, 201 rejected  — **P2** · _edge_
- **Pre:** Logged in as admin. REST client with admin token.
- **Steps:**
  1. POST a banner with title of exactly 200 characters + a valid image_url.
  2. POST a banner with title of 201 characters.
- **API:** `POST /admin/banners`
- **Expect:** 200-char title succeeds (validate uses len()>200, DB column is VARCHAR(200)). 201-char title returns 400 'title too long'. Confirms the off-by-one boundary matches the DB VARCHAR(200).

#### `BAN-11` Invalid cta_kind rejected by DB CHECK (leaky error)  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client with admin token (the UI select only offers valid kinds, so this requires a direct API call).
- **Steps:**
  1. POST /admin/banners with title+image_url and {"cta_kind":"banana"}.
- **API:** `POST /admin/banners`
- **Expect:** 400 with error message bubbling the raw Postgres CHECK violation (handler returns err.Error() verbatim: 'create banner: ...violates check constraint...'). validate() does NOT pre-check cta_kind, so the DB enforces it. Pass = request is rejected (no row); note the leaky error string as a minor info-disclosure smell.

#### `BAN-12` Invalid audience value rejected by DB CHECK  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client with admin token (UI select only offers valid audiences).
- **Steps:**
  1. POST /admin/banners with title+image_url and {"audience":"everyone"}.
- **API:** `POST /admin/banners`
- **Expect:** 400 raw CHECK violation (banners.audience CHECK IN ('all','new_users','vip','zone')). Note: empty audience is defaulted to 'all' by validate(), so '' succeeds; only a non-empty invalid value fails.

#### `BAN-14` Clearing a previously-set schedule date  — **P2** · _edge_
- **Pre:** Logged in as admin. A banner with starts_at set exists.
- **Steps:**
  1. Edit the banner, clear the starts_at datetime-local field (empty).
  2. Save + confirm.
  3. Reopen in Edit.
- **API:** `PUT /admin/banners/{id}`, `GET /admin/banners/{id}`
- **Expect:** Empty input -> istInputToUTC returns null -> starts_at stored NULL. Reopen shows empty field. No 400/500. Confirms nullable scheduling.

#### `BAN-15` Broken image URL degrades gracefully  — **P2** · _edge_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Create a banner with Image URL = 'https://example.com/does-not-exist.png'.
  2. Observe the list card thumbnail and the editor live preview.
- **API:** `POST /admin/banners`, `GET /admin/banners`
- **Expect:** Banner saves fine (no URL validation server- or client-side). On the list card the <img onError> hides the broken image (style.display='none') leaving the grey placeholder box. No JS error. Note: editor live preview <img> has NO onError handler, so it shows a broken-image glyph there.

#### `BAN-16` Edit/Delete a non-existent banner returns 404/400  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client. Know a valid-format UUID that is not in banners.
- **Steps:**
  1. GET /admin/banners/{random-uuid}.
  2. PUT /admin/banners/{random-uuid} with valid body.
  3. DELETE /admin/banners/{random-uuid}.
- **API:** `GET /admin/banners/{id}`, `PUT /admin/banners/{id}`, `DELETE /admin/banners/{id}`
- **Expect:** GET returns 404 {"error":"banner not found"}. PUT and DELETE return 400 {"error":"banner not found"} (RowsAffected()==0 -> ErrNotFound, but the handler maps ALL repo errors to 400, not 404 — inconsistent status code; flag). UI would show an error toast.

#### `BAN-17` Malformed UUID in path  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client.
- **Steps:**
  1. GET /admin/banners/not-a-uuid.
  2. PUT /admin/banners/not-a-uuid with a valid body.
- **API:** `GET /admin/banners/{id}`, `PUT /admin/banners/{id}`
- **Expect:** The $1::uuid cast fails in Postgres -> GET returns 500 {"error":"internal error"}; PUT returns 400 with the raw cast error string. Pass = no crash, no row affected. Flag the 500 on GET (invalid uuid is a client error, should be 400/404).

#### `BAN-22` Reorder with bogus/foreign UUID returns success (no validation)  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client.
- **Steps:**
  1. POST /admin/banners/reorder with {"ids":["<valid-uuid-not-in-banners>"]}.
  2. POST /admin/banners/reorder with {"ids":["not-a-uuid"]}.
- **API:** `POST /admin/banners/reorder`
- **Expect:** Valid-but-missing uuid: transaction runs UPDATE...WHERE id=$1 affecting 0 rows, commits, returns 200 {ok:true} (no error — silently succeeds, audit banner.reorder still logged). Malformed uuid: 400 with raw ::uuid cast error and the whole transaction rolls back. Flag: reorder accepts unknown ids without error.

#### `BAN-24` Malformed JSON body to create/update  — **P2** · _negative_
- **Pre:** Logged in as admin. REST client.
- **Steps:**
  1. POST /admin/banners with body '{not json' and Content-Type: application/json.
- **API:** `POST /admin/banners`
- **Expect:** 400 {"error":"invalid body"} from BodyParser failure. No row inserted, no audit log.

### experiments-flags  <sub>(25 flows — P0:8 P1:11 P2:6)</sub>

Two CRM admin surfaces: Feature Flags (/flags) renders a code-defined registry of flags grouped by category, lets superadmins toggle/edit values stored in Redis (namespace+"flags"), snapshots every change to crm_config_snapshots, and supports rollback to a prior snapshot. A/B Tests (/experiments) is record-keeping for experiment definitions in crm_experiments with a draft→running→paused→completed→rolled_out lifecycle. Neither surface is wired to any live production engine yet (flags are not read by prod config_manager; experiments have no bucketing engine), so both are effectively record-keeping/config-store today.

**Pages:** `/flags` · `/experiments` · `backend` · `backend` · `backend` · `backend` · `backend`

**Test data:** A superadmin CRM admin account (role 'superadmin') — required for flags.update and flags.rollback.; An admin CRM account (role 'admin') — required for experiments.* writes and to read flags; used to verify flags write-blocking.; A support and a viewer CRM account — to verify flags read-block (support/viewer get 403 on GET /admin/flags) and experiments read-allow (viewer can read).; Running Redis reachable by crm-api with the configured RedisNamespace; the flags hash is <namespace>flags. No seed required — flags fall back to DefaultRegistry defaults when absent.; Postgres with migrations 039 (crm_config_snapshots) and 041 (crm_experiments) applied. Run `make migrate` if tables missing.; For snapshot/rollback flows: at least 2 prior flag changes so crm_config_snapshots has multiple rows (created by running FLAG-02/FLAG-03 first).; For experiment lifecycle flows: at least one draft experiment with >=2 variants summing to 100 (create via EXP-02), plus note a real variant id for rollout tests.; For the webhook flow (FLAG-13): a registered webhook subscriber for event 'admin.flag.changed' (created by a superadmin via the webhooks admin surface) pointing at a local request capture (e.g. nc -l / requestbin).; Valid CRM JWTs for each role to script the forced-API negative/RBAC cases via curl or browser devtools.

#### `EXP-02` Create experiment with valid 50/50 split (happy path)  — **P0** · _happy_
- **Pre:** Logged in as admin (experiments.create=admin).
- **Steps:**
  1. Click 'New experiment'.
  2. Enter Name 'Home layout test', optional Hypothesis.
  3. Kind=flag, Target='ui.home_layout', Metric='booking_conversion', Audience=All.
  4. Default 2 variants Control(50)/B(50) — confirm header reads 'Variants (100% allocated — must equal 100)'.
  5. Click Create; confirm modal; click Create.
- **API:** `POST /admin/experiments`, `GET /admin/experiments`
- **Expect:** POST returns the created Experiment with status 'draft'. Toast 'Experiment created.' New card appears with a Start button. Audit log gets experiment.create entry.

#### `EXP-05` Lifecycle: Start -> Pause -> Resume -> Stop -> Roll out winner (happy, state machine)  — **P0** · _happy_
- **Pre:** Logged in as admin. A draft experiment with >=2 variants exists (from EXP-02).
- **Steps:**
  1. On the draft card click Start, confirm modal, confirm -> status becomes running (started_at set).
  2. Click Pause -> status paused.
  3. Click Resume (Play) -> status running again.
  4. Click Stop, confirm -> status completed (ended_at set).
  5. On completed card click 'Roll out winner', pick a variant from the select, click Roll out.
- **API:** `POST /admin/experiments/:id/start`, `POST /admin/experiments/:id/pause`, `POST /admin/experiments/:id/stop`, `POST /admin/experiments/:id/rollout`
- **Expect:** Each transition returns {ok:true}, toast 'Updated.', card refreshes with new status pill. Rollout sets status rolled_out and winner_variant. started_at set once on first run; ended_at set on stop. Each action writes an audit entry (experiment.start/pause/stop/rollout).

#### `EXP-10` RBAC: viewer can read but not create/control experiments  — **P0** · _rbac_
- **Pre:** Logged in as role 'viewer' (experiments.read=viewer; all writes=admin).
- **Steps:**
  1. Navigate to /experiments — list loads (viewer can read).
  2. Confirm 'New experiment' button is hidden (wrapped in <Can perm='experiments.create'>).
  3. On any draft/running card, confirm Start/Pause/Stop/Rollout buttons render DISABLED with title 'Insufficient permissions'.
  4. Force a write via devtools: POST /admin/experiments/:id/start.
- **API:** `GET /admin/experiments`, `POST /admin/experiments`, `POST /admin/experiments/:id/start`
- **Expect:** List loads. New experiment button absent. Action buttons disabled. Forced POST returns 403 {required_role:admin, your_role:viewer}. Required role for all writes: admin. Insufficient: viewer/support.

#### `FLAG-01` View flags grouped by category (happy path)  — **P0** · _happy_
- **Pre:** Logged in as an admin or superadmin. Backend on :8090, CRM on :5174. Redis reachable.
- **Steps:**
  1. Sign in, click Flags in the sidebar (or navigate to http://localhost:5174/flags).
  2. Observe section headers: Booking, Payments, UI, Workers, Notifications, Experimental.
  3. Confirm 14 flag cards render, each with name, description and a StatusPill (on/off/value).
  4. Enable Pro mode (proMode store) and confirm each card now shows key/type/default footer.
- **API:** `GET /admin/flags`
- **Expect:** All 14 registry flags render under correct category headers. Bool flags show on/off pill; number/enum/string show their value. No console errors. Pro-mode footer shows def.key/type/default.

#### `FLAG-02` Toggle a boolean flag with confirm + snapshot (happy path)  — **P0** · _happy_
- **Pre:** Logged in as superadmin (flags.update is superadmin-only).
- **Steps:**
  1. On /flags, find 'Cash on Delivery' (payments.cod_enabled).
  2. Click the toggle switch to flip it.
  3. In the confirm modal verify Before/After JSON shows the value flip (e.g. true -> false).
  4. Click Save.
- **API:** `PUT /admin/flags/payments.cod_enabled`, `GET /admin/flags`, `GET /admin/flags/snapshots`
- **Expect:** PUT returns {ok:true,key,value}. Success toast 'Flag value saved (and snapshotted for rollback).' Pill flips. A new snapshot appears in History. Audit log gets a flag.update entry.

#### `FLAG-07` Snapshots history + rollback (happy + data correctness)  — **P0** · _happy_
- **Pre:** Logged in as superadmin. At least 2 prior flag changes exist (run FLAG-02 and FLAG-03 first).
- **Steps:**
  1. Note current value of payments.cod_enabled and matching.max_walk_minutes.
  2. Change matching.max_walk_minutes to 60 and save (creates snapshot S1 capturing the pre-60 tree).
  3. Click History; in Snapshots modal confirm rows show reason/admin_email/created_at, newest first.
  4. On the snapshot taken BEFORE the 60 change, click Rollback, confirm the destructive modal, click Rollback.
  5. Reopen /flags and verify matching.max_walk_minutes reverted to its value in that snapshot.
- **API:** `PUT /admin/flags/matching.max_walk_minutes`, `GET /admin/flags/snapshots`, `POST /admin/flags/snapshots/:id/rollback`, `GET /admin/flags`
- **Expect:** Rollback toast 'Rolled back. New snapshot created.' All flags revert to the snapshot's stored values, and a NEW snapshot with reason 'rollback to <id>' is appended. Snapshot list shows it. Audit log gets flag.rollback entry.

#### `FLAG-08` Rollback overwrites ALL flags, not just the changed one (money/state correctness)  — **P0** · _money_
- **Pre:** Logged in as superadmin. Take a snapshot S0 (any flag change). Then change a DIFFERENT flag, e.g. set payments.upi_enabled = false.
- **Steps:**
  1. Confirm payments.upi_enabled is now false and there is a snapshot S0 from before you touched upi.
  2. Open History, Rollback to S0.
  3. Reopen /flags and inspect payments.upi_enabled.
- **API:** `POST /admin/flags/snapshots/:id/rollback`, `GET /admin/flags`
- **Expect:** Because Rollback DELs the entire hash and re-applies the full snapshot tree, payments.upi_enabled reverts to its S0 value (true) even though the admin only intended to revert the originally-changed flag. Tester should confirm this whole-tree revert behaviour is understood/expected — it is a blast-radius risk (see suspectedBugs).

#### `FLAG-10` RBAC: admin (not superadmin) is blocked from writing flags  — **P0** · _rbac_
- **Pre:** Logged in as a role 'admin' (NOT superadmin). flags.read=admin so the page loads; flags.update/rollback=superadmin.
- **Steps:**
  1. Navigate to /flags. Page loads and flags render (admin can read).
  2. Confirm every editor (toggle/number Save/string Save/enum select) is rendered DISABLED with title 'Insufficient permissions' (canUpdate=false).
  3. Open History; confirm Rollback buttons are disabled.
  4. Force a write via devtools: PUT /admin/flags/payments.cod_enabled.
- **API:** `GET /admin/flags`, `PUT /admin/flags/payments.cod_enabled`, `POST /admin/flags/snapshots/:id/rollback`
- **Expect:** UI controls disabled. Forced PUT/rollback return 403 {error:insufficient_permissions, required_role:superadmin, your_role:admin}. Required role: superadmin. Insufficient: admin/support/viewer.

#### `EXP-01` List experiments + empty state (happy/edge)  — **P1** · _happy_
- **Pre:** Logged in as viewer or higher (experiments.read=viewer).
- **Steps:**
  1. Navigate to /experiments.
  2. With no rows: confirm card with EmptyState 'No experiments yet'.
  3. With rows: confirm each card shows name, kind -> target_key, metric, status pill, and variant list with traffic_pct and JSON value.
- **API:** `GET /admin/experiments`
- **Expect:** FE reads {items:[...]} (matches experimentsApi.list which uses r.data.items). Status pill colour: running=success, paused=warning, rolled_out=info, else neutral. No console errors.

#### `EXP-03` Create blocked when traffic does not sum to 100 (negative)  — **P1** · _negative_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Open New experiment, set variant A traffic 60, variant B traffic 50 (sum 110).
  2. Confirm header shows '110% allocated' and Create button is DISABLED (FE valid requires trafficSum===100).
  3. Force via API: POST /admin/experiments with variants summing to 90.
- **API:** `POST /admin/experiments`
- **Expect:** FE Create disabled until sum==100. Forced API call returns 400 'variant traffic_pct must sum to 100, got 90'. Also test <2 variants -> 400 'at least two variants required'. Negative traffic_pct -> 400 'traffic_pct must be >= 0'.

#### `EXP-06` Rollout requires winner selection (negative)  — **P1** · _negative_
- **Pre:** Logged in as admin. A completed experiment exists.
- **Steps:**
  1. Click 'Roll out winner'; leave the variant select at '— pick variant —'.
  2. Confirm the Roll out button is disabled (confirmDisabled when winner==='').
  3. Force via API: POST /admin/experiments/:id/rollout with body {} or {winner:''}.
- **API:** `POST /admin/experiments/:id/rollout`
- **Expect:** FE blocks empty winner. Forced API with empty/missing winner returns 400 'winner variant id required'.

#### `EXP-07` Illegal state transitions allowed by API (state-machine integrity, negative)  — **P1** · _negative_
- **Pre:** Logged in as admin. A DRAFT experiment exists (note its id and a variant id).
- **Steps:**
  1. Via devtools/curl, POST /admin/experiments/:id/rollout {winner:'<variant id>'} on a draft (FE never shows this button for a draft).
  2. Also try POST /admin/experiments/:id/pause on a draft, and POST /admin/experiments/:id/start on an already rolled_out experiment.
  3. Reload /experiments and inspect status.
- **API:** `POST /admin/experiments/:id/rollout`, `POST /admin/experiments/:id/pause`, `POST /admin/experiments/:id/start`
- **Expect:** BUG EXPECTED: SetStatus has no transition guard, so a draft jumps straight to rolled_out (ended_at set, started_at still null), and pause/start succeed from any state. The DB CHECK only validates the target value, not the path. Confirm this and file as state-machine integrity gap (see suspectedBugs).

#### `EXP-08` Rollout accepts a non-existent winner variant id (data integrity, negative)  — **P1** · _negative_
- **Pre:** Logged in as admin. A completed experiment exists.
- **Steps:**
  1. Via devtools/curl, POST /admin/experiments/:id/rollout with {winner:'does-not-exist'}.
  2. Reload /experiments and inspect winner_variant.
- **API:** `POST /admin/experiments/:id/rollout`
- **Expect:** BUG EXPECTED: returns {ok:true} and stores winner_variant='does-not-exist' even though it is not one of the experiment's variant ids. Rollout does not validate the winner against the variants array (see suspectedBugs).

#### `FLAG-03` Edit a number flag within min/max bounds (happy path)  — **P1** · _happy_
- **Pre:** Logged in as superadmin.
- **Steps:**
  1. Find 'Max Walk Time (minutes)' (matching.max_walk_minutes, bounds 1..120).
  2. Type 45 into the number input; confirm the input border is not red and the Save (disk) button is enabled.
  3. Click Save, confirm the modal Before/After (e.g. 20 -> 45), click Save.
- **API:** `PUT /admin/flags/matching.max_walk_minutes`
- **Expect:** PUT succeeds, pill shows 45, snapshot created. The min...max helper text '1...120' is shown next to input.

#### `FLAG-04` Number flag boundary values (edge: exactly min, exactly max, below, above)  — **P1** · _edge_
- **Pre:** Logged in as superadmin. Flag workers.min_rating_to_accept bounds 0..5.
- **Steps:**
  1. Set workers.min_rating_to_accept to 0 (exactly min) -> Save should be enabled, PUT succeeds.
  2. Set it to 5 (exactly max) -> Save enabled, PUT succeeds.
  3. Type -1 (below min): input border turns red (border-danger) and Save button is disabled.
  4. Type 6 (above max): input border red, Save disabled.
  5. Type a fractional 3.5 -> allowed (number, no integer constraint).
- **API:** `PUT /admin/flags/workers.min_rating_to_accept`
- **Expect:** min and max are inclusive (backend validateValue rejects only < min and > max). Out-of-range values disable Save client-side; if forced via API they return 400 with message 'value X below/above min/max'.

#### `FLAG-05` Enum flag select (edge + negative)  — **P1** · _edge_
- **Pre:** Logged in as superadmin. Flag ui.home_layout enum {default,minimal,promo_heavy}.
- **Steps:**
  1. Find 'Home Layout' (ui.home_layout); confirm the select offers exactly default/minimal/promo_heavy.
  2. Pick 'promo_heavy'; confirm modal -> Save.
  3. Negative (API): PUT /admin/flags/ui.home_layout with body {value:'rainbow'} via curl/devtools.
- **API:** `PUT /admin/flags/ui.home_layout`
- **Expect:** UI commit succeeds for valid options. Out-of-enum value returns 400 'value "rainbow" not in enum' and no snapshot/audit row is written for it.

#### `FLAG-06` Type-mismatch rejection (negative, 4xx + toast surfacing)  — **P1** · _negative_
- **Pre:** Logged in as superadmin. Use devtools/curl to bypass typed inputs.
- **Steps:**
  1. PUT /admin/flags/payments.cod_enabled with body {value: 'yes'} (string into a bool flag).
  2. PUT /admin/flags/matching.max_walk_minutes with body {value: 'abc'} (string into number).
  3. PUT /admin/flags/unknown.flag.key with body {value:true} (unknown key).
- **API:** `PUT /admin/flags/payments.cod_enabled`, `PUT /admin/flags/matching.max_walk_minutes`, `PUT /admin/flags/unknown.flag.key`
- **Expect:** Each returns 400 with error 'flag X expects bool/number' or 'unknown flag: X'. In the UI an error toast is surfaced by the axios interceptor (onError handler is empty by design). No Redis write, no snapshot.

#### `FLAG-11` RBAC: viewer/support blocked from even reading flags page (negative)  — **P1** · _rbac_
- **Pre:** Logged in as role 'viewer' or 'support' (flags.read requires admin).
- **Steps:**
  1. Navigate directly to http://localhost:5174/flags (sidebar may hide the link, but the route is not permission-gated in App.tsx).
  2. Observe the page attempt to load flags.
- **API:** `GET /admin/flags`
- **Expect:** GET /admin/flags returns 403 (required_role admin). The page shows a broken/empty data state and an error toast from the interceptor rather than a clean access-denied screen — confirm the FE degrades gracefully (no white screen). Required role: admin. Insufficient: viewer/support.

#### `FLAG-13` Webhook fires on flag change (side-effect / IsProduction concern)  — **P1** · _negative_
- **Pre:** Logged in as superadmin. Register a webhook subscriber for event 'admin.flag.changed' (POST /admin/webhooks if available, superadmin). Point it at a local request-bin / netcat listener.
- **Steps:**
  1. Change any flag value and save.
  2. Observe the subscriber endpoint for an inbound POST.
- **API:** `PUT /admin/flags/payments.cod_enabled`
- **Expect:** Dispatcher.Dispatch fires a real outbound HTTP delivery to the subscriber with the admin.flag.changed payload {key,old_value,new_value,admin_id}. Verify this is acceptable in non-prod — there is no IsProduction() guard at the flags handler before fireWebhook (see suspectedBugs).

#### `EXP-04` Create with missing name/target blocked (negative + edge)  — **P2** · _negative_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Open New experiment, leave Name blank, fill Target.
  2. Confirm Create is disabled (FE valid requires name && targetKey).
  3. Now fill Name, blank Target -> Create still disabled (FE requires targetKey).
  4. Force via API: POST with empty name.
- **API:** `POST /admin/experiments`
- **Expect:** FE requires both name and target_key. Note: backend validate() only requires name+kind+variants, NOT target_key — so an API caller can create an experiment with NULL target_key (the card then shows '—'). Confirm whether that divergence is acceptable.

#### `EXP-09` Status change on non-existent experiment id (negative, 4xx)  — **P2** · _negative_
- **Pre:** Logged in as admin.
- **Steps:**
  1. POST /admin/experiments/00000000-0000-0000-0000-000000000000/start.
  2. GET /admin/experiments/<random-uuid>.
- **API:** `POST /admin/experiments/:id/start`, `GET /admin/experiments/:id`
- **Expect:** SetStatus returns ErrNotFound surfaced as 400 {error:'experiment not found'} (note: status change uses 400, while GET uses 404 — inconsistent status code, see suspectedBugs). GET returns 404.

#### `EXP-11` Double-click Start (concurrency/idempotency)  — **P2** · _concurrency_
- **Pre:** Logged in as admin. A draft experiment. Throttle network.
- **Steps:**
  1. Click Start, in the confirm modal double-click the confirm button quickly.
  2. Watch Network for duplicate POST /start.
- **API:** `POST /admin/experiments/:id/start`
- **Expect:** SetStatus running uses started_at=COALESCE(started_at,now()) so a second call does not reset started_at (idempotent on timestamp). End status is running either way. Confirm at most one audit duplicate; ideally the confirm button disables during mutation.

#### `EXP-12` Variant value typing in create form (edge)  — **P2** · _edge_
- **Pre:** Logged in as admin.
- **Steps:**
  1. Open New experiment, add a 3rd variant via '+ Add variant'.
  2. Set traffic so all three sum to 100 (e.g. 40/30/30).
  3. In the variant value fields enter: 'true', '42', 'null', '{"a":1}', and a bare word 'hello' across variants.
  4. Create and inspect the stored variants JSON via GET.
- **API:** `POST /admin/experiments`, `GET /admin/experiments`
- **Expect:** parseValue coerces 'true'->bool true, '42'->number 42, 'null'->null, '{"a":1}'->object, 'hello'->string. Variants persist with those JSON types. traffic header must read 100% before Create enables.

#### `FLAG-09` Empty snapshot list state  — **P2** · _edge_
- **Pre:** Fresh DB / no rows in crm_config_snapshots. Logged in as superadmin.
- **Steps:**
  1. Open /flags before making any change.
  2. Click History.
- **API:** `GET /admin/flags/snapshots`
- **Expect:** Snapshots modal shows EmptyState 'No snapshots yet' with body 'Snapshots are created on every flag change.' No crash.

#### `FLAG-12` Double-click / double-submit on Save (concurrency/idempotency)  — **P2** · _concurrency_
- **Pre:** Logged in as superadmin. Throttle network in devtools to widen the window.
- **Steps:**
  1. Toggle a bool flag, in the confirm modal rapidly double-click Save.
  2. Watch the Network tab for duplicate PUT requests.
- **API:** `PUT /admin/flags/payments.cod_enabled`
- **Expect:** PUT is idempotent (setting same value twice yields same end state), but each call writes a SEPARATE snapshot and audit row. Confirm whether 1 or 2 snapshots are created — 2 indicates the confirm button is not disabled during mutation (minor double-snapshot noise).

### dashboard  <sub>(21 flows — P0:7 P1:9 P2:5)</sub>

The CRM dashboard is the landing page (route "/"): a HealthStrip ops bar, six KPI tiles (active orders, workers online, revenue today, pending refunds, worker applications, open disputes), a QuickActions pill row, a 7-day revenue bar chart, a today's-categories donut, a Live Orders feed, an Alerts feed, and a MiniWorkerMap. All widgets are read-only and auto-poll (KPIs/live-orders 10s, alerts 15s, charts 60s, health 30s, map 10s). Backend dashboard endpoints require permission dashboard.read (minimum role viewer); money is integer paise summed in SQL and divided by 100 only for display.

**Pages:** `/` · `(component) HealthStrip` · `(component) QuickActions` · `(component) MiniWorkerMap` · `(api) dashboard` · `(api) all.ts` · `(api) workers.ts` · `(backend) dashboard` · `(backend) alerts` · `(backend) healthmetrics`

**Test data:** crm_admins rows for each role: viewer, support, admin, superadmin, each with a known password and an active crm_admin_sessions row (non-revoked, future expires_at) to mint a usable JWT; bookings: completed rows with completed_at=today IST and known amount_paise (incl. one ₹1,234.56 = 123456 paise) for the revenue tile; completed rows spread across the last 7 IST days with known per-day totals for the revenue chart; one cancelled + one pending today with large amounts to prove exclusion; bookings with status in (pending,searching,dispatching,accepted,arrived,in_progress) to drive Active orders KPI and the live-orders feed; varied customer_id (users.name/phone), helper_id (some NULL → 'unassigned'), service_category_id (some NULL → 'unknown'); service_categories rows with distinct category/name for donut labels and live-orders category column; helpers: rows with is_available=true (Workers online KPI) and approval_status='pending' (Worker applications KPI); pending_refunds rows with status='pending' (Pending refunds KPI); crm_disputes rows with status NOT IN ('resolved') (Open disputes KPI); crm_alerts rows with severity error/warning/info, distinct source/message/created_at, and read_by JSON arrays (some empty, some already containing the test admin's id) for the idempotency check; worker location data backing GET /admin/workers/live (live pins) — at least a few helpers with recent lat/lng and job_status idle/en_route/on_job for the MiniWorkerMap, plus an empty-state scenario; Health metrics: AppAPIURL env pointing at a reachable user-app /health (uptime=up) for the happy path, and an unreachable/dead target for the APP UNREACHABLE banner test; An empty/fresh DB snapshot (no completed orders, no alerts, no online workers, no today's bookings) to exercise every empty state

#### `DASH-P0-01` Dashboard loads with all six KPI tiles populated  — **P0** · _happy_
- **Pre:** Logged in as an admin with role viewer or higher (dashboard.read = viewer). Backend on :8090, CRM on :5174.
- **Steps:**
  1. Log in and land on / (Dashboard)
  2. Wait for the six KPI tiles to finish their skeleton state
  3. Read each tile: Active orders, Workers online, Revenue today, Pending refunds, Worker applications, Open disputes
- **API:** `GET /admin/dashboard/kpis`
- **Expect:** All six tiles show a number (Revenue shown as ₹ with Indian grouping). No skeleton remains. Network tab shows GET /admin/dashboard/kpis → 200 with active_orders/workers_online/revenue_today_paise/pending_refunds/pending_applications/open_disputes keys. Tile re-polls every ~10s without layout shift.

#### `DASH-P0-02` Revenue today tile is money-correct (paise → rupees)  — **P0** · _money_
- **Pre:** Seed exactly one booking with status='completed', completed_at = today (Asia/Kolkata), amount_paise = 123456 (₹1,234.56). No other completed bookings today.
- **Steps:**
  1. Open Dashboard
  2. Read the 'Revenue today' KPI tile
- **API:** `GET /admin/dashboard/kpis`
- **Expect:** API returns revenue_today_paise = 123456. Tile renders ₹1,235 (fmtCents divides by 100 and rounds with maximumFractionDigits:0 → 1234.56 → 1,235). Confirm value is paise/100, never paise shown raw, never a float in the API payload.

#### `DASH-P0-03` 7-day revenue chart sums only completed orders per IST day  — **P0** · _money_
- **Pre:** Seed completed bookings across the last 7 days with known amount_paise per day (e.g. day-0=500000, day-3=0, day-6=1000000); include one cancelled and one pending booking today with large amounts that must be excluded.
- **Steps:**
  1. Open Dashboard
  2. Locate 'Revenue · last 7 days' bar chart
  3. Hover each bar to read the tooltip value
  4. Compare bar heights to seeded per-day totals
- **API:** `GET /admin/dashboard/revenue-7d`
- **Expect:** Exactly 7 bars (one per day incl. zero days). Tooltip shows ₹ value = seeded completed-only total per IST day. Cancelled/pending bookings are NOT counted. Y-axis ticks formatted ₹ with /100. Sum across bars equals sum of seeded completed amount_paise/100.

#### `DASH-P0-08` HealthStrip surfaces APP UNREACHABLE banner when probe fails  — **P0** · _negative_
- **Pre:** Point AppAPIURL at an unreachable host OR stop the user-app so /admin/health/metrics returns uptime='down'.
- **Steps:**
  1. Open Dashboard
  2. Observe the red banner above the indicator strip
- **API:** `GET /admin/health/metrics`
- **Expect:** Red 'APP UNREACHABLE — main API health check failed' banner appears when q.isError OR data.uptime==='down'. Uptime indicator dot is red.

#### `DASH-P0-09` RBAC: viewer can read dashboard but worker map widget is blocked  — **P0** · _rbac_
- **Pre:** Two admins: one role=viewer, one role=support. dashboard.read=viewer; workers.read=support; healthmetrics.read=viewer; alerts.read=viewer.
- **Steps:**
  1. Log in as viewer
  2. Open Dashboard
  3. Observe KPIs, charts, alerts, health strip all load
  4. Scroll to 'Workers · live' map card and watch the network tab for GET /admin/workers/live
  5. Note any error toast
- **API:** `GET /admin/dashboard/kpis`, `GET /admin/dashboard/live-orders`, `GET /admin/dashboard/revenue-7d`, `GET /admin/dashboard/category-share`, `GET /admin/alerts`, `GET /admin/health/metrics`, `GET /admin/workers/live`
- **Expect:** As viewer: all dashboard.read/alerts.read/healthmetrics.read calls 200. GET /admin/workers/live returns 403 insufficient_permissions (required support); client shows toast 'Insufficient permissions. Requires support; you are viewer.' and MiniWorkerMap stays empty/loading. As support: /admin/workers/live returns 200 and pins render. This is a known UX seam — note required(support) vs the viewer who can see the rest of the dashboard.

#### `DASH-P0-10` RBAC: unauthenticated / expired session cannot read dashboard  — **P0** · _rbac_
- **Pre:** No valid CRM session, or manually expire/revoke the crm_admin_sessions row for the logged-in admin.
- **Steps:**
  1. With no token, hit the dashboard endpoints directly (e.g. curl GET /admin/dashboard/kpis with no Authorization header)
  2. In the SPA, revoke the session row in DB then let a poll fire
- **API:** `GET /admin/dashboard/kpis`, `POST /admin/auth/refresh`
- **Expect:** Direct call with no Bearer → 401 {error:'authentication required'}. In SPA, a 401 triggers single-flight silent refresh; if refresh cookie also invalid (401/403) the session is cleared and SPA routes to /login. Dashboard data is never shown to an unauthenticated caller.

#### `DASH-P0-15` Mark-all-alerts-read has NO permission gate (RBAC gap)  — **P0** · _rbac_
- **Pre:** Logged in as the LOWEST role (viewer). Seed several crm_alerts rows unread by this admin.
- **Steps:**
  1. Obtain the viewer's access token (from devtools)
  2. Send POST /admin/alerts/read-all with the viewer Bearer token (markAllAlertsRead exists in api/dashboard.ts; there is no UI button on the dashboard but the endpoint is reachable)
  3. Re-query GET /admin/alerts and inspect read_by arrays
- **API:** `POST /admin/alerts/read-all`, `GET /admin/alerts`
- **Expect:** BUG EXPECTATION: POST /admin/alerts/read-all returns 200 {ok:true} even for a viewer — the route is mounted with only JWT, no RequirePermission. Every alert's read_by now contains the viewer's adminID. Compare against alerts.read which correctly requires viewer; the write path is effectively any-authenticated. Also confirm no audit-log row is written for this mutation.

#### `DASH-P1-04` Live orders feed shows recent orders with status badges  — **P1** · _happy_
- **Pre:** Seed 3+ bookings with varied status (pending, in_progress, completed, cancelled), known customer name, helper assigned on some and NULL helper on others, varied created_at.
- **Steps:**
  1. Open Dashboard
  2. Scroll to 'Live orders' card
  3. Read each row: customer · category, helper_name (or 'unassigned'), time, status pill color
- **API:** `GET /admin/dashboard/live-orders`
- **Expect:** Up to 20 rows, newest first (ORDER BY created_at DESC). Rows with no helper show 'unassigned'. Status pill colors: completed=success, in_progress/arrived=info, cancelled=danger, pending=warning. Re-polls every ~10s.

#### `DASH-P1-05` Category donut shows today's order split  — **P1** · _happy_
- **Pre:** Seed bookings created today (IST) across 3 distinct service categories with different counts; seed one booking with NULL service_category_id (should bucket as 'unknown').
- **Steps:**
  1. Open Dashboard
  2. Locate 'Categories · today' donut
  3. Read legend labels and relative slice sizes
- **API:** `GET /admin/dashboard/category-share`
- **Expect:** One slice per category ordered by count desc, NULL-category bookings grouped under 'unknown'. Counts match seeded today-only data. Bookings from yesterday are excluded.

#### `DASH-P1-06` Alerts feed renders with severity dots  — **P1** · _happy_
- **Pre:** Seed crm_alerts rows with severity error/warning/info, distinct source/message/created_at.
- **Steps:**
  1. Open Dashboard
  2. Scroll to 'Alerts' card
  3. Read each alert: colored dot (error=red, warning=amber, info=primary), message, source · timestamp
- **API:** `GET /admin/alerts`
- **Expect:** Most recent 100 alerts, newest first. Dot color matches severity. Re-polls every ~15s. GET /admin/alerts → 200 with {alerts:[...]}.

#### `DASH-P1-07` HealthStrip shows latency/error/uptime and timestamp  — **P1** · _happy_
- **Pre:** Backend running; AppAPIURL configured to a reachable user-app /health so probe returns up.
- **Steps:**
  1. Open Dashboard
  2. Read the top HealthStrip bar: Latency (ms), Errors (%), Uptime (UP), and the right-aligned checked-at time
- **API:** `GET /admin/health/metrics`
- **Expect:** Latency dot green <200ms / amber 200-500 / red >500. Errors green <1% / amber ≤5% / red >5%. Uptime UP=green. Polls every 30s. No APP UNREACHABLE banner.

#### `DASH-P1-11` Empty states render for fresh/zero data  — **P1** · _edge_
- **Pre:** Empty DB (no bookings today, no completed orders in 7 days, no crm_alerts, no online workers).
- **Steps:**
  1. Open Dashboard on an empty environment
  2. Inspect revenue chart, category donut, live orders, alerts, worker map cards
- **API:** `GET /admin/dashboard/kpis`, `GET /admin/dashboard/revenue-7d`, `GET /admin/dashboard/category-share`, `GET /admin/dashboard/live-orders`, `GET /admin/alerts`, `GET /admin/workers/live`
- **Expect:** Revenue chart shows 'No revenue yet'; donut shows 'No orders yet today'; live orders shows 'No active orders'; alerts shows 'All clear'; worker map shows 'No workers currently online'. KPI tiles all show 0 (or — only if the key is null). No crashes, no error toasts.

#### `DASH-P1-14` QuickActions pills are permission-gated and route correctly  — **P1** · _rbac_
- **Pre:** Admin with promos.create/push.create/banners.create (admin role for promos/banners, support for push) vs a viewer lacking all three.
- **Steps:**
  1. As admin: open Dashboard, observe QuickActions pills
  2. Click 'New Promo' → expect navigation to /promos; 'Send Push' → /push; 'Add Banner' → /banners; 'View Refunds' → /refunds
  3. Hover the two disabled pills (View Pipeline, SLA Dashboard)
  4. Log in as viewer and re-open Dashboard
- **API:** `(client-side route navigation only; no /admin call on click)`
- **Expect:** As admin: New Promo/Send Push/Add Banner pills visible and navigate. View Refunds always visible (ungated link). Disabled pills show 'Coming soon' tooltip and are non-clickable. As viewer: promos/push/banners pills are hidden entirely (usePermission false), View Refunds still shown. Note: View Refunds link is NOT permission-gated in QuickActions even though /refunds backend requires refunds.read=support — verify the target page itself enforces it.

#### `DASH-P1-16` Idempotency: repeated mark-all-read does not duplicate read_by entries  — **P1** · _idempotency_
- **Pre:** Authenticated admin; at least one crm_alert already containing this admin's id in read_by.
- **Steps:**
  1. Call POST /admin/alerts/read-all twice in a row with the same token
  2. Inspect read_by JSON arrays for any alert
- **API:** `POST /admin/alerts/read-all`, `GET /admin/alerts`
- **Expect:** read_by contains the adminID exactly once (SQL uses CASE WHEN read_by ? $1 THEN read_by ELSE read_by || ...). Second call is a no-op append; no duplicate ids; both calls return 200.

#### `DASH-P1-17` Concurrency: overlapping dashboard polls keep prior data, no flicker  — **P1** · _concurrency_
- **Pre:** Authenticated admin; throttle network in devtools so a poll takes longer than the 10s interval.
- **Steps:**
  1. Open Dashboard with slow 3G throttling
  2. Watch KPI tiles and live-orders feed across several refetch cycles
- **API:** `GET /admin/dashboard/kpis`, `GET /admin/dashboard/live-orders`
- **Expect:** React Query keeps previous data while refetching — tiles/feed never blank back to skeleton on refetch, no layout shift. Overlapping in-flight requests do not corrupt the rendered values.

#### `DASH-P1-18` Concurrency: a 401 mid-poll triggers single-flight refresh, not a logout storm  — **P1** · _concurrency_
- **Pre:** Authenticated admin whose access token is about to expire; multiple dashboard widgets polling simultaneously.
- **Steps:**
  1. Let the access token expire so the next batch of polls (kpis, live-orders, alerts, health, pins) all 401 at once
  2. Watch the network tab for /admin/auth/refresh calls
- **API:** `GET /admin/dashboard/kpis`, `GET /admin/dashboard/live-orders`, `GET /admin/alerts`, `POST /admin/auth/refresh`
- **Expect:** Exactly ONE POST /admin/auth/refresh fires (refreshInFlight single-flight) even though many widgets 401 concurrently; each original request retries once with the new token and succeeds. User is NOT logged out and is NOT shown an error toast (401 path is silent).

#### `DASH-P2-12` Large / boundary money values render without overflow  — **P2** · _edge_
- **Pre:** Seed a completed booking today with amount_paise = 99999999999 (≈₹999,999,999.99) — near int range; and a 7-day chart day with a very large total.
- **Steps:**
  1. Open Dashboard
  2. Read Revenue today tile and hover the tallest revenue bar
- **API:** `GET /admin/dashboard/kpis`, `GET /admin/dashboard/revenue-7d`
- **Expect:** Tile and tooltip show the full ₹ value with Indian grouping, no scientific notation, no NaN, no layout break. Note: KPIs use Go int (revenue_today_paise int) — verify the seeded sum does not exceed 32-bit int on a 32-bit build; on amd64 int is 64-bit so this is safe but worth confirming the number is exact, not truncated.

#### `DASH-P2-13` KPI partial failure degrades to 0 instead of erroring whole tile row  — **P2** · _edge_
- **Pre:** Make one KPI subquery fail (e.g. drop/rename pending_refunds table on a scratch DB) while others succeed.
- **Steps:**
  1. Open Dashboard
  2. Read all six KPI tiles
  3. Check backend logs
- **API:** `GET /admin/dashboard/kpis`
- **Expect:** GET /admin/dashboard/kpis still returns 200; the failing metric shows 0 (best-effort default), others show real values. Backend logs '[crm.dashboard] kpi query failed — defaulting to 0'. NOTE this masks real outages — see suspectedBug: a genuinely-broken revenue query is indistinguishable from ₹0 revenue.

#### `DASH-P2-19` Server error on a dashboard endpoint surfaces a toast  — **P2** · _negative_
- **Pre:** Force a dashboard endpoint to 500 (e.g. kill the DB read pool, or point CRM_DATABASE_READ_URL at a dead host while live-orders runs a real query that errors — note KPIs swallow errors but live-orders/revenue/category propagate).
- **Steps:**
  1. Open Dashboard with the read pool broken
  2. Observe live-orders / revenue / category-share cards and any toast
- **API:** `GET /admin/dashboard/live-orders`, `GET /admin/dashboard/revenue-7d`, `GET /admin/dashboard/category-share`
- **Expect:** Endpoint returns 500 {error:'internal error'}. Client response interceptor shows an error toast 'internal error' (status !== 401). The affected card stays in loading/empty rather than crashing the page. (KPIs endpoint will NOT 500 — it defaults to 0, masking the failure.)

#### `DASH-P2-20` Live-orders timestamp timezone display  — **P2** · _edge_
- **Pre:** Seed a booking with a known created_at. Run the browser in a non-IST timezone (e.g. set OS/browser to America/New_York).
- **Steps:**
  1. Open Dashboard in a non-IST browser timezone
  2. Read the time shown under a live-order row and an alert row
- **API:** `GET /admin/dashboard/live-orders`, `GET /admin/alerts`
- **Expect:** OBSERVE: created_at is rendered with new Date(...).toLocaleTimeString()/toLocaleString() = the BROWSER local timezone, not Asia/Kolkata. Per repo rule all timestamps must display in IST. A non-IST tester will see shifted times — flag as a display inconsistency (see suspectedBug).

#### `DASH-P2-21` Revenue chart all-zero days shows empty state, not a flat chart  — **P2** · _edge_
- **Pre:** Seed completed bookings such that revenue-7d returns 7 rows all with revenue_paise=0 (e.g. no completed orders in the last 7 days but the generate_series still yields 7 rows).
- **Steps:**
  1. Open Dashboard
  2. Inspect the revenue chart
- **API:** `GET /admin/dashboard/revenue-7d`
- **Expect:** Because (data).every(p=>p.revenue_paise===0) is true, the 'No revenue yet' empty state shows instead of a row of zero-height bars. Confirm this is intended and that a single non-zero day flips it to the chart.

### users  <sub>(25 flows — P0:7 P1:13 P2:5)</sub>

Customer/pro user database for the ZopMop ops CRM: a server-side searchable/filterable/sortable/paginated table (UsersPage) and a tabbed detail drawer (UserDrawer: Overview, Orders, Notes) where admins can suspend, unsuspend, ban, unban, toggle VIP, and add notes. Status is a derived rollup (banned > suspended > active) computed from users.is_suspended and users.banned_at; money (LTV, avg order) is int64 paise summed from completed bookings. All writes are RBAC-gated (suspend/ban/vip = admin, add_note = support) and audited; suspend/ban also fire outbound webhooks.

**Pages:** `/users` · `/users?id=<uuid>` · `n/a (api layer)` · `n/a (backend)` · `n/a (backend)`

**Test data:** CRM admin accounts at each role: viewer, support, admin, superadmin (crm_admins + a valid crm_admin_sessions row each) — needed for all RBAC flows. The JWT carries crmAdminRole; sessions must be non-revoked and not expired.; At least ~55 users in `users` (deleted_at NULL) so pagination spans >=3 pages at 25/page; mix of role customer + pro.; Users covering every derived status: active (is_suspended FALSE, banned_at NULL), suspended (is_suspended TRUE, suspend_reason set, banned_at NULL), banned (banned_at NOT NULL, ban_reason set).; At least 2 VIP users (is_vip TRUE) and several non-VIP for the VIP-only filter.; One user with >=2 `bookings` in status 'completed' (non-zero amount_paise) so LTV/avg_order_paise are non-zero; one user with zero bookings so Avg shows '—'.; One user with >=1 in-flight booking (status in pending/searching/dispatching/accepted/arrived/in_progress) for the suspend/ban active-orders warning; one with none.; Bookings linked via customer_id=user.id with service_category_id pointing at rows in `service_categories` so Orders tab + Preferred categories render category names (else fallback '—').; A `crm_user_notes` row or two on one user (admin_email populated) to verify the Notes list and admin attribution.; Distinct name/phone/email values across users so search-by-each can be verified; include one user whose name or email contains '_' to test wildcard quirk.; For webhook flows: a `crm_webhooks`/subscriber row subscribed to admin.user.suspended and admin.user.banned, pointing at a request-bin URL to confirm fire-on-suspend/ban and NO-fire-on-unsuspend/unban.; A soft-deleted banned user (deleted_at set, banned_at set) to expose the Unban missing deleted_at guard (P3).

#### `USR-P0-01` Search by name/phone/email returns server-filtered results  — **P0** · _happy_
- **Pre:** Logged in as support+ (users.read = support). At least 3 users seeded with distinct names, phones, emails.
- **Steps:**
  1. Go to http://localhost:5174/users
  2. Type a known partial name (e.g. 'rav') into the 'Search by name, phone, or email…' box
  3. Observe the table reloads (keepPreviousData shows old rows briefly)
  4. Clear the box and type a known phone fragment, then a known email fragment
- **API:** `GET /admin/users?search=rav&sort_by=joined_at&sort_dir=desc&limit=25&offset=0`
- **Expect:** Only rows whose lower(name|phone|email) contain the term render; pagination footer shows 'N of <matchCount>'; offset resets to 0 on each new search (page returns to 1). Empty box sends no search param.

#### `USR-P0-02` Open user drawer, view Overview, money renders in rupees from paise  — **P0** · _money_
- **Pre:** Support+ login. A user with >=2 completed bookings exists so LTV/avg are non-zero.
- **Steps:**
  1. On /users click any row
  2. Drawer opens; confirm header shows name/phone/email/uuid and a status pill
  3. Overview tab: read Lifetime value, Total orders, Avg order, Active orders, Joined, Last active, Preferred categories
- **API:** `GET /admin/users/{id}`
- **Expect:** URL gains ?id=<uuid>. LTV and Avg order display as ₹ formatted from paise (ltv_paise/avg_order_paise, never ₹NaN). For a user with total_orders=0 the Avg order cell shows '—' not ₹0.

#### `USR-P0-03` Suspend an active user with a reason  — **P0** · _happy_
- **Pre:** Login as admin (users.suspend = admin). Target user currently active (not suspended/banned).
- **Steps:**
  1. Open the user drawer
  2. Click the 'Suspend' button (Pause icon, warning colour)
  3. In 'Suspend user?' modal, observe active-orders warning if any, type a reason in 'Reason (required)'
  4. Click 'Suspend'
- **API:** `GET /admin/users/{id}/active-orders`, `POST /admin/users/{id}/suspend`
- **Expect:** Toast 'User suspended.'; drawer + list refetch; status pill flips to 'suspended' (warning); suspend reason banner appears in header; an audit row action=user.suspend is written; admin.user.suspended webhook fires to any subscribers.

#### `USR-P0-04` Ban a user via typed-phrase confirmation  — **P0** · _happy_
- **Pre:** Login as admin (users.ban = admin). Target user not already banned.
- **Steps:**
  1. Open the user drawer
  2. Click 'Ban' (Ban icon, danger colour)
  3. In 'Ban user?' modal type a reason, then type BAN USER in the 'Type BAN USER to confirm' field
  4. Confirm 'Ban User' button enables only after the phrase matches; click it
- **API:** `GET /admin/users/{id}/active-orders`, `POST /admin/users/{id}/ban`
- **Expect:** Confirm button is disabled until typed phrase exactly equals 'BAN USER'. On confirm: toast 'User banned.', status pill goes 'banned' (danger), ban reason banner shows; audit row action=user.ban; admin.user.banned webhook fires.

#### `USR-P0-05` Unban restores access  — **P0** · _happy_
- **Pre:** Login as admin (users.unban = admin). Target user currently banned.
- **Steps:**
  1. Open the banned user's drawer
  2. Click 'Lift ban' (Play icon)
  3. In 'Lift ban?' modal click 'Unban'
- **API:** `POST /admin/users/{id}/unban`
- **Expect:** Toast 'Ban lifted.'; status pill returns to 'active'; ban banner disappears; audit row action=user.unban. NOTE: unlike ban, NO webhook fires on unban (verify subscribers receive nothing).

#### `USR-P0-09` RBAC: viewer cannot read users at all  — **P0** · _rbac_
- **Pre:** Login as viewer (users.read requires support).
- **Steps:**
  1. Navigate to /users
- **API:** `GET /admin/users (expect 403)`
- **Expect:** List request returns 403 insufficient_permissions (required_role=support, your_role=viewer). The client interceptor surfaces toast 'Insufficient permissions. Requires support; you are viewer.' Table shows the error state / no rows. Required role: support. Insufficient role: viewer.

#### `USR-P0-10` RBAC: support is blocked from suspend/ban/unban/vip server-side  — **P0** · _rbac_
- **Pre:** Login as support. Open a user drawer (support CAN read).
- **Steps:**
  1. In the drawer note Suspend/Ban/VIP buttons are disabled (greyed) with 'Insufficient permissions' tooltip
  2. Force the call: with devtools, replay POST /admin/users/{id}/suspend (or temporarily flip the FE gate) to confirm the server also rejects
- **API:** `POST /admin/users/{id}/suspend (expect 403)`, `POST /admin/users/{id}/ban (expect 403)`, `POST /admin/users/{id}/vip (expect 403)`
- **Expect:** FE: buttons disabled + clicking the disabled-but-bypassed path shows toast 'Insufficient permissions'. BE: each returns 403 insufficient_permissions required_role=admin your_role=support. Required role: admin. Insufficient role: support/viewer.

#### `USR-P0-06` Unsuspend restores access  — **P1** · _happy_
- **Pre:** Login as admin. Target user currently suspended.
- **Steps:**
  1. Open the suspended user's drawer
  2. Click 'Unsuspend' (Play icon, success colour)
  3. Click 'Unsuspend' in the 'Reinstate user?' modal
- **API:** `POST /admin/users/{id}/unsuspend`
- **Expect:** Toast 'User reinstated.'; status pill returns to 'active'; suspend banner clears; audit row action=user.unsuspend. No webhook fires (asymmetry vs suspend).

#### `USR-P0-07` Toggle VIP on and off  — **P1** · _happy_
- **Pre:** Login as admin (users.set_vip = admin).
- **Steps:**
  1. Open a non-VIP user's drawer
  2. Click 'Add to VIP' (Star)
  3. Confirm 'Make VIP' in modal
  4. Reopen action bar, click 'Remove VIP', confirm 'Remove'
- **API:** `POST /admin/users/{id}/vip (body {is_vip:true})`, `POST /admin/users/{id}/vip (body {is_vip:false})`
- **Expect:** Toast 'VIP status updated.' each time; gold star appears/disappears in header and list row; 'VIP only' filter on /users now includes/excludes this user; audit rows action=user.vip.set with after=true/false.

#### `USR-P0-08` Add a note as support role  — **P1** · _happy_
- **Pre:** Login as support (users.add_note = support — the ONE write support can do here).
- **Steps:**
  1. Open any user drawer
  2. Click the 'Notes' tab
  3. Type text in the 'Add a note about this user…' textarea
  4. Click 'Add note'
- **API:** `GET /admin/users/{id}/notes`, `POST /admin/users/{id}/notes`
- **Expect:** Button disabled while textarea is empty/whitespace; on save toast 'Note added.', textarea clears, note appears at top with admin email + timestamp; audit row action=user.note.add with the full note body stored in after_value.

#### `USR-P0-11` RBAC: support CAN add a note but NOT other writes  — **P1** · _rbac_
- **Pre:** Login as support.
- **Steps:**
  1. Open drawer → Notes tab; confirm 'Add note' is enabled and works (covered in USR-P0-08)
  2. Confirm action-bar buttons (Suspend/Ban/VIP) stay disabled
- **API:** `POST /admin/users/{id}/notes (expect 200)`, `POST /admin/users/{id}/suspend (expect 403)`
- **Expect:** Note POST succeeds for support; suspend/ban/vip POST return 403. Confirms users.add_note=support boundary vs users.suspend=admin.

#### `USR-P1-12` Suspend/Ban reason is required (empty rejected) but length tags NOT enforced  — **P1** · _negative_
- **Pre:** Login as admin. Open an active user drawer.
- **Steps:**
  1. Click Suspend, leave the Reason field blank, click 'Suspend'
  2. Observe failure
  3. Retry with a single character 'x' as reason
  4. Retry with a very long reason (paste ~2000 chars)
- **API:** `POST /admin/users/{id}/suspend (blank → 400; 'x' → 200; long → 200)`
- **Expect:** Blank/whitespace reason → 400 {error:'reason required'} and toast surfaces it; modal stays open. BUG WATCH: the model's validate:"min=2,max=500" tag is NOT enforced (no validator runs), so a 1-char reason and a >500-char reason both succeed with 200.

#### `USR-P1-14` Pagination Prev/Next boundaries  — **P1** · _edge_
- **Pre:** Login as support. Seed >50 users so >=3 pages exist at 25/page.
- **Steps:**
  1. On /users observe footer 'Page 1 of N' and Prev disabled
  2. Click 'Next →' repeatedly to the last page
  3. Confirm Next disables on last page; click 'Prev ←' back to page 1
  4. Confirm the range label '(offset+1)–(min(offset+count,total)) of total' is correct on each page
- **API:** `GET /admin/users?...&limit=25&offset=0`, `GET /admin/users?...&limit=25&offset=25`, `GET /admin/users?...&limit=25&offset=50`
- **Expect:** Prev disabled on page 1, Next disabled on last page; range numbers never exceed total; no blank page. Last page shows the remainder count correctly.

#### `USR-P1-15` Sort toggles direction and resets to page 1  — **P1** · _happy_
- **Pre:** Login as support. On a multi-page user set.
- **Steps:**
  1. Navigate to page 2
  2. Click the 'LTV' column header
  3. Observe sort indicator (chevron) and that page resets to 1
  4. Click 'LTV' again to flip asc/desc
  5. Repeat for 'Orders' and 'Joined' columns
- **API:** `GET /admin/users?sort_by=ltv_cents&sort_dir=desc&offset=0`, `GET /admin/users?sort_by=ltv_cents&sort_dir=asc&offset=0`, `GET /admin/users?sort_by=total_orders&...`, `GET /admin/users?sort_by=joined_at&...`
- **Expect:** Each header click sends correct sort_by (note LTV column emits sort_by=ltv_cents, not ltv_paise) and sort_dir; offset resets to 0; rows reorder server-side; chevron up=asc, down=desc on the active column only. NULLS LAST keeps zero-order users at the bottom on desc.

#### `USR-P1-16` Status + role + VIP filters combine  — **P1** · _happy_
- **Pre:** Login as support. Seed users covering active/suspended/banned, customer/pro, VIP+non-VIP.
- **Steps:**
  1. Set Status dropdown to 'Banned'
  2. Set Role dropdown to 'Customer'
  3. Tick 'VIP only'
  4. Observe results, then set Status back to 'All statuses'
- **API:** `GET /admin/users?status=banned&role=customer&is_vip=true&...`
- **Expect:** Only banned customer VIPs show. Status maps server-side: active=is_suspended FALSE & banned_at NULL; suspended=is_suspended TRUE & banned_at NULL; banned=banned_at NOT NULL. Unchecking VIP drops is_vip param entirely (undefined, not false).

#### `USR-P1-17` Empty states: no users and no search matches  — **P1** · _edge_
- **Pre:** Login as support. (a) point at an empty DB or filter to zero; (b) search a nonsense string.
- **Steps:**
  1. Search 'zzzqqq-nomatch'
  2. Observe empty state copy
  3. Clear filters on an empty DB to see the no-users state
- **API:** `GET /admin/users?search=zzzqqq-nomatch&... (200, items:[])`
- **Expect:** With a search term: 'No matches for "zzzqqq-nomatch"' + 'Try a different search term…'. With no search and zero rows: 'No users yet'. Pagination footer is hidden when items.length is 0.

#### `USR-P1-18` Deep-link drawer with valid and invalid ?id=  — **P1** · _edge_
- **Pre:** Login as support. Know one real user uuid.
- **Steps:**
  1. Hit /users?id=<valid-uuid> directly
  2. Confirm drawer opens on that user
  3. Hit /users?id=not-a-uuid
  4. Hit /users?id=00000000-0000-0000-0000-000000000000 (valid shape, no such user)
- **API:** `GET /admin/users/{valid-uuid} (200)`, `GET /admin/users/{nonexistent-uuid} (404)`
- **Expect:** Valid uuid → drawer + GET fires. Malformed id fails the UUID_RE guard so drawerId stays null and NO request fires (drawer closed). Valid-shape-but-missing → 404 → drawer shows 'User not found' empty state. Browser Back closes the drawer (removes ?id=).

#### `USR-P1-19` Orders tab and Notes tab load and audit  — **P1** · _happy_
- **Pre:** Login as support. User with order + note history.
- **Steps:**
  1. Open drawer, click 'Orders' tab
  2. Confirm order rows show category/status/amount(₹)/date
  3. Click 'Notes' tab and confirm notes list
- **API:** `GET /admin/users/{id}/orders`, `GET /admin/users/{id}/notes`
- **Expect:** Orders amounts render from price_paise in ₹; statuses get coloured pills. Each tab open writes an audit row (user.orders.list with count, user.notes.list with count) — verify in audit log. List GET /admin/users itself is NOT audited (high-volume browsing), but GET /admin/users/{id} IS (user.view).

#### `USR-P1-20` Double-click Ban confirm does not double-submit  — **P1** · _concurrency_
- **Pre:** Login as admin. Active user.
- **Steps:**
  1. Open Ban modal, type reason and BAN USER
  2. Rapidly double-click the 'Ban User' confirm button
- **API:** `POST /admin/users/{id}/ban (should fire once)`
- **Expect:** ConfirmModal busy guard (if(busy)return; setBusy(true)) blocks the second click; button shows 'Working…' and is disabled. Only ONE POST /ban hits the network (check devtools). One audit row, one webhook.

#### `USR-P1-21` Re-ban / re-suspend overwrites original timestamp+reason (no idempotency guard)  — **P1** · _idempotency_
- **Pre:** Login as admin. A user already banned with a known ban_reason and banned_at.
- **Steps:**
  1. Ban an active user with reason 'fraud-A' (note banned_at time)
  2. The Ban button now hides (status=banned). To re-ban, replay POST /admin/users/{id}/ban with reason 'fraud-B' via devtools/curl
  3. Re-GET the user
- **API:** `POST /admin/users/{id}/ban {reason:'fraud-A'}`, `POST /admin/users/{id}/ban {reason:'fraud-B'} (replay)`
- **Expect:** Second ban returns 200 and OVERWRITES banned_at=now() and ban_reason='fraud-B' (repository Ban has no banned_at IS NULL guard). Audit before-value is always nil so the original ban metadata is lost from the row's before. This is the documented suspected idempotency bug — verify the original banned_at is gone.

#### `USR-P1-13` Note body min/max not enforced; oversized note accepted  — **P2** · _negative_
- **Pre:** Login as support. Notes tab open.
- **Steps:**
  1. Paste a >2000-character note body into the textarea
  2. Click 'Add note'
- **API:** `POST /admin/users/{id}/notes (expect 200 despite validate min=1,max=2000)`
- **Expect:** Note saves with full oversized body (validate tag decorative; handler only checks TrimSpace != ''). Whitespace-only body is blocked by the client (button disabled) AND by the server (400 body required). Document the size gap as a finding.

#### `USR-P1-22` Suspend modal active-orders warning is accurate  — **P2** · _edge_
- **Pre:** Login as admin. (a) a user with >=1 in-flight booking (pending/searching/dispatching/accepted/arrived/in_progress); (b) a user with none.
- **Steps:**
  1. Open the in-flight user's Suspend modal
  2. Confirm the '⚠ User has N active order(s)' line shows the right N
  3. Open a no-active-order user's Suspend modal and confirm no warning line
- **API:** `GET /admin/users/{id}/active-orders`
- **Expect:** Warning appears only when has_active=true; count matches the booking rows in active statuses. Confirms suspending does NOT cancel those orders (copy says so). Active-orders query is fired lazily only when the suspend/ban modal opens.

#### `USR-P2-23` Search wildcard characters behave as SQL LIKE wildcards  — **P2** · _edge_
- **Pre:** Login as support.
- **Steps:**
  1. Type '%' alone into the search box
  2. Type '_' into the search box
  3. Type a literal name fragment that contains an underscore if any user has one
- **API:** `GET /admin/users?search=%25 (URL-encoded %)`, `GET /admin/users?search=_`
- **Expect:** '%' matches all users (acts as wildcard, not a literal) and '_' matches any single char — because the LIKE clause has no ESCAPE and the term is wrapped in %term%. Parameterised args mean it is NOT an injection, just surprising matching. Flag as a usability quirk.

#### `USR-P2-24` limit/offset boundary and over-limit clamp  — **P2** · _edge_
- **Pre:** Login as support (or replay via devtools to vary params).
- **Steps:**
  1. Replay GET /admin/users with limit=0, limit=999, offset=-5
  2. Observe response limit/offset echoed in payload
- **API:** `GET /admin/users?limit=0`, `GET /admin/users?limit=999`, `GET /admin/users?offset=-5`
- **Expect:** limit<=0 or >200 clamps to 50; offset<0 clamps to 0 (repository.go:86-93). Response echoes the clamped limit/offset. The SPA itself always sends limit=25 so this is server-robustness only.

#### `USR-P2-25` 4xx/5xx toast surfacing on list failure  — **P2** · _negative_
- **Pre:** Login as support. Force a backend error (stop crm-api or break the users query).
- **Steps:**
  1. With backend stopped/erroring, load /users
  2. Observe the table error state and click 'Retry'
- **API:** `GET /admin/users (500 or network error)`
- **Expect:** Table shows 'Could not load users' ErrorState with a Retry that refetches. A 500 with a message also raises a toast via the interceptor (non-401). 401 is handled silently by the refresh path, not a toast.

### zone-approvals  <sub>(19 flows — P0:7 P1:6 P2:6)</sub>

Admin review queue for worker "zone exception" requests: a pro who tries to Go Online outside their assigned service zone uploads a selfie + GPS, creating a pending zone_approval_requests row. Admins approve (pro can immediately retry Go Online + gets a push) or reject (with a reason note). The status flip reuses the shift package's state machine via a conditional UPDATE (WHERE status='pending') for idempotency/race safety, returns 409 already_reviewed on a lost race, and writes a crm_audit_log row only on a real state change. No money is involved; the only computed value is a display-only haversine distance.

**Pages:** `/zone-approvals (SPA route rendering ZoneApprovalsPage)` · `n/a (API client module)` · `n/a (axios instance + interceptors)` · `n/a (backend handler)` · `n/a (state machine + SQL)` · `n/a (service + push)` · `n/a (RBAC map)`

**Test data:** CRM admin accounts at three role levels with active (non-revoked, non-expired) sessions: one 'viewer' (rank0), one 'support' (rank1), one 'admin' (rank2). Verify crm_admin_sessions rows exist so JWT middleware sessionStillActive passes.; zone_approval_requests rows with status='pending': at least 3 (one fully-enriched: pro has name+phone, photo_url set, and an active pro_zone_assignments -> service_zones with lat/lon/radius_km).; One pending request whose pro has NO active pro_zone_assignments (all effective_to set) so the zone join yields NULL columns (for ZA-16).; One pending request whose users row has NULL name and NULL phone and whose zone_approval_requests.photo_url is NULL (for ZA-17).; One request already in status='approved' and one already in 'rejected' (with reviewed_by/reviewed_at set) to test idempotency 409s without overwriting (ZA-06).; A known valid UUID that does NOT exist in zone_approval_requests (for ZA-13) and a clearly non-UUID string (for ZA-14).; For ZA-18: ~100+ pending rows with distinct requested_at values to verify ordering and lack of pagination.; users/pro rows backing each request (FK pro_id -> users.id); service_zones rows with sz.lat, sz.lon, sz.radius_km populated for haversine + map circle; pro_zone_assignments linking pro to zone with effective_to IS NULL for the assigned-zone case.; Backend crm-api running on :8090 and CRM dev server on :5174; Google Maps API key configured so GoogleMapWrapper renders (drawer map). If the key is missing, note the map area may error but Approve/Reject still function.; Ability to fire raw HTTP (curl/DevTools console) with each role's JWT to exercise RBAC and validation-bypass negative flows.

#### `ZA-01` Happy path: approve a pending zone request  — **P0** · _happy_
- **Pre:** Logged in as admin (or superadmin). At least one zone_approval_requests row with status='pending'.
- **Steps:**
  1. Navigate to Zone Approvals page (http://localhost:5174 -> Zone Approvals).
  2. Confirm header shows the pending count and 'auto-refreshes every 30s'.
  3. Click any table row OR its 'Review' button to open the right-side drawer.
  4. Verify drawer shows proof photo, map with pro marker + zone circle, distance text, and 'Pending review' status pill.
  5. Leave the Notes field empty (notes optional for approve).
  6. Click the 'Approve' button (primary).
  7. In the confirm modal, click 'Approve'.
- **API:** `GET /admin/zone-approvals`, `POST /admin/zone-approvals/:id/approve`
- **Expect:** Success toast 'Approved.'; the row disappears immediately (optimistic removal) and stays gone after the 30s refetch; pending count decrements; a crm_audit_log row exists with action='zone_approval.approve', module='zone-approvals', target_id=request id. DB row status flips to 'approved' with reviewed_by set.

#### `ZA-02` Happy path: reject a pending zone request with a reason  — **P0** · _happy_
- **Pre:** Logged in as admin. At least one pending request.
- **Steps:**
  1. Open the review drawer for a pending request.
  2. Type a reason of at least 5 characters in the Notes field (e.g. 'Selfie does not match location').
  3. Confirm the 'Reject' button becomes enabled.
  4. Click 'Reject'.
  5. In the destructive confirm modal verify the Reason text echoes your note, then click 'Reject'.
- **API:** `POST /admin/zone-approvals/:id/reject`
- **Expect:** Success toast 'Rejected.'; row removed; DB status='rejected', notes stored, reviewed_by set; crm_audit_log row action='zone_approval.reject' with after_value containing {"notes":"..."}.

#### `ZA-04` Concurrency: double-click Approve in confirm modal  — **P0** · _concurrency_
- **Pre:** Logged in as admin; one pending request; drawer open; confirm modal shown.
- **Steps:**
  1. Throttle network to Slow 3G in DevTools to widen the window.
  2. In the Approve confirm modal, click 'Approve' twice in rapid succession.
- **API:** `POST /admin/zone-approvals/:id/approve`, `POST /admin/zone-approvals/:id/approve`
- **Expect:** At most one state change. The conditional UPDATE (WHERE status='pending') makes the second call match 0 rows -> 409 already_reviewed. Exactly one crm_audit_log approve row; DB approved once. UI shows either 'Approved.' or the 'Already reviewed by another admin. Refreshing.' warning, never two success toasts and never two audit rows.

#### `ZA-05` Concurrency: two admins race on the same request (approve vs reject)  — **P0** · _concurrency_
- **Pre:** Same pending request open in two browsers as two different admins (both admin role).
- **Steps:**
  1. Admin A opens the drawer and clicks Approve -> confirm Approve.
  2. Immediately Admin B (who still sees the stale row) opens the drawer and clicks Reject with a valid note -> confirm Reject.
- **API:** `POST /admin/zone-approvals/:id/approve`, `POST /admin/zone-approvals/:id/reject`
- **Expect:** First request wins (status set, one audit row, one push). Loser gets HTTP 409 {error:'already_reviewed'} and the UI shows 'Already reviewed by another admin. Refreshing.' then the row vanishes after invalidate. No second state change, no second audit row, no push for the loser (service skips push on error).

#### `ZA-06` Idempotency: re-submit an already-decided request  — **P0** · _idempotency_
- **Pre:** A request already status='approved' (or 'rejected'); its id known.
- **Steps:**
  1. Via DevTools console or curl with a valid admin JWT, POST /admin/zone-approvals/<approvedId>/approve again.
  2. Then POST /admin/zone-approvals/<approvedId>/reject with notes.
- **API:** `POST /admin/zone-approvals/:id/approve`, `POST /admin/zone-approvals/:id/reject`
- **Expect:** Both return 409 {error:'already_reviewed', message:'This request was already reviewed by another admin'}. No change to reviewed_by/reviewed_at/status, no new audit rows, no push. (Verify reviewed_at is NOT overwritten.)

#### `ZA-07` RBAC: read-only support role can view but cannot approve/reject  — **P0** · _rbac_
- **Pre:** Logged in as 'support' role (rank 1). zones.approval.read=support, approve/reject=admin.
- **Steps:**
  1. Open Zone Approvals; confirm the queue loads (read allowed).
  2. Open a request drawer.
  3. Hover the 'Approve' button: confirm it is disabled with tooltip 'Insufficient permissions'.
  4. Type a 5+ char note; hover 'Reject': confirm disabled with 'Insufficient permissions'.
  5. Force the call anyway: in console run the approve POST with the support JWT.
- **API:** `GET /admin/zone-approvals`, `POST /admin/zone-approvals/:id/approve`
- **Expect:** UI buttons disabled. The forced POST returns 403 {error:'insufficient_permissions', required_role:'admin', your_role:'support'} and the axios interceptor shows an error toast naming the required role. No state change, no audit row.

#### `ZA-15` Unauthenticated / expired session is rejected  — **P0** · _negative_
- **Pre:** No valid JWT (logged out or revoked session).
- **Steps:**
  1. Hit GET /admin/zone-approvals with no Authorization header (curl).
  2. In the SPA, let the access token expire / revoke the session, then trigger a refetch.
- **API:** `GET /admin/zone-approvals`
- **Expect:** Raw call returns 401 {error:'authentication required'}. In the SPA, the interceptor attempts a silent refresh on 401; if refresh fails the session clears and the app routes to /login. No data leaks.

#### `ZA-03` Reject button disabled until notes >= 5 chars (client gate)  — **P1** · _edge_
- **Pre:** Logged in as admin; one pending request; drawer open.
- **Steps:**
  1. With Notes empty, hover the 'Reject' button.
  2. Confirm it is disabled and tooltip reads 'Notes required (min 5 chars) for rejection'.
  3. Type 4 characters; confirm Reject still disabled.
  4. Type a 5th character; confirm Reject enables.
- **Expect:** Reject is disabled at 0-4 trimmed chars and enabled at >=5. No API call fires while disabled.

#### `ZA-08` RBAC: viewer role is fully blocked at page boundary  — **P1** · _rbac_
- **Pre:** Logged in as 'viewer' role (rank 0). Lacks zones.approval.read.
- **Steps:**
  1. Navigate to Zone Approvals.
  2. Observe the page body.
  3. Force the list call in console with the viewer JWT.
- **API:** `GET /admin/zone-approvals`
- **Expect:** Page shows the 'Restricted' EmptyState ('Your role does not have permission to view zone approvals'); the list query is disabled (enabled:canRead=false) so no GET fires from the UI. The forced GET returns 403 insufficient_permissions required_role=support.

#### `ZA-09` Empty state: no pending requests  — **P1** · _edge_
- **Pre:** Logged in as admin/support; zero rows with status='pending' (all decided or table empty).
- **Steps:**
  1. Navigate to Zone Approvals.
  2. Observe header count and body.
- **API:** `GET /admin/zone-approvals`
- **Expect:** Header reads '0 requests pending review'; body shows the MapPin EmptyState 'No pending zone approvals' with the hint that approved/rejected don't show here. No table rendered. No console errors.

#### `ZA-10` List error state + retry  — **P1** · _negative_
- **Pre:** Logged in as admin. Backend reachable but able to be made to fail (stop crm-api or block the route to force a 500/network error).
- **Steps:**
  1. Open Zone Approvals while the list call fails (e.g. stop backend just before load, or DevTools block the request URL).
  2. Observe the card.
  3. Restore backend, click the 'Retry' button in the ErrorState (or the header 'Refresh').
- **API:** `GET /admin/zone-approvals`
- **Expect:** On failure: ErrorState 'Could not load zone approvals' with Retry. A non-401 error also raises an error toast via the interceptor. After restore + Retry, the queue loads. A 401 silently triggers token refresh, not the error state.

#### `ZA-12` Negative: reject with notes < 5 chars sent directly to the API (server-side validation gap)  — **P1** · _negative_
- **Pre:** Logged in as admin; one pending request id known; valid admin JWT.
- **Steps:**
  1. Bypass the disabled UI button: in console/curl POST /admin/zone-approvals/<pendingId>/reject with body {"notes":"x"} (1 char).
  2. Then try with empty body {} (no notes).
  3. Re-check the row in DB.
- **API:** `POST /admin/zone-approvals/:id/reject`
- **Expect:** DOCUMENTS A BUG: backend accepts both, returns 200 {message:'rejected'}, status flips to 'rejected'. Empty notes stored as NULL (NULLIF), 1-char note stored verbatim. The min-5-char rule is client-only; expected behaviour for a hardened API would be a 400. Audit after_value records the short/empty note.

#### `ZA-16` Edge: request with no current zone assignment (NULL zone columns)  — **P1** · _edge_
- **Pre:** A pending request whose pro has no active pro_zone_assignments row (effective_to all set) -> zone join returns NULL.
- **Steps:**
  1. Open the drawer for that request.
  2. Inspect the Location section, the map, and the distance value.
- **API:** `GET /admin/zone-approvals`
- **Expect:** distance_meters is NULL -> table and drawer render '—'. Location text reads 'from their assigned zone (no current assignment found)'. Map shows only the pro marker, no zone circle (haveZone=false). assigned_zone_name shows '—'. No crash. Approve/Reject still work.

#### `ZA-11` Auto-refresh and manual refresh keep the queue fresh  — **P2** · _happy_
- **Pre:** Logged in as admin; queue has rows; second client (pro app or DB) can change the data.
- **Steps:**
  1. Load Zone Approvals and note the rows.
  2. Out of band, decide one request (e.g. another admin approves it) or insert a new pending row in DB.
  3. Wait up to 30s for auto-refresh, OR click the header 'Refresh' button (watch it spin/disable while fetching), OR switch away and back to the tab (refetchOnWindowFocus).
- **API:** `GET /admin/zone-approvals`
- **Expect:** Queue updates without a full reload: decided rows drop off, new pending rows appear. Refresh button is disabled and the icon spins while isFetching.

#### `ZA-13` Negative: act on a non-existent request id  — **P2** · _negative_
- **Pre:** Logged in as admin; a syntactically valid UUID that does not exist in zone_approval_requests.
- **Steps:**
  1. Console/curl POST /admin/zone-approvals/<random-valid-uuid>/approve.
- **API:** `POST /admin/zone-approvals/:id/approve`
- **Expect:** DOCUMENTS A BUG: returns 409 already_reviewed (0 rows affected) even though the request never existed — no distinct 404. UI would show 'Already reviewed by another admin.' which is misleading. No audit row, no state change.

#### `ZA-14` Negative: malformed (non-UUID) :id path param  — **P2** · _negative_
- **Pre:** Logged in as admin; zone_approval_requests.id column is uuid type.
- **Steps:**
  1. Console/curl POST /admin/zone-approvals/not-a-uuid/approve.
  2. Observe HTTP status and body.
- **API:** `POST /admin/zone-approvals/:id/approve`
- **Expect:** DOCUMENTS A BUG/ROUGH EDGE: the UPDATE's uuid cast fails, DecideZoneApproval returns the raw pg error, handler returns 400 with the raw DB error string in {error:...} (not 409, not a clean validation message). Frontend handleConflict treats 400 as 'already reviewed'. No state change, no audit.

#### `ZA-17` Edge: missing pro_name / pro_phone / photo  — **P2** · _edge_
- **Pre:** A pending request whose user row has NULL name/phone and the request has no photo_url.
- **Steps:**
  1. View the row in the table and open the drawer.
- **API:** `GET /admin/zone-approvals`
- **Expect:** Table: pro_name shows '—', phone '—', photo cell shows 'no photo'. Drawer header avatar falls back to '?' initial, name 'Unknown pro', phone '—'. PhotoSection shows 'No photo provided.' No crash from null fields.

#### `ZA-18` Edge: large queue ordering and no pagination  — **P2** · _edge_
- **Pre:** Many pending requests (e.g. 100+) inserted with varied requested_at.
- **Steps:**
  1. Load Zone Approvals.
  2. Scroll the table; check ordering and that the sticky header stays.
  3. Confirm the header count matches the number of rows.
- **API:** `GET /admin/zone-approvals`
- **Expect:** All pending rows render in ascending requested_at order (oldest first); no pagination exists (entire pending set returned in one query). Sticky thead works. Count equals row count. Note for QA: there is no server-side limit, so a very large pending set returns everything in one payload.

#### `ZA-19` Push side effect is best-effort and never blocks the decision  — **P2** · _edge_
- **Pre:** Logged in as admin; one pending request; FCM/push can be made to fail (no device token / push disabled).
- **Steps:**
  1. Approve (or reject) a request whose pro has no valid push token.
  2. Observe the UI result and the DB row.
- **API:** `POST /admin/zone-approvals/:id/approve`
- **Expect:** Decision still returns 200 and DB status flips even if the async push fails (push runs in a background goroutine after the DB commit; failure is logged, not surfaced). Audit row written. No 5xx to the admin.

### disputes  <sub>(26 flows — P0:7 P1:11 P2:8)</sub>

Trust & Safety disputes queue in the ZopMop CRM: a tabbed list (open / in_progress / resolved / escalated) of user/worker conflict cases with a 48h SLA, plus actions to open a new case, transition status (In progress / Escalate), and resolve with a free-text outcome. Frontend is pages/DisputesPage.tsx calling tsApi in api/all.ts; backend is internal/crm/trustsafety/trustsafety.go mounting routes under /admin/disputes (JWT + per-admin rate limiter). All write actions require role 'support' or higher; list requires 'viewer'.

**Pages:** `/disputes (rendered by <DisputesPage/> in the CRM SPA; exact path depends on the router, but the page component is DisputesPage)` · `n/a (API client module)` · `n/a (backend handler)` · `n/a (RBAC)` · `n/a (axios client)`

**Test data:** A CRM admin account for each role: viewer, support, admin (to exercise RBAC: viewer blocked from writes, support allowed). Roles map via crmAdminRole JWT claim.; crm_disputes rows seeded across all statuses: at least 2 'open', 1 'in_progress', 1 'escalated', 1 'resolved' (with a non-empty resolution + resolved_at).; One 'open' dispute with sla_due_at set in the PAST (to render the 'SLA breach' badge) and one 'resolved' dispute with a past sla_due_at (to confirm the badge is suppressed).; One dispute with sla_due_at = NULL (to confirm SLA renders '—' and no breach badge).; 60+ disputes in a single status (e.g. 'open') to test the 50-row cap / missing pagination.; One dispute pre-set to 'resolved' (or 'closed') for the re-resolve idempotency flow (DISP-011) and the terminal-state status-transition flow (DISP-015).; A known-existent dispute UUID plus a random non-existent UUID and a malformed (non-UUID) string for negative-case resolve/status calls.; Ability to inspect the CRM audit log (admin role with audit.read, or direct DB access) to verify dispute.create/status/resolve entries (module='trustsafety').

#### `DISP-001` List open disputes (happy path, default tab)  — **P0** · _happy_
- **Pre:** Logged in as role >= viewer. At least 2 disputes with status='open' exist.
- **Steps:**
  1. Navigate to the Disputes page
  2. Confirm the 'Open' tab is selected by default (underline on 'open')
  3. Observe the list of cards rendered
- **API:** `GET /admin/disputes?status=open`
- **Expect:** Each card shows the 8-char id prefix, a severity StatusPill (danger for high/critical, warning for medium, neutral for low), description, and 'source · level · SLA' line. Cards ordered newest-first (created_at DESC). Action buttons 'In progress', 'Escalate', 'Resolve' appear on each card.

#### `DISP-004` Create a new dispute (happy path)  — **P0** · _happy_
- **Pre:** Logged in as role >= support.
- **Steps:**
  1. Click '+ New case' (top-right; only visible with disputes.create)
  2. In the modal type a Description
  3. Leave Severity = 'medium' and Source = 'admin' (defaults)
  4. Click 'Create'
- **API:** `POST /admin/disputes`, `GET /admin/disputes?status=open`
- **Expect:** Toast 'Case opened.', modal closes, the disputes query is invalidated and the list refetches. New case appears under the 'Open' tab with SLA = created_at + 48h, level defaulting to L1.

#### `DISP-007` Transition open -> in_progress  — **P0** · _happy_
- **Pre:** Logged in >= support. An 'open' dispute exists.
- **Steps:**
  1. On Open tab, find a card
  2. Click 'In progress'
- **API:** `POST /admin/disputes/{id}/status (body {status:'in_progress'})`, `GET /admin/disputes?status=open`
- **Expect:** Toast 'Status updated.', list refetches; the card leaves the Open tab and appears under In progress. Note the 'In progress' button is hidden when d.status==='in_progress' already.

#### `DISP-009` Resolve a dispute with outcome text (state machine)  — **P0** · _happy_
- **Pre:** Logged in >= support. An 'open' or 'in_progress' dispute exists.
- **Steps:**
  1. Click 'Resolve' on a card
  2. In the ConfirmModal, type a resolution/outcome in the textarea
  3. Click 'Resolve' to confirm
- **API:** `POST /admin/disputes/{id}/resolve (body {resolution:'...'})`, `GET /admin/disputes?status=open`
- **Expect:** Toast 'Resolved.', modal closes, resolution state cleared, list refetches. Card disappears from non-resolved tabs and appears under Resolved with resolved_at set. Backend sets status='resolved', resolution, resolved_at=now().

#### `DISP-011` Double-resolve / re-resolve an already-resolved dispute (idempotency)  — **P0** · _idempotency_
- **Pre:** Logged in >= support. A dispute already in 'resolved' status with an existing resolution.
- **Steps:**
  1. Directly call the resolve endpoint twice for the same already-resolved id (use API client / curl, since the Resolved tab hides the button)
  2. Inspect crm_disputes row before/after
- **API:** `POST /admin/disputes/{id}/resolve (body {resolution:'second outcome'})`
- **Expect:** BUG EXPECTATION: second resolve returns 200 {ok:true} and OVERWRITES resolution and resolved_at (UPDATE has no WHERE status!='resolved' guard, RowsAffected=1). Unlike SetDisputeStatus which guards against resolved/closed. Verify the audit log still records dispute.resolve. This is a data-integrity gap — flag if outcome is silently rewritten.

#### `DISP-019` RBAC: viewer cannot create/resolve (UI gating)  — **P0** · _rbac_
- **Pre:** Logged in as role 'viewer'. Disputes exist.
- **Steps:**
  1. Open Disputes page
  2. Confirm '+ New case' button is NOT rendered (Can perm='disputes.create')
  3. On a card, observe 'In progress'/'Escalate'/'Resolve' buttons are disabled with title 'Insufficient permissions'
  4. Click a disabled-looking 'Resolve' (if clickable)
- **API:** `GET /admin/disputes?status=open`
- **Expect:** List still loads (disputes.read = viewer). New case button hidden. Action buttons disabled (disabled={!canResolve}). If a click registers, an 'Insufficient permissions' error toast shows and no POST fires. Required role for write = support; viewer is insufficient.

#### `DISP-020` RBAC: backend rejects write from viewer even if UI bypassed  — **P0** · _rbac_
- **Pre:** Hold a valid viewer JWT.
- **Steps:**
  1. Directly POST /admin/disputes/{id}/resolve with the viewer token
- **API:** `POST /admin/disputes/{id}/resolve`
- **Expect:** Backend RequirePermission('disputes.resolve') returns 403 {error:'insufficient_permissions', required_role:'support', your_role:'viewer'}. Axios interceptor renders 'Insufficient permissions. Requires support; you are viewer.'

#### `DISP-002` Tab switching refetches per-status  — **P1** · _happy_
- **Pre:** Logged in >= viewer. Disputes exist in 'open', 'in_progress', 'resolved', 'escalated'.
- **Steps:**
  1. Open Disputes page
  2. Click the 'In progress' tab
  3. Click the 'Resolved' tab
  4. Click the 'Escalated' tab
  5. Click back to 'Open'
- **API:** `GET /admin/disputes?status=in_progress`, `GET /admin/disputes?status=resolved`, `GET /admin/disputes?status=escalated`, `GET /admin/disputes?status=open`
- **Expect:** Each tab click fires a new GET with the matching status param (queryKey ['disputes', status]) and renders only matching cards. On the 'resolved' tab, NO action buttons render (status==='resolved' branch hides them).

#### `DISP-003` Empty state per tab  — **P1** · _edge_
- **Pre:** Logged in >= viewer. A status with zero rows, e.g. no 'escalated' disputes.
- **Steps:**
  1. Open Disputes page
  2. Click the 'Escalated' tab (ensure DB has none for this status)
- **API:** `GET /admin/disputes?status=escalated`
- **Expect:** A Card with EmptyState 'No escalated disputes' renders. No error, no crash.

#### `DISP-005` Create blocked when description empty  — **P1** · _edge_
- **Pre:** Logged in >= support.
- **Steps:**
  1. Click '+ New case'
  2. Leave Description blank
  3. Observe the 'Create' button
- **Expect:** 'Create' button is disabled (disabled={!desc || !canCreate}); no POST fires. If forced via API with empty description, backend returns 400 {error:'description required'}.

#### `DISP-008` Transition open -> escalated  — **P1** · _happy_
- **Pre:** Logged in >= support. An 'open' dispute exists.
- **Steps:**
  1. On Open tab, click 'Escalate' on a card
- **API:** `POST /admin/disputes/{id}/status (body {status:'escalated'})`, `GET /admin/disputes?status=open`
- **Expect:** Toast 'Status updated.', card moves to Escalated tab. 'Escalate' button hidden once status==='escalated'.

#### `DISP-012` Double-click Resolve confirm (concurrency / double-submit)  — **P1** · _concurrency_
- **Pre:** Logged in >= support. A non-resolved dispute exists. Throttle network in devtools to widen the window.
- **Steps:**
  1. Click 'Resolve' on a card
  2. Type a resolution
  3. Rapidly double-click the 'Resolve' confirm button in the ConfirmModal
- **API:** `POST /admin/disputes/{id}/resolve`
- **Expect:** Risk: the resolve mutation (m) is NOT gated by m.isPending in this code (onConfirm={() => m.mutateAsync()}), so the confirm button may fire two POSTs before the modal closes. Both will 200 (no status guard). Verify whether two audit rows are written and whether resolved_at is rewritten. If ConfirmModal does not internally disable on submit, this is a double-submit risk to flag.

#### `DISP-013` Double-click status transition button (concurrency)  — **P1** · _concurrency_
- **Pre:** Logged in >= support. An 'open' dispute exists. Throttle network.
- **Steps:**
  1. On Open tab, rapidly double-click 'Escalate' on one card
- **API:** `POST /admin/disputes/{id}/status`
- **Expect:** Transition buttons ARE disabled while transition.isPending (disabled={!canResolve || transition.isPending}), so the second click should be blocked. Confirm only ONE POST fires and only one audit row (dispute.status) is written.

#### `DISP-014` Set status to invalid value via API (negative, 400)  — **P1** · _negative_
- **Pre:** Logged in >= support. A non-resolved dispute exists.
- **Steps:**
  1. Call the status endpoint with an invalid status, e.g. body {status:'resolved'} or {status:'garbage'}
- **API:** `POST /admin/disputes/{id}/status (body {status:'resolved'})`
- **Expect:** Backend returns 400 {error:'status must be in_progress or escalated'} (SetDisputeStatus only allows in_progress/escalated). The generic axios interceptor surfaces a toast with that message. Confirm no row is mutated.

#### `DISP-015` Transition a resolved/closed dispute via API (state-machine guard)  — **P1** · _negative_
- **Pre:** Logged in >= support. A dispute in 'resolved' (or 'closed') status exists.
- **Steps:**
  1. Call status endpoint on the resolved dispute id with body {status:'in_progress'}
- **API:** `POST /admin/disputes/{id}/status (body {status:'in_progress'})`
- **Expect:** Backend returns 404 {error:'dispute not found or already resolved'} (WHERE status NOT IN ('resolved','closed'), RowsAffected=0 -> ErrNotFound). Toast surfaces the message. Note the status-code mismatch: a valid-but-terminal-state transition returns 404, not 409 — flag as a wrong-status-code candidate.

#### `DISP-022` SLA breach badge appears for overdue open disputes (boundary date)  — **P1** · _edge_
- **Pre:** Logged in >= viewer. A dispute with sla_due_at in the PAST and status != 'resolved'.
- **Steps:**
  1. Seed a dispute with sla_due_at < now() and status='open'
  2. Open the Open tab and view that card
- **API:** `GET /admin/disputes?status=open`
- **Expect:** A red 'SLA breach' StatusPill renders (overdue = sla_due_at < now && status!=='resolved'). For a resolved dispute the badge must NOT show even if sla_due_at is past.

#### `DISP-024` List cap at 50 / no pagination (off-by-page)  — **P1** · _edge_
- **Pre:** Logged in >= viewer. More than 50 disputes in a single status.
- **Steps:**
  1. Seed 60+ 'open' disputes
  2. Open the Open tab and scroll to the bottom
- **API:** `GET /admin/disputes?status=open`
- **Expect:** Only the newest 50 render (frontend never passes a limit param; backend default=50). There is no pager/'load more' UI, so disputes 51+ are unreachable from this page. Flag as a missing-pagination/visibility gap on a queue that can grow.

#### `DISP-026` Audit log written for every dispute write  — **P1** · _happy_
- **Pre:** Logged in >= support with audit.read (admin) to inspect, or DB access to crm audit table.
- **Steps:**
  1. Create, transition, and resolve a dispute
  2. Inspect the audit log (Audit page or DB) filtered to module='trustsafety'
- **API:** `POST /admin/disputes`, `POST /admin/disputes/{id}/status`, `POST /admin/disputes/{id}/resolve`
- **Expect:** Three audit entries: dispute.create (after=request body), dispute.status (after=status string), dispute.resolve (after=resolution string), each with admin id/email, IP, user-agent, module='trustsafety', target_type='ts'. Confirm none are missing.

#### `DISP-006` Create with each severity/source combination  — **P2** · _happy_
- **Pre:** Logged in >= support.
- **Steps:**
  1. Open New case modal
  2. For each Severity option (low, medium, high, critical) and Source option (admin, customer, worker, system): set selects, type a description, click Create
  3. After each, switch to Open tab and confirm pill color
- **API:** `POST /admin/disputes`
- **Expect:** All combos succeed (all within DB CHECK constraints). Severity pill colors: critical/high=danger, medium=warning, low=neutral.

#### `DISP-010` Resolve with empty resolution text  — **P2** · _edge_
- **Pre:** Logged in >= support. A non-resolved dispute exists.
- **Steps:**
  1. Click 'Resolve'
  2. Leave the resolution textarea blank
  3. Click 'Resolve' to confirm
- **API:** `POST /admin/disputes/{id}/resolve (body {resolution:''})`
- **Expect:** Backend accepts empty resolution (no server-side required check) and resolves the case. Document whether QA considers a blank outcome acceptable — there is no client or server guard against it.

#### `DISP-016` Create dispute with invalid severity/source via API (negative, leaks raw PG error)  — **P2** · _negative_
- **Pre:** Logged in >= support.
- **Steps:**
  1. POST a create with body {description:'x', severity:'urgent', source:'admin'} (severity not in low/medium/high/critical)
- **API:** `POST /admin/disputes`
- **Expect:** DB CHECK constraint (migration 041 line 92-93) rejects it; CreateDispute returns the raw pg error and handler responds 400 with the raw error string (e.g. mentions constraint name). UI selects prevent this combo, but raw API exposes a non-friendly/leaky error message — flag the leak.

#### `DISP-017` Resolve a non-existent dispute id (negative, 404)  — **P2** · _negative_
- **Pre:** Logged in >= support.
- **Steps:**
  1. Call resolve with a random valid-format UUID that does not exist
- **API:** `POST /admin/disputes/{nonexistent-uuid}/resolve`
- **Expect:** Backend returns 404 {error:'dispute not found'} (RowsAffected=0 -> ErrNotFound). Toast surfaces 'dispute not found'.

#### `DISP-018` Resolve with malformed (non-UUID) id (negative, 500)  — **P2** · _negative_
- **Pre:** Logged in >= support.
- **Steps:**
  1. Call resolve with id='not-a-uuid'
- **API:** `POST /admin/disputes/not-a-uuid/resolve`
- **Expect:** $1::uuid cast fails in Postgres; ResolveDispute returns a wrapped error (not ErrNotFound) so handler returns 500 {error:'internal error'}. Flag: a client-supplied malformed id yields 500 instead of 400/404 — input not validated before the DB cast.

#### `DISP-021` RBAC: support can resolve, fraud/blacklist still blocked  — **P2** · _rbac_
- **Pre:** Logged in as role 'support'.
- **Steps:**
  1. Confirm '+ New case' is visible and Resolve works (support has disputes.resolve)
  2. (If the same surface exposes fraud/blacklist) confirm those actions are gated higher)
- **API:** `POST /admin/disputes/{id}/resolve`
- **Expect:** support succeeds on dispute create/resolve/status (min role support). Note fraud.review and blacklist.add/remove require admin — out of scope for this page but confirm support is not granted them if surfaced.

#### `DISP-023` SLA boundary: due exactly now / null sla_due_at  — **P2** · _edge_
- **Pre:** Logged in >= viewer. One dispute with sla_due_at = null and one with sla_due_at = a few seconds in the future.
- **Steps:**
  1. View both cards on the Open tab
- **API:** `GET /admin/disputes?status=open`
- **Expect:** Null sla_due_at renders SLA as '—' and shows NO breach badge (overdue is falsy when sla_due_at null). Future due renders the localized timestamp and no badge until it passes.

#### `DISP-025` List error state + retry  — **P2** · _negative_
- **Pre:** Logged in >= viewer. Force a backend 500 (e.g. stop the DB / kill read pool) while loading.
- **Steps:**
  1. Open the Disputes page with the backend list returning 500
  2. Observe the error card
  3. Click 'Retry' after restoring the backend
- **API:** `GET /admin/disputes?status=open`
- **Expect:** ErrorState 'Could not load disputes' with a Retry button renders (q.isError). Clicking Retry refetches and renders the list once the backend recovers.

### audit-settings  <sub>(43 flows — P0:7 P1:20 P2:16)</sub>

The Audit Log viewer (pages/audit/AuditPage.tsx) renders an append-only, read-only view of crm_audit_log written by every CRM module's handler.audit() call; it supports server-side module/action/admin_email/limit filtering and client-side entity_type/entity_id/date-range filtering over the fetched page. The Settings page (pages/SettingsPage.tsx) is a tabbed hub for platform config: loyalty (superadmin), zones, surge, webhooks (superadmin), response templates, app-version policy, changelog (superadmin), an embedded audit viewer tab, and blacklist. Verifying writes elsewhere produce audit rows is in-scope: each module writes via a non-blocking audit.Recorder.Log that swallows DB errors, so a missing audit row never fails the business write.

**Pages:** `/audit` · `/settings` · `App/zopmop-crm/src/api/audit.ts` · `App/zopmop-crm/src/api/all.ts` · `internal/crm/platform/platform.go` · `internal/crm/audit/audit.go` · `internal/crm/growth/growth.go` · `internal/crm/auth/permissions.go` · `internal/crm/middleware/jwt.go`

**Test data:** CRM admin accounts for each role: viewer, support, admin, superadmin (to exercise audit.read=admin and superadmin-only writes).; At least one row in crm_audit_log per module to validate filters: zones, platform, trustsafety, growth, plus an entry with non-empty before_value and one with non-empty after_value for the detail modal.; More than 200 audit rows (ideally >500) spanning multiple days to exercise limit boundaries (25/100/500), the >500 clamp, and the client-side date/entity off-by-page hazard (AUD-10).; Audit rows with target_type in {worker, order, user, zone_approval_request, refund} to test entity deep-links (refund renders plain).; At least one zone (with realistic lat/lon e.g. 28.6139,77.2090, radius_km 5) to toggle/edit and to attach surge rules.; At least one surge rule to delete; a fractional multiplier (1.25/1.5) to check float round-trip.; At least one crm_webhooks row, with at least one FAILED crm_webhook_deliveries row (non-2xx) to exercise Retry and a 127.0.0.1/internal URL webhook to probe SSRF/IsProduction guard.; Existing loyalty config row in crm_loyalty_config with non-empty bonus_rules JSON to verify SET-06 (no wipe).; A few crm_response_templates, crm_app_versions, crm_changelog rows, and crm_blacklist entries to validate list/empty states.; A scratch/throwaway DB where crm_audit_log inserts can be intentionally broken (revoke INSERT or rename a column) to verify AUD-25 (write succeeds, audit row silently absent).

#### `AUD-01` Audit log loads and lists most-recent-first  — **P0** · _happy_
- **Pre:** Logged in as admin or superadmin (audit.read = admin minimum). At least 1 audit row exists.
- **Steps:**
  1. Navigate to /audit (Audit Log)
  2. Observe the header subtitle counts and the table
  3. Confirm rows render Timestamp/Admin/Module/Action/Entity/Preview
  4. Confirm newest row is at the top
- **API:** `GET /admin/audit?limit=100`
- **Expect:** Table renders rows ordered by created_at DESC. Subtitle reads 'N entries shown · M fetched · server cap 100'. Each row shows admin_email, a module pill, the dotted action string, entity type+truncated id, and a one-line before/after preview.

#### `AUD-02` Generate an audit row by performing a write elsewhere, then see it appear  — **P0** · _happy_
- **Pre:** superadmin (to exercise a superadmin write) or admin. A zone exists to toggle.
- **Steps:**
  1. Go to /settings, Zones tab
  2. Click Enable/Disable on a zone (or create a zone)
  3. Go to /audit
  4. Set Module filter = 'zones'
  5. Click Refresh
- **API:** `POST /admin/zones/:id/toggle`, `GET /admin/audit?module=zones&limit=100`
- **Expect:** A new row appears with module 'zones', action 'zone.toggle' (or 'zone.create'), admin = current admin email, entity type 'zone' with the zone id, and a before/after preview. This verifies the cross-module write-produces-audit contract.

#### `AUD-14` RBAC: viewer/support are blocked from the audit page  — **P0** · _rbac_
- **Pre:** Two test admins: one role=support, one role=viewer. audit.read requires role=admin.
- **Steps:**
  1. Log in as support (or viewer)
  2. Navigate to /audit
- **API:** `(GET /admin/audit is NOT fired — query disabled when !canRead)`
- **Expect:** Page shows the 'Restricted — Your role does not have permission to view the audit log.' empty state. No /admin/audit request is made (useQuery enabled:canRead=false). Required role: admin; insufficient: viewer, support.

#### `AUD-15` RBAC: backend rejects audit read for support even if frontend bypassed  — **P0** · _rbac_
- **Pre:** support JWT token.
- **Steps:**
  1. Using the support token, call GET /admin/audit directly (curl/devtools)
  2. Inspect status + body
- **API:** `GET /admin/audit`
- **Expect:** 403 with {error:'insufficient_permissions', required_role:'admin', your_role:'support'}. Confirms server-side gate independent of the SPA.

#### `SET-04` Loyalty config save (superadmin) writes config and an audit row  — **P0** · _money_
- **Pre:** superadmin. loyalty.update=superadmin.
- **Steps:**
  1. Open /settings as superadmin, Loyalty tab
  2. Set Enabled, 'Points per ₹100 spent' = 2, 'Points per ₹1 discount' = 100
  3. Click Save
  4. Confirm in the ConfirmModal ('Save loyalty config?')
  5. Go to /audit, filter Module='growth'
- **API:** `PUT /admin/growth/loyalty`, `GET /admin/growth/loyalty`, `GET /admin/audit?module=growth&limit=100`
- **Expect:** Toast 'Loyalty saved.'; config persists (re-query shows new values). An audit row action 'growth.loyalty.set' under module 'growth' appears with the new config in after. IMPORTANT for QA: loyalty audit is under module 'growth' NOT 'loyalty' (no 'loyalty' module exists in the dropdown) — filter by 'growth'.

#### `SET-10` RBAC: support/viewer cannot toggle/create zones (button gated + backend 403)  — **P0** · _rbac_
- **Pre:** support and viewer test admins. zones.* = admin.
- **Steps:**
  1. Log in as support, Settings>Zones
  2. Hover the Disable/Enable button (disabled, title 'Insufficient permissions')
  3. Click it
- **API:** `(no call if button disabled; if forced: POST /admin/zones/:id/toggle -> 403)`
- **Expect:** Enable/Disable button is disabled with 'Insufficient permissions' tooltip; clicking shows error toast 'Insufficient permissions' and fires no request. '+ New zone' is hidden (Can perm='zones.create'). Backend independently returns 403 if called directly. Required: admin; insufficient: viewer, support.

#### `SET-24` RBAC: support sees Settings but every write button is gated  — **P0** · _rbac_
- **Pre:** support test admin.
- **Steps:**
  1. Log in as support, /settings (sees zones/surge/templates/audit/blacklist)
  2. On each tab attempt the primary action button
- **API:** `(disabled buttons fire no call; direct calls -> 403)`
- **Expect:** All write buttons disabled with 'Insufficient permissions' tooltip and clicking shows error toast; superadmin-only tabs (loyalty/webhooks/app-version/changelog) are not even rendered. Backend returns 403 if any write is called directly with the support token. Required varies (admin or superadmin per perm).

#### `AUD-03` Server-side filter: module dropdown  — **P1** · _happy_
- **Pre:** admin+. Rows exist for >=2 modules.
- **Steps:**
  1. On /audit open the 'All modules' dropdown
  2. Select 'platform'
  3. Observe table + URL
- **API:** `GET /admin/audit?module=platform&limit=100`
- **Expect:** Only module=platform rows return; URL gains ?module=platform; subtitle 'fetched' count reflects the filtered server response.

#### `AUD-04` Server-side filter: action is substring ILIKE, not exact  — **P1** · _edge_
- **Pre:** admin+. Rows with actions like 'zone.toggle','webhook.delete' exist.
- **Steps:**
  1. In the Action field type 'delete'
  2. Wait for refetch
- **API:** `GET /admin/audit?action=delete&limit=100`
- **Expect:** Backend applies action ILIKE '%delete%' so ANY action containing 'delete' (webhook.delete, template.delete, etc.) returns — typing a bare verb works as the placeholder 'Action (e.g. approve)' implies.

#### `AUD-05` Server-side filter: admin email exact match  — **P1** · _happy_
- **Pre:** admin+. At least one row written by a known admin email.
- **Steps:**
  1. Type the exact admin email into the 'Admin email' search box
  2. Observe results
- **API:** `GET /admin/audit?admin_email=<email>&limit=100`
- **Expect:** Only rows where admin_email EXACTLY equals the value return (backend uses '=' not ILIKE). A partial email or wrong case returns zero rows — verify the empty-state shows 'No audit entries match your filters'.

#### `AUD-07` Limit selector changes server cap  — **P1** · _happy_
- **Pre:** admin+. More than 25 rows exist.
- **Steps:**
  1. Open the 'Limit 100' dropdown
  2. Select 'Limit 25'
  3. Observe URL and subtitle
- **API:** `GET /admin/audit?limit=25`
- **Expect:** At most 25 rows fetched; subtitle shows 'server cap 25'; URL gains ?limit=25. Selecting 500 fetches up to 500 (hard cap).

#### `AUD-09` Client-side date range filter (from/to) over the fetched page  — **P1** · _edge_
- **Pre:** admin+. Rows spanning multiple days within the fetched page.
- **Steps:**
  1. Pick a From date and a To date that bracket some rows
  2. Observe 'entries shown' vs 'fetched'
- **API:** `GET /admin/audit?limit=100 (date filter is client-side only)`
- **Expect:** Table narrows to rows whose created_at falls in [From 00:00 local, To+1day 00:00 local). Single-day (From==To) includes the whole day (IST-correct via localMidnightMs). Subtitle 'entries shown' < 'fetched'. The footnote 'Date range and entity filters apply client-side' is visible.

#### `AUD-10` Client-side date filter can hide matching rows beyond the server cap (off-by-page hazard)  — **P1** · _edge_
- **Pre:** admin+. >100 audit rows; the rows matching a chosen old date are OLDER than the newest 100.
- **Steps:**
  1. Set Limit = 25
  2. Pick a From/To date that is older than the 25 most-recent rows
  3. Observe result
- **API:** `GET /admin/audit?limit=25`
- **Expect:** Empty state 'No audit entries match your filters' appears EVEN THOUGH matching rows exist in the DB — because date filtering runs client-side only over the fetched (newest-N) page. QA pass criterion: raising Limit to 500 surfaces the rows. Document this as a known limitation, not a backend data-loss bug.

#### `AUD-17` Error state + retry on backend failure  — **P1** · _negative_
- **Pre:** admin+. Ability to force the GET /admin/audit to 500 (stop DB read pool / kill backend after load).
- **Steps:**
  1. Open /audit
  2. Kill the backend or DB read connection
  3. Click Refresh
- **API:** `GET /admin/audit (returns 500)`
- **Expect:** AlertCircle error card 'Failed to load audit log' with a Retry button; clicking Retry refetches. Note jsonOrErr returns 500 {error:'internal error'} (no detail leak).

#### `AUD-25` Audit row is NOT blocked when audit insert fails (write still succeeds, row silently missing)  — **P1** · _negative_
- **Pre:** superadmin/admin. Ability to break crm_audit_log inserts (e.g. revoke INSERT or rename column in a scratch DB).
- **Steps:**
  1. Break the crm_audit_log insert path
  2. Perform a write (e.g. toggle a zone)
  3. Confirm the business write succeeded
  4. Go to /audit and look for the row
- **API:** `POST /admin/zones/:id/toggle (200)`, `GET /admin/audit`
- **Expect:** The zone toggle returns 200 and the state change persists, but NO audit row exists (Recorder.Log swallows the error and only logs it). QA/ops pass criterion: backend logs '[crm.audit] failed to write audit row — investigate'. This documents that a missing audit row is a silent P1, not a request failure — verify via logs, not via UI.

#### `SET-01` Settings tab visibility differs by role (superadmin-only tabs hidden)  — **P1** · _rbac_
- **Pre:** Test admins of each role. Superadmin tabs: loyalty, webhooks, app-version, changelog.
- **Steps:**
  1. Log in as admin, open /settings, note tab list
  2. Log in as superadmin, open /settings, note tab list
  3. Log in as support/viewer, open /settings
- **API:** `(tab list is client-computed from usePermission)`
- **Expect:** admin sees zones/surge/templates/audit/blacklist (NOT loyalty/webhooks/app-version/changelog). superadmin sees all 9 tabs. support/viewer see only non-gated tabs (zones/surge/templates/audit/blacklist). The default active tab is the first visible tab.

#### `SET-02` Embedded Settings>Audit tab lists rows and filters by module/action  — **P1** · _happy_
- **Pre:** admin+ (the audit tab itself renders to all roles, but GET /admin/audit needs audit.read=admin).
- **Steps:**
  1. Open /settings
  2. Click the 'audit' tab
  3. Type a module in 'Filter module' and an action in 'Filter action'
- **API:** `GET /admin/audit?module=<m>&action=<a>&limit=200`
- **Expect:** For admin+: compact mono list of rows (module pill, action, target, admin·time). For viewer/support the underlying GET returns 403 and the tab shows empty/no rows. NOTE the audit tab is visible to all roles but the data call is admin-gated — verify viewer sees an error/empty list, not data.

#### `SET-05` Loyalty validation: zero/negative rates rejected  — **P1** · _negative_
- **Pre:** superadmin.
- **Steps:**
  1. Loyalty tab, set 'Points per ₹1 discount' = 0 (or negative)
  2. Click Save, confirm
- **API:** `PUT /admin/growth/loyalty (400)`
- **Expect:** Backend returns 400 'points_per_redeem_inr must be > 0' (and similarly points_per_100_inr>0). The mutation has no onError handler so verify whether a toast surfaces — flag if the 400 is swallowed silently with no user feedback.

#### `SET-06` Loyalty save preserves bonus_rules (no silent wipe)  — **P1** · _money_
- **Pre:** superadmin. Existing loyalty config has non-empty bonus_rules.
- **Steps:**
  1. Loyalty tab loads existing config
  2. Change only the toggle, Save, confirm
  3. Re-open the tab / inspect GET response
- **API:** `PUT /admin/growth/loyalty`, `GET /admin/growth/loyalty`
- **Expect:** bonus_rules is echoed back unchanged (form has no editor; mutation sends q.data.bonus_rules). Verify the saved row's bonus_rules equals the prior value, not [].

#### `SET-08` Zone create writes zone + audit row  — **P1** · _happy_
- **Pre:** admin+. zones.create=admin.
- **Steps:**
  1. Settings>Zones, click '+ New zone'
  2. Fill Name, City, Lat, Lon, Radius km, click Save
  3. Check the zone list and /audit module='zones'
- **API:** `POST /admin/zones`, `GET /admin/zones`, `GET /admin/audit?module=zones&limit=100`
- **Expect:** Toast 'Saved.'; new zone appears; audit row action 'zone.create' module 'zones' target_type 'zone'. Verify lat/lon round-trip (note: lat/lon/radius are floats end-to-end — check precision e.g. 28.6139).

#### `SET-11` Surge rule create (multiplier) writes audit; precision check  — **P1** · _money_
- **Pre:** admin+. surge.create=admin. At least one zone exists.
- **Steps:**
  1. Settings>Surge, pick a zone, set Multiplier '1.5', optional Reason, click Add
  2. Observe Active rules list and /audit
- **API:** `POST /admin/zones/surge`, `GET /admin/zones/surge`, `GET /admin/audit?module=zones&limit=100`
- **Expect:** Toast 'Surge rule created.'; rule shows '1.50×'; audit row action 'surge.create' module 'zones'. Multiplier is a float — verify a value like 1.25 round-trips exactly and the impact note 'Pricing reverts to normal immediately.' applies on removal.

#### `SET-12` Surge create with non-numeric/empty multiplier  — **P1** · _negative_
- **Pre:** admin+.
- **Steps:**
  1. Settings>Surge, pick a zone, set Multiplier to 'abc' or blank
  2. Observe Add button state, then try a value like 0
- **API:** `POST /admin/zones/surge (if submitted)`
- **Expect:** Add is disabled when zoneID or mul is empty. 'abc' -> Number('abc')=NaN sent as multiplier — verify backend rejects/handles NaN (flag if NaN is persisted). 0 or negative multiplier behavior should be validated server-side; confirm a sensible 4xx and a surfaced error.

#### `SET-14` Webhook create (superadmin) writes audit row  — **P1** · _happy_
- **Pre:** superadmin. webhooks.create=superadmin.
- **Steps:**
  1. Settings>Webhooks, enter a valid https URL and events 'order.completed,refund.approved'
  2. Click Add
  3. Check the list + /audit module='platform'
- **API:** `POST /admin/webhooks`, `GET /admin/webhooks`, `GET /admin/audit?module=platform&limit=100`
- **Expect:** Toast 'Webhook added.'; webhook listed active; audit row action 'webhook.create' module 'platform' (NOT 'webhooks' — webhook events audit under platform). The events string is split/trimmed/filtered. URL must start with http(s) or backend 400.

#### `SET-15` Webhook create validation: non-http URL and empty events  — **P1** · _negative_
- **Pre:** superadmin.
- **Steps:**
  1. Enter 'ftp://x' as URL with events present, click Add
  2. Then enter a valid URL but clear events, click Add
- **API:** `POST /admin/webhooks (400)`
- **Expect:** Backend 400 'url must start with http(s)' and 'at least one event required'. Verify error toast/inline surfacing — the create mutation lacks onError, so a 400 may show no toast; flag silent failure if so.

#### `SET-16` Webhook Test ping — IsProduction guard / SSRF awareness  — **P1** · _edge_
- **Pre:** superadmin (Test button is Can perm='webhooks.create'). A webhook exists.
- **Steps:**
  1. Settings>Webhooks, click 'Test' on a webhook
  2. Edit the Event and Sample payload (valid JSON), click Send
  3. Observe the inline DeliveryResultCard and toast
- **API:** `POST /admin/webhooks/:id/test`
- **Expect:** A real outbound HTTP call is made to the webhook URL via the dispatcher and a delivery row is returned (status_code, duration, body). Toast 'Test sent — <code>' or 'Test failed — <code>'. SECURITY/QA: confirm whether the dispatcher honors an IsProduction()/SSRF guard before firing to arbitrary URLs (open audit item 'webhook SSRF'); test against a local 127.0.0.1 URL to see if internal addresses are blocked. Audit row action 'webhook.test' module 'platform'.

#### `SET-18` Webhook Deliveries drawer + Retry (idempotency / new delivery row)  — **P1** · _idempotency_
- **Pre:** superadmin. A webhook with at least one FAILED delivery.
- **Steps:**
  1. Settings>Webhooks, click 'Deliveries' on a webhook
  2. Find a failed (non-2xx) delivery, click 'Retry'
  3. Confirm in the modal
  4. Watch the drawer (polls every 10s)
- **API:** `GET /admin/webhooks/:id/deliveries (every 10s)`, `POST /admin/webhooks/deliveries/:deliveryId/retry`
- **Expect:** Toast 'Replayed — new delivery #<id>'. A NEW delivery row is created (retry does not mutate the original); the original shows a 'replayed <time>' marker. Audit row action 'webhook.retry' module 'platform' with new_delivery_id. Verify replaying twice creates two new rows (each replay is a distinct delivery, by design — confirm no double-charge/double-effect since payload is the same event).

#### `SET-23` Blacklist add/remove writes audit rows  — **P1** · _happy_
- **Pre:** admin+. blacklist.add/.remove=admin.
- **Steps:**
  1. Settings>blacklist, pick kind (phone/email/device_id/ip), enter Value + Reason, click Add
  2. Click Remove on an entry
  3. Check /audit module='trustsafety'
- **API:** `POST /admin/blacklist`, `DELETE /admin/blacklist/:id`, `GET /admin/audit?module=trustsafety&limit=100`
- **Expect:** Toast 'Added.'/list updates; audit rows action 'blacklist.add' and 'blacklist.remove' under module 'trustsafety' (NOT 'blacklist' — confirms the AuditPage comment that blacklist is recorded under trustsafety). Add disabled until value+reason present.

#### `AUD-06` admin_email is exact-match: partial/case-mismatch yields empty  — **P2** · _negative_
- **Pre:** admin+. Row exists for 'Ops.Admin@zopmop.com' (mixed case if DB stores mixed case).
- **Steps:**
  1. Enter a partial fragment of an admin email (e.g. 'ops')
  2. Observe results
  3. Clear, enter the full email in different case
- **API:** `GET /admin/audit?admin_email=ops&limit=100`, `GET /admin/audit?admin_email=<wrongcase>&limit=100`
- **Expect:** Both return zero rows (exact match, case-sensitive). This is a usability sharp edge versus the substring action filter; document expected behavior so QA does not log it as a data-loss bug.

#### `AUD-08` Limit boundary: value above 500 clamps server-side  — **P2** · _edge_
- **Pre:** admin+.
- **Steps:**
  1. Manually edit the URL to /audit?limit=9999 and load
  2. Observe subtitle vs actual rows
- **API:** `GET /admin/audit?limit=9999`
- **Expect:** Backend clamps limit>500 to 100 (default). NOTE the UI subtitle will show 'server cap 9999' (it echoes the client value, not the server-applied cap) — flag this as a minor display mismatch; rows returned are capped at 100.

#### `AUD-11` Client-side entity_type and entity_id filters  — **P2** · _happy_
- **Pre:** admin+. Rows with target_type 'zone' and 'worker' exist in the fetched page.
- **Steps:**
  1. Open 'All entity types' dropdown, select 'worker'
  2. Type a partial entity id fragment in 'Entity ID (contains)'
  3. Observe rows
- **API:** `GET /admin/audit?limit=100 (entity filters client-side)`
- **Expect:** Rows filtered to target_type=='worker' AND target_id containing the fragment (case-insensitive). entity_type uses exact equality; entity_id uses substring contains.

#### `AUD-12` Row detail modal shows before/after JSON and Copy JSON  — **P2** · _happy_
- **Pre:** admin+. A row with non-empty after_value (e.g. a template.create).
- **Steps:**
  1. Click any audit row
  2. Inspect the modal KV grid (Timestamp/ID/Admin/IP/Module/Action/Entity type/Entity ID)
  3. Expand/collapse Before and After blocks
  4. Click 'Copy JSON'
- **API:** `(none — modal renders fetched row)`
- **Expect:** Modal opens with all metadata; Before shows 'empty' for creates (before=null), After shows pretty-printed JSON. Copy JSON writes the full row to clipboard and a success toast 'Copied to clipboard.' appears.

#### `AUD-13` Entity deep-link from a row navigates correctly  — **P2** · _happy_
- **Pre:** admin+. A row with target_type 'worker' or 'order' or 'user'.
- **Steps:**
  1. In the Entity column click the linked entity (worker/order/user)
  2. Confirm navigation
- **API:** `(client-side route nav)`
- **Expect:** worker -> /workers?id=<id>, order -> /orders/<id>, user -> /users?id=<id>, zone_approval_request -> /zone-approvals. refund and all other types render as plain text (no link) by design. Click does NOT also open the detail modal (stopPropagation).

#### `AUD-16` Empty state when no rows match  — **P2** · _edge_
- **Pre:** admin+.
- **Steps:**
  1. Apply a Module filter for a module with no rows (e.g. set Action='zzz-nonexistent')
  2. Observe
  3. Click 'Clear filters'
- **API:** `GET /admin/audit?action=zzz-nonexistent&limit=100`
- **Expect:** FileText empty state 'No audit entries match your filters' with a 'Clear filters' button that resets all filters and the URL params.

#### `AUD-18` Filter state persists in URL and survives back-nav / reload  — **P2** · _happy_
- **Pre:** admin+.
- **Steps:**
  1. Set Module=platform, Action=delete, Limit=50, From/To dates
  2. Copy the URL, open in a new tab (or reload)
  3. Navigate away and use browser Back
- **API:** `GET /admin/audit?module=platform&action=delete&limit=50`
- **Expect:** All non-default filters restore from URL params on reload/back. Default limit (100) is omitted from the URL (writeFilters only sets limit when !=100).

#### `SET-03` Settings>Audit tab passes empty module/action params  — **P2** · _edge_
- **Pre:** admin+.
- **Steps:**
  1. Open Settings>audit tab with both filter fields blank
  2. Observe the network request
- **API:** `GET /admin/audit?module=&action=&limit=200`
- **Expect:** platformApi.listAudit sends module= and action= as empty strings (unlike api/audit.ts which strips empties). Backend treats empty module/action as no filter (conds skip empty), so all rows up to 200 return. Verify no 400/odd behavior from the empty params.

#### `SET-07` Loyalty save double-click / double-submit  — **P2** · _concurrency_
- **Pre:** superadmin.
- **Steps:**
  1. Loyalty tab, change a value, click Save
  2. In the ConfirmModal rapidly click the confirm button twice
- **API:** `PUT /admin/growth/loyalty (possibly x2)`
- **Expect:** SetLoyalty INSERTs a new config row each call (versioned table, ORDER BY updated_at DESC). Two confirms could write two rows; GetLoyalty returns the latest so user impact is nil, but verify two 'growth.loyalty.set' audit rows do not indicate a corrupted state. Flag if the confirm button is not disabled during the in-flight mutation.

#### `SET-09` Zone toggle (enable/disable) writes audit row  — **P2** · _happy_
- **Pre:** admin+. zones.toggle=admin.
- **Steps:**
  1. Settings>Zones, click Enable/Disable on a zone
  2. Observe StatusPill flip
  3. Check /audit
- **API:** `POST /admin/zones/:id/toggle`, `GET /admin/audit?module=zones&limit=100`
- **Expect:** Pill toggles active/off, list invalidates. Audit row action 'zone.toggle' with after = boolean active value.

#### `SET-13` Surge rule delete (confirm modal) writes audit row  — **P2** · _happy_
- **Pre:** admin+. surge.delete=admin. A surge rule exists.
- **Steps:**
  1. Settings>Surge, click Remove on a rule
  2. Confirm in ConfirmModal ('Remove surge rule?')
  3. Check list + /audit
- **API:** `DELETE /admin/zones/surge/:id`, `GET /admin/audit?module=zones&limit=100`
- **Expect:** Toast 'Removed.'; rule gone; audit row action 'surge.delete'. ConfirmModal is destructive-styled.

#### `SET-17` Webhook Test invalid JSON aborts before send  — **P2** · _negative_
- **Pre:** superadmin.
- **Steps:**
  1. Open Test modal, replace the sample payload with invalid JSON '{bad'
  2. Click Send
- **API:** `(none — aborted client-side)`
- **Expect:** Inline 'Invalid JSON' error shows; no POST /admin/webhooks/:id/test fires. Fixing the JSON clears the error.

#### `SET-19` Opening the Deliveries drawer writes an audit row for a READ (doc contradiction)  — **P2** · _edge_
- **Pre:** superadmin. A webhook exists.
- **Steps:**
  1. Settings>Webhooks, click 'Deliveries'
  2. Immediately go to /audit, filter module='platform', action='delivery'
- **API:** `GET /admin/webhooks/:id/deliveries`, `GET /admin/audit?module=platform&action=delivery&limit=100`
- **Expect:** An audit row action 'webhook.delivery.list' is recorded for a READ operation (ListDeliveries audits a read), even though audit.go states 'Reads are not audited'. Verify each drawer-open logs one such row. The 10s poll re-queries deliveries — confirm whether each poll also logs (it should NOT, since polling reuses the same GET which DOES audit; flag if 6 rows/minute pile up).

#### `SET-20` Template create/delete writes audit rows  — **P2** · _happy_
- **Pre:** admin+. templates.create/.delete=admin.
- **Steps:**
  1. Settings>Templates, pick category, enter Name + Body, click Add
  2. Then click × to delete a template, observe
  3. Check /audit module='platform'
- **API:** `POST /admin/templates`, `DELETE /admin/templates/:id`, `GET /admin/audit?module=platform&limit=100`
- **Expect:** Toast 'Template added.'; library updates; audit rows action 'template.create' and 'template.delete' module 'platform'. Add disabled until name+body present.

#### `SET-21` App version policy set (superadmin) with force update  — **P2** · _happy_
- **Pre:** superadmin. app_version.update=superadmin.
- **Steps:**
  1. Settings>app-version, choose platform, enter Min version '1.4.2', check Force update, enter a message
  2. Click 'Save policy'
  3. Check History + /audit
- **API:** `POST /admin/app-versions`, `GET /admin/app-versions`, `GET /admin/audit?module=platform&limit=100`
- **Expect:** Toast 'Version policy saved.'; new history entry with force pill; audit row action 'appversion.set' module 'platform'. Save disabled until min_version present; backend 400 if platform/min_version missing.

#### `SET-22` Changelog create with publish toggle (superadmin)  — **P2** · _happy_
- **Pre:** superadmin. changelog.publish=superadmin.
- **Steps:**
  1. Settings>changelog, enter Version + Body, toggle 'Publish immediately'
  2. Click Save
  3. Check Published list + /audit
- **API:** `POST /admin/changelog`, `GET /admin/changelog`, `GET /admin/audit?module=platform&limit=100`
- **Expect:** Toast 'Saved.'; entry shows 'published' or 'draft' pill; published_at set only when toggled. Audit row action 'changelog.create' module 'platform'.

### leaves  <sub>(23 flows — P0:6 P1:11 P2:6)</sub>

The Leaves area is a read-mostly CRM view over pro (worker) leave declarations from the pro_leaves table, with reassignment outcomes, plus per-pro monthly leave-balance cards and an inline "Allocate" action that adjusts a worker's running leave_balance. NOTE: despite the task title "approve/reject", there is NO approve/reject endpoint in this code — leave status (approved/cancelled/pending/rejected) is read-only display only; the only write is POST allocate (positive days = grant, negative days = deduct, gated behind extra leaves.deduct permission). All three endpoints live under /admin and require a CRM JWT.

**Pages:** `/leaves` · `/orders/:bookingId`

**Test data:** A CRM admin account (role=admin) and a CRM support account (role=support) and a CRM viewer account (role=viewer) with working login credentials for http://localhost:5174 — needed for all RBAC flows (LV-09, LV-14, LV-15).; At least one helpers row with a known id (this id IS the pro_id), known leave_balance (e.g. 2), monthly_leave_quota set, and leave_balance_reset_at — for allocate/deduct money flows (LV-06, LV-07, LV-09, LV-10).; A corresponding users row (id == helpers.id, deleted_at IS NULL) with name + phone so the table/balance cards show a name instead of '—' / '(deleted)'.; Several pro_leaves rows for that pro across different dates with status values approved/pending/cancelled/rejected, varied source ('pro' and 'admin'), and non-zero bookings_affected — for list/status/ordering flows (LV-01, LV-19).; At least one pro_leaves row with reassignment_outcome='cancelled' and 1-2 UUIDs in cancelled_booking_ids (matching real bookings ids if the /orders deep link is to be exercised) — for LV-20.; A pro_leaves row dated for the CURRENT calendar month with status='approved' so the balances 'used_this_month' subquery returns >0 (uses Asia/Kolkata month boundaries) — for LV-01 balance-strip verification.; >100 pro_leaves rows inside a single date window to exercise the pagination ceiling — for LV-17.; A valid-but-non-helper UUID (e.g. a customer user id or random UUID) for the 404 path — LV-11.; A valid admin JWT exported for curl/Postman to exercise direct-API negative/boundary cases (LV-05, LV-08, LV-09, LV-10, LV-12, LV-18, LV-23) and read crm_audit_log for LV-22.; Read access to the crm_audit_log table to verify the audit row (and the NULL before_value gap) for LV-22.

#### `LV-01` Load Leaves page, see table + balance strip (happy path)  — **P0** · _happy_
- **Pre:** Logged into CRM at http://localhost:5174 as an admin (or any role >= viewer). At least 3 pro_leaves rows exist, and >=1 helpers row with leave_balance/monthly_leave_quota set.
- **Steps:**
  1. Navigate to /leaves from the sidebar (Leaves / CalendarDays icon)
  2. Observe the 'Pro balances (current month)' strip renders up to 6 cards
  3. Observe the leaves table renders rows newest-first (by date desc, then declared_at desc)
  4. Confirm each row shows Pro name+phone, formatted Date, Declared-at datetime, Status pill, Bookings affected (right-aligned), Reassignment outcome pill, and an Allocate control
- **API:** `GET /admin/leaves?limit=100`, `GET /admin/leaves/balances`
- **Expect:** Table shows leave rows ordered by date desc; status pill is green only for 'approved', neutral otherwise; balance strip shows 'bal X / used Y' per card with '<used> used / <quota> quota'. No error toast.

#### `LV-06` Allocate +N days (happy path, money/state change)  — **P0** · _money_
- **Pre:** Logged in as admin (workers.update => RoleAdmin). Know a pro row in the table with a known starting leave_balance (e.g. 2).
- **Steps:**
  1. Go to /leaves
  2. Find a row for the target pro
  3. In the Allocate control set the number input to 3
  4. Click 'Allocate'
  5. Read the success toast
  6. Re-query DB or refetch to confirm
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":3,"reason":""}`
- **Expect:** Success toast 'Allocated. New balance: 5'. DB helpers.leave_balance increases by exactly 3 (2 -> 5). React Query invalidates ['leaves'] so balance strip refetches and reflects new value. Input resets to 1.

#### `LV-07` Allocate is balance-additive, not idempotent — double click adds twice  — **P0** · _concurrency_
- **Pre:** Logged in as admin. Target pro with starting leave_balance known (e.g. 5). Throttle network to make the in-flight window visible, or just click fast.
- **Steps:**
  1. Go to /leaves
  2. Set the row's number input to 1
  3. Click 'Allocate' and immediately try to click it again before the first resolves
  4. Observe button disabled state (disabled={mut.isPending})
  5. After settle, check DB leave_balance
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":1}`
- **Expect:** Button disables while pending, so a fast double-click in the SAME control fires only ONE POST (good). BUT the endpoint has NO idempotency key: two SEPARATE successful POSTs (e.g. two browser tabs, or retry) each add days — balance goes 5 -> 6 -> 7. Verify each accepted POST increments by exactly its days; confirm there is no dedupe. This is expected behavior to document, not a defect by itself.

#### `LV-09` Allocate negative days (deduction) blocked for support, allowed for admin  — **P0** · _rbac_
- **Pre:** Two CRM accounts: one role=support, one role=admin. leaves.deduct and workers.update both require RoleAdmin. FE cannot send negative (min=1), so test via API with each account's JWT.
- **Steps:**
  1. As SUPPORT: POST /admin/pro/<proId>/leave/allocate {"days":-1}
  2. As ADMIN: POST /admin/pro/<proId>/leave/allocate {"days":-1}
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":-1}`
- **Expect:** Support is ALREADY blocked at the route by workers.update (RoleAdmin) => 403 before the negative branch is even reached. Admin: route passes (workers.update ok) AND the negative-days leaves.deduct check passes (also RoleAdmin) => 200, balance decreases by 1. Required role for both = admin; insufficient = viewer/support.

#### `LV-15` RBAC: viewer/support cannot allocate (positive grant)  — **P0** · _rbac_
- **Pre:** CRM account role=support (or viewer). Allocate route gated on workers.update => RoleAdmin.
- **Steps:**
  1. Log in as support
  2. Go to /leaves
  3. Set a row input to 1 and click 'Allocate'
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":1}`
- **Expect:** 403 {"error":"insufficient_permissions","required_role":"admin","your_role":"support"}. UI shows error toast 'Failed to allocate'. NOTE: FE does NOT hide the Allocate button for low-role users, so the control is visible/clickable but the call is rejected server-side. Required role = admin; insufficient = support/viewer.

#### `LV-16` No auth token => 401  — **P0** · _negative_
- **Pre:** No/expired CRM JWT.
- **Steps:**
  1. Call GET /admin/leaves with no Authorization header
  2. Call POST /admin/pro/<proId>/leave/allocate with no Authorization header
- **API:** `GET /admin/leaves`, `POST /admin/pro/<proId>/leave/allocate`
- **Expect:** JWT middleware rejects with 401 before reaching the handler. From the SPA, an expired token triggers the refresh flow; a hard failure routes to login.

#### `LV-02` Empty state when no leaves match  — **P1** · _edge_
- **Pre:** Logged in as admin. Pick a From/To window with zero pro_leaves rows (e.g. From=2099-01-01, To=2099-01-02).
- **Steps:**
  1. Go to /leaves
  2. Set From field to 2099-01-01
  3. Set To field to 2099-01-02
  4. Wait for refetch
- **API:** `GET /admin/leaves?from=2099-01-01&to=2099-01-02&limit=100`
- **Expect:** Table area shows EmptyState 'No leaves found' with body 'Try widening the date range.' No crash, no error toast. Balance strip may still render (balances are not date-filtered).

#### `LV-03` Filter by full pro UUID (valid)  — **P1** · _happy_
- **Pre:** Logged in as admin. Know a real pro_id UUID that has leave rows and a helpers row.
- **Steps:**
  1. Go to /leaves
  2. Paste the full 36-char UUID into 'Filter by pro id'
  3. Wait ~300ms (debounce)
- **API:** `GET /admin/leaves?pro_id=<uuid>&limit=100`, `GET /admin/leaves/balances?pro_id=<uuid>`
- **Expect:** Table shows only that pro's leaves; balances call also scopes to that pro. No 400/500. Clearing the field (Clear button) refetches the full unfiltered list.

#### `LV-04` Partial / malformed pro UUID never hits the server  — **P1** · _edge_
- **Pre:** Logged in as admin. Open browser devtools Network tab.
- **Steps:**
  1. Go to /leaves
  2. Type a few characters into 'Filter by pro id' (e.g. 'abc')
  3. Watch the Network tab for ~1s
- **API:** `(none expected for pro_id while invalid) GET /admin/leaves?limit=100`
- **Expect:** FE UUID_RE guard + 300ms debounce means NO /admin/leaves request carries the partial pro_id (validProId stays undefined). No 400 toast spam. Only the unfiltered list query runs.

#### `LV-05` Backend rejects malformed pro_id with 400 (direct API)  — **P1** · _negative_
- **Pre:** Have a valid admin JWT. Use curl/Postman against http://localhost:8090.
- **Steps:**
  1. Send GET /admin/leaves?pro_id=not-a-uuid with the Authorization bearer token
  2. Send GET /admin/leaves/balances?pro_id=not-a-uuid
- **API:** `GET /admin/leaves?pro_id=not-a-uuid`, `GET /admin/leaves/balances?pro_id=not-a-uuid`
- **Expect:** Both return 400 with body {"error":"invalid pro_id"} (uuid.Parse guard), NOT 500. This is the protection the FE comment in LeavesPage.tsx:30-32 describes.

#### `LV-08` Allocate with zero days rejected  — **P1** · _negative_
- **Pre:** Logged in as admin. The FE number input clamps min=1 so 0 is hard to send from UI; test via API for the guard, and via UI by trying to clear the field.
- **Steps:**
  1. UI: in the Allocate input, select-all and delete / type 0 — observe onChange forces value back to >=1 (Math.max(1, ...))
  2. API: POST /admin/pro/<proId>/leave/allocate with {"days":0}
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":0}`
- **Expect:** UI never lets you submit 0 (clamped to 1). Direct API returns 400 {"error":"days must be non-zero"}. No DB write, no audit row.

#### `LV-10` Negative deduction can drive balance below zero (no clamp)  — **P1** · _money_
- **Pre:** Admin JWT. Target pro with small balance (e.g. leave_balance=1).
- **Steps:**
  1. POST /admin/pro/<proId>/leave/allocate {"days":-3}
  2. Read returned new_balance
  3. Refetch /leaves balances strip
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":-3}`
- **Expect:** By design (comment leaves.go:196-200) balance is NOT clamped: 1 -> -2. Response new_balance = -2; balance card shows -2. Confirm downstream treats negative as 'no days left' — but the CRM happily displays a negative integer. Document as intended.

#### `LV-11` Allocate against non-existent / non-helper pro returns 404  — **P1** · _negative_
- **Pre:** Admin JWT. Use a syntactically valid UUID that is NOT a helpers row (e.g. a customer user id or a random UUID).
- **Steps:**
  1. POST /admin/pro/00000000-0000-0000-0000-000000000000/leave/allocate {"days":1}
- **API:** `POST /admin/pro/00000000-0000-0000-0000-000000000000/leave/allocate body {"days":1}`
- **Expect:** 404 {"error":"pro not found"} (ErrProNotFound from pgx.ErrNoRows on the UPDATE...RETURNING). No DB change. From the UI this surfaces as the generic error toast 'Failed to allocate'.

#### `LV-12` Allocate with malformed :id path param (suspected 500)  — **P1** · _negative_
- **Pre:** Admin JWT. The Allocate handler does NOT uuid.Parse the :id param (unlike List/Balances).
- **Steps:**
  1. POST /admin/pro/not-a-uuid/leave/allocate {"days":1}
  2. Inspect HTTP status and body
- **API:** `POST /admin/pro/not-a-uuid/leave/allocate body {"days":1}`
- **Expect:** Likely 500 {"error":"internal error"} because the UPDATE ... WHERE id = $1 receives a non-UUID against a uuid column (invalid input syntax for type uuid), and that pg error is NOT pgx.ErrNoRows so it falls through to the 500 branch. Expected-correct behavior would be 400. Flagged as a suspected bug — pass criterion: tester confirms the status code returned (document actual).

#### `LV-13` Allocate error surfaces as toast in UI  — **P1** · _negative_
- **Pre:** Logged in as admin. Force a failure (e.g. stop the backend, or target a pro that gets deleted between load and click).
- **Steps:**
  1. Go to /leaves
  2. Stop the crm-api backend (or disconnect network)
  3. Set a row input to 1 and click 'Allocate'
- **API:** `POST /admin/pro/<proId>/leave/allocate (fails / 5xx / network)`
- **Expect:** onError fires => error toast 'Failed to allocate'. Button re-enables (mut.isPending resets). No silent failure, no balance change.

#### `LV-14` RBAC: viewer can read leaves + balances  — **P1** · _rbac_
- **Pre:** CRM account with role=viewer. leaves.read => RoleViewer (lowest).
- **Steps:**
  1. Log in as viewer
  2. Navigate to /leaves
- **API:** `GET /admin/leaves?limit=100`, `GET /admin/leaves/balances`
- **Expect:** Both GETs return 200; table and balance strip render for a viewer. Required role = viewer (everyone allowed).

#### `LV-22` Audit trail written on allocate  — **P1** · _happy_
- **Pre:** Admin JWT. Access to crm_audit_log table.
- **Steps:**
  1. Perform an allocate (LV-06)
  2. Query crm_audit_log for the latest row
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":3,"reason":"bonus"}`
- **Expect:** A crm_audit_log row exists with action='leave.allocate', module='leaves', target_type='pro', target_id=<proId>, after_value containing {days,reason}, admin_id/admin_email populated, ip/user_agent/request_id captured. NOTE before_value is NULL (the handler passes Before:nil) so the prior balance is NOT captured — verify and document this gap.

#### `LV-17` Pagination ceiling — rows beyond 100 are invisible in UI  — **P2** · _edge_
- **Pre:** Seed >100 pro_leaves rows inside a single date window (or unfiltered).
- **Steps:**
  1. Go to /leaves with no filters
  2. Count rows shown vs DB count
  3. Inspect the /admin/leaves response total_count vs items.length
- **API:** `GET /admin/leaves?limit=100`
- **Expect:** FE hardcodes limit=100 and never sends offset or renders a pager. Response total_count may exceed 100 but only 100 rows display; the rest are silently hidden. Pass = tester confirms total_count > items.length is not surfaced anywhere. (Backend itself caps limit at 200; values >200 are coerced to default 50.)

#### `LV-18` Limit boundary behavior (direct API)  — **P2** · _edge_
- **Pre:** Admin JWT. Enough rows to test.
- **Steps:**
  1. GET /admin/leaves?limit=200
  2. GET /admin/leaves?limit=201
  3. GET /admin/leaves?limit=0
  4. GET /admin/leaves?limit=-5
  5. GET /admin/leaves?offset=-1
- **API:** `GET /admin/leaves?limit=200`, `GET /admin/leaves?limit=201`, `GET /admin/leaves?limit=0`, `GET /admin/leaves?offset=-1`
- **Expect:** limit=200 honored; limit=201 or <=0 coerced to 50 (List: if limit<=0 || limit>200 => 50); offset<0 coerced to 0. Response echoes the EFFECTIVE limit/offset in limit/offset fields, so tester can confirm coercion. No 500.

#### `LV-19` Boundary dates — from==to single day  — **P2** · _edge_
- **Pre:** Admin. Know a date with exactly one pro_leave (pl.date).
- **Steps:**
  1. Go to /leaves
  2. Set From and To to the same date that has a leave
- **API:** `GET /admin/leaves?from=<d>&to=<d>&limit=100`
- **Expect:** Filter is inclusive on both ends (pl.date >= from AND pl.date <= to), so a single-day window returns that day's leaves. Confirm the row appears. Invalid date strings (e.g. 'from=2026-13-40') are silently ignored by the handler (time.Parse fails => filter not applied), so an out-of-range date just drops that bound rather than erroring.

#### `LV-20` Cancelled reassignment row shows danger styling + booking deep links  — **P2** · _happy_
- **Pre:** Seed a pro_leaves row with reassignment_outcome='cancelled' and 1-2 entries in cancelled_booking_ids.
- **Steps:**
  1. Go to /leaves
  2. Locate the cancelled row
  3. Confirm row background is danger-tinted (bg-danger/10)
  4. Confirm 'View Booking <id8>' links render under the 'Cancelled' pill
  5. Click a 'View Booking' link
- **API:** `GET /admin/leaves?limit=100`
- **Expect:** Cancelled row is highlighted; one link per cancelled booking id, label shows first 8 chars; clicking navigates to /orders/<full-booking-id>. Other outcomes (reassigned=success, partially_reassigned=warning, none=neutral) show the correct pill tone and NO booking links.

#### `LV-21` Auto-refresh every 60s  — **P2** · _edge_
- **Pre:** Logged in as admin on /leaves.
- **Steps:**
  1. Open /leaves and watch Network tab
  2. Wait ~60s without interacting
  3. Insert/modify a pro_leave in DB during the wait
- **API:** `GET /admin/leaves?limit=100 (repeats every 60s)`
- **Expect:** leavesQ has refetchInterval 60_000, so a new GET fires ~every minute and the new/changed row appears without manual reload. keepPreviousData prevents flicker. Balances query has NO refetchInterval, so a balance change only appears after an allocate (which invalidates) or manual reload — confirm the strip does NOT auto-refresh on the 60s cadence.

#### `LV-23` Large allocate value  — **P2** · _edge_
- **Pre:** Admin JWT. FE input caps max=31; API has no upper bound.
- **Steps:**
  1. UI: try to type 999 in the Allocate input (observe max=31 attribute)
  2. API: POST {"days":100000}
- **API:** `POST /admin/pro/<proId>/leave/allocate body {"days":100000}`
- **Expect:** UI input has max=31 (browser may still allow typing larger; the onChange does not re-clamp the upper bound — only Math.max(1,..) on the lower). API accepts 100000 and adds it (no server-side ceiling), balance jumps by 100000. Document that there is no upper bound enforced server-side.

### analytics  <sub>(15 flows — P0:3 P1:6 P2:6)</sub>

Read-only analytics reporting surface: one CRM page (AnalyticsPage) renders 7 summary stat cards plus 4 charts/tables (revenue/day bar, orders/day line, signups/day line, by-category table) driven by 5 GET endpoints under /admin/analytics, all gated by the lowest permission (analytics.read = viewer) and served from the dedicated read pool. A separate health-metrics endpoint (/admin/health/metrics, healthmetrics.read = viewer) returns in-memory request latency/error-rate aggregates plus an upstream uptime probe. No writes, no money mutations, no idempotency — but money is reported (paise) and two endpoints compute revenue against different timestamp columns, creating a reconciliation hazard.

**Pages:** `/analytics` · `n/a (support module)` · `n/a (backend handler)` · `n/a (backend handler)` · `n/a (backend support)` · `n/a (router)`

**Test data:** A CRM admin account at role 'viewer' (analytics.read minimum) to confirm allow-path, and one account with an unknown/empty role (or a hand-crafted token with an invalid role claim) to confirm the 403 deny-path.; bookings rows with mixed status ('completed','cancelled', and others) spanning the last 90 days, with amount_paise populated (int64 paise).; At least one completed booking whose created_at is OUTSIDE a 30-day window but completed_at is INSIDE it (and one with the reverse) to expose the summary-vs-chart revenue mismatch (AN-P1-03).; Two completed bookings straddling IST midnight (completed_at 23:50 IST one day, 00:10 IST next day) to verify Asia/Kolkata day bucketing (AN-P2-06).; users rows with role 'customer' and role 'pro', some with deleted_at set (must be excluded from signups/new-user counts) and some null, created within range.; service_categories rows linked to bookings via service_category_id, plus at least one booking with NULL service_category_id (renders as '—' category), and one category with only cancelled bookings (AN-P2 by-category test).; An empty date range / fresh DB state (or future from/to) to exercise empty-state vs flat-zero rendering (AN-P1-04).; A way to break the read pool (e.g. CRM_DATABASE_READ_URL pointing at a DB without the bookings table, or stopping the DB post-login) to exercise the 500-as-empty-data bug (AN-P1-11).; cfg.AppAPIURL configurations: (a) reachable /health returning 2xx, (b) unreachable/5xx host, (c) empty string — to cover uptime up/down/unknown (HM tests).; Redis running so the per-admin 60/min rate limiter is exercisable (AN-P2-12); ability to send >60 requests/min on one admin token.

#### `AN-P0-01` Happy path: load Analytics with default 30d range  — **P0** · _happy_
- **Pre:** Logged in as any admin role (viewer or higher). Backend running on :8090, CRM on :5174. DB has at least a few bookings (some completed, some cancelled) and users (role customer and pro) created within the last 30 days.
- **Steps:**
  1. Log in to the CRM at http://localhost:5174
  2. Navigate to the Analytics page (sidebar 'Analytics' link, route /analytics)
  3. Observe the 7 KPI stat cards at the top render real numbers (Orders, Completed, Revenue, Avg order, New customers, New pros, Cancelled)
  4. Observe the 'Revenue / day' bar chart, 'Orders / day' line, 'Signups / day' line, and 'By category' table all render
  5. Confirm the 30d preset button is highlighted by default
- **API:** `GET /admin/analytics/summary?from=...&to=...`, `GET /admin/analytics/revenue-daily?from=...&to=...`, `GET /admin/analytics/orders-daily?from=...&to=...`, `GET /admin/analytics/signups-daily?from=...&to=...`, `GET /admin/analytics/by-category?from=...&to=...`
- **Expect:** All 5 requests return 200. Stat cards show integers/rupee strings (Revenue and Avg order formatted as ₹ via formatRupees). Charts render bars/lines with one point per day in range. By-category table lists categories sorted by order count descending. No console errors, no '—' placeholders where data exists.

#### `AN-P0-02` Date-range preset switching (7d / 30d / 90d) refetches all panels  — **P0** · _happy_
- **Pre:** Logged in; data spanning >90 days ideally so each preset shows a different total.
- **Steps:**
  1. On /analytics, click the '7d' preset button
  2. Watch all 4 charts + 7 stat cards reload (skeletons may flash)
  3. Click '90d'
  4. Compare: 90d totals should be >= 30d totals >= 7d totals (monotonic for cumulative-style metrics like Orders)
  5. Open browser devtools Network tab and confirm each click fires 5 fresh requests with updated from/to query params
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/revenue-daily`, `GET /admin/analytics/orders-daily`, `GET /admin/analytics/signups-daily`, `GET /admin/analytics/by-category`
- **Expect:** Each preset click issues 5 new requests (react-query keys include `days`, so cache is per-preset). from = now - days*86400000 ms, to = now, both ISO8601. 7d chart shows ~8 day-buckets, 30d ~31, 90d ~91 (see suspected off-by-one bug). Totals scale up with the range.

#### `AN-P0-09` Unauthenticated / expired-session access is rejected  — **P0** · _negative_
- **Pre:** A valid admin session that you then revoke/expire, OR no token at all.
- **Steps:**
  1. Open devtools, copy a valid request to /admin/analytics/summary
  2. Replay it with no Authorization header
  3. Replay it with a Bearer token whose session has been logged out / revoked (log out in another tab, then replay)
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/revenue-daily`
- **Expect:** No header -> 401 {"error":"authentication required"}. Revoked/expired session -> 401 (sessionStillActive query returns false: revoked_at not null or expires_at <= now). In the SPA, the axios client should surface this (redirect to login or toast). Confirm the page does not render stale data after logout.

#### `AN-P1-03` Revenue card vs Revenue/day chart reconciliation (money-correctness)  — **P1** · _money_
- **Pre:** Logged in. Seed bookings that are completed where completed_at falls in range but created_at falls OUTSIDE the range (e.g. created 40 days ago, completed yesterday), and vice versa (created in range, completed after `to`). Use the 30d preset.
- **Steps:**
  1. On /analytics with 30d selected, read the 'Revenue' stat card value
  2. Sum the bars in the 'Revenue / day' chart (hover each bar; tooltip shows ₹ per day)
  3. Compare the two totals
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/revenue-daily`
- **Expect:** BUG EXPECTATION: they will NOT match. Summary.revenue_paise filters completed bookings by created_at in [from,to] (analytics.go:136-139), while RevenueDaily filters completed bookings by completed_at in each day bucket (analytics.go:54-58). A completed booking created before the window but completed inside it appears in the chart but not the card (and vice versa). Pass criterion for QA: file the discrepancy; the 'Revenue' card and chart total should agree but don't.

#### `AN-P1-04` Empty-state rendering when no data in range  — **P1** · _edge_
- **Pre:** Logged in as a fresh/empty tenant OR pick a date range with zero activity. Easiest repro: a brand-new DB with no bookings/users, or temporarily set ?from/?to far in the future via direct API.
- **Steps:**
  1. On /analytics, ensure the selected range contains no bookings/users (or hit the API directly with a future from/to)
  2. Observe the chart cards
  3. Observe the By category card
- **API:** `GET /admin/analytics/revenue-daily`, `GET /admin/analytics/orders-daily`, `GET /admin/analytics/signups-daily`, `GET /admin/analytics/by-category`, `GET /admin/analytics/summary`
- **Expect:** Charts show 'No data in range' empty state. By-category shows 'No data'. NOTE: revenue-daily/orders-daily/signups-daily still return one zero-valued point per day (generate_series produces buckets even with no rows), so `points.length` is NOT 0 — the chart will render flat-zero bars/lines, NOT the EmptyState. Only by-category (which has no day scaffold) truly returns empty. QA should verify whether 'empty' is correctly detected: revenue/orders/signups will likely show a flat zero chart rather than EmptyState because length > 0. Summary cards show 0 / ₹0.

#### `AN-P1-08` Invalid / malformed from/to query params are silently ignored  — **P1** · _negative_
- **Pre:** Logged in. Use devtools or a REST client with a valid admin bearer token.
- **Steps:**
  1. Call GET /admin/analytics/summary?from=garbage&to=also-garbage with a valid token
  2. Call GET /admin/analytics/summary?from=2026-13-45T99:99:99Z
  3. Call GET /admin/analytics/revenue-daily?from=2026-06-01T00:00:00%2B05:30&to=2026-05-01T00:00:00%2B05:30 (from AFTER to — reversed range)
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/revenue-daily`
- **Expect:** Malformed RFC3339 values are silently discarded (parseRange only overrides defaults when time.Parse succeeds), so the endpoint falls back to default last-30d and returns 200 — NOT a 400. QA note: no input validation / no 4xx on bad dates. For the reversed range (from>to), revenue-daily's generate_series(from_trunc, to_trunc) with start>stop yields ZERO rows -> empty points array -> chart EmptyState; summary's WHERE created_at>=from AND <=to yields zero matches -> all-zero summary. No error, no toast. Document this as lenient/silent behavior.

#### `AN-P1-10` RBAC: lower/unknown role is blocked from analytics  — **P1** · _rbac_
- **Pre:** Two admin accounts: one with role 'viewer' (should be ALLOWED — analytics.read minimum is viewer), and one whose role is empty/unknown or not in roleRank (should be DENIED). To exercise denial, you need an account whose crmAdminRole is unset or a value outside {viewer,support,admin,superadmin}.
- **Steps:**
  1. Log in as the 'viewer' account, open /analytics — confirm it loads (viewer is the minimum role for analytics.read)
  2. Log in as an account with an unknown/empty role (or craft a token with an invalid role claim) and call GET /admin/analytics/summary
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/by-category`, `GET /admin/health/metrics`
- **Expect:** Required role = viewer (lowest). Therefore EVERY normal authenticated admin (viewer/support/admin/superadmin) is allowed — there is no normal lower role to block. Denial only occurs for an unknown/empty role: HasPermission returns false (role not in roleRank) -> 403 {"error":"insufficient_permissions","required_role":"viewer","your_role":""}. QA note: analytics is effectively readable by all roles incl. viewer; the only enforceable negative case is malformed role. Verify the SPA surfaces the 403 (toast / error state) rather than rendering blank silent charts.

#### `AN-P1-11` Backend 500 surfacing (read-pool query failure)  — **P1** · _negative_
- **Pre:** Ability to induce a query error — e.g. point CRM_DATABASE_READ_URL at a DB missing the bookings/service_categories tables, or stop the read replica/DB after login.
- **Steps:**
  1. With a valid session, stop or break the read pool DB connection
  2. Reload /analytics
  3. Observe the UI behavior for each panel
- **API:** `GET /admin/analytics/summary`, `GET /admin/analytics/revenue-daily`, `GET /admin/analytics/by-category`
- **Expect:** Endpoints return 500 {"error":"internal error"} (jsonOrErr logs '[crm.analytics] query failed' and returns 500). Frontend: react-query queries enter error state. CHECK whether the page surfaces this — AnalyticsPage only branches on isLoading and empty, NOT on isError; on error, summary.data is undefined so stat cards show stuck skeletons, and charts show empty/loading=false with data ?? [] -> EmptyState 'No data in range'. So a 500 is mis-rendered as 'No data', NOT an error toast. Flag as a UX bug: failures masquerade as empty data.

#### `HM-P1-13` Health metrics endpoint happy path + uptime probe  — **P1** · _happy_
- **Pre:** Logged in (any role >= viewer). AppAPIURL configured (cfg.AppAPIURL) pointing at a reachable /health, or empty.
- **Steps:**
  1. Navigate to wherever getHealthMetrics is consumed (health strip / dashboard) OR call GET /admin/health/metrics directly with a valid token
  2. Inspect avg_latency_ms, error_rate, request_count, uptime, app_url, checked_at
- **API:** `GET /admin/health/metrics`
- **Expect:** 200 with JSON: avg_latency_ms (int), error_rate (0.0-1.0, counts only status>=500 over last 5 min), request_count (int), uptime 'up'|'down'|'unknown' (unknown if app_url empty; up if probe /health returns 2xx; down on error/non-2xx), app_url echoed, checked_at RFC3339 UTC. Probe runs synchronously with a 3s timeout.

#### `AN-P2-05` Zero / large value rendering on stat cards  — **P2** · _edge_
- **Pre:** Logged in. Range where some metrics are 0 (e.g. zero cancelled orders) and revenue is large (>₹10,00,000 to test Indian-locale grouping).
- **Steps:**
  1. Select a range with at least one large revenue total and a zero in some metric (e.g. Cancelled = 0)
  2. Inspect each stat card value
- **API:** `GET /admin/analytics/summary`
- **Expect:** Zero values render literal '0' (not '—' and not a stuck skeleton — `value ?? Skeleton` only swaps on null/undefined, and 0 is neither). Revenue/avg render with Indian comma grouping via toLocaleString('en-IN'), e.g. ₹12,34,567, fractional paise dropped (maximumFractionDigits:0). No ₹NaN.

#### `AN-P2-06` Boundary date / timezone correctness (IST day bucketing)  — **P2** · _edge_
- **Pre:** Logged in. Seed one completed booking with completed_at at 23:50 IST on a given day and another at 00:10 IST the next day (i.e. straddling IST midnight, which is 18:20/18:40 UTC). Use 7d preset.
- **Steps:**
  1. On /analytics with 7d selected, hover the two adjacent day bars in 'Revenue / day'
  2. Verify each booking lands in its correct IST calendar day, not shifted by UTC offset
- **API:** `GET /admin/analytics/revenue-daily`, `GET /admin/analytics/orders-daily`
- **Expect:** Day buckets are computed in Asia/Kolkata (analytics.go uses AT TIME ZONE 'Asia/Kolkata' for both generate_series and the join bounds). The 23:50 IST booking shows on day N, the 00:10 IST booking on day N+1. No off-by-one-day shift. Date labels (to_char YYYY-MM-DD) reflect IST dates.

#### `AN-P2-07` Off-by-one bucket count on presets  — **P2** · _edge_
- **Pre:** Logged in. Any data. Use 30d preset.
- **Steps:**
  1. Select 30d
  2. Count the number of bars in 'Revenue / day' (or count day labels on the X axis)
- **API:** `GET /admin/analytics/revenue-daily`
- **Expect:** BUG EXPECTATION: 31 buckets appear, not 30. generate_series(date_trunc(from), date_trunc(to), '1 day') is inclusive on both ends; from=now-30d, to=now spans 31 distinct IST days. QA should note the '30d' label produces 31 day-buckets (and 7d produces 8). Low severity but a visible off-by-one.

#### `AN-P2-12` Per-admin rate limit (60/min) on analytics navigation  — **P2** · _edge_
- **Pre:** Logged in. Redis up. A script/repeated rapid reloads.
- **Steps:**
  1. Rapidly reload /analytics or hammer GET /admin/analytics/summary >60 times within 60 seconds with the same admin token
  2. Observe responses
- **API:** `GET /admin/analytics/summary`
- **Expect:** After 60 requests/min the per-admin limiter (crmAdminLimiter, bucket ratelimit:crm-admin:*) returns 429 and logs an audit 'ratelimit.exceeded' entry. Note: each page load fires 5 analytics calls + others, so heavy preset-toggling can hit the cap quickly. Verify the SPA handles 429 gracefully (does not infinite-retry).

#### `HM-P2-14` Health metrics uptime probe when upstream is down  — **P2** · _edge_
- **Pre:** Logged in. Configure AppAPIURL to a host that is down or returns 5xx (or stop the user-app).
- **Steps:**
  1. Call GET /admin/health/metrics with upstream unreachable
  2. Measure response latency and the uptime field
- **API:** `GET /admin/health/metrics`
- **Expect:** uptime = 'down'. Response is delayed up to ~3s while the probe times out (synchronous probe blocks the handler). request_count/error_rate still reflect the in-memory window. QA note: a slow/hung upstream makes the metrics endpoint itself slow (capped at 3s). Empty AppAPIURL -> uptime 'unknown' and no probe delay.

#### `HM-P2-15` Health metrics cold-start empty window  — **P2** · _edge_
- **Pre:** Backend just restarted (no requests recorded in the last 5 minutes), logged in.
- **Steps:**
  1. Immediately after backend restart, call GET /admin/health/metrics
  2. Inspect the aggregate fields
- **API:** `GET /admin/health/metrics`
- **Expect:** With zero samples in window: avg_latency_ms=0, error_rate=0, request_count=0 (Snapshot returns zero-value struct; no divide-by-zero). uptime still computed from probe. Verify no NaN and request_count grows as you make more calls within the 5-min window.
