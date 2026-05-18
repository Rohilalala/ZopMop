package workers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a worker lookup yields no result.
var ErrNotFound = errors.New("worker not found")

// Repository wraps DB access for the workers module.
type Repository struct {
	read  *pgxpool.Pool
	write *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

const statusExpr = `
	CASE
	  WHEN u.banned_at IS NOT NULL                                     THEN 'banned'
	  WHEN u.is_suspended                                              THEN 'suspended'
	  WHEN h.approval_status = 'pending'                               THEN 'pending'
	  WHEN h.approval_status = 'rejected'                              THEN 'rejected'
	  ELSE 'active'
	END
`

// List returns a page of workers and total count. Only users w/ role='pro'
// are considered.
func (r *Repository) List(ctx context.Context, f ListFilter) (*ListResponse, error) {
	args := []any{}
	conds := []string{"u.role = 'pro'", "u.deleted_at IS NULL"}
	add := func(clause string, vals ...any) {
		args = append(args, vals...)
		conds = append(conds, clause)
	}

	if f.Search != "" {
		args = append(args, "%"+strings.ToLower(f.Search)+"%")
		idx := len(args)
		conds = append(conds, fmt.Sprintf(
			"(LOWER(u.phone) LIKE $%d OR LOWER(u.name) LIKE $%d OR LOWER(u.email::text) LIKE $%d)",
			idx, idx, idx,
		))
	}
	switch f.Status {
	case StatusActive:
		conds = append(conds, "u.banned_at IS NULL AND u.is_suspended = FALSE AND h.approval_status = 'approved'")
	case StatusPending:
		conds = append(conds, "h.approval_status = 'pending'")
	case StatusRejected:
		conds = append(conds, "h.approval_status = 'rejected'")
	case StatusSuspended:
		conds = append(conds, "u.is_suspended = TRUE AND u.banned_at IS NULL")
	case StatusBanned:
		conds = append(conds, "u.banned_at IS NOT NULL")
	}
	if f.Category != "" {
		add(fmt.Sprintf("$%d = ANY(h.services)", len(args)+1), f.Category)
	}
	if f.OnlyOnline {
		conds = append(conds, "h.is_available = TRUE")
	}

	sortColMap := map[string]string{
		"":          "u.created_at",
		"joined_at": "u.created_at",
		"total_jobs": "h.total_jobs",
		"rating":    "h.rating",
		"name":      "u.name",
	}
	sortCol, ok := sortColMap[f.SortBy]
	if !ok {
		sortCol = "u.created_at"
	}
	sortDir := strings.ToUpper(strings.TrimSpace(f.SortDir))
	if sortDir != "ASC" {
		sortDir = "DESC"
	}

	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	whereSQL := "WHERE " + strings.Join(conds, " AND ")

	args = append(args, limit, offset)
	limitParam := len(args) - 1
	offsetParam := len(args)

	pageSQL := fmt.Sprintf(`
		SELECT
		  u.id::text, u.phone, u.name, u.avatar_url,
		  %s AS status,
		  h.is_available,
		  (h.is_available AND h.last_location_at IS NOT NULL
		    AND h.last_location_at > NOW() - INTERVAL '90 seconds') AS is_online,
		  u.is_vip, h.rating, h.total_jobs, h.services,
		  u.created_at, last_b.created_at AS last_active_at
		FROM users u
		JOIN helpers h ON h.id = u.id
		LEFT JOIN LATERAL (
		  SELECT created_at FROM bookings
		  WHERE helper_id = u.id
		  ORDER BY created_at DESC
		  LIMIT 1
		) last_b ON TRUE
		%s
		ORDER BY %s %s NULLS LAST
		LIMIT $%d OFFSET $%d
	`, statusExpr, whereSQL, sortCol, sortDir, limitParam, offsetParam)

	rows, err := r.read.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("list workers: %w", err)
	}
	defer rows.Close()

	items := []ListItem{}
	for rows.Next() {
		var (
			it     ListItem
			status string
		)
		if err := rows.Scan(
			&it.ID, &it.Phone, &it.Name, &it.AvatarURL, &status,
			&it.IsAvailable, &it.IsOnline, &it.IsVIP, &it.Rating, &it.TotalJobs, &it.Categories,
			&it.JoinedAt, &it.LastActiveAt,
		); err != nil {
			return nil, fmt.Errorf("scan worker: %w", err)
		}
		it.Status = Status(status)
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`
		SELECT COUNT(*) FROM users u
		JOIN helpers h ON h.id = u.id
		%s
	`, whereSQL)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count workers: %w", err)
	}

	return &ListResponse{Items: items, TotalCount: total, Limit: limit, Offset: offset}, nil
}

