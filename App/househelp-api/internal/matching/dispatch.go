package matching

// Scheduled-booking dispatch shared infrastructure.
//
// Two cron consumers live alongside the Engine:
//
//   - ScheduledDispatcher  (scheduled_dispatch.go) — fires nightly at 22:00
//     IST, walks every unassigned scheduled booking that fires within the
//     next ~30 hours and runs InviteChain on each.
//   - StealthDispatcher    (stealth_dispatch.go)   — ticks every minute,
//     finds bookings with is_stealth_instant=true whose fire_at has passed
//     and runs InviteChain with a 15-minute search window. Surfaces
//     "still looking" / "keep looking or cancel" customer prompts.
//
// Both share InviteChain (this file), which:
//   1. Tries the customer's preferred helpers in oldest-first order
//   2. Falls back to a shuffled general pool, capped at generalPoolCap pros
//   3. Per pro: filters availability, fires the SCHEDULED_INVITE FCM data
//      push, then waits up to perProInviteWait for an /accept call
//   4. Returns ChainResult with the assignment outcome + which phase hit
//
// Acceptance is detected by polling bookings.helper_id — once the existing
// booking.AcceptBooking endpoint runs (atomic UPDATE … WHERE helper_id IS
// NULL), the next poll sees the assignment and the chain exits.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/users"
)

// Tunables — the numeric values in the spec.
const (
	perProInviteWait     = 25 * time.Second
	// 5s poll halves the round-trip count vs the prior 2s default
	// (audit D3-F5). Real fix is event-driven (subscribe to booking-
	// accepted notifications); deferred. This is the cheap mechanical
	// win — for a 30-pro chain RTTs drop from ~390 to ~150.
	pollInterval         = 5 * time.Second
	chainHardCap         = 30 * time.Minute
	stealthSearchWindow  = 15 * time.Minute
	generalPoolCap       = 60
	rebookLookbackWindow = 2 * time.Hour
)

// ChainPhase describes which leg of the invite chain ultimately won.
type ChainPhase string

const (
	PhasePreferred ChainPhase = "preferred"
	PhaseGeneral   ChainPhase = "general"
	PhaseNone      ChainPhase = "none"
)

// ChainResult is what InviteChain reports back to the cron driver.
type ChainResult struct {
	Assigned       bool
	HelperID       string
	Phase          ChainPhase
	ProsTried      int
	ChainExhausted bool          // true when both phases ran with no acceptance
	Elapsed        time.Duration // how long the chain ran
}

// expertsLookup is the (small) interface InviteChain needs from the experts
// package. Implemented by *experts.Service. Kept as an interface so this
// package doesn't depend on the experts package directly (avoids the import
// cycle that would happen once experts grows to depend on matching).
type expertsLookup interface {
	PreferredHelperIDs(ctx context.Context, userID string) ([]string, error)
}

// notifier is the subset of *notification.Service we need. Defined as an
// interface for testability.
type notifier interface {
	SendData(ctx context.Context, userID string, data map[string]string) error
	SendDataAlert(ctx context.Context, userID, title, body string, data map[string]string) error
}

// Dispatcher bundles the shared dependencies of both cron drivers.
type Dispatcher struct {
	db            *pgxpool.Pool
	rdb           *redis.Client
	notifications notifier
	experts       expertsLookup
}

// NewDispatcher constructs a Dispatcher. Pass nil notifications to no-op the
// FCM side (handy in tests).
func NewDispatcher(db *pgxpool.Pool, rdb *redis.Client, notif notifier, exp expertsLookup) *Dispatcher {
	return &Dispatcher{db: db, rdb: rdb, notifications: notif, experts: exp}
}

// scheduledBookingRow is the projection InviteChain needs to make decisions.
type scheduledBookingRow struct {
	ID                 string
	CustomerID         string
	ScheduledTime      time.Time
	DurationMinutes    int
	Locality           *string
	PreferredExhausted bool
}

