# Deploy manifests

## retention-cronjob.yaml

Daily CronJob that runs `cmd/retention-worker` to enforce the per-table
DPDP/GDPR retention policies registered in `internal/compliance/policies.go`.

### Schedule
`0 3 * * *` — 03:00 in cluster timezone. If the cluster is UTC, change to
`30 21 * * *` so the sweep runs at 03:00 IST.

### Concurrency
`Forbid` — never run two retention sweeps in parallel. The worker uses
`SELECT ... FOR UPDATE SKIP LOCKED` per-batch but a second concurrent
process would still contend on the same rows and waste DB capacity.

### History
3 successful jobs kept, 7 failed jobs kept. Failed jobs surface in
`kubectl get jobs` and the pod logs are retained until the next failed
run rolls them out.

### Dry run
For a first deploy, change `command: ["/app/bin/retention-worker"]` to
`command: ["/app/bin/retention-worker", "-dry-run"]`. The worker logs
what it WOULD delete without actually issuing the DELETE. Compare the
counts against expectations (e.g. `helper_status_log` rows older than
90 days, `crm_login_attempts` rows older than 90 days, etc.) before
flipping back to non-dry-run.

### Validating after the first non-dry-run
1. `kubectl logs -l job-name=<job>` — see per-policy delete counts.
2. Confirm `crm_audit_log` has no rows older than 3 years (or the
   configured window).
3. Confirm `bookings.address` is NULL on rows where
   `completed_at < NOW() - 7y` AND `customer_id = TombstoneUserID`
   (anonymised, not deleted).

### Image
Assumes `zopmop/api:latest` contains both `cmd/api` and
`cmd/retention-worker` binaries under `/app/bin/`. The Dockerfile
multi-stage `RUN go build ./...` produces both.

### Secrets
`zopmop-secrets` Secret must contain `database-url` and (optionally)
`redis-url`. Redis is used only for the helper-location residue purge
in a different code path — the retention worker itself does not touch
Redis. The env var is wired so future expansion can read it without a
manifest change.
