package shift

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository owns all SQL touching the Phase-7 shift tables.
type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// ─── Commitments ──────────────────────────────────────────────────

// InsertCommitment fails with ErrShiftOverlap on UNIQUE collision.
func (r *Repository) InsertCommitment(ctx context.Context, proID, shiftDate, startTime, endTime string) (*Commitment, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	row := &Commitment{}
	var locked, started, ended *time.Time
	err := r.db.QueryRow(ctx, `
		INSERT INTO shift_commitments (pro_id, shift_date, start_time, end_time)
		VALUES ($1, $2::date, $3::time, $4::time)
		RETURNING id, pro_id,
		          to_char(shift_date,'YYYY-MM-DD'),
		          to_char(start_time,'HH24:MI'),
		          to_char(end_time,'HH24:MI'),
		          status, locked_at, online_started_at, online_ended_at, late_show
	`, proID, shiftDate, startTime, endTime).Scan(
		&row.ID, &row.ProID, &row.ShiftDate, &row.StartTime, &row.EndTime,
		&row.Status, &locked, &started, &ended, &row.LateShow,
	)
	if err != nil {
		// 23505 = unique_violation
		if isUniqueViolation(err) {
			return nil, ErrShiftOverlap
		}
		return nil, fmt.Errorf("insert commitment: %w", err)
	}
	row.LockedAt, row.OnlineStartedAt, row.OnlineEndedAt = locked, started, ended
	return row, nil
}

// GetCommitment loads one row by id (no pro filter — callers verify
// ownership via WithProGuard).
func (r *Repository) GetCommitment(ctx context.Context, id string) (*Commitment, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return r.scanCommitment(ctx, `WHERE id = $1`, id)
}

// GetCommitmentForPro loads one row scoped to a pro.
func (r *Repository) GetCommitmentForPro(ctx context.Context, proID, id string) (*Commitment, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return r.scanCommitment(ctx, `WHERE id = $1 AND pro_id = $2`, id, proID)
}

func (r *Repository) scanCommitment(ctx context.Context, where string, args ...any) (*Commitment, error) {
	q := `SELECT id, pro_id,
	             to_char(shift_date,'YYYY-MM-DD'),
	             to_char(start_time,'HH24:MI'),
	             to_char(end_time,'HH24:MI'),
	             status, locked_at, online_started_at, online_ended_at, late_show
	      FROM shift_commitments ` + where
	row := &Commitment{}
	var locked, started, ended *time.Time
	err := r.db.QueryRow(ctx, q, args...).Scan(
		&row.ID, &row.ProID, &row.ShiftDate, &row.StartTime, &row.EndTime,
		&row.Status, &locked, &started, &ended, &row.LateShow,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCommitmentNotFound
		}
		return nil, fmt.Errorf("scan commitment: %w", err)
	}
	row.LockedAt, row.OnlineStartedAt, row.OnlineEndedAt = locked, started, ended
	return row, nil
}

// ListUpcomingCommitments returns the next 14 days' shifts for a pro.
func (r *Repository) ListUpcomingCommitments(ctx context.Context, proID string) ([]Commitment, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx, `
		SELECT id, pro_id,
		       to_char(shift_date,'YYYY-MM-DD'),
		       to_char(start_time,'HH24:MI'),
		       to_char(end_time,'HH24:MI'),
		       status, locked_at, online_started_at, online_ended_at, late_show
		FROM shift_commitments
		WHERE pro_id = $1
		  AND shift_date >= current_date
		  AND shift_date <= current_date + INTERVAL '14 days'
		  AND status <> 'cancelled'
		ORDER BY shift_date, start_time
	`, proID)
	if err != nil {
		return nil, fmt.Errorf("list commitments: %w", err)
	}
	defer rows.Close()

	var out []Commitment
	for rows.Next() {
		c := Commitment{}
		var locked, started, ended *time.Time
		if err := rows.Scan(
			&c.ID, &c.ProID, &c.ShiftDate, &c.StartTime, &c.EndTime,
			&c.Status, &locked, &started, &ended, &c.LateShow,
		); err != nil {
			return nil, err
		}
		c.LockedAt, c.OnlineStartedAt, c.OnlineEndedAt = locked, started, ended
		out = append(out, c)
	}
	return out, rows.Err()
}

// CancelCommitment marks status=cancelled. Caller verifies !locked.
func (r *Repository) CancelCommitment(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`UPDATE shift_commitments SET status = 'cancelled', updated_at = now() WHERE id = $1`,
		id)
	return err
}