// loadBooking fetches just enough of a booking row to drive InviteChain.
// Returns sql.ErrNoRows wrapped if the booking vanished mid-cron.
func (d *Dispatcher) loadBooking(ctx context.Context, bookingID string) (*scheduledBookingRow, error) {
	row := &scheduledBookingRow{}
	var locality *string
	err := d.db.QueryRow(ctx, `
		SELECT id::text, customer_id::text, scheduled_time,
		       COALESCE(total_duration_minutes, 60),
		       locality,
		       preferred_helper_chain_exhausted
		FROM bookings
		WHERE id = $1::uuid
	`, bookingID).Scan(
		&row.ID, &row.CustomerID, &row.ScheduledTime, &row.DurationMinutes,
		&locality, &row.PreferredExhausted,
	)
	if err != nil {
		return nil, err
	}
	row.Locality = locality
	return row, nil
}

// helperEligibility is the per-pro check result.
type helperEligibility struct {
	HelperID    string
	Eligible    bool
	SkipReason  string // for logging only
}

// checkEligibility runs the leave / locality / overlap / activeness checks for
// a single pro. Cheap query — one round-trip, all gates together.
//
// Phase 10 addition: shift-aware gates. A pro is eligible only when an open
// shift_sessions row exists (online_at IS NOT NULL AND offline_at IS NULL)
// AND their current shift_commitment has enough remaining time to absorb
// the booking duration + a 15-minute buffer for travel/wrap. Stops the
// "offered to a pro 30 min from end-of-shift" class of bug.
//
// Zone resolution: pro_zone_assignments is the source of truth when an
// active assignment exists; helpers.locality is the legacy fallback for
// pros that haven't been formally zone-assigned yet. Phase 12 cleanup:
// drop the locality fallback once CRM has migrated every active pro to
// pro_zone_assignments.
func (d *Dispatcher) checkEligibility(ctx context.Context, helperID string, b *scheduledBookingRow) (helperEligibility, error) {
	var (
		isActive      bool
		isApproved    bool
		helperLoc     *string
		zoneName      *string
		onLeave       bool
		overlapping   bool
		shiftOnline   bool
		remainingMin  *int
	)
	scheduledDate := b.ScheduledTime.Format("2006-01-02")
	durationInterval := time.Duration(b.DurationMinutes) * time.Minute
	windowEnd := b.ScheduledTime.Add(durationInterval)

	err := d.db.QueryRow(ctx, `
		SELECT
		    (u.banned_at IS NULL AND u.deleted_at IS NULL)            AS is_active,
		    COALESCE(h.approval_status = 'approved', false)            AS is_approved,
		    h.locality                                                 AS helper_locality,
		    (
		        SELECT z.name FROM pro_zone_assignments a
		          JOIN service_zones z ON z.id = a.zone_id
		         WHERE a.pro_id = $1::uuid AND a.effective_to IS NULL
		         LIMIT 1
		    )                                                          AS zone_name,
		    EXISTS (
		        SELECT 1 FROM pro_leaves pl
		        WHERE pl.pro_id = $1::uuid
		          AND pl.date   = $2::date
		          AND pl.status = 'approved'
		    )                                                          AS on_leave,
		    EXISTS (
		        SELECT 1 FROM bookings ob
		        WHERE ob.helper_id      = $1::uuid
		          AND ob.id             <> $5::uuid
		          AND ob.status         IN ('accepted','in_progress','arrived')
		          AND ob.scheduled_time IS NOT NULL
		          AND ob.scheduled_time < $4
		          AND (ob.scheduled_time + (COALESCE(ob.total_duration_minutes, 60) || ' minutes')::interval) > $3
		    )                                                          AS overlapping,
		    EXISTS (
		        SELECT 1
		          FROM shift_sessions ss
		         WHERE ss.pro_id    = $1::uuid
		           AND ss.online_at  IS NOT NULL
		           AND ss.offline_at IS NULL
		    )                                                          AS shift_online,
		    (
		        SELECT FLOOR(
		            EXTRACT(EPOCH FROM (
		                (sc.shift_date + sc.end_time)
		                  AT TIME ZONE 'Asia/Kolkata'
		                - now()
		            )) / 60
		        )::int
		          FROM shift_commitments sc
		          JOIN shift_sessions ss ON ss.shift_commitment_id = sc.id
		         WHERE ss.pro_id = $1::uuid
		           AND ss.online_at  IS NOT NULL
		           AND ss.offline_at IS NULL
		         LIMIT 1
		    )                                                          AS remaining_shift_min
		FROM users u
		LEFT JOIN helpers h ON h.id = u.id
		WHERE u.id = $1::uuid
	`, helperID, scheduledDate, b.ScheduledTime, windowEnd, b.ID).Scan(
		&isActive, &isApproved, &helperLoc, &zoneName, &onLeave, &overlapping, &shiftOnline, &remainingMin,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return helperEligibility{HelperID: helperID, Eligible: false, SkipReason: "helper not found"}, nil
		}
		return helperEligibility{}, err
	}

	switch {
	case !isActive:
		return helperEligibility{HelperID: helperID, SkipReason: "inactive account"}, nil
	case !isApproved:
		return helperEligibility{HelperID: helperID, SkipReason: "not approved"}, nil
	case onLeave:
		return helperEligibility{HelperID: helperID, SkipReason: "on leave"}, nil
	case overlapping:
		return helperEligibility{HelperID: helperID, SkipReason: "overlapping booking"}, nil
	case !shiftOnline:
		return helperEligibility{HelperID: helperID, SkipReason: "not online"}, nil
	}

	// Remaining-shift-time gate: must have enough runway for the
	// booking duration plus a 15-minute travel/wrap buffer. Skip when
	// remainingMin is unavailable (lets pros without a wired
	// commitment still appear — failure-open to avoid starving the
	// pool during partial rollout).
	if remainingMin != nil && *remainingMin < b.DurationMinutes+15 {
		return helperEligibility{HelperID: helperID, SkipReason: "shift ending soon"}, nil
	}

	// Zone/locality match. Primary: pro_zone_assignments. Fallback:
	// helpers.locality. If booking has no locality at all, accept any.
	if b.Locality != nil && *b.Locality != "" {
		matched := false
		if zoneName != nil && *zoneName != "" {
			matched = equalsCI(*zoneName, *b.Locality)
		}
		if !matched && helperLoc != nil {
			matched = equalsCI(*helperLoc, *b.Locality)
		}
		if !matched {
			return helperEligibility{HelperID: helperID, SkipReason: "zone/locality mismatch"}, nil
		}
	}

	return helperEligibility{HelperID: helperID, Eligible: true}, nil
}

