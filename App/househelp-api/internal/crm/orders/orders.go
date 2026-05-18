// Package orders is the CRM-side surface for booking lifecycle management.
// Reads happen on the read pool, mutations on the write pool. The package
// never reaches into matching/booking business logic — it only annotates
// existing rows on bookings + writes to crm_audit_log.
package orders

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

var ErrNotFound = errors.New("order not found")

// ── Models ─────────────────────────────────────────────────────────────

// ListItem is a row in the orders table.
type ListItem struct {
	ID             string     `json:"id"`
	CustomerName   *string    `json:"customer_name,omitempty"`
	CustomerPhone  string     `json:"customer_phone"`
	WorkerName     *string    `json:"worker_name,omitempty"`
	WorkerPhone    *string    `json:"worker_phone,omitempty"`
	Category       string     `json:"category"`
	Status         string     `json:"status"`
	AmountPaise    int        `json:"price_paise"`
	DiscountPaise  int        `json:"discount_paise"`
	PromoCode      *string    `json:"promo_code,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
}

// Detail is the per-order drawer payload, including the timeline.
type Detail struct {
	ListItem
	CustomerID    string         `json:"customer_id"`
	WorkerID      *string        `json:"worker_id,omitempty"`
	Address       string         `json:"address"`
	Lat           float64        `json:"lat"`
	Lng           float64        `json:"lng"`
	ScheduledTime *time.Time     `json:"scheduled_time,omitempty"`
	MatchedAt     *time.Time     `json:"matched_at,omitempty"`
	AcceptedAt    *time.Time     `json:"accepted_at,omitempty"`
	StartedAt     *time.Time     `json:"started_at,omitempty"`
	ArrivedAt     *time.Time     `json:"arrived_at,omitempty"`
	CancelledAt   *time.Time     `json:"cancelled_at,omitempty"`
	CancelledBy   *string        `json:"cancelled_by,omitempty"`
	EnRouteAt     *time.Time     `json:"en_route_at,omitempty"`
	CompletedAt2  *time.Time     `json:"-"`
	Services      []ServiceLine  `json:"services"`
}

// ServiceLine is one row of the order's task checklist (booking_services join).
type ServiceLine struct {
	ServiceID       string     `json:"service_id"`
	ServiceName     string     `json:"service_name"`
	DurationMinutes int        `json:"duration_minutes"`
	PricePaise      int        `json:"price_paise"`
	Status          string     `json:"status"`
	DisplayOrder    int        `json:"display_order"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	SkipReason      *string    `json:"skip_reason,omitempty"`
}

// CancelRequest is the body of POST /orders/:id/cancel.
type CancelRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// ReassignRequest is the body of POST /orders/:id/reassign.
type ReassignRequest struct {
	NewWorkerID string `json:"new_worker_id" validate:"required"`
	Reason      string `json:"reason" validate:"required,min=2,max=500"`
}

// ReassignResult is the post-mutation snapshot returned by Repository.Reassign,
// used by the handler to fan out audit / notifications / webhook.
type ReassignResult struct {
	OldHelperID         string
	NewHelperID         string
	CustomerID          string
	ServiceCategoryName string
	NewHelperName       string
}

// AvailableWorker is one row in the GET /orders/:id/available-workers payload.
type AvailableWorker struct {
	WorkerID      string   `json:"worker_id"`
	Name          string   `json:"name"`
	Rating        float64  `json:"rating"`
	DistanceKm    float64  `json:"distance_km"`
	Categories    []string `json:"categories"`
	CurrentStatus string   `json:"current_status"` // always "online_idle" — they're filtered to that.
}

// ── Repository ─────────────────────────────────────────────────────────

// Repository wraps DB access for the orders module.
type Repository struct {
	read, write *pgxpool.Pool
	rdb         *redis.Client
}

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

// SetRedis wires the Redis client used for GEOSEARCH on helpers:locations.
// Optional — endpoints that need it return a 503 if unset.
func (r *Repository) SetRedis(rdb *redis.Client) { r.rdb = rdb }