// MarkLateShow + MarkActive + MarkCompleted are status transitions
// fired from the service layer.
func (r *Repository) MarkActive(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx,
		`UPDATE shift_commitments SET status = 'active', online_started_at = COALESCE(online_started_at, now()), updated_at = now() WHERE id = $1`,
		id)
	return err
}
func (r *Repository) MarkLateShow(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx,
		`UPDATE shift_commitments SET late_show = true, updated_at = now() WHERE id = $1`, id)
	return err
}
func (r *Repository) MarkCompleted(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx,
		`UPDATE shift_commitments SET status = 'completed', online_ended_at = now(), updated_at = now() WHERE id = $1`,
		id)
	return err
}

// LockShiftsForToday is the 3-AM-cron primitive — stamps locked_at on
// every committed shift whose date is today and returns the affected
// rows for the absence-record pass.
func (r *Repository) LockShiftsForToday(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx, `
		UPDATE shift_commitments
		   SET locked_at = COALESCE(locked_at, now()),
		       updated_at = now()
		 WHERE shift_date = current_date
		   AND status = 'committed'
	`)
	return err
}

// ProsWithoutShiftToday returns pros (helpers.id) who have no
// non-cancelled commitment for today. Used by the 3-AM cron to
// generate absence_records.
func (r *Repository) ProsWithoutShiftToday(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := r.db.Query(ctx, `
		SELECT h.id
		  FROM helpers h
		  JOIN users  u ON u.id = h.id AND u.role = 'pro' AND u.deleted_at IS NULL
		 WHERE NOT EXISTS (
		           SELECT 1 FROM shift_commitments sc
		            WHERE sc.pro_id = h.id
		              AND sc.shift_date = current_date
		              AND sc.status <> 'cancelled'
		       )
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ─── Sessions ─────────────────────────────────────────────────────

// OpenSession inserts a new shift_sessions row with offline_at=NULL.
func (r *Repository) OpenSession(ctx context.Context, commitmentID, proID string, lat, lng float64, locationOK, manualApprovalUsed bool, adminID *string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var id string
	err := r.db.QueryRow(ctx, `
		INSERT INTO shift_sessions
		    (commitment_id, pro_id, start_lat, start_lng,
		     location_verified_at_start, manual_approval_used, manual_approval_admin_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id
	`, commitmentID, proID, lat, lng, locationOK, manualApprovalUsed, adminID).Scan(&id)
	return id, err
}

// CurrentSessionForPro returns the open session (offline_at IS NULL)
// for the pro, or nil if none.
func (r *Repository) CurrentSessionForPro(ctx context.Context, proID string) (*Session, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	s := &Session{}
	var commitmentID string
	var offline *time.Time
	var onlineMin *int
	err := r.db.QueryRow(ctx, `
		SELECT id, commitment_id, online_at, offline_at, online_minutes, job_minutes,
		       location_verified_at_start, manual_approval_used
		  FROM shift_sessions
		 WHERE pro_id = $1 AND offline_at IS NULL
		 ORDER BY online_at DESC
		 LIMIT 1
	`, proID).Scan(
		&s.ID, &commitmentID, &s.OnlineAt, &offline, &onlineMin, &s.JobMinutes,
		&s.LocationVerifiedAtStart, &s.ManualApprovalUsed,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", nil
		}
		return nil, "", err
	}
	s.CommitmentID = commitmentID
	s.OfflineAt = offline
	s.OnlineMinutes = onlineMin
	return s, commitmentID, nil
}

// CloseSession stamps offline_at + online_minutes; returns the
// computed minute count for the live denormalisation update.
func (r *Repository) CloseSession(ctx context.Context, sessionID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var minutes int
	err := r.db.QueryRow(ctx, `
		UPDATE shift_sessions
		   SET offline_at     = now(),
		       online_minutes = GREATEST(0, EXTRACT(EPOCH FROM (now() - online_at))::int / 60)
		 WHERE id = $1
		 RETURNING online_minutes
	`, sessionID).Scan(&minutes)
	return minutes, err
}

// BumpHelperOnlineMinutes adds to the denormalised fortnight counter.
func (r *Repository) BumpHelperOnlineMinutes(ctx context.Context, proID string, deltaMinutes int) error {
	if deltaMinutes <= 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`UPDATE helpers SET current_fortnight_online_min = current_fortnight_online_min + $1 WHERE id = $2`,
		deltaMinutes, proID)
	return err
}

// ─── Zones ────────────────────────────────────────────────────────

// CurrentZoneAssignment returns the active zone for a pro, with the
// zone's center coords + the Go-Online verification radius
// (shift_radius_km — distinct from service-area radius_km).
// Returns ErrNoZoneAssigned if none.
func (r *Repository) CurrentZoneAssignment(ctx context.Context, proID string) (zoneID string, lat, lng float64, shiftRadiusKm float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err = r.db.QueryRow(ctx, `
		SELECT z.id, z.lat::float8, z.lon::float8, z.shift_radius_km::float8
		  FROM pro_zone_assignments a
		  JOIN service_zones z ON z.id = a.zone_id
		 WHERE a.pro_id = $1 AND a.effective_to IS NULL
		 LIMIT 1
	`, proID).Scan(&zoneID, &lat, &lng, &shiftRadiusKm)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, 0, 0, ErrNoZoneAssigned
	}
	return
}

// ZoneInfo carries the user-facing view of a pro's current zone.
// Returned by GET /pro/zone.
type ZoneInfo struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Lat           float64 `json:"lat"`
	Lng           float64 `json:"lng"`
	ShiftRadiusKm float64 `json:"shift_radius_km"`
}

// CurrentZoneInfo returns the active zone display details for a pro.
// Returns nil + nil err when no zone is assigned (UI renders the
// no-zone state).
func (r *Repository) CurrentZoneInfo(ctx context.Context, proID string) (*ZoneInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var z ZoneInfo
	err := r.db.QueryRow(ctx, `
		SELECT z.id, COALESCE(z.name, ''), z.lat::float8, z.lon::float8, z.shift_radius_km::float8
		  FROM pro_zone_assignments a
		  JOIN service_zones z ON z.id = a.zone_id
		 WHERE a.pro_id = $1 AND a.effective_to IS NULL
		 LIMIT 1
	`, proID).Scan(&z.ID, &z.Name, &z.Lat, &z.Lng, &z.ShiftRadiusKm)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &z, nil
}

// AssignZone inserts a new assignment, expiring any prior current
// one. Idempotent: re-assigning the same zone is a no-op.
func (r *Repository) AssignZone(ctx context.Context, proID, zoneID string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`UPDATE pro_zone_assignments SET effective_to = current_date WHERE pro_id = $1 AND effective_to IS NULL`,
		proID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO pro_zone_assignments (pro_id, zone_id, effective_from) VALUES ($1, $2, current_date)
		 ON CONFLICT DO NOTHING`,
		proID, zoneID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// InsertZoneApproval persists the pro's selfie-based approval ask.
func (r *Repository) InsertZoneApproval(ctx context.Context, proID, commitmentID string, lat, lng float64, photoURL string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var id string
	err := r.db.QueryRow(ctx, `
		INSERT INTO zone_approval_requests (pro_id, shift_commitment_id, current_lat, current_lng, photo_url)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, proID, commitmentID, lat, lng, photoURL).Scan(&id)
	return id, err
}

// PendingApprovalForCommitment returns true if a pending request
// already exists.
func (r *Repository) PendingApprovalForCommitment(ctx context.Context, commitmentID string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var id string
	err := r.db.QueryRow(ctx,
		`SELECT id FROM zone_approval_requests WHERE shift_commitment_id = $1 AND status = 'pending' LIMIT 1`,
		commitmentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return id, err == nil, err
}

// ApprovedApprovalForCommitment is the gate used by GoOnline to
// bypass the radius check after admin approval.
func (r *Repository) ApprovedApprovalForCommitment(ctx context.Context, commitmentID string) (approved bool, adminID *string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var aID *string
	err = r.db.QueryRow(ctx, `
		SELECT reviewed_by
		  FROM zone_approval_requests
		 WHERE shift_commitment_id = $1 AND status = 'approved'
		 ORDER BY reviewed_at DESC NULLS LAST LIMIT 1
	`, commitmentID).Scan(&aID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	return err == nil, aID, err
}

// ListPendingZoneApprovals — admin endpoint. Joins users + pro_zone_assignments
// + service_zones to enrich each row with the pro's name/phone and the zone
// they were assigned to when they requested the exception, plus a haversine
// distance (metres) from the pro's reported coordinates to the zone centre.
// Zones with no current assignment (effective_to IS NULL) return NULL on
// the zone columns; the admin UI shows "—" / hides the overlay.
func (r *Repository) ListPendingZoneApprovals(ctx context.Context) ([]ZoneApprovalRequest, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rows, err := r.db.Query(ctx, `
		SELECT zar.id, zar.pro_id, zar.shift_commitment_id, zar.requested_at,
		       zar.current_lat::float8, zar.current_lng::float8,
		       COALESCE(zar.photo_url,''), zar.status, COALESCE(zar.notes,''),
		       u.name AS pro_name,
		       u.phone AS pro_phone,
		       sz.id::text AS assigned_zone_id,
		       sz.name AS assigned_zone_name,
		       sz.lat::float8 AS assigned_zone_lat,
		       sz.lon::float8 AS assigned_zone_lng,
		       sz.radius_km::float8 AS assigned_zone_radius_km,
		       CASE
		         WHEN sz.lat IS NULL OR sz.lon IS NULL THEN NULL
		         ELSE 2 * 6371000 * asin(sqrt(
		           pow(sin(radians((zar.current_lat - sz.lat::float8) / 2)), 2)
		           + cos(radians(zar.current_lat)) * cos(radians(sz.lat::float8))
		             * pow(sin(radians((zar.current_lng - sz.lon::float8) / 2)), 2)
		         ))
		       END AS distance_meters
		  FROM zone_approval_requests zar
		  LEFT JOIN users u ON u.id = zar.pro_id
		  LEFT JOIN pro_zone_assignments pza
		    ON pza.pro_id = zar.pro_id AND pza.effective_to IS NULL
		  LEFT JOIN service_zones sz ON sz.id = pza.zone_id
		 WHERE zar.status = 'pending'
		 ORDER BY zar.requested_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ZoneApprovalRequest{}
	for rows.Next() {
		var z ZoneApprovalRequest
		if err := rows.Scan(
			&z.ID, &z.ProID, &z.ShiftCommitmentID, &z.RequestedAt,
			&z.CurrentLat, &z.CurrentLng, &z.PhotoURL, &z.Status, &z.Notes,
			&z.ProName, &z.ProPhone,
			&z.AssignedZoneID, &z.AssignedZoneName,
			&z.AssignedZoneLat, &z.AssignedZoneLng, &z.AssignedZoneRadiusKm,
			&z.DistanceMeters,
		); err != nil {
			return nil, err
		}
		out = append(out, z)
	}
	return out, rows.Err()
}

// DecideZoneApproval flips status + records the admin reviewer.
func (r *Repository) DecideZoneApproval(ctx context.Context, requestID, status, adminID, notes string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd, err := r.db.Exec(ctx, `
		UPDATE zone_approval_requests
		   SET status      = $2,
		       reviewed_by = $3,
		       reviewed_at = now(),
		       notes       = NULLIF($4,'')
		 WHERE id = $1 AND status = 'pending'
	`, requestID, status, adminID, notes)
	if err != nil {
		return err
	}
	// 0 rows → request was already approved/rejected (admin race or
	// stale UI). Surface as ErrAlreadyReviewed so the caller skips the
	// audit row + push instead of reporting a phantom success.
	if cmd.RowsAffected() == 0 {
		return ErrAlreadyReviewed
	}
	return nil
}

// ZoneApprovalByID fetches just the pro_id + commitment_id + status
// for a given request — used by the service to enrich the granted
// push notification.
func (r *Repository) ZoneApprovalByID(ctx context.Context, requestID string) (proID, commitmentID, status string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err = r.db.QueryRow(ctx, `
		SELECT pro_id, shift_commitment_id, status
		  FROM zone_approval_requests
		 WHERE id = $1
	`, requestID).Scan(&proID, &commitmentID, &status)
	return
}

// NameForPro returns the user's display name for FCM body
// interpolation. Empty string on any error or missing row — caller
// falls back to a generic body.
func (r *Repository) NameForPro(ctx context.Context, proID string) string {
	ctx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()
	var name string
	if err := r.db.QueryRow(ctx,
		`SELECT COALESCE(name,'') FROM users WHERE id = $1`, proID).Scan(&name); err != nil {
		return ""
	}
	return name
}

// DecrementLeaveBalance lowers helpers.leave_balance by 1 floored at
// zero. Called when a no-show absence is recorded.
func (r *Repository) DecrementLeaveBalance(ctx context.Context, proID string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`UPDATE helpers SET leave_balance = GREATEST(leave_balance - 1, 0) WHERE id = $1`, proID)
	return err
}

// ─── Cancellations ────────────────────────────────────────────────

// CountCancellations30d returns the rolling 30-day count.
func (r *Repository) CountCancellations30d(ctx context.Context, proID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var n int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM booking_cancellations
		 WHERE pro_id = $1 AND customer_was_notified = true
		   AND cancelled_at > now() - INTERVAL '30 days'
	`, proID).Scan(&n)
	return n, err
}

// InsertCancellation records the strike. customer_was_notified true
// means it counts toward the 5-strike rule.
func (r *Repository) InsertCancellation(ctx context.Context, proID, bookingID string, notified bool, estMinutes, penaltyPaise, index int) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx, `
		INSERT INTO booking_cancellations
		    (pro_id, booking_id, customer_was_notified, estimated_job_minutes,
		     penalty_amount_paise, cancellation_index_30d)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, proID, bookingID, notified, estMinutes, penaltyPaise, index)
	return err
}

// BumpCancellationCount30d keeps the helpers.cancellation_count_30d
// denormalised counter in sync. RecomputeCancellationCount30d is the
// hourly correctness sweep that resets it from the source of truth.
func (r *Repository) BumpCancellationCount30d(ctx context.Context, proID string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`UPDATE helpers SET cancellation_count_30d = cancellation_count_30d + 1 WHERE id = $1`, proID)
	return err
}

// RecomputeCancellationCount30d rewrites every pro's
// cancellation_count_30d from the booking_cancellations table.
// Hourly cron.
func (r *Repository) RecomputeCancellationCount30d(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx, `
		UPDATE helpers h
		   SET cancellation_count_30d = COALESCE(c.cnt, 0)
		  FROM (
		    SELECT pro_id, COUNT(*) AS cnt
		      FROM booking_cancellations
		     WHERE customer_was_notified = true
		       AND cancelled_at > now() - INTERVAL '30 days'
		     GROUP BY pro_id
		  ) c
		 WHERE h.id = c.pro_id
		    OR (c.pro_id IS NULL AND h.cancellation_count_30d <> 0)
	`)
	return err
}