// equalsCI is a tiny case-insensitive equality. ASCII-only because all
// localities are seeded ASCII (no unicode title-case headaches).
func equalsCI(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 32
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 32
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// generalPool returns all currently eligible-by-locality helpers excluding
// the supplied "already tried" set. Capped at generalPoolCap and shuffled
// in-place. Locality filter applied here so the per-pro eligibility check
// becomes the final gate (leave / overlap / approval).
func (d *Dispatcher) generalPool(ctx context.Context, locality *string, exclude map[string]struct{}) ([]string, error) {
	args := []any{}
	where := []string{
		`u.role IN ('helper','pro')`,
		`u.deleted_at IS NULL`,
		`u.banned_at  IS NULL`,
		`COALESCE(h.approval_status = 'approved', false)`,
	}
	if locality != nil && *locality != "" {
		where = append(where, fmt.Sprintf(`h.locality ILIKE $%d`, len(args)+1))
		args = append(args, *locality)
	}
	q := "SELECT u.id::text FROM users u JOIN helpers h ON h.id = u.id WHERE " + joinAnd(where)

	rows, err := d.db.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("general pool query: %w", err)
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if _, skip := exclude[id]; skip {
			continue
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	if len(out) > generalPoolCap {
		out = out[:generalPoolCap]
	}
	return out, nil
}

func joinAnd(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += "(" + p + ")"
	}
	return out
}

// inviteSinglePro is the per-pro phase: SAdd to the helper's Redis invite
// set, fire the data push, and poll bookings.helper_id every pollInterval
// until perProInviteWait elapses or someone takes it.
//
// Outcomes:
//   - acceptedByThisPro (true, "")     — the polled-for assignment matches helperID
//   - acceptedBySomeoneElse            — bookings.helper_id was set to a different ID;
//                                         caller must abort the chain
//   - timed out                        — no acceptance; remove the invite, try next
func (d *Dispatcher) inviteSinglePro(ctx context.Context, b *scheduledBookingRow, helperID string) (acceptedByThisPro, takenBySomeoneElse bool, err error) {
	// Add booking to the pro's invite set so the existing /me/invites poll +
	// the new SCHEDULED_INVITE push both surface it.
	helperKey := fmt.Sprintf(matchHelperKeyFmt, helperID)
	if d.rdb != nil {
		// Redis errors are non-fatal — the FCM push + DB-poll path still works.
		if err := d.rdb.SAdd(ctx, helperKey, b.ID).Err(); err != nil {
			log.Warn().Err(err).Msg("[dispatch] redis SAdd failed (continuing)")
		}
		// TTL = our wait window plus a buffer so a slow accept that arrives
		// just after we move on still drops the row from the set.
		d.rdb.Expire(ctx, helperKey, perProInviteWait+30*time.Second)
	}

	// Fire the data push. Failure to send is logged but doesn't abort —
	// the pro might still see the invite via the existing poll endpoint.
	if d.notifications != nil {
		dat := map[string]string{
			"type":             "SCHEDULED_INVITE",
			"booking_id":       b.ID,
			"customer_id":      b.CustomerID,
			"scheduled_time":   b.ScheduledTime.UTC().Format(time.RFC3339),
			"duration_minutes": fmt.Sprintf("%d", b.DurationMinutes),
			"time_remaining_sec": fmt.Sprintf("%d", int(perProInviteWait.Seconds())),
		}
		if b.Locality != nil {
			dat["locality"] = *b.Locality
		}
		// Rich offer payload — pro app uses these to render the
		// JobOffer card without an extra GET round-trip. All values
		// are best-effort; the chain proceeds even if enrichment
		// fails.
		if extras, err := d.fetchOfferEnrichment(ctx, b.ID, b.CustomerID, b.DurationMinutes); err == nil {
			for k, v := range extras {
				dat[k] = v
			}
		} else {
			log.Warn().Err(err).Str("booking_id", b.ID).Msg("[dispatch] offer enrichment failed (continuing)")
		}
		// Use the alert variant: a job offer is time-sensitive and a
		// silent data-only background push never reaches a locked phone.
		// The tray alert wakes the device; the data fields still route the
		// foreground/background handler to the JobOffer screen.
		if perr := d.notifications.SendDataAlert(ctx, helperID, "New job offer", "Tap to view and accept", dat); perr != nil {
			log.Warn().Err(perr).Str("helper_id", helperID).Str("booking_id", b.ID).Msg("[dispatch] offer push failed")
		}
	}

	deadline := time.Now().Add(perProInviteWait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false, false, ctx.Err()
		case <-time.After(pollInterval):
		}
		var assignedID *string
		if err := d.db.QueryRow(ctx,
			`SELECT helper_id::text FROM bookings WHERE id = $1::uuid`, b.ID,
		).Scan(&assignedID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, true, nil // booking deleted out from under us
			}
			log.Warn().Err(err).Str("booking_id", b.ID).Msg("[dispatch] poll failed")
			continue
		}
		if assignedID == nil {
			continue
		}
		if *assignedID == helperID {
			return true, false, nil
		}
		// Some other pro accepted (race window during the prior pro's chain).
		return false, true, nil
	}

	// Timed out for this pro — drop the invite from their Redis set so they
	// stop seeing it in /me/invites.
	if d.rdb != nil {
		d.rdb.SRem(ctx, helperKey, b.ID)
	}
	return false, false, nil
}