// Get returns the per-worker detail.
func (r *Repository) Get(ctx context.Context, id string) (*Detail, error) {
	q := fmt.Sprintf(`
		SELECT
		  u.id::text, u.phone, u.name, u.avatar_url,
		  %s AS status,
		  h.is_available,
		  (h.is_available AND h.last_location_at IS NOT NULL
		    AND h.last_location_at > NOW() - INTERVAL '90 seconds') AS is_online,
		  u.is_vip, h.rating, h.total_jobs, h.services,
		  u.created_at, last_b.created_at AS last_active_at,
		  COALESCE(h.address, ''),
		  h.current_lat, h.current_lng,
		  u.suspend_reason, u.ban_reason,
		  COALESCE(stats.completed_30d, 0),
		  COALESCE(stats.earnings_30d_cents, 0),
		  COALESCE(stats.cancellation_rate, 0),
		  h.locality,
		  to_char(h.dob, 'YYYY-MM-DD'),
		  h.gender,
		  COALESCE(h.languages, '{}'),
		  h.alt_phone,
		  h.emergency_contact_name,
		  h.emergency_contact_phone,
		  h.photo_url,
		  h.aadhaar_number,
		  h.aadhaar_verified,
		  h.bank_account_number,
		  h.bank_account_holder_name,
		  h.bank_ifsc,
		  h.bank_verified
		FROM users u
		JOIN helpers h ON h.id = u.id
		LEFT JOIN LATERAL (
		  SELECT created_at FROM bookings
		  WHERE helper_id = u.id
		  ORDER BY created_at DESC
		  LIMIT 1
		) last_b ON TRUE
		LEFT JOIN LATERAL (
		  SELECT
		    COUNT(*) FILTER (WHERE b.status = 'completed' AND b.completed_at >= now() - interval '30 days') AS completed_30d,
		    COALESCE(SUM(b.amount_paise) FILTER (WHERE b.status = 'completed' AND b.completed_at >= now() - interval '30 days'), 0) AS earnings_30d_cents,
		    CASE
		      WHEN COUNT(*) = 0 THEN 0
		      ELSE COUNT(*) FILTER (WHERE b.status = 'cancelled')::float / COUNT(*)
		    END AS cancellation_rate
		  FROM bookings b
		  WHERE b.helper_id = u.id
		) stats ON TRUE
		WHERE u.id = $1::uuid AND u.role = 'pro' AND u.deleted_at IS NULL
	`, statusExpr)

	var (
		d      Detail
		status string
		lat    *float64
		lng    *float64
	)
	// TODO Phase 12: when row.AdminID's role is not 'superadmin', null out
	// AadhaarNumber + BankAccountNumber before returning, and audit the read.
	err := r.read.QueryRow(ctx, q, id).Scan(
		&d.ID, &d.Phone, &d.Name, &d.AvatarURL, &status,
		&d.IsAvailable, &d.IsOnline, &d.IsVIP, &d.Rating, &d.TotalJobs, &d.Categories,
		&d.JoinedAt, &d.LastActiveAt,
		&d.Address, &lat, &lng,
		&d.SuspendReason, &d.BanReason,
		&d.CompletedJobs30d, &d.Earnings30dCents, &d.CancellationRate,
		&d.Locality,
		&d.DOB, &d.Gender, &d.Languages, &d.AltPhone,
		&d.EmergencyContactName, &d.EmergencyContactPhone, &d.PhotoURL,
		&d.AadhaarNumber, &d.AadhaarVerified,
		&d.BankAccountNumber, &d.BankAccountHolderName, &d.BankIFSC, &d.BankVerified,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get worker: %w", err)
	}
	d.Status = Status(status)
	d.CurrentLat = lat
	d.CurrentLng = lng
	return &d, nil
}