// ─── Absences ─────────────────────────────────────────────────────

// AbsenceExistsInFortnight reports whether the pro already has an
// absence row in the current fortnight (any reason). Used to set
// is_first_in_fortnight.
func (r *Repository) AbsenceExistsInFortnight(ctx context.Context, proID string, fortnightStart string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var exists bool
	err := r.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM absence_records WHERE pro_id = $1 AND fortnight_start = $2::date)`,
		proID, fortnightStart).Scan(&exists)
	return exists, err
}

// InsertAbsence persists one absence row. Returns true if a new row
// was inserted, false if the row already existed (ON CONFLICT).
func (r *Repository) InsertAbsence(ctx context.Context, proID, reason, fortnightStart string, firstInFortnight, leaveDeducted bool, cashPaise int) (inserted bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	res, err := r.db.Exec(ctx, `
		INSERT INTO absence_records
		    (pro_id, absence_date, reason, is_first_in_fortnight, leave_deducted, cash_deducted_paise, fortnight_start)
		VALUES ($1, current_date, $2, $3, $4, $5, $6::date)
		ON CONFLICT (pro_id, absence_date, reason) DO NOTHING
	`, proID, reason, firstInFortnight, leaveDeducted, cashPaise, fortnightStart)
	if err != nil {
		return false, err
	}
	return res.RowsAffected() > 0, nil
}

// HelperFortnightSnapshot — feeds /pro/fortnight/progress.
//
// FortnightStart is a pointer because `helpers.fortnight_start_date`
// is NULL for any pro who hasn't committed a shift yet. Scanning NULL
// into a non-pointer `time.Time` raises a pgx error and 500s the
// endpoint; callers must handle nil as "no fortnight started yet" and
// fall back to the calendar-derived current Monday.
type HelperFortnightSnapshot struct {
	FortnightStart       *time.Time
	OnlineMinutes        int
	CancellationCount30d int
	LeaveBalance         int
	WeeklyHoursTarget    int
}

func (r *Repository) HelperFortnight(ctx context.Context, proID string) (*HelperFortnightSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	s := &HelperFortnightSnapshot{}
	err := r.db.QueryRow(ctx, `
		SELECT fortnight_start_date,
		       current_fortnight_online_min,
		       cancellation_count_30d,
		       leave_balance,
		       weekly_hours_target
		  FROM helpers
		 WHERE id = $1
	`, proID).Scan(&s.FortnightStart, &s.OnlineMinutes, &s.CancellationCount30d, &s.LeaveBalance, &s.WeeklyHoursTarget)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCommitmentNotFound // re-use: pro row missing
	}
	return s, err
}

// FortnightJobMinutes sums job_minutes across this fortnight's
// sessions for the pro.
func (r *Repository) FortnightJobMinutes(ctx context.Context, proID string, fortnightStart time.Time) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var n int
	err := r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(job_minutes), 0)
		  FROM shift_sessions
		 WHERE pro_id = $1 AND online_at >= $2
	`, proID, fortnightStart).Scan(&n)
	return n, err
}