// List returns a page of orders matching the filter.
func (r *Repository) List(ctx context.Context, search, status, category, customerID, workerID string, fromTS, toTS *time.Time, minCents, maxCents *int, sortBy, sortDir string, limit, offset int) ([]ListItem, int, error) {
	args := []any{}
	conds := []string{"1=1"}
	if search != "" {
		args = append(args, "%"+strings.ToLower(search)+"%")
		i := len(args)
		conds = append(conds, fmt.Sprintf(
			"(LOWER(b.id::text) LIKE $%d OR LOWER(cu.name) LIKE $%d OR LOWER(cu.phone) LIKE $%d OR LOWER(hu.name) LIKE $%d)",
			i, i, i, i,
		))
	}
	if status != "" {
		args = append(args, status)
		conds = append(conds, fmt.Sprintf("b.status = $%d", len(args)))
	}
	if category != "" {
		args = append(args, category)
		conds = append(conds, fmt.Sprintf("LOWER(sc.name) = LOWER($%d)", len(args)))
	}
	if customerID != "" {
		args = append(args, customerID)
		conds = append(conds, fmt.Sprintf("b.customer_id = $%d::uuid", len(args)))
	}
	if workerID != "" {
		args = append(args, workerID)
		conds = append(conds, fmt.Sprintf("b.helper_id = $%d::uuid", len(args)))
	}
	if fromTS != nil {
		args = append(args, *fromTS)
		conds = append(conds, fmt.Sprintf("b.created_at >= $%d", len(args)))
	}
	if toTS != nil {
		args = append(args, *toTS)
		conds = append(conds, fmt.Sprintf("b.created_at <= $%d", len(args)))
	}
	if minCents != nil {
		args = append(args, *minCents)
		conds = append(conds, fmt.Sprintf("b.amount_paise >= $%d", len(args)))
	}
	if maxCents != nil {
		args = append(args, *maxCents)
		conds = append(conds, fmt.Sprintf("b.amount_paise <= $%d", len(args)))
	}

	sortColMap := map[string]string{"": "b.created_at", "created_at": "b.created_at", "price": "b.amount_paise", "status": "b.status"}
	sortCol, ok := sortColMap[sortBy]
	if !ok {
		sortCol = "b.created_at"
	}
	sortDirN := strings.ToUpper(strings.TrimSpace(sortDir))
	if sortDirN != "ASC" {
		sortDirN = "DESC"
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	whereSQL := "WHERE " + strings.Join(conds, " AND ")
	args = append(args, limit, offset)
	limitParam, offsetParam := len(args)-1, len(args)

	pageSQL := fmt.Sprintf(`
		SELECT b.id::text, cu.name, COALESCE(cu.phone, '(deleted)'), hu.name, hu.phone,
		       COALESCE(sc.name, '—'),
		       b.status, b.amount_paise, b.discount_paise, b.promo_code,
		       b.created_at, b.completed_at
		FROM bookings b
		LEFT JOIN users cu ON cu.id = b.customer_id AND cu.deleted_at IS NULL
		LEFT JOIN users hu ON hu.id = b.helper_id AND hu.deleted_at IS NULL
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		%s
		ORDER BY %s %s
		LIMIT $%d OFFSET $%d
	`, whereSQL, sortCol, sortDirN, limitParam, offsetParam)

	rows, err := r.read.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list orders: %w", err)
	}
	defer rows.Close()

	items := []ListItem{}
	for rows.Next() {
		var it ListItem
		if err := rows.Scan(
			&it.ID, &it.CustomerName, &it.CustomerPhone, &it.WorkerName, &it.WorkerPhone,
			&it.Category, &it.Status, &it.AmountPaise, &it.DiscountPaise, &it.PromoCode,
			&it.CreatedAt, &it.CompletedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan order: %w", err)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`
		SELECT COUNT(*) FROM bookings b
		LEFT JOIN users cu ON cu.id = b.customer_id AND cu.deleted_at IS NULL
		LEFT JOIN users hu ON hu.id = b.helper_id AND hu.deleted_at IS NULL
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		%s
	`, whereSQL)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count orders: %w", err)
	}
	return items, total, nil
}

// Get returns the per-order detail with the per-service task list.
func (r *Repository) Get(ctx context.Context, id string) (*Detail, error) {
	const q = `
		SELECT b.id::text, cu.name, COALESCE(cu.phone, '(deleted)'), hu.name, hu.phone,
		       COALESCE(sc.name, '—'),
		       b.status, b.amount_paise, b.discount_paise, b.promo_code,
		       b.created_at, b.completed_at,
		       b.customer_id::text, b.helper_id::text,
		       b.address, b.lat::float8, b.lng::float8,
		       b.scheduled_time, b.matched_at, b.accepted_at,
		       b.started_at, b.arrived_at, b.cancelled_at, b.cancelled_by,
		       b.en_route_at
		FROM bookings b
		LEFT JOIN users cu ON cu.id = b.customer_id AND cu.deleted_at IS NULL
		LEFT JOIN users hu ON hu.id = b.helper_id AND hu.deleted_at IS NULL
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.id = $1::uuid
	`
	var d Detail
	err := r.read.QueryRow(ctx, q, id).Scan(
		&d.ID, &d.CustomerName, &d.CustomerPhone, &d.WorkerName, &d.WorkerPhone,
		&d.Category, &d.Status, &d.AmountPaise, &d.DiscountPaise, &d.PromoCode,
		&d.CreatedAt, &d.CompletedAt,
		&d.CustomerID, &d.WorkerID,
		&d.Address, &d.Lat, &d.Lng,
		&d.ScheduledTime, &d.MatchedAt, &d.AcceptedAt,
		&d.StartedAt, &d.ArrivedAt, &d.CancelledAt, &d.CancelledBy,
		&d.EnRouteAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get order: %w", err)
	}

	// Per-service task list. A failed join shouldn't fail the whole
	// detail — empty Services is acceptable for legacy single-category
	// rows that pre-date booking_services.
	rows, sErr := r.read.Query(ctx, `
		SELECT bs.service_id::text, COALESCE(sc.name, ''), bs.duration_minutes,
		       bs.price_paise, bs.status, bs.display_order,
		       bs.started_at, bs.completed_at, bs.skip_reason
		FROM booking_services bs
		LEFT JOIN service_categories sc ON sc.id = bs.service_id
		WHERE bs.booking_id = $1::uuid
		ORDER BY bs.display_order ASC, bs.id ASC
	`, id)
	if sErr == nil {
		defer rows.Close()
		d.Services = make([]ServiceLine, 0)
		for rows.Next() {
			var s ServiceLine
			if err := rows.Scan(&s.ServiceID, &s.ServiceName, &s.DurationMinutes,
				&s.PricePaise, &s.Status, &s.DisplayOrder,
				&s.StartedAt, &s.CompletedAt, &s.SkipReason); err != nil {
				return nil, fmt.Errorf("scan service line: %w", err)
			}
			d.Services = append(d.Services, s)
		}
	} else {
		d.Services = []ServiceLine{}
	}
	return &d, nil
}

// AddNote inserts an admin_booking_notes row attached to this order.
// Returns the persisted shape including the admin's email for display.
func (r *Repository) AddNote(ctx context.Context, bookingID, adminID, body string) (*NoteRow, error) {
	// Booking existence check — return 404 before INSERTing a dangling row.
	var exists bool
	if err := r.read.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM bookings WHERE id = $1::uuid)`, bookingID,
	).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check booking: %w", err)
	}
	if !exists {
		return nil, ErrNotFound
	}

	row := &NoteRow{BookingID: bookingID, AdminID: adminID, Body: body}
	err := r.write.QueryRow(ctx, `
		INSERT INTO admin_booking_notes (booking_id, admin_id, body)
		VALUES ($1::uuid, $2::uuid, $3)
		RETURNING id::text, created_at
	`, bookingID, adminID, body).Scan(&row.ID, &row.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert note: %w", err)
	}
	// Best-effort email join.
	_ = r.read.QueryRow(ctx,
		`SELECT email FROM crm_admins WHERE id = $1::uuid`, adminID,
	).Scan(&row.AdminEmail)
	return row, nil
}

