# crm-api

Standalone Zopmop CRM admin backend. Runs as its own process on its own port,
with its own DB connection pool and JWT secret. The user-facing app
(`cmd/api`) is unaffected by anything that happens here.

## Required env vars

| Var | Default | Notes |
|---|---|---|
| `CRM_API_PORT` | `8090` | Listen port. |
| `DATABASE_URL` | _required_ | Same DSN as the user app — shared schema. |
| `CRM_DATABASE_READ_URL` | _falls back to `DATABASE_URL`_ | Read replica for analytics. |
| `REDIS_URL` | _required_ | Shared Redis. |
| `CRM_REDIS_NAMESPACE` | `crm:` | Key prefix for CRM-only Redis state. |
| `CRM_DB_POOL_MAX_CONNS` | `15` | Capped low so CRM cannot starve user-app pool. |
| `CRM_JWT_SECRET` | _required_ | **Must differ from `JWT_SECRET`.** ≥64 chars. |
| `CRM_JWT_SECRET_ID` | `crm-active` | `kid` header value. |
| `CRM_JWT_PREVIOUS_SECRETS` | _empty_ | Comma-separated `key_id:secret` rotation set for verifying tokens signed with previously-active secrets. Issuance always uses `CRM_JWT_SECRET`. Mirrors `JWT_PREVIOUS_SECRETS` for the user-API. Example: `v1:abc...64chars,v2:def...64chars`. |
| `CRM_ACCESS_TOKEN_TTL_MINUTES` | `240` | 4 hours per spec. |
| `CRM_REFRESH_TOKEN_TTL_HOURS` | `720` | 30 days. |
| `CRM_TOTP_ISSUER` | `Zopmop CRM` | Shown in Google Authenticator. |
| `CRM_REFRESH_COOKIE_DOMAIN` | _empty_ | e.g. `.zopmop.com` in prod. |
| `CRM_REFRESH_COOKIE_SECURE` | `true` | Set to `false` for local http dev. |
| `CRM_ALLOWED_ORIGINS` | _empty_ | Comma-separated; e.g. `https://crm.zopmop.com`. |
| `CRM_LOCKOUT_THRESHOLD` | `5` | Failed logins before lockout. |
| `CRM_LOCKOUT_DURATION_MINUTES` | `15` | Lockout window. |

## Running

```bash
go build ./cmd/crm-api/
./crm-api
```

## Bootstrapping the first admin

The migrations create empty `crm_admins`. Insert the first row manually:

```bash
# 1. Pick a strong password and generate a bcrypt hash.
go run ./cmd/crm-api/bootstrap -email you@zopmop.com -name "You" \
  -password 'somethingStrong' > /dev/null
# (the bootstrap helper prints the SQL; pipe to psql when ready)
```

Or run the SQL directly:

```sql
INSERT INTO crm_admins (email, password_hash, display_name, role, permissions, is_active)
VALUES (
  'you@zopmop.com',
  '<bcrypt hash from any tool, cost 12>',
  'You',
  'superadmin',
  '["*"]'::jsonb,
  TRUE
);
```

The first time this admin logs in, the system generates a TOTP secret and
returns the `otpauth://` URL in the login response so the SPA can render a
QR code for Google Authenticator.

## Endpoints (so far)

- `GET  /health`, `GET /ready`
- `POST /admin/auth/login`
- `POST /admin/auth/totp/verify`
- `POST /admin/auth/refresh`
- `POST /admin/auth/logout`
- `GET  /admin/auth/me`            *(authed)*
- `GET  /admin/auth/sessions`      *(authed)*
- `DELETE /admin/auth/sessions/:id` *(authed)*
- `GET  /admin/dashboard/kpis`     *(authed)*
- `GET  /admin/dashboard/live-orders` *(authed)*
- `GET  /admin/dashboard/revenue-7d` *(authed)*
- `GET  /admin/dashboard/category-share` *(authed)*
- `GET  /admin/flags`              *(authed)*
- `PUT  /admin/flags/:key`         *(authed)*
- `GET  /admin/flags/snapshots`    *(authed)*
- `POST /admin/flags/snapshots/:id/rollback` *(authed)*
- `GET  /admin/alerts`             *(authed)*
- `POST /admin/alerts/read-all`    *(authed)*