// FortnightCashDeductions sums absence cash penalties + cancellation
// penalties in the current fortnight. Kept for callers that only want
// the rolled-up total; the Money tab now wants them split — see
// FortnightDeductionsSplit.
func (r *Repository) FortnightCashDeductions(ctx context.Context, proID string, fortnightStart time.Time) (int, error) {
	absence, cancel, err := r.FortnightDeductionsSplit(ctx, proID, fortnightStart)
	if err != nil {
		return 0, err
	}
	return absence + cancel, nil
}

// FortnightDeductionsSplit returns the absence and cancellation
// deductions separately so the Money tab can render named lines.
func (r *Repository) FortnightDeductionsSplit(ctx context.Context, proID string, fortnightStart time.Time) (absencePaise, cancellationPaise int, err error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	err = r.db.QueryRow(ctx, `
		SELECT
		  COALESCE((
		    SELECT SUM(cash_deducted_paise) FROM absence_records
		     WHERE pro_id = $1 AND fortnight_start = $2::date
		  ), 0),
		  COALESCE((
		    SELECT SUM(penalty_amount_paise) FROM booking_cancellations
		     WHERE pro_id = $1 AND cancelled_at >= $2
		  ), 0)
	`, proID, fortnightStart).Scan(&absencePaise, &cancellationPaise)
	return
}