// ListNotes returns notes for the booking newest-first, with admin email
// joined in for display.
func (r *Repository) ListNotes(ctx context.Context, bookingID string) ([]NoteRow, error) {
	rows, err := r.read.Query(ctx, `
		SELECT n.id::text, n.booking_id::text, n.admin_id::text,
		       COALESCE(a.email::text, ''), n.body, n.created_at
		FROM admin_booking_notes n
		LEFT JOIN crm_admins a ON a.id = n.admin_id
		WHERE n.booking_id = $1::uuid
		ORDER BY n.created_at DESC
		LIMIT 200
	`, bookingID)
	if err != nil {
		return nil, fmt.Errorf("list notes: %w", err)
	}
	defer rows.Close()
	out := make([]NoteRow, 0)
	for rows.Next() {
		var n NoteRow
		if err := rows.Scan(&n.ID, &n.BookingID, &n.AdminID, &n.AdminEmail, &n.Body, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan note: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// Cancel marks an order cancelled. Refuses to cancel completed orders —
// admins should issue a refund for those instead.
func (r *Repository) Cancel(ctx context.Context, id, reason, adminEmail string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE bookings
		SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, updated_at = now()
		WHERE id = $1::uuid AND status NOT IN ('completed','cancelled')
	`, id, "admin:"+adminEmail)
	if err != nil {
		return fmt.Errorf("cancel order: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("order is completed or already cancelled")
	}
	_ = reason // captured in audit log by handler
	return nil
}

// MarkComplete forces an order into 'completed' state. Pro Mode only.
func (r *Repository) MarkComplete(ctx context.Context, id string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE bookings
		SET status = 'completed', completed_at = now(), updated_at = now()
		WHERE id = $1::uuid AND status NOT IN ('completed','cancelled')
	`, id)
	if err != nil {
		return fmt.Errorf("mark complete: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("order is already completed or cancelled")
	}
	return nil
}

// AvailableWorkersNear returns approved + available + idle helpers within
// radiusKm of the order's lat/lng who offer the order's category. Distance
// comes from Redis GEOSEARCH on helpers:locations; Postgres enriches name /
// rating / categories and applies the eligibility filter.
func (r *Repository) AvailableWorkersNear(ctx context.Context, orderID string, radiusKm float64) ([]AvailableWorker, error) {
	if r.rdb == nil {
		return nil, errors.New("redis not configured")
	}
	// 1. Load order context.
	var (
		currentHelperID *string
		categoryID      string
		lat, lng        float64
		status          string
	)
	err := r.read.QueryRow(ctx, `
		SELECT helper_id::text, service_category_id::text, lat::float8, lng::float8, status
		FROM bookings WHERE id = $1::uuid
	`, orderID).Scan(&currentHelperID, &categoryID, &lat, &lng, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load order for available-workers: %w", err)
	}
	if status == "completed" || status == "cancelled" {
		return nil, fmt.Errorf("order is %s — cannot list reassign candidates", status)
	}

	// 2. Redis GEOSEARCH for nearby helpers (mirror internal/matching/engine.go).
	geoResults, err := r.rdb.GeoSearchLocation(ctx, "helpers:locations",
		&redis.GeoSearchLocationQuery{
			GeoSearchQuery: redis.GeoSearchQuery{
				Longitude:  lng,
				Latitude:   lat,
				Radius:     radiusKm,
				RadiusUnit: "km",
				Sort:       "ASC",
				Count:      100,
			},
			WithDist: true,
		},
	).Result()
	if err != nil {
		return nil, fmt.Errorf("geo search: %w", err)
	}
	if len(geoResults) == 0 {
		return []AvailableWorker{}, nil
	}

	helperIDs := make([]string, 0, len(geoResults))
	distByID := make(map[string]float64, len(geoResults))
	for _, g := range geoResults {
		helperIDs = append(helperIDs, g.Name)
		distByID[g.Name] = g.Dist
	}

	// 3. Postgres enrich + filter. We resolve the category NAME so the services
	// TEXT[] ANY-match works (services stores category names, not IDs).
	var categoryName string
	if err := r.read.QueryRow(ctx, `SELECT name FROM service_categories WHERE id = $1::uuid`, categoryID).Scan(&categoryName); err != nil {
		return nil, fmt.Errorf("load category name: %w", err)
	}

	currentID := ""
	if currentHelperID != nil {
		currentID = *currentHelperID
	}

	rows, err := r.read.Query(ctx, `
		SELECT h.id::text, COALESCE(u.name, '—'), COALESCE(h.rating, 5.0), h.services
		FROM helpers h
		JOIN users u ON u.id = h.id AND u.deleted_at IS NULL
		WHERE h.id = ANY($1::uuid[])
		  AND h.is_available = true
		  AND h.approval_status = 'approved'
		  AND $2 = ANY(h.services)
		  AND ($3 = '' OR h.id != $3::uuid)
		  AND NOT EXISTS (
		    SELECT 1 FROM bookings b
		    WHERE b.helper_id = h.id AND b.status IN ('accepted','in_progress')
		  )
	`, helperIDs, categoryName, currentID)
	if err != nil {
		return nil, fmt.Errorf("enrich available workers: %w", err)
	}
	defer rows.Close()

	out := make([]AvailableWorker, 0, len(geoResults))
	for rows.Next() {
		var (
			id, name string
			rating   float64
			services []string
		)
		if err := rows.Scan(&id, &name, &rating, &services); err != nil {
			return nil, fmt.Errorf("scan available worker: %w", err)
		}
		out = append(out, AvailableWorker{
			WorkerID:      id,
			Name:          name,
			Rating:        rating,
			DistanceKm:    distByID[id],
			Categories:    services,
			CurrentStatus: "online_idle",
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sort.Slice(out, func(i, j int) bool { return out[i].DistanceKm < out[j].DistanceKm })
	return out, nil
}

// Reassign moves an in-flight booking from its current helper to newWorkerID.
// Validates eligibility inside a single tx with FOR UPDATE on the booking row.
// Returns the before/after IDs needed by the handler for audit + notifications.
func (r *Repository) Reassign(ctx context.Context, orderID, newWorkerID, reason, adminEmail string) (*ReassignResult, error) {
	tx, err := r.write.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Lock + load booking.
	var (
		currentHelperID *string
		customerID      string
		categoryID      string
		status          string
	)
	err = tx.QueryRow(ctx, `
		SELECT helper_id::text, customer_id::text, service_category_id::text, status
		FROM bookings WHERE id = $1::uuid FOR UPDATE
	`, orderID).Scan(&currentHelperID, &customerID, &categoryID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load booking: %w", err)
	}

	// 2. Status guard — only mid-flight bookings can be reassigned.
	if status != "accepted" && status != "in_progress" {
		return nil, fmt.Errorf("order is %s — only accepted/in_progress orders can be reassigned", status)
	}
	oldHelperID := ""
	if currentHelperID != nil {
		oldHelperID = *currentHelperID
	}
	if oldHelperID == newWorkerID {
		return nil, errors.New("worker is already assigned to this order")
	}

	// 3. Resolve the category NAME (helpers.services stores names, not IDs).
	var categoryName string
	if err := tx.QueryRow(ctx, `SELECT name FROM service_categories WHERE id = $1::uuid`, categoryID).Scan(&categoryName); err != nil {
		return nil, fmt.Errorf("load category name: %w", err)
	}

	// 4. Validate the new worker.
	var (
		isAvailable    bool
		approvalStatus string
		services       []string
	)
	err = tx.QueryRow(ctx, `
		SELECT is_available, approval_status, services FROM helpers WHERE id = $1::uuid
	`, newWorkerID).Scan(&isAvailable, &approvalStatus, &services)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("new worker not found")
	}
	if err != nil {
		return nil, fmt.Errorf("load new worker: %w", err)
	}
	if approvalStatus != "approved" {
		return nil, errors.New("new worker is not approved")
	}
	if !isAvailable {
		return nil, errors.New("new worker is not available")
	}
	if !slices.Contains(services, categoryName) {
		return nil, errors.New("new worker does not offer this category")
	}

	// 5. Idle check — refuse if the new worker is already on another active job.
	var busy bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM bookings WHERE helper_id = $1::uuid AND status IN ('accepted','in_progress')
		)
	`, newWorkerID).Scan(&busy); err != nil {
		return nil, fmt.Errorf("check new worker idle: %w", err)
	}
	if busy {
		return nil, errors.New("new worker is busy with another active booking")
	}

	// 6. Apply.
	if _, err := tx.Exec(ctx, `
		UPDATE bookings SET helper_id = $2::uuid, updated_at = now() WHERE id = $1::uuid
	`, orderID, newWorkerID); err != nil {
		return nil, fmt.Errorf("update booking helper: %w", err)
	}

	// 7. Resolve new helper's display name for the customer notification.
	var newHelperName string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(name, '') FROM users WHERE id = $1::uuid`, newWorkerID).Scan(&newHelperName); err != nil {
		newHelperName = ""
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	_ = reason     // captured by audit log on the handler side
	_ = adminEmail // captured by audit log on the handler side

	return &ReassignResult{
		OldHelperID:         oldHelperID,
		NewHelperID:         newWorkerID,
		CustomerID:          customerID,
		ServiceCategoryName: categoryName,
		NewHelperName:       newHelperName,
	}, nil
}

// ── Handler ────────────────────────────────────────────────────────────

// Handler is the HTTP layer.
type Handler struct {
	repo       *Repository
	recorder   *audit.Recorder
	notif      *notification.Service
	dispatcher *webhooks.Dispatcher
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// SetRedis forwards the Redis client to the underlying Repository so geo
// lookups (available-workers) can run. Optional.
func (h *Handler) SetRedis(rdb *redis.Client) {
	if h.repo != nil {
		h.repo.SetRedis(rdb)
	}
}

// SetNotification wires the FCM service used for reassign notifications.
func (h *Handler) SetNotification(n *notification.Service) { h.notif = n }

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

// RegisterRoutes mounts /orders/* on the authed group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/orders")
	read := middleware.RequirePermission("orders.read")
	g.Get("/",                       read, h.List)
	g.Get("/:id",                    read, h.Get)
	g.Get("/:id/available-workers",  read, h.AvailableWorkers)
	g.Get("/:id/notes",              read, h.ListNotes)
	g.Post("/:id/notes",             middleware.RequirePermission("orders.add_note"), h.AddNote)
	g.Post("/:id/cancel",            middleware.RequirePermission("orders.cancel"), h.Cancel)
	g.Post("/:id/complete",          middleware.RequirePermission("orders.complete"), h.Complete)
	g.Post("/:id/reassign",          middleware.RequirePermission("orders.reassign"), h.Reassign)
}

// NoteRequest is the body of POST /orders/:id/notes.
type NoteRequest struct {
	Body string `json:"body"`
}

// NoteRow is one persisted admin note attached to a booking.
type NoteRow struct {
	ID         string    `json:"id"`
	BookingID  string    `json:"booking_id"`
	AdminID    string    `json:"admin_id"`
	AdminEmail string    `json:"admin_email,omitempty"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

// AddNote handles POST /orders/:id/notes.
func (h *Handler) AddNote(c *fiber.Ctx) error {
	id := c.Params("id")
	var req NoteRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "body required"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	row, err := h.repo.AddNote(c.UserContext(), id, adminID, body)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add note"})
	}
	h.audit(c, "order.note.add", id, nil, row)
	return c.Status(fiber.StatusCreated).JSON(row)
}

// ListNotes handles GET /orders/:id/notes.
func (h *Handler) ListNotes(c *fiber.Ctx) error {
	id := c.Params("id")
	rows, err := h.repo.ListNotes(c.UserContext(), id)
	if err != nil {
		log.Error().Err(err).Msg("[crm.orders] list notes failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": rows})
}

// List handles GET /orders.
func (h *Handler) List(c *fiber.Ctx) error {
	q := c.Query
	limit, _ := strconv.Atoi(q("limit", "50"))
	offset, _ := strconv.Atoi(q("offset", "0"))

	var fromTS, toTS *time.Time
	if v := q("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			fromTS = &t
		}
	}
	if v := q("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			toTS = &t
		}
	}
	var minC, maxC *int
	if v := q("min_cents"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			minC = &n
		}
	}
	if v := q("max_cents"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxC = &n
		}
	}

	items, total, err := h.repo.List(c.UserContext(),
		q("search"), q("status"), q("category"), q("customer_id"), q("worker_id"),
		fromTS, toTS, minC, maxC, q("sort_by"), q("sort_dir"), limit, offset,
	)
	if err != nil {
		log.Error().Err(err).Msg("[crm.orders] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

// Get handles GET /orders/:id.
func (h *Handler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	d, err := h.repo.Get(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	// Audit single-order PII reads (audit NEW-A1-002 partial).
	// List endpoint intentionally NOT audited — high volume.
	h.audit(c, "order.view", id, nil, nil)
	return c.JSON(d)
}

// Cancel handles POST /orders/:id/cancel.
func (h *Handler) Cancel(c *fiber.Ctx) error {
	var req CancelRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	if err := h.repo.Cancel(c.UserContext(), id, req.Reason, adminEmail); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "order.cancel", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Complete handles POST /orders/:id/complete (Pro Mode only on the SPA).
func (h *Handler) Complete(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.MarkComplete(c.UserContext(), id); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "order.complete_manual", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// AvailableWorkers handles GET /orders/:id/available-workers.
// No extra permission required — equivalent to viewing the orders detail.
func (h *Handler) AvailableWorkers(c *fiber.Ctx) error {
	id := c.Params("id")
	radiusKm := 10.0
	const maxRadiusKm = 50.0
	if v := c.Query("radius_km"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			// Hard cap: clamp to 50km before the DB call so a runaway client
			// can't widen the geo search arbitrarily.
			if f > maxRadiusKm {
				f = maxRadiusKm
			}
			radiusKm = f
		}
	}
	workers, err := h.repo.AvailableWorkersNear(c.UserContext(), id, radiusKm)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		log.Error().Err(err).Str("order_id", id).Msg("[crm.orders] available workers failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	// Audit candidate-worker reveal (audit A5-02 broader). Returns nearby
	// worker names + location proxy; HIGH PII.
	h.audit(c, "order.candidates.list", id, nil, fiber.Map{"count": len(workers), "radius_km": radiusKm})
	return c.JSON(fiber.Map{"items": workers, "radius_km": radiusKm})
}

// Reassign handles POST /orders/:id/reassign.
func (h *Handler) Reassign(c *fiber.Ctx) error {
	var req ReassignRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if req.NewWorkerID == "" || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "new_worker_id and reason are required"})
	}
	id := c.Params("id")
	adminEmail, _ := c.Locals("crmAdminEmail").(string)

	result, err := h.repo.Reassign(c.UserContext(), id, req.NewWorkerID, req.Reason, adminEmail)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	h.audit(c, "order.reassign", id,
		map[string]any{"old_helper_id": result.OldHelperID},
		map[string]any{"new_helper_id": result.NewHelperID, "reason": req.Reason})

	// Best-effort notifications — never fail the request on a notify error.
	if h.notif != nil {
		if result.OldHelperID != "" {
			if err := h.notif.NotifyProBookingUnassigned(c.UserContext(), result.OldHelperID, id); err != nil {
				log.Warn().Err(err).Str("helper_id", result.OldHelperID).Msg("[crm.orders] notify previous helper failed")
			}
		}
		if err := h.notif.NotifyProBookingReassigned(c.UserContext(), result.NewHelperID, id, result.ServiceCategoryName); err != nil {
			log.Warn().Err(err).Str("helper_id", result.NewHelperID).Msg("[crm.orders] notify new helper failed")
		}
		if result.CustomerID != "" {
			if err := h.notif.NotifyCustomerWorkerChanged(c.UserContext(), result.CustomerID, result.NewHelperName, id); err != nil {
				log.Warn().Err(err).Str("customer_id", result.CustomerID).Msg("[crm.orders] notify customer failed")
			}
		}
	}

	if h.dispatcher != nil {
		h.dispatcher.Dispatch(c.UserContext(), webhooks.EventOrderReassigned, webhooks.OrderReassignedEvent{
			OrderID:          id,
			PreviousHelperID: result.OldHelperID,
			NewHelperID:      result.NewHelperID,
			Reason:           req.Reason,
			ReassignedBy:     adminEmail,
			OccurredAt:       time.Now().UTC(),
		})
	}

	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "orders",
		TargetType: "order", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