// InviteChain is the shared driver for both cron consumers. Spec §3 + §4.
// Returns when one of:
//   - a pro accepts (Assigned=true)
//   - both phases exhaust with no acceptance (ChainExhausted=true)
//   - chainHardCap elapses (ChainExhausted=true)
//   - the supplied ctx is cancelled
//
// Booking row state mutations live in the cron drivers — InviteChain itself
// only reads, sends, and waits.
func (d *Dispatcher) InviteChain(ctx context.Context, bookingID string) (*ChainResult, error) {
	start := time.Now()
	chainCtx, cancel := context.WithTimeout(ctx, chainHardCap)
	defer cancel()

	b, err := d.loadBooking(chainCtx, bookingID)
	if err != nil {
		return nil, fmt.Errorf("load booking: %w", err)
	}

	tried := map[string]struct{}{}
	res := &ChainResult{Phase: PhaseNone}

	// runOne walks a list of candidate helper IDs, invoking inviteSinglePro
	// for each that passes eligibility. Returns true to bubble up an exit
	// signal (assigned or taken-by-someone-else); false means "keep going".
	runOne := func(ids []string, phase ChainPhase) (exit bool, err error) {
		for _, hid := range ids {
			if chainCtx.Err() != nil {
				return true, nil
			}
			tried[hid] = struct{}{}
			elig, err := d.checkEligibility(chainCtx, hid, b)
			if err != nil {
				log.Warn().Err(err).Str("helper_id", hid).Msg("[dispatch] eligibility error")
				continue
			}
			if !elig.Eligible {
				log.Debug().Str("helper_id", hid).Str("skip", elig.SkipReason).Str("phase", string(phase)).Msg("[dispatch] skipped")
				continue
			}
			res.ProsTried++
			ok, taken, err := d.inviteSinglePro(chainCtx, b, hid)
			if err != nil {
				return true, err
			}
			if ok {
				res.Assigned = true
				res.HelperID = hid
				res.Phase = phase
				return true, nil
			}
			if taken {
				return true, nil
			}
		}
		return false, nil
	}

	// Phase 1 — preferred helpers, oldest-first.
	if !b.PreferredExhausted && d.experts != nil {
		preferred, lerr := d.experts.PreferredHelperIDs(chainCtx, b.CustomerID)
		if lerr != nil {
			log.Warn().Err(lerr).Str("customer_id", b.CustomerID).Msg("[dispatch] preferred lookup failed")
		}
		exit, rerr := runOne(preferred, PhasePreferred)
		if rerr != nil {
			return nil, rerr
		}
		if exit {
			res.Elapsed = time.Since(start)
			return res, nil
		}
		// Mark phase 1 done so a later resumed dispatch (e.g. stealth Keep
		// Looking) skips straight to phase 2.
		_, _ = d.db.Exec(chainCtx,
			`UPDATE bookings SET preferred_helper_chain_exhausted = true WHERE id = $1::uuid`,
			bookingID)
	}

	// Phase 2 — general pool, locality-filtered, shuffled, capped.
	pool, perr := d.generalPool(chainCtx, b.Locality, tried)
	if perr != nil {
		log.Warn().Err(perr).Msg("[dispatch] general pool failed")
	}
	exit, rerr := runOne(pool, PhaseGeneral)
	if rerr != nil {
		return nil, rerr
	}
	if !exit {
		res.ChainExhausted = true
	}
	res.Elapsed = time.Since(start)
	return res, nil
}

