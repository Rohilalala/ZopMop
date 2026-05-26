package payroll

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository wraps the SQL surface used by the payroll engine.
type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// EligibleHelpers returns helpers whose effective_start_date is on
// or before cycle_end — i.e. they were live for at least one day of
// the cycle. Pros joined strictly after the window are filtered out
// so the cron does not write zero-pay rows for them.
func (r *Repository) EligibleHelpers(ctx context.Context, cycleEnd time.Time) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := r.db.Query(ctx, `
		SELECT h.id::text
		  FROM helpers h
		  JOIN users   u ON u.id = h.id
		                AND u.role = 'pro'
		                AND u.deleted_at IS NULL
		 WHERE h.effective_start_date <= $1::date
		 ORDER BY h.id
	`, cycleEnd.Format("2006-01-02"))
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

// CloseStaleSessionsForCycle auto-closes sessions that are still
// open (offline_at IS NULL) whose shift_date falls within the cycle.
// These are app-crash orphans — the pro went offline without the
// session being stamped. We cap them at their shift's scheduled end
// time so the hours are counted in the correct cycle rather than
// being lost forever.
func (r *Repository) CloseStaleSessionsForCycle(ctx context.Context, proID string, cycleStart, cycleEnd time.Time) (closed int64, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := r.db.Exec(ctx, `
		UPDATE shift_sessions ss
		   SET offline_at     = sc.shift_date + sc.end_time,
		       online_minutes = GREATEST(0, EXTRACT(EPOCH FROM ((sc.shift_date + sc.end_time) - ss.online_at))::int / 60)
		  FROM shift_commitments sc
		 WHERE sc.id = ss.commitment_id
		   AND ss.pro_id = $1::uuid
		   AND sc.shift_date BETWEEN $2::date AND $3::date
		   AND ss.offline_at IS NULL
	`, proID, cycleStart.Format("2006-01-02"), cycleEnd.Format("2006-01-02"))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected(), nil
}

// AggregateActivity sums closed-session online and working minutes
// for the pro across the cycle. Sessions are attributed to the
// shift_commitment's shift_date (a DATE column) so cycle membership
// is unambiguous and timezone-stable.
//
// Callers should run CloseStaleSessionsForCycle first so orphaned
// sessions are included.
func (r *Repository) AggregateActivity(ctx context.Context, proID string, cycleStart, cycleEnd time.Time) (onlineMin, workingMin int, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err = r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(ss.online_minutes), 0)::int AS online_min,
		       COALESCE(SUM(ss.job_minutes),    0)::int AS working_min
		  FROM shift_sessions ss
		  JOIN shift_commitments sc ON sc.id = ss.commitment_id
		 WHERE ss.pro_id = $1::uuid
		   AND sc.shift_date BETWEEN $2::date AND $3::date
		   AND ss.offline_at IS NOT NULL
	`, proID, cycleStart.Format("2006-01-02"), cycleEnd.Format("2006-01-02")).Scan(&onlineMin, &workingMin)
	if err != nil {
		return 0, 0, err
	}
	return onlineMin, workingMin, nil
}

// UpsertPayout writes the payouts row for (pro, cycle_start) if no
// row exists yet. ON CONFLICT DO NOTHING means a re-run of the cron
// (or a manual replay) is safe and never overwrites a row an admin
// has touched.
//
// Returns true if a row was inserted, false if one already existed.
func (r *Repository) UpsertPayout(ctx context.Context, proID string, cycle CycleClose, p PayBreakdown) (inserted bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tag, err := r.db.Exec(ctx, `
		INSERT INTO payouts (
			pro_id, cycle_start, cycle_end,
			online_minutes, working_minutes,
			base_pay_paise, work_bonus_paise, gross_pay_paise,
			deductions_paise, net_pay_paise, status
		) VALUES (
			$1::uuid, $2::date, $3::date,
			$4, $5,
			$6, $7, $8,
			0, $9, 'pending_manual_payout'
		)
		ON CONFLICT (pro_id, cycle_start) DO NOTHING
	`,
		proID, cycle.StartDate(), cycle.EndDate(),
		p.OnlineMinutes, p.WorkingMinutes,
		p.BasePayPaise, p.BonusPayPaise, p.GrossPayPaise,
		p.NetPayPaise,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// HelperDates returns the IST-date bounds the proration formula
// needs: effective_start_date and deactivated_at (or zero if the
// helper is still active).
func (r *Repository) HelperDates(ctx context.Context, proID string) (effectiveStart, deactivatedAt time.Time, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var dAt *time.Time
	err = r.db.QueryRow(ctx, `
		SELECT effective_start_date, deactivated_at
		  FROM helpers WHERE id = $1::uuid
	`, proID).Scan(&effectiveStart, &dAt)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if dAt != nil {
		deactivatedAt = *dAt
	}
	return effectiveStart, deactivatedAt, nil
}

// AcceptanceRate counts offers dispatched to a pro in the cycle and
// the subset that were accepted. Denominator filters to offers where
// the pro was online AND not already on another job at offer time
// (those flags are captured by the dispatcher when the row is
// inserted, so the query doesn't have to re-derive state).
//
//	accepted   = COUNT(*) WHERE response='accepted' AND eligible
//	dispatched = COUNT(*) WHERE eligible
//	eligible   = pro_was_online_at_offer AND NOT pro_on_another_job_at_offer
func (r *Repository) AcceptanceRate(ctx context.Context, proID string, cycleStart, cycleEnd time.Time) (accepted, dispatched int, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err = r.db.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (
		    WHERE response = 'accepted'
		      AND pro_was_online_at_offer
		      AND NOT pro_on_another_job_at_offer
		  )::int AS accepted,
		  COUNT(*) FILTER (
		    WHERE pro_was_online_at_offer
		      AND NOT pro_on_another_job_at_offer
		  )::int AS dispatched
		  FROM dispatched_jobs
		 WHERE pro_id = $1::uuid
		   AND offered_at::date BETWEEN $2::date AND $3::date
	`, proID, cycleStart.Format("2006-01-02"), cycleEnd.Format("2006-01-02")).Scan(&accepted, &dispatched)
	return accepted, dispatched, err
}

// UpsertFlag writes a helper_flags row if one does not already
// exist for (helper, cycle_start, flag_type). Returns true if a
// row was inserted, false if one already existed (idempotent re-run).
func (r *Repository) UpsertFlag(ctx context.Context, proID string, cycle CycleClose, flagType string, actual, expected float64, details []byte) (inserted bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tag, err := r.db.Exec(ctx, `
		INSERT INTO helper_flags (
		  helper_id, cycle_start, cycle_end, flag_type,
		  actual_value, expected_value, details
		) VALUES (
		  $1::uuid, $2::date, $3::date, $4, $5, $6, $7::jsonb
		)
		ON CONFLICT (helper_id, cycle_start, flag_type) DO NOTHING
	`, proID, cycle.StartDate(), cycle.EndDate(), flagType, actual, expected, details)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// PayoutExists is a read used by manual-replay handlers to short-
// circuit before doing any aggregation work.
func (r *Repository) PayoutExists(ctx context.Context, proID string, cycle CycleClose) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var one int
	err := r.db.QueryRow(ctx, `
		SELECT 1 FROM payouts WHERE pro_id = $1::uuid AND cycle_start = $2::date
	`, proID, cycle.StartDate()).Scan(&one)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
