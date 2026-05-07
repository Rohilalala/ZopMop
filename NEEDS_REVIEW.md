# Fixes deferred during overnight run

## Item 6 — growth cron panic propagation

Audit NEW-B2-001 advised re-panicking from `dispatchOne` so process-level monitoring observes the failure. dispatchOne is called serially from `Tick`; a re-panic would unwind the scheduler goroutine and block `Wait()` in `Stop()`. Re-architecting the supervisor to a per-row goroutine + error channel is a bigger change (~50+ LOC and changes shutdown semantics), so the overnight run applied the smaller observability fix: stack trace in the panic log. Wire alerting on `[crm.push.cron] SendPush panicked` in the log aggregator.

Files: `App/househelp-api/internal/crm/growth/cron.go:230-260`.

Decision when awake: keep stack-trace fix as-is, or re-architect supervisor to per-row goroutine + error channel.

## Item 9 — paise TODO comments

NEW-C2-001 calls these "stale", but the JSON tags they reference (e.g. `json:"price_cents"`) are NOT yet renamed to `amount_paise`. Removing the TODOs without renaming the tags or filing a tracking issue elsewhere destroys migration context.

Files (14 TODOs):
- internal/booking/model.go:27,30,93,95
- internal/zop/service.go:397,399
- internal/crm/users/model.go:58
- internal/crm/workers/model.go:56
- internal/admin/model.go:78,80
- internal/crm/orders/orders.go:42,44
- internal/helper/model.go:25
- internal/webhooks/payloads.go:42

Decision when awake: either (a) rename JSON tags now (breaking change, requires mobile coordinate), or (b) keep TODOs until v2 ships, or (c) move them to a tracking issue and remove inline comments.