// Jobs returns the worker's job history (most recent first).
func (r *Repository) Jobs(ctx context.Context, workerID string, limit int) ([]JobRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.read.Query(ctx, `
		SELECT b.id::text,
		       COALESCE(sc.name, '—'),
		       b.status, b.amount_paise, b.created_at, b.completed_at
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.helper_id = $1::uuid
		ORDER BY b.created_at DESC
		LIMIT $2
	`, workerID, limit)
	if err != nil {
		return nil, fmt.Errorf("worker jobs: %w", err)
	}
	defer rows.Close()
	out := []JobRow{}
	for rows.Next() {
		var j JobRow
		if err := rows.Scan(&j.ID, &j.Category, &j.Status, &j.AmountPaise, &j.CreatedAt, &j.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// LivePins returns all currently-online workers with coordinates. Used by
// the Live Map page; refreshed every 10s. Filters mirror List(StatusActive)
// so suspended/banned/pending/rejected helpers never leak onto the map even
// if they happen to have stale lat/lng + is_available=TRUE.
func (r *Repository) LivePins(ctx context.Context) ([]LivePin, error) {
	rows, err := r.read.Query(ctx, `
		SELECT u.id::text, u.name, u.phone, h.current_lat::float8, h.current_lng::float8, h.rating::float8,
		       active.id::text, active.status
		FROM helpers h
		JOIN users u ON u.id = h.id
		LEFT JOIN LATERAL (
		  SELECT id, status FROM bookings
		  WHERE helper_id = u.id
		    AND status IN ('assigned','en_route','in_progress','arrived')
		  ORDER BY created_at DESC
		  LIMIT 1
		) active ON TRUE
		WHERE h.is_available = TRUE
		  AND h.current_lat IS NOT NULL
		  AND h.current_lng IS NOT NULL
		  AND h.last_location_at IS NOT NULL
		  AND h.last_location_at > NOW() - INTERVAL '90 seconds'
		  AND u.deleted_at IS NULL
		  AND u.role = 'pro'
		  AND u.banned_at IS NULL
		  AND u.is_suspended = FALSE
		  AND h.approval_status = 'approved'
		LIMIT 1000
	`)
	if err != nil {
		return nil, fmt.Errorf("live pins: %w", err)
	}
	defer rows.Close()

	out := []LivePin{}
	for rows.Next() {
		var (
			p             LivePin
			activeID      *string
			activeStatus  *string
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Phone, &p.Lat, &p.Lng, &p.Rating, &activeID, &activeStatus); err != nil {
			return nil, err
		}
		switch {
		case activeID == nil:
			p.JobStatus = "idle"
		case activeStatus != nil && *activeStatus == "in_progress":
			p.JobStatus = "on_job"
			p.ActiveBookingID = activeID
		default: // assigned / en_route / arrived
			p.JobStatus = "en_route"
			p.ActiveBookingID = activeID
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// HasActiveJob reports whether the worker has an in-flight booking. Used
// before force-offline to surface a warning.
func (r *Repository) HasActiveJob(ctx context.Context, workerID string) (bool, *string, error) {
	var bookingID *string
	err := r.read.QueryRow(ctx, `
		SELECT id::text FROM bookings
		WHERE helper_id = $1::uuid
		  AND status IN ('assigned','en_route','in_progress','arrived')
		ORDER BY created_at DESC
		LIMIT 1
	`, workerID).Scan(&bookingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, fmt.Errorf("check active job: %w", err)
	}
	return bookingID != nil, bookingID, nil
}

// ── Mutations ──────────────────────────────────────────────────────────

// CreateRequest is the admin-driven pro registration payload. Replaces
// SQL seeding for net-new pros.
//
// KYC / payment fields landed in migration 106. All KYC fields optional —
// pilot pros can be created with just name+phone and have KYC filled in later
// via PATCH (Phase 12). Plaintext storage is acceptable today; see TODO
// comments on Detail in model.go for the hardening backlog.
type CreateRequest struct {
	Phone             string   `json:"phone"` // 10-digit or +91-prefixed
	Name              string   `json:"name"`
	Email             string   `json:"email,omitempty"`
	Address           string   `json:"address,omitempty"`
	Locality          string   `json:"locality,omitempty"`            // free-text (validated against localities table elsewhere)
	WeeklyHoursTarget int      `json:"weekly_hours_target,omitempty"` // 0 → default 80
	Categories        []string `json:"categories,omitempty"`          // service category slugs
	ZoneID            string   `json:"zone_id,omitempty"`             // optional; inserts pro_zone_assignments
	StartActive       bool     `json:"start_active,omitempty"`        // false = approval_status='pending' (in_training)

	// Personal — migration 106.
	DOB                   string   `json:"dob,omitempty"`                     // YYYY-MM-DD
	Gender                string   `json:"gender,omitempty"`                  // 'male' | 'female' | 'other'
	Languages             []string `json:"languages,omitempty"`               // ISO codes or free text
	AltPhone              string   `json:"alt_phone,omitempty"`
	EmergencyContactName  string   `json:"emergency_contact_name,omitempty"`
	EmergencyContactPhone string   `json:"emergency_contact_phone,omitempty"`
	PhotoURL              string   `json:"photo_url,omitempty"`

	// KYC + payment — migration 106. Plaintext for pilot; Phase 12 encrypts.
	AadhaarNumber         string `json:"aadhaar_number,omitempty"`
	BankAccountNumber     string `json:"bank_account_number,omitempty"`
	BankAccountHolderName string `json:"bank_account_holder_name,omitempty"`
	BankIFSC              string `json:"bank_ifsc,omitempty"`
}

// CreateResult is returned to the admin after a successful pro create.
type CreateResult struct {
	ID    string `json:"id"`
	Phone string `json:"phone"`
}

// ErrPhoneInUse — a user already exists with this phone. Don't reuse it.
var ErrPhoneInUse = errors.New("phone already in use")

// Create inserts users + helpers atomically. Optionally inserts a
// pro_zone_assignments row when ZoneID is supplied. Returns the new pro id.
func (r *Repository) Create(ctx context.Context, req CreateRequest) (*CreateResult, error) {
	// Normalise phone to E.164 (+91XXXXXXXXXX) — the same shape OTP/login
	// emits. 10-digit input is auto-prefixed.
	phone := normalisePhone(req.Phone)
	if !validPhone(phone) {
		return nil, fmt.Errorf("invalid phone")
	}
	if strings.TrimSpace(req.Name) == "" {
		return nil, fmt.Errorf("name required")
	}

	tx, err := r.write.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var userID string
	err = tx.QueryRow(ctx, `
		INSERT INTO users (phone, name, role, has_accepted_privacy_policy, privacy_policy_accepted_at)
		VALUES ($1, $2, 'pro', TRUE, now())
		RETURNING id::text
	`, phone, strings.TrimSpace(req.Name)).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "users_phone_key") || strings.Contains(err.Error(), "duplicate key") {
			return nil, ErrPhoneInUse
		}
		return nil, fmt.Errorf("insert user: %w", err)
	}

	weekly := req.WeeklyHoursTarget
	if weekly <= 0 {
		weekly = 80
	}
	approval := "pending"
	if req.StartActive {
		approval = "approved"
	}
	categories := req.Categories
	if categories == nil {
		categories = []string{}
	}
	locality := strings.TrimSpace(req.Locality)
	var localityArg any
	if locality == "" {
		localityArg = nil
	} else {
		localityArg = locality
	}

	// KYC + personal field marshalling. All optional — pass nil where empty
	// so the column lands NULL (vs. empty string), keeping later "did the
	// admin supply this?" checks unambiguous.
	var (
		dobArg                   any
		genderArg                any
		languagesArg             []string
		altPhoneArg              any
		emergencyNameArg         any
		emergencyPhoneArg        any
		photoURLArg              any
		aadhaarArg               any
		bankAcctArg              any
		bankHolderArg            any
		bankIFSCArg              any
	)
	if s := strings.TrimSpace(req.DOB); s != "" {
		// Parse here so a bad date fails fast instead of relying on the
		// postgres cast error. YYYY-MM-DD only.
		if _, err := time.Parse("2006-01-02", s); err != nil {
			return nil, fmt.Errorf("invalid dob (want YYYY-MM-DD): %w", err)
		}
		dobArg = s
	}
	if s := strings.TrimSpace(req.Gender); s != "" {
		genderArg = s
	}
	if len(req.Languages) > 0 {
		languagesArg = req.Languages
	} else {
		languagesArg = []string{}
	}
	if s := strings.TrimSpace(req.AltPhone); s != "" {
		altPhoneArg = s
	}
	if s := strings.TrimSpace(req.EmergencyContactName); s != "" {
		emergencyNameArg = s
	}
	if s := strings.TrimSpace(req.EmergencyContactPhone); s != "" {
		emergencyPhoneArg = s
	}
	if s := strings.TrimSpace(req.PhotoURL); s != "" {
		photoURLArg = s
	}
	// TODO Phase 12: encrypt aadhaar_number with KMS-managed key before storing.
	if s := strings.TrimSpace(req.AadhaarNumber); s != "" {
		aadhaarArg = s
	}
	// TODO Phase 12: encrypt bank_account_number with KMS-managed key before storing.
	if s := strings.TrimSpace(req.BankAccountNumber); s != "" {
		bankAcctArg = s
	}
	if s := strings.TrimSpace(req.BankAccountHolderName); s != "" {
		bankHolderArg = s
	}
	if s := strings.TrimSpace(req.BankIFSC); s != "" {
		bankIFSCArg = s
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO helpers (
			id, address, approval_status, services, locality, weekly_hours_target,
			dob, gender, languages, alt_phone,
			emergency_contact_name, emergency_contact_phone, photo_url,
			aadhaar_number, bank_account_number, bank_account_holder_name, bank_ifsc
		)
		VALUES (
			$1::uuid, $2, $3, $4, $5, $6,
			$7, $8, $9, $10,
			$11, $12, $13,
			$14, $15, $16, $17
		)
	`,
		userID, strings.TrimSpace(req.Address), approval, categories, localityArg, weekly,
		dobArg, genderArg, languagesArg, altPhoneArg,
		emergencyNameArg, emergencyPhoneArg, photoURLArg,
		aadhaarArg, bankAcctArg, bankHolderArg, bankIFSCArg,
	)
	if err != nil {
		// Surface the CHECK constraint as a 400-worthy validation error.
		if strings.Contains(err.Error(), "helpers_gender_check") {
			return nil, fmt.Errorf("invalid gender (want male|female|other): %w", err)
		}
		return nil, fmt.Errorf("insert helper: %w", err)
	}

	if strings.TrimSpace(req.ZoneID) != "" {
		_, err = tx.Exec(ctx, `
			INSERT INTO pro_zone_assignments (pro_id, zone_id)
			VALUES ($1::uuid, $2::uuid)
			ON CONFLICT DO NOTHING
		`, userID, req.ZoneID)
		if err != nil {
			return nil, fmt.Errorf("insert pro_zone_assignments: %w", err)
		}
	}

	if email := strings.TrimSpace(req.Email); email != "" {
		_, err = tx.Exec(ctx, `UPDATE users SET email = $2 WHERE id = $1::uuid`, userID, email)
		if err != nil {
			return nil, fmt.Errorf("set email: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return &CreateResult{ID: userID, Phone: phone}, nil
}

// normalisePhone returns +91XXXXXXXXXX for plain 10-digit input;
// keeps anything else as-is (validPhone enforces the +91 prefix later).
func normalisePhone(in string) string {
	digits := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		if in[i] >= '0' && in[i] <= '9' {
			digits = append(digits, in[i])
		}
	}
	switch len(digits) {
	case 10:
		return "+91" + string(digits)
	case 12:
		if digits[0] == '9' && digits[1] == '1' {
			return "+" + string(digits)
		}
	}
	return strings.TrimSpace(in)
}

func validPhone(s string) bool {
	if len(s) != 13 || s[:3] != "+91" {
		return false
	}
	for i := 3; i < 13; i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// AddDeduction inserts an admin_pro_deductions row. fortnight_start in the
// request is optional — if present must be YYYY-MM-DD.
func (r *Repository) AddDeduction(ctx context.Context, proID, adminID string, req DeductionRequest) (*DeductionRow, error) {
	var fortnight *time.Time
	if req.FortnightStart != nil && strings.TrimSpace(*req.FortnightStart) != "" {
		t, err := time.Parse("2006-01-02", strings.TrimSpace(*req.FortnightStart))
		if err != nil {
			return nil, fmt.Errorf("invalid fortnight_start: %w", err)
		}
		fortnight = &t
	}

	row := &DeductionRow{
		ProID:       proID,
		AdminID:     adminID,
		AmountPaise: req.AmountPaise,
		Reason:      strings.TrimSpace(req.Reason),
	}
	err := r.write.QueryRow(ctx, `
		INSERT INTO admin_pro_deductions (pro_id, admin_id, amount_paise, reason, fortnight_start)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text, created_at, to_char(fortnight_start, 'YYYY-MM-DD')
	`, proID, adminID, req.AmountPaise, row.Reason, fortnight).
		Scan(&row.ID, &row.CreatedAt, &row.FortnightStart)
	if err != nil {
		// FK violation = unknown pro_id.
		if strings.Contains(err.Error(), "admin_pro_deductions_pro_id_fkey") {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("insert deduction: %w", err)
	}
	if row.FortnightStart != nil && *row.FortnightStart == "" {
		row.FortnightStart = nil
	}
	return row, nil
}

// ListDeductions returns active (non-reversed) deductions newest-first.
func (r *Repository) ListDeductions(ctx context.Context, proID string) ([]DeductionRow, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, pro_id::text, admin_id::text, amount_paise, reason,
		       to_char(fortnight_start, 'YYYY-MM-DD'), created_at, reversed_at
		FROM admin_pro_deductions
		WHERE pro_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 200
	`, proID)
	if err != nil {
		return nil, fmt.Errorf("list deductions: %w", err)
	}
	defer rows.Close()

	out := make([]DeductionRow, 0)
	for rows.Next() {
		var d DeductionRow
		if err := rows.Scan(&d.ID, &d.ProID, &d.AdminID, &d.AmountPaise, &d.Reason,
			&d.FortnightStart, &d.CreatedAt, &d.ReversedAt); err != nil {
			return nil, fmt.Errorf("scan deduction: %w", err)
		}
		if d.FortnightStart != nil && *d.FortnightStart == "" {
			d.FortnightStart = nil
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Approve flips approval_status to 'approved'.
func (r *Repository) Approve(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE helpers SET approval_status = 'approved' WHERE id = $1::uuid
	`, workerID)
	if err != nil {
		return fmt.Errorf("approve: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Reject flips approval_status to 'rejected'. Reason is stored as a note
// (so the reason history is queryable alongside other admin notes).
func (r *Repository) Reject(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE helpers SET approval_status = 'rejected' WHERE id = $1::uuid
	`, workerID)
	if err != nil {
		return fmt.Errorf("reject: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Suspend / Unsuspend / Ban / Unban operate on the user row exactly like
// the users module. Duplicated here so the workers handler stays
// self-contained (we don't want it reaching across to internal/crm/users).
func (r *Repository) Suspend(ctx context.Context, workerID, reason string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users SET is_suspended = TRUE, suspend_reason = $2, updated_at = now()
		WHERE id = $1::uuid AND role = 'pro' AND deleted_at IS NULL
	`, workerID, reason)
	if err != nil {
		return fmt.Errorf("suspend worker: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Unsuspend clears the suspension.
func (r *Repository) Unsuspend(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users SET is_suspended = FALSE, suspend_reason = NULL, updated_at = now()
		WHERE id = $1::uuid AND role = 'pro' AND deleted_at IS NULL
	`, workerID)
	if err != nil {
		return fmt.Errorf("unsuspend worker: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ForceOffline toggles is_available=false. Doesn't cancel any active booking.
func (r *Repository) ForceOffline(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `UPDATE helpers SET is_available = FALSE WHERE id = $1::uuid`, workerID)
	if err != nil {
		return fmt.Errorf("force offline: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetCategories overwrites the worker's services array.
func (r *Repository) SetCategories(ctx context.Context, workerID string, cats []string) error {
	if cats == nil {
		cats = []string{}
	}
	res, err := r.write.Exec(ctx, `UPDATE helpers SET services = $2 WHERE id = $1::uuid`, workerID, cats)
	if err != nil {
		return fmt.Errorf("set categories: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetLocality validates against active localities and writes the canonical
// (case-corrected) name back. Empty input clears the field. Returns the
// stored value or an error suitable for surfacing to the admin user.
func (r *Repository) SetLocality(ctx context.Context, workerID, locality string) (string, error) {
	loc := strings.TrimSpace(locality)
	if loc == "" {
		_, err := r.write.Exec(ctx, `UPDATE helpers SET locality = NULL WHERE id = $1::uuid`, workerID)
		if err != nil {
			return "", fmt.Errorf("clear locality: %w", err)
		}
		return "", nil
	}
	var canonical string
	err := r.write.QueryRow(ctx,
		`SELECT name FROM localities WHERE active = true AND name ILIKE $1 LIMIT 1`,
		loc,
	).Scan(&canonical)
	if err != nil {
		return "", fmt.Errorf("unknown locality")
	}
	if _, err := r.write.Exec(ctx,
		`UPDATE helpers SET locality = $2 WHERE id = $1::uuid`, workerID, canonical,
	); err != nil {
		return "", fmt.Errorf("write locality: %w", err)
	}
	return canonical, nil
}
