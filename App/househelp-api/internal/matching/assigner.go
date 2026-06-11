package matching

// Unified just-in-time assigner (spec §5). Replaces the three legacy dispatch
// pipelines (5 s batcher, nightly 22:00 cron, stealth cron) and the offer/accept
// invite chain with ONE force-assigner:
//
//   - ClaimDue        — claims pending rows due within dispatchLeadMin of their
//                       scheduled_time (now() >= scheduled_time - lead), one at a
//                       time, FOR UPDATE SKIP LOCKED, retrying stale claims every
//                       tick. Mirrors scheduled_dispatch.go:claimNext.
//   - EligibleCandidates — ONE set-based SQL covering every eligibility gate for
//                       the whole locality pool, ordered shift-end-soonest, with
//                       preferred pros pulled to the front in Go.
//   - TravelFeasible  — per-candidate Google Maps walking-ETA check with a short
//                       in-process TTL cache; fail-open to the travel buffer when
//                       Maps / live location are unavailable (dispatch must never
//                       stall on Google).
//   - Assign          — atomic UPDATE … WHERE helper_id IS NULL AND status='pending'
//                       under a per-pro advisory lock; pushes pro + customer and
//                       writes the booking.accepted outbox row.
//   - AssignOne       — load → candidates → first travel-feasible candidate wins;
//                       (nil, ErrNoEligiblePro) when none qualify.
//
// Pros never accept or decline — work is force-assigned into their committed
// shift window (pilot). The assigner reuses dispatch.go helpers
// (loadBooking shape, pushCustomerAccepted, helperName).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/googlemaps"
)

// ErrNoEligiblePro is returned by AssignOne when no candidate clears every gate
// (eligibility + travel feasibility). The cron driver decides what to do with it
// (retry next tick before the slot, terminal no-pros-found at/after the slot).
var ErrNoEligiblePro = errors.New("no eligible pro for booking")

// staleClaimAge is how long a claimed-but-still-pending row waits before another
// tick re-claims it. The cron ticks every 60 s; 55 s means a row a previous tick
// stamped but failed to place is retried on the very next tick rather than
// sitting idle. (One-shot "matched_at IS NULL" claiming — the nightly model —
// would never retry, which is wrong for a JIT retry loop.)
const staleClaimAge = 55 * time.Second

// travelCacheTTL bounds how long a cached walking ETA is reused. Pros barely
// move between ticks, so repeat candidate checks within the window are cache
// hits instead of Maps calls (spec §6).
const travelCacheTTL = 2 * time.Minute

// assignerNotifier is the notification surface the assigner needs: data-only
// pushes (customer copy, mirrors dispatch.go's notifier) plus an alerting push
// with a title/body for the pro's "New job" tray notification. Both are
// satisfied by *notification.Service (SendData / SendToProByID).
type assignerNotifier interface {
	SendData(ctx context.Context, userID string, data map[string]string) error
	SendToProByID(ctx context.Context, proID, title, body string, data map[string]string) error
}

// Assigner is the unified JIT dispatcher. Construct with NewAssigner.
type Assigner struct {
	db            *pgxpool.Pool
	rdb           *redis.Client
	notifications assignerNotifier
	experts       expertsLookup
	maps          *googlemaps.Client
	cfg           func(context.Context) DispatchConfig

	travel *travelCache
}

// NewAssigner constructs an Assigner. Pass nil notifications/maps to no-op those
// sides (handy in tests — a nil maps client triggers the fail-open travel path).
// cfg supplies a fresh DispatchConfig snapshot per call so config edits take
// effect without a restart; a nil cfg falls back to the hardcoded defaults.
func NewAssigner(
	db *pgxpool.Pool,
	rdb *redis.Client,
	notif assignerNotifier,
	exp expertsLookup,
	maps *googlemaps.Client,
	cfg func(context.Context) DispatchConfig,
) *Assigner {
	if cfg == nil {
		cfg = func(context.Context) DispatchConfig { return LoadDispatchConfig(context.Background(), nil) }
	}
	return &Assigner{
		db:            db,
		rdb:           rdb,
		notifications: notif,
		experts:       exp,
		maps:          maps,
		cfg:           cfg,
		travel:        newTravelCache(),
	}
}

