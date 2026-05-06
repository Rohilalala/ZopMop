# Database Migrations

## Tooling

[golang-migrate/migrate](https://github.com/golang-migrate/migrate) v4.
CLI binary at `cmd/migrate`.

## Naming convention

```
NNN_description.up.sql
```

Where `NNN` is a zero-padded 3-digit monotonically-increasing number.
CI rejects any other pattern (see `.github/workflows/migrations.yml`).

**Forward-only.** No `.down.sql` files. To undo a change, write a new
corrective migration. Down migrations rot fast — by the time you need
to roll back, the data has changed and the "down" SQL is wrong.

## Daily use

Build the binary:

```sh
cd App/househelp-api
go build -o bin/migrate ./cmd/migrate
```

Apply pending migrations:

```sh
DATABASE_URL=postgres://... ./bin/migrate up
```

Check current version:

```sh
./bin/migrate version
```

Apply only N migrations (testing one at a time):

```sh
./bin/migrate up --steps 1
```

## First-deploy procedure (one-time per environment)

Production / staging DBs that pre-date the runner already have all
migrations applied at the schema level but lack a `schema_migrations`
tracking table. Use `baseline` to mark them as applied:

```sh
DATABASE_URL=postgres://... ./bin/migrate baseline
```

This creates `schema_migrations` and forces version=79 (highest
existing migration as of chunk 19). Idempotent — re-running is safe
and prints `already at version 79 (no-op)`.

After baseline, normal `migrate up` flow applies new migrations from
version 80 onward.

Order matters on first deploy:

1. Deploy code that's compatible with current schema.
2. Run `migrate baseline` (one-shot).
3. From here, every deploy: `migrate up` then start new code.

## Adding a new migration

1. Pick the next number:

   ```sh
   ls migrations/ | sort | tail -3
   ```

2. Create `migrations/NNN_description.up.sql` with the next number.
3. Use `IF NOT EXISTS` / `IF EXISTS` defensively. Idempotent
   migrations let you re-run without fear if `migrate force` is
   ever used to recover from a dirty state.
4. Test locally:

   ```sh
   ./bin/migrate up
   ```

5. Commit with the rest of your feature.

## Concurrency / locking

`golang-migrate` uses a Postgres advisory lock
(`pg_try_advisory_lock`) under the hood. Two `migrate up` invocations
against the same DB can't fight: one acquires, the other blocks until
release. No additional setup.

## Emergency: force a version

Only when the runner reports `dirty` (a migration crashed mid-run and
left `schema_migrations.dirty=true`). Inspect manually first; fix the
schema state by hand if needed; then:

```sh
./bin/migrate force --version 80
```

This sets `schema_migrations.version` and `dirty=false` without
running anything. Subsequent `migrate up` resumes from there.

## CLI-only by design

`cmd/api` and `cmd/crm-api` do **not** auto-migrate at boot. Two
failure modes that boot-time integration causes at scale:

- Two API instances starting at the same time race the lock; the loser
  blocks long enough that its readiness probe fails and the orchestrator
  recycles it, sometimes mid-migration.
- A long migration trips the readiness probe on the lone instance
  driving it.

Migrations run as a deliberate deploy step (CI/CD job, manual ops
runbook, or a sidecar k8s Job). The API binaries assume the schema
is at the right version; if it isn't, they fail loudly on the first
query rather than silently running stale code against a new schema.

## History

Chunk 19 (audit B5-D7) introduced the runner. Resolved three
duplicate prefixes by renumbering the alphabetically-later file in
each pair to 077 / 078 / 079:

| Old | New |
|---|---|
| `049_users_privacy_policy.sql` | `077_users_privacy_policy.up.sql` |
| `057_reviews.sql` | `078_reviews.up.sql` |
| `058_seed_ncr_zones.sql` | `079_seed_ncr_zones.up.sql` |

All other 76 files renamed `*.sql` → `*.up.sql`. Existing DBs were
not affected at the schema level — the rename is filename-only.