// ─── Bookings glue ────────────────────────────────────────────────

// PendingBookingsCountForPro returns the number of in-flight bookings
// (status pending/accepted/in_progress) currently assigned to the pro.
// Used to gate Go Offline.
func (r *Repository) PendingBookingsCountForPro(ctx context.Context, proID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var n int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM bookings
		 WHERE helper_id = $1 AND status IN ('pending','accepted','in_progress')
	`, proID).Scan(&n)
	return n, err
}

// BookingMinutesEstimate returns estimated job minutes for a booking
// based on services × per-service duration. Falls back to 60 min if
// unavailable. The lookup intentionally swallows errors — the strike
// rule should never block on a flaky read.
func (r *Repository) BookingMinutesEstimate(ctx context.Context, bookingID string) int {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var minutes int
	_ = r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(bs.minutes), 0)
		  FROM booking_services bs
		 WHERE bs.booking_id = $1
	`, bookingID).Scan(&minutes)
	if minutes <= 0 {
		return 60
	}
	return minutes
}

// BookingOwnerAndStatus returns the helper_id + status for a booking
// so the cancel endpoint can verify ownership and notified-state.
func (r *Repository) BookingOwnerAndStatus(ctx context.Context, bookingID string) (helperID, status string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var hID *string
	err = r.db.QueryRow(ctx, `SELECT helper_id, status FROM bookings WHERE id = $1`, bookingID).
		Scan(&hID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrBookingNotOwnedByPro
	}
	if err != nil {
		return "", "", err
	}
	if hID != nil {
		helperID = *hID
	}
	return
}

// MarkBookingCancelled transitions the booking to cancelled state.
func (r *Repository) MarkBookingCancelled(ctx context.Context, bookingID string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`,
		bookingID)
	return err
}

// ─── helpers ──────────────────────────────────────────────────────

func isUniqueViolation(err error) bool {
	// pgx wraps as *pgconn.PgError but we avoid the import here by
	// pattern-matching on the string form, which is stable across
	// driver versions for our use.
	return err != nil && (containsAny(err.Error(),
		"unique_violation",
		"duplicate key value",
		"shift_commitments_pro_id_shift_date_start_time_key"))
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if len(sub) <= len(s) && indexOf(s, sub) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
