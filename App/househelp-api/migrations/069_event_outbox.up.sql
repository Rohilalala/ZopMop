-- 069_event_outbox.sql
-- Transactional outbox for side-effect events emitted from payment-webhook
-- handlers and other write paths. Producers insert in the same DB transaction
-- that mutates the source-of-truth row; downstream consumers (a future
-- drainer worker) drain the table and dispatch.
--
-- Only the table is in scope here — no drainer, no dispatcher. When a real
-- subscriber lands (CRM swap, analytics pipeline, etc.) we will write the
-- drainer at that point and decide between an in-process goroutine, a
-- separate Go binary, or pushing onto Redis Streams / NATS / a hosted bus.
-- The drainer / retry / reclaim / metrics pattern lives on the archived
-- branch `archive/booking-side-effects-outbox` and will be ported when
-- needed.
--
-- Columns:
--   event_type     — e.g. 'booking.paid', 'wallet.topped_up'
--   version        — payload schema version; consumers branch on this
--                    instead of sniffing JSON. Defaults to 'v1'; bump when
--                    payload shape changes incompatibly.
--   aggregate_id   — id of the source row (booking, payment, user, …)
--   payload        — JSONB blob, schema-versioned
--   status         — 'pending' on insert, 'processing' while a drainer
--                    holds it, 'done' after successful dispatch, 'failed'
--                    after all retries are exhausted (terminal).
--   attempt_count  — increments on each drainer attempt (success or fail).
--   available_at   — drainer must NOT pick up the row before this time.
--                    Defaults to NOW() so freshly-inserted rows are eligible
--                    immediately. On failure the drainer pushes this forward
--                    by backoff(attempt_count) before flipping status back
--                    to 'pending'.
--   last_error     — message from last failed dispatch, NULL on success.
--   done_at        — set when status flips to 'done'. NULL otherwise.

CREATE TABLE IF NOT EXISTS event_outbox (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT         NOT NULL,
  version       TEXT         NOT NULL DEFAULT 'v1',
  aggregate_id  UUID         NOT NULL,
  payload       JSONB        NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','failed')),
  attempt_count INT          NOT NULL DEFAULT 0,
  available_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_error    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  done_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_pending_scan
  ON event_outbox (status, available_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_event_outbox_aggregate
  ON event_outbox (aggregate_id, event_type, created_at DESC);