// AssignResult is the success payload of AssignOne — what the synchronous ASAP
// path (Task 5) needs to build the customer's arrival promise. Defined here (not
// in booking) so the booking service can depend on matching via a narrow
// interface without an import cycle.
type AssignResult struct {
	HelperID   string
	HelperName string
	EtaMin     int
}

// assignerBooking is the projection the assigner needs to place a booking:
// timing for the lead/slot math, destination coords + locality for eligibility
// and the Maps ETA, and the duration that drives the padded clash window.
type assignerBooking struct {
	ID              string
	CustomerID      string
	ScheduledTime   time.Time
	DurationMinutes int
	Locality        *string
	Lat             float64
	Lng             float64
}

// Candidate is one eligible pro returned by EligibleCandidates, already
// stripped down to what ordering + travel need.
type Candidate struct {
	ID          string
	ShiftEndsAt time.Time
	HasLocation bool // a live Redis GEO position exists → nearest-first is meaningful
}

// ── ClaimDue ────────────────────────────────────────────────────────────────

// ClaimDue claims the next due, unassigned, paid booking via a CTE, one row at a
// time. Mirrors scheduled_dispatch.go:claimNext but with the JIT window and a
// retry-friendly claim:
//
//   - due when now() >= scheduled_time - leadMin (vs the nightly 6h–30h window);
//   - re-claims a row whose matched_at is stale (< now() - staleClaimAge) so a
//     tick that stamped but failed to place a booking retries it next tick,
//     instead of the nightly one-shot "matched_at IS NULL" that never retries;
//   - keeps the payment gate (Cashfree-pending unpaid rows stay hidden) and
//     FOR UPDATE SKIP LOCKED so multiple instances share the load.
//
// Returns ok=false (no error) when nothing is due.
func (a *Assigner) ClaimDue(ctx context.Context) (bookingID string, ok bool, err error) {
	leadMin := a.cfg(ctx).LeadMin

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `
		WITH claimed AS (
			SELECT id
			FROM   bookings
			WHERE  status         = 'pending'
			  AND  helper_id      IS NULL
			  AND  scheduled_time IS NOT NULL
			  AND  now() >= scheduled_time - make_interval(mins => $1::int)
			  AND  (matched_at IS NULL OR matched_at < now() - make_interval(secs => $2::int))
			  AND  (payment_method IS DISTINCT FROM 'cashfree' OR payment_status = 'paid')
			ORDER BY scheduled_time ASC
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		UPDATE bookings b
		SET    matched_at = now()
		FROM   claimed
		WHERE  b.id = claimed.id
		RETURNING b.id::text
	`, leadMin, int(staleClaimAge.Seconds()))
	if err := row.Scan(&bookingID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return bookingID, true, nil
}

// ── EligibleCandidates ──────────────────────────────────────────────────────