// markBookingNoProsFound transitions a booking into the no-pros-found state.
// Sets cancelled, cancelled_by, invite_exhausted_at — used by the nightly
// scheduled dispatch when chainHardCap fires before any pro accepts.
func (d *Dispatcher) markBookingNoProsFound(ctx context.Context, bookingID string) error {
	_, err := d.db.Exec(ctx, `
		UPDATE bookings
		SET status              = 'cancelled',
		    cancelled_by        = 'no_pros_found',
		    invite_exhausted_at = now(),
		    updated_at          = now()
		WHERE id     = $1::uuid
		  AND status IN ('pending','searching')
	`, bookingID)
	return err
}

// pushCustomerNoProsFound is the customer-facing "we couldn't find a pro"
// notification. Single-shot — fired by the cron driver immediately after
// markBookingNoProsFound succeeds.
func (d *Dispatcher) pushCustomerNoProsFound(ctx context.Context, customerID, bookingID, when string) {
	if d.notifications == nil {
		return
	}
	body := fmt.Sprintf("We couldn't find a pro for your %s booking. Tap to try booking again.", when)
	_ = d.notifications.SendData(ctx, customerID, map[string]string{
		"type":       "BOOKING_NO_PROS_FOUND",
		"booking_id": bookingID,
		"title":      "Booking unfilled",
		"body":       body,
	})
}

// pushCustomerAccepted notifies the customer that someone accepted. The
// scheduled cron uses helperName + a slightly different body when the
// accepter was a preferred ("expert") pro.
func (d *Dispatcher) pushCustomerAccepted(ctx context.Context, customerID, bookingID, helperName string, fromPreferred bool) {
	if d.notifications == nil {
		return
	}
	title := "Booking confirmed"
	body := fmt.Sprintf("%s has accepted your booking.", helperName)
	if fromPreferred {
		title = "Your expert is on it"
		body = fmt.Sprintf("Your expert %s has accepted your booking.", helperName)
	}
	_ = d.notifications.SendData(ctx, customerID, map[string]string{
		"type":       "BOOKING_ACCEPTED",
		"booking_id": bookingID,
		"helper_name": helperName,
		"title":       title,
		"body":        body,
	})
}

