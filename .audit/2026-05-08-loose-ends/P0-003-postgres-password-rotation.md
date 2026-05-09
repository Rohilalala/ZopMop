# P0-003 — Postgres password leaked in chat 3x today

**Severity:** P0
**Category:** SEC
**Surfaced by:** Live observation during Railway deploy debug, 2026-05-08
**Date:** 2026-05-08

## Summary

The production Postgres password (PostGIS service on Railway) was pasted in
plain text three times during today's deploy debugging session — twice in
terminal commands shown to the assistant, once via `pbpaste | head` for
clipboard verification. The chat conversation now contains the live
production credential. Rotation is overdue. Fix: regenerate
`POSTGRES_PASSWORD` in Railway, let services auto-redeploy with new value.
~2 min.

## Finding

During today's Railway deploy session, the assistant repeatedly asked the
user to paste the `DATABASE_PUBLIC_URL` for migration commands. The shell-
quoting trick used (`DATABASE_URL='<paste>' /tmp/migrate up`) makes the URL
appear in scrollback and in pasted command output sent to the assistant.

Three exposures occurred:
1. First migrate command: full URL with password pasted in command
2. After the first failed migration: same URL re-pasted to retry
3. Diagnostic `pbpaste | head -c 50` printed the first 50 chars of clipboard,
   exposing the password prefix

The leaked URL contains:
- Username: `postgres`
- Password: 32-char random string (visible)
- Host: `turntable.proxy.rlwy.net:47710`
- Database: `railway`

Anyone with read access to this conversation history (assistant logs,
Anthropic systems, or anyone the user shares the chat with) can connect
directly to the production database.

## Evidence

Conversation history of 2026-05-08 contains the password in at least three
turn pairs. No need to re-derive — the user is already aware.

## Blast Radius

**Today (no real users yet):**
- An attacker with the URL can connect to Postgres
- Read all 18 service categories (already public via `/api/v1/services`)
- Read empty users/bookings/payments tables (no real data yet)
- DROP TABLES, replace seed data, or hold the DB ransom
- Recreate-from-scratch is feasible — minor inconvenience

**Once launched with real users:**
- Direct access to PII: phone numbers, addresses, payment records
- DPDP §6/§8 violations (data fiduciary obligations)
- Wallet balance manipulation
- Identity theft material
- Catastrophic, recoverable only via full incident response

## Reproduction

Connection from anywhere with internet:
```
psql 'postgres://postgres:<leaked-password>@turntable.proxy.rlwy.net:47710/railway'
\dt
SELECT * FROM users LIMIT 5;
```

## Fix Plan

### Step 1: Rotate the password (NOW)

In Railway dashboard:
1. Click PostGIS service tile
2. Variables tab
3. Find `POSTGRES_PASSWORD`
4. Click 3-dot menu (⋮) → "Regenerate" if available
5. If only "Edit": generate new password locally:
   ```bash
   openssl rand -base64 32 | tr -d '/=+' | head -c 32
   ```
   Paste as new value. Save.

Railway will:
- Update the Postgres database with the new password
- Auto-redeploy ZopMop service (which references `${{PostGIS.DATABASE_PRIVATE_URL}}`)
- Old password becomes useless within ~30 seconds

### Step 2: Verify new state

```bash
# Wait 60 sec for Railway redeploys to settle
curl https://zopmop-production.up.railway.app/health
# Should still be 200 OK
```

If 200, ZopMop reconnected successfully with new password.

### Step 3: Test old password is dead

```bash
psql 'postgres://postgres:<OLD-leaked-password>@turntable.proxy.rlwy.net:47710/railway' -c 'SELECT 1'
# Should fail: password authentication failed
```

If fails, old credential is dead. Confirmed safe.

### Step 4: Document the lesson for future deploys

For future operations that need DATABASE_URL:
- Set as a temporary local env var: `export DATABASE_URL='...'` in a SCRATCH
  shell that you close after
- Or use Railway CLI's `railway run` which injects env vars without
  printing them
- Never paste the URL in a command that gets sent to an assistant
- Never run `pbpaste` for debug if clipboard contains secrets

## Recommendation

**Step 1 immediately.** Steps 2-3 within 5 minutes of step 1. Step 4 is a
write-up for future-you.

## Effort

- Rotation: 30 seconds
- Verification: 2 minutes
- Documentation: 5 minutes (when feeling diligent)

**Total: 2-10 minutes.**

## Dependencies

None. Self-contained.

## Acceptance Criteria

- New `POSTGRES_PASSWORD` set in Railway PostGIS service
- ZopMop `/health` returns 200 after auto-redeploy completes
- Old leaked password fails authentication when tested
- Conversation history is documented as containing dead credentials only

## Related

- Future audit pattern: when an assistant asks for credentials, push back
  and use Railway CLI `railway run` instead of paste-into-command. The
  `railway run` flow keeps secrets in env vars not visible in scrollback.

## Anchor

No code changes — operational fix only. No git tag needed.