// EligibleCandidates returns every pro in the booking's locality pool that
// clears all of dispatch.go:checkEligibility's gates, in ONE set-based query
// (spec §5.3) — active/approved, not on leave that IST date, no padded-window
// clash (GiST `&&` probe against idx_bookings_helper_window_gist), live shift
// session, remaining shift runway >= duration + travel buffer, zone/locality
// match (pro_zone_assignments with the helpers.locality fallback).
//
// Survivors come back ORDER BY shift end_time ascending (soonest-expiring
// capacity first — spec §5.2). Preferred pros (experts.PreferredHelperIDs) are
// then pulled to the front in Go, preserving the preferred order. excludeProID
// (a re-dispatch exclusion after a pro cancel/leave) is dropped.
func (a *Assigner) EligibleCandidates(ctx context.Context, b *assignerBooking, excludeProID string) ([]Candidate, error) {
	cfg := a.cfg(ctx)
	pad := cfg.TravelBufferMin
	scheduledDate := b.ScheduledTime.In(istLocation()).Format("2006-01-02")

	// Padded window upper bound built the SAME way as the GiST index expression
	// (132_assigner_indexes.up.sql): add the pad in the UTC wall-clock domain so
	// the && probe hits the index. duration + pad mirrors capacityTravelPadMin.
	rows, err := a.db.Query(ctx, `
		WITH params AS (
			SELECT
				$1::uuid                                                          AS booking_id,
				$2::timestamptz                                                   AS win_start,
				($2::timestamptz AT TIME ZONE 'UTC'
				   + make_interval(mins => $3::int + $4::int)) AT TIME ZONE 'UTC' AS win_end,
				$5::date                                                          AS sched_date,
				$6::text                                                          AS locality,
				$7::int                                                           AS runway_min,
				$8::uuid                                                          AS exclude_id
		)
		SELECT
			h.id::text,
			((sc.shift_date + sc.end_time) AT TIME ZONE 'Asia/Kolkata') AS shift_ends_at
		FROM helpers h
		JOIN users u ON u.id = h.id
		JOIN shift_sessions ss
		  ON ss.pro_id = h.id
		 AND ss.online_at  IS NOT NULL
		 AND ss.offline_at IS NULL
		JOIN shift_commitments sc ON sc.id = ss.commitment_id
		CROSS JOIN params p
		WHERE u.banned_at IS NULL
		  AND u.deleted_at IS NULL
		  AND h.approval_status = 'approved'
		  AND (p.exclude_id IS NULL OR h.id <> p.exclude_id)
		  -- Leave on the booking's IST date.
		  AND NOT EXISTS (
		      SELECT 1 FROM pro_leaves pl
		      WHERE pl.pro_id = h.id
		        AND pl.date   = p.sched_date
		        AND pl.status = 'approved'
		  )
		  -- Padded-window clash against the pro's committed jobs (GiST &&).
		  AND NOT EXISTS (
		      SELECT 1 FROM bookings ob
		      WHERE ob.helper_id      = h.id
		        AND ob.id             <> p.booking_id
		        AND ob.status         IN ('accepted','in_progress','arrived')
		        AND ob.scheduled_time IS NOT NULL
		        AND tstzrange(
		                ob.scheduled_time,
		                (ob.scheduled_time AT TIME ZONE 'UTC'
		                   + make_interval(mins => COALESCE(ob.total_duration_minutes, 60) + $4::int))
		                  AT TIME ZONE 'UTC'
		            ) && tstzrange(p.win_start, p.win_end)
		  )
		  -- Remaining committed-shift runway >= duration + travel buffer.
		  AND ((sc.shift_date + sc.end_time) AT TIME ZONE 'Asia/Kolkata') - now()
		        >= make_interval(mins => p.runway_min)
		  -- Zone assignment OR helpers.locality matches the booking locality
		  -- (case-insensitive). A booking with no locality accepts any pro.
		  AND (
		      p.locality IS NULL OR p.locality = ''
		      OR lower(h.locality) = lower(p.locality)
		      OR EXISTS (
		          SELECT 1 FROM pro_zone_assignments za
		          JOIN service_zones z ON z.id = za.zone_id
		          WHERE za.pro_id = h.id
		            AND za.effective_to IS NULL
		            AND lower(z.name) = lower(p.locality)
		      )
		  )
		ORDER BY shift_ends_at ASC
	`,
		b.ID,
		b.ScheduledTime,
		b.DurationMinutes,
		pad,
		scheduledDate,
		nullableLocality(b.Locality),
		b.DurationMinutes+pad,
		nullableUUID(excludeProID),
	)
	if err != nil {
		return nil, fmt.Errorf("eligible candidates query: %w", err)
	}
	defer rows.Close()

	var pool []Candidate
	var ids []string
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.ID, &c.ShiftEndsAt); err != nil {
			return nil, err
		}
		pool = append(pool, c)
		ids = append(ids, c.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Stamp which candidates have a live Redis GEO position (nearest-first is
	// only meaningful for those). Best-effort: Redis down → all false, travel
	// falls open.
	a.markLiveLocations(ctx, pool, ids)

	return a.pullPreferredToFront(ctx, b.CustomerID, pool, excludeProID), nil
}

// markLiveLocations sets HasLocation on each candidate that has a Redis GEO
// position. Failure is non-fatal — leaves HasLocation false (degrades to the
// query's shift-end ordering + fail-open travel).
func (a *Assigner) markLiveLocations(ctx context.Context, pool []Candidate, ids []string) {
	if a.rdb == nil || len(ids) == 0 {
		return
	}
	positions, err := a.rdb.GeoPos(ctx, helpersGeoKey, ids...).Result()
	if err != nil || len(positions) != len(pool) {
		return
	}
	for i := range pool {
		if positions[i] != nil {
			pool[i].HasLocation = true
		}
	}
}

// pullPreferredToFront reorders pool so the customer's preferred pros (in their
// returned order) lead, with the rest keeping the query's shift-end ordering.
// excludeProID stays excluded even if it is a preferred pro.
func (a *Assigner) pullPreferredToFront(ctx context.Context, customerID string, pool []Candidate, excludeProID string) []Candidate {
	if a.experts == nil || len(pool) < 2 {
		return pool
	}
	preferred, err := a.experts.PreferredHelperIDs(ctx, customerID)
	if err != nil {
		log.Warn().Err(err).Str("customer_id", customerID).Msg("[assigner] preferred lookup failed")
		return pool
	}
	if len(preferred) == 0 {
		return pool
	}

	byID := make(map[string]Candidate, len(pool))
	for _, c := range pool {
		byID[c.ID] = c
	}
	front := make([]Candidate, 0, len(pool))
	seen := make(map[string]struct{}, len(pool))
	for _, pid := range preferred {
		if pid == excludeProID {
			continue
		}
		if c, ok := byID[pid]; ok {
			front = append(front, c)
			seen[pid] = struct{}{}
		}
	}
	for _, c := range pool {
		if _, taken := seen[c.ID]; taken {
			continue
		}
		front = append(front, c)
	}
	return front
}

// ── TravelFeasible ──────────────────────────────────────────────────────────

// TravelFeasible reports whether a candidate can reach the booking in time and
// the ETA minutes used for the customer promise. It reads the pro's live Redis
// GEO position, asks Google Maps for a walking ETA (cached per
// (geohash5(pro), bookingID) with a short TTL), then applies:
//
//   - ASAP / past-slot tail: eta + AsapEtaPadMin <= AsapMaxPromiseMin
//   - future slot:           eta + AsapEtaPadMin <= minutes until scheduled_time
//
// Fail-open: a nil maps client, no live position, or a Maps error all assume an
// ETA of TravelBufferMin — dispatch must never stall on Google (spec §6/§12).
func (a *Assigner) TravelFeasible(ctx context.Context, cand Candidate, b *assignerBooking, cfg DispatchConfig) (etaMin int, ok bool) {
	eta := a.candidateETA(ctx, cand, b, cfg)

	promise := eta + cfg.AsapEtaPadMin
	until := int(time.Until(b.ScheduledTime).Minutes())
	if until <= 0 {
		// At or past scheduled_time (ASAP, or the slot retry tail) → ASAP rule.
		return eta, promise <= cfg.AsapMaxPromiseMin
	}
	return eta, promise <= until
}

// candidateETA returns the walking ETA in minutes, falling open to
// cfg.TravelBufferMin whenever it can't get a real one.
func (a *Assigner) candidateETA(ctx context.Context, cand Candidate, b *assignerBooking, cfg DispatchConfig) int {
	if a.maps == nil || a.rdb == nil {
		return cfg.TravelBufferMin
	}
	lat, lng, has := a.proPosition(ctx, cand.ID)
	if !has {
		return cfg.TravelBufferMin
	}

	key := geohash5(lat, lng) + "|" + b.ID
	if eta, hit := a.travel.get(key); hit {
		return eta
	}

	etaCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	mins, err := a.maps.GetTravelMinutes(etaCtx, lat, lng, b.Lat, b.Lng)
	cancel()
	if err != nil || mins == 0 {
		// Maps error / ZERO_RESULTS → fail-open. Don't cache the fallback; a
		// later tick may get a real answer.
		return cfg.TravelBufferMin
	}
	a.travel.set(key, mins)
	return mins
}

// proPosition reads a pro's live Redis GEO position. has=false on any miss.
func (a *Assigner) proPosition(ctx context.Context, proID string) (lat, lng float64, has bool) {
	pos, err := a.rdb.GeoPos(ctx, helpersGeoKey, proID).Result()
	if err != nil || len(pos) == 0 || pos[0] == nil {
		return 0, 0, false
	}
	return pos[0].Latitude, pos[0].Longitude, true
}

// ── Assign ──────────────────────────────────────────────────────────────────

// Assign atomically claims the booking for proID and fans out notifications.
// Two concurrency gates guard it:
//
//   - The UPDATE guard (helper_id IS NULL AND status='pending') stops two writers
//     racing for the SAME booking — only one wins; the loser gets ErrAlreadyClaimed.
//   - A per-pro advisory xact lock plus an in-lock padded-window clash re-check
//     stop one pro being grabbed by two DIFFERENT overlapping bookings (the
//     synchronous ASAP race). The lock serialises the two assigns; the re-check
//     lets the second see the first's committed job and bow out with ErrProBusy.
//
// The booking-row guard alone cannot cover the second case: EligibleCandidates
// runs before either booking commits, so each booking's own row guard passes
// independently.
//
// On success: pro alert push (booking_assigned), customer accepted push, and a
// booking.accepted outbox row (mirrors booking/repository.go:449) — all
// best-effort after the row is committed. Returns the assigned helper's display
// name (looked up once, reused for the customer push and the AssignResult).
func (a *Assigner) Assign(ctx context.Context, b *assignerBooking, proID string) (helperName string, err error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	// Per-pro advisory lock — serialises concurrent assigns to the same pro so
	// two ASAP races can't both pass the clash check and double-book.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, proID); err != nil {
		return "", fmt.Errorf("assigner advisory lock: %w", err)
	}

	// Re-verify the padded-window clash INSIDE the lock. EligibleCandidates ran
	// while both racing bookings were still pending (neither committed), so the
	// booking-row guard below passes independently for each — it stops two writers
	// on the SAME booking, not one pro grabbing two overlapping bookings. The
	// advisory lock serialises the two assigns; this probe (identical &&/tstzrange
	// form to EligibleCandidates) lets the second one see the first's now-committed
	// row and bow out with ErrProBusy so AssignOne tries the next candidate.
	pad := a.cfg(ctx).TravelBufferMin
	var clash bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM bookings ob
			WHERE ob.helper_id      = $1::uuid
			  AND ob.id             <> $2::uuid
			  AND ob.status         IN ('accepted','in_progress','arrived')
			  AND ob.scheduled_time IS NOT NULL
			  AND tstzrange(
			          ob.scheduled_time,
			          (ob.scheduled_time AT TIME ZONE 'UTC'
			             + make_interval(mins => COALESCE(ob.total_duration_minutes, 60) + $5::int))
			            AT TIME ZONE 'UTC'
			      ) && tstzrange(
			          $3::timestamptz,
			          ($3::timestamptz AT TIME ZONE 'UTC'
			             + make_interval(mins => $4::int + $5::int)) AT TIME ZONE 'UTC'
			      )
		)
	`, proID, b.ID, b.ScheduledTime, b.DurationMinutes, pad).Scan(&clash); err != nil {
		return "", fmt.Errorf("assign clash recheck: %w", err)
	}
	if clash {
		return "", ErrProBusy
	}

	var customerID string
	err = tx.QueryRow(ctx, `
		UPDATE bookings
		SET    helper_id  = $2,
		       status     = 'accepted',
		       accepted_at = now(),
		       matched_at = COALESCE(matched_at, now()),
		       updated_at = now()
		WHERE  id = $1::uuid AND helper_id IS NULL AND status = 'pending'
		RETURNING customer_id::text
	`, b.ID, proID).Scan(&customerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrAlreadyClaimed
		}
		return "", fmt.Errorf("assign update: %w", err)
	}

	// Durable customer notification — booking.accepted outbox row inside the tx
	// so it survives a crash right after commit (mirror repository.go:449).
	if p, merr := json.Marshal(map[string]any{
		"booking_id": b.ID, "customer_id": customerID, "helper_id": proID,
	}); merr == nil {
		_, _ = tx.Exec(ctx,
			`INSERT INTO event_outbox (event_type, aggregate_id, payload)
			 VALUES ('booking.accepted', $1::uuid, $2::jsonb)`,
			b.ID, p)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("assign commit: %w", err)
	}

	return a.notifyAssigned(ctx, proID, customerID, b.ID), nil
}

// ErrAlreadyClaimed signals that another writer (cron tick, admin assign, racing
// ASAP attempt) won the booking first. AssignOne treats it as "try the next
// candidate" rather than a hard failure.
var ErrAlreadyClaimed = errors.New("booking already claimed by another pro")

// ErrProBusy signals that the pro picked up an overlapping job between
// EligibleCandidates and the in-lock clash re-check (a racing assign of a
// different booking to the same pro). AssignOne treats it as "try the next
// candidate"; the booking itself is untouched.
var ErrProBusy = errors.New("pro became busy on an overlapping job")

// notifyAssigned fires the post-assignment pushes (best-effort) and returns the
// assigned helper's display name (looked up once here, reused by the caller).
// Pro gets a tray alert (booking_assigned, already routed in the app); customer
// gets the accepted push via the shared dispatch helper.
func (a *Assigner) notifyAssigned(ctx context.Context, proID, customerID, bookingID string) string {
	if a.notifications != nil {
		_ = a.notifications.SendToProByID(ctx, proID,
			"New job scheduled",
			"You've been assigned a new job. Check your bookings.",
			map[string]string{"type": "booking_assigned", "booking_id": bookingID},
		)
	}
	// Customer accepted push reuses the dispatch.go helper (data push). Build a
	// throwaway Dispatcher carrying the same db + notifier so we don't duplicate
	// the body/lookup logic.
	d := &Dispatcher{db: a.db, notifications: dataNotifier{a.notifications}}
	name := d.helperName(ctx, proID)
	d.pushCustomerAccepted(ctx, customerID, bookingID, name, false)
	return name
}

// dataNotifier adapts an assignerNotifier down to the SendData-only notifier
// the Dispatcher helpers expect. nil-safe: a nil inner yields a nil notifier so
// the helpers no-op.
type dataNotifier struct{ inner assignerNotifier }

func (d dataNotifier) SendData(ctx context.Context, userID string, data map[string]string) error {
	if d.inner == nil {
		return nil
	}
	return d.inner.SendData(ctx, userID, data)
}

// ── AssignOne ───────────────────────────────────────────────────────────────

// AssignOne is the end-to-end placement for one booking: load → eligible pool →
// walk in §5.2 order, first travel-feasible candidate wins. Returns the winning
// AssignResult, or (nil, ErrNoEligiblePro) when no candidate qualifies. A
// candidate that loses the atomic claim (ErrAlreadyClaimed) is skipped and the
// walk continues.
func (a *Assigner) AssignOne(ctx context.Context, bookingID, excludeProID string) (*AssignResult, error) {
	b, err := a.loadAssignerBooking(ctx, bookingID)
	if err != nil {
		return nil, err
	}
	cfg := a.cfg(ctx)

	candidates, err := a.EligibleCandidates(ctx, b, excludeProID)
	if err != nil {
		return nil, err
	}

	for _, cand := range candidates {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		eta, ok := a.TravelFeasible(ctx, cand, b, cfg)
		if !ok {
			continue
		}
		name, err := a.Assign(ctx, b, cand.ID)
		if err != nil {
			if errors.Is(err, ErrAlreadyClaimed) {
				// Booking taken between candidates — nothing more to do.
				return nil, ErrAlreadyClaimed
			}
			if errors.Is(err, ErrProBusy) {
				// This pro grabbed an overlapping job in a racing assign — skip
				// it and try the next candidate.
				continue
			}
			return nil, err
		}
		return &AssignResult{HelperID: cand.ID, HelperName: name, EtaMin: eta}, nil
	}
	return nil, ErrNoEligiblePro
}

// loadAssignerBooking fetches the projection AssignOne needs. Mirrors
// dispatch.go:loadBooking's shape with the destination coords added (the Maps
// ETA needs them).
func (a *Assigner) loadAssignerBooking(ctx context.Context, bookingID string) (*assignerBooking, error) {
	b := &assignerBooking{}
	var locality *string
	err := a.db.QueryRow(ctx, `
		SELECT id::text, customer_id::text, scheduled_time,
		       COALESCE(total_duration_minutes, 60),
		       locality,
		       lat::float8, lng::float8
		FROM bookings
		WHERE id = $1::uuid
	`, bookingID).Scan(
		&b.ID, &b.CustomerID, &b.ScheduledTime, &b.DurationMinutes,
		&locality, &b.Lat, &b.Lng,
	)
	if err != nil {
		return nil, err
	}
	b.Locality = locality
	return b, nil
}

// ── small helpers ───────────────────────────────────────────────────────────

// helpersGeoKey is the Redis GEO sorted-set of live pro positions (shared with
// location.Service.UpdateHelperLocation).
const helpersGeoKey = "helpers:locations"

func nullableLocality(loc *string) any {
	if loc == nil || *loc == "" {
		return nil
	}
	return *loc
}

func nullableUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// istLocation returns Asia/Kolkata, falling back to a fixed +05:30 zone if the
// tz database isn't present (all date keys in dispatch are IST per project rule).
func istLocation() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		return time.FixedZone("IST", 5*3600+30*60)
	}
	return loc
}

// ── travel cache (in-process, TTL) ──────────────────────────────────────────

// travelCache is a tiny TTL map keyed (geohash5(pro), bookingID). Pros barely
// move between ticks, so repeat candidate checks collapse to cache hits instead
// of Maps calls (spec §6). Expired entries are pruned lazily on read.
type travelCache struct {
	mu sync.Mutex
	m  map[string]travelEntry
}

type travelEntry struct {
	eta     int
	expires time.Time
}

func newTravelCache() *travelCache { return &travelCache{m: map[string]travelEntry{}} }

func (c *travelCache) get(key string) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok {
		return 0, false
	}
	if time.Now().After(e.expires) {
		delete(c.m, key)
		return 0, false
	}
	return e.eta, true
}

func (c *travelCache) set(key string, eta int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = travelEntry{eta: eta, expires: time.Now().Add(travelCacheTTL)}
}

// geohash5 encodes a lat/lng to a 5-character geohash (~2.4 km cell). Used only
// as a cache bucket key — a pro that hasn't crossed a ~2.4 km cell since the
// last tick reuses the cached ETA. Standard base-32 geohash, no external dep.
func geohash5(lat, lng float64) string {
	const base32 = "0123456789bcdefghjkmnpqrstuvwxyz"
	latRange := [2]float64{-90, 90}
	lngRange := [2]float64{-180, 180}
	var hash []byte
	even := true
	bit, ch := 0, 0
	for len(hash) < 5 {
		if even {
			mid := (lngRange[0] + lngRange[1]) / 2
			if lng >= mid {
				ch |= 1 << (4 - bit)
				lngRange[0] = mid
			} else {
				lngRange[1] = mid
			}
		} else {
			mid := (latRange[0] + latRange[1]) / 2
			if lat >= mid {
				ch |= 1 << (4 - bit)
				latRange[0] = mid
			} else {
				latRange[1] = mid
			}
		}
		even = !even
		if bit < 4 {
			bit++
		} else {
			hash = append(hash, base32[ch])
			bit, ch = 0, 0
		}
	}
	return string(hash)
}