// helperName fetches the display name of the assigned helper for the
// customer-facing acceptance push. Returns "Your pro" on lookup failure so
// the push always has a meaningful subject.
func (d *Dispatcher) helperName(ctx context.Context, helperID string) string {
	var name string
	err := d.db.QueryRow(ctx, `SELECT COALESCE(name, '') FROM users WHERE id = $1::uuid AND `+users.AliveCondition, helperID).Scan(&name)
	if err != nil || name == "" {
		return "Your pro"
	}
	return name
}

// offerTaskItem is the per-service line surfaced on the pro's offer
// card. Mirrored in app/api/jobs.ts; keep in sync.
type offerTaskItem struct {
	ServiceName   string `json:"service_name"`
	DurationMinutes int  `json:"duration_minutes"`
	Quantity      int    `json:"quantity"`
	DisplayOrder  int    `json:"display_order"`
}

// fetchOfferEnrichment loads the rich-offer payload (task list,
// customer first name, masked address, estimated earnings) used by
// the pro app's JobOfferScreen. Failure is non-fatal — invite chain
// still proceeds with the minimal SCHEDULED_INVITE payload.
//
// Earnings preview uses the base rate × duration only (no peak /
// weekend surcharge calc at offer time; the actual paid amount is
// re-computed at /complete and may differ if the job runs over/under).
func (d *Dispatcher) fetchOfferEnrichment(ctx context.Context, bookingID, customerID string, durationMin int) (map[string]string, error) {
	out := map[string]string{}

	// Customer first name + address summary.
	var (
		custName *string
		address  *string
		locality *string
	)
	if err := d.db.QueryRow(ctx, `
		SELECT u.name, b.address, b.locality
		  FROM users u
		  JOIN bookings b ON b.id = $1::uuid
		 WHERE u.id = $2::uuid
	`, bookingID, customerID).Scan(&custName, &address, &locality); err != nil {
		return nil, fmt.Errorf("fetch customer: %w", err)
	}
	if custName != nil && *custName != "" {
		out["customer_first_name"] = strings.SplitN(strings.TrimSpace(*custName), " ", 2)[0]
	}
	if locality != nil && *locality != "" {
		out["address_summary"] = *locality
	} else if address != nil && *address != "" {
		// Best-effort summary: keep up to two comma-separated trailing chunks.
		parts := strings.Split(*address, ",")
		if n := len(parts); n > 2 {
			parts = parts[n-2:]
		}
		out["address_summary"] = strings.TrimSpace(strings.Join(parts, ","))
	}

	// Task list — booking_services rows ordered by display_order.
	rows, err := d.db.Query(ctx, `
		SELECT COALESCE(sc.name, ''), COALESCE(bs.duration_minutes, 0),
		       COALESCE(bs.quantity, 1), COALESCE(bs.display_order, 0)
		  FROM booking_services bs
		  LEFT JOIN service_categories sc ON sc.id = bs.service_id
		 WHERE bs.booking_id = $1::uuid
		 ORDER BY COALESCE(bs.display_order, 0)
	`, bookingID)
	if err != nil {
		return out, fmt.Errorf("fetch services: %w", err)
	}
	defer rows.Close()
	var tasks []offerTaskItem
	for rows.Next() {
		var t offerTaskItem
		if err := rows.Scan(&t.ServiceName, &t.DurationMinutes, &t.Quantity, &t.DisplayOrder); err != nil {
			continue
		}
		tasks = append(tasks, t)
	}
	if encoded, jerr := json.Marshal(tasks); jerr == nil {
		out["task_list_json"] = string(encoded)
	}

	// Earnings preview = booked duration × ₹160/hr — the gross a pro earns
	// during a job in the time-based model (₹80/hr online + ₹80/hr working,
	// and on a job they are both). Integer multiply-first / truncate-once.
	const onAndWorkingRatePaisePerHour = 16000 // ₹160/hr = ₹80 online + ₹80 working
	estEarnings := int64(durationMin) * onAndWorkingRatePaisePerHour / 60
	out["estimated_earnings_paise"] = fmt.Sprintf("%d", estEarnings)
	out["estimated_duration_minutes"] = fmt.Sprintf("%d", durationMin)

	return out, nil
}
