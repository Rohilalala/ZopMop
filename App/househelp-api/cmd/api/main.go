package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	// pprof handlers are registered onto http.DefaultServeMux only when
	// the binary is built with `-tags pprof` (see pprof_dev.go). The
	// ENABLE_PPROF=1 listener below still starts in either case but
	// serves nothing useful without the build tag (audit E3D-2 / NEW-F3-002).
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/adityarohilla/househelp-api/internal/addresses"
	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/auth"
	"github.com/adityarohilla/househelp-api/internal/bff"
	"github.com/adityarohilla/househelp-api/internal/booking"
	cartmod "github.com/adityarohilla/househelp-api/internal/cart"
	"github.com/adityarohilla/househelp-api/internal/compliance"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/content"
	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/localities"
	"github.com/adityarohilla/househelp-api/internal/crm/notifications"
	"github.com/adityarohilla/househelp-api/internal/disputes"
	"github.com/adityarohilla/househelp-api/internal/experts"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	helpermod "github.com/adityarohilla/househelp-api/internal/helper"
	"github.com/adityarohilla/househelp-api/internal/insights"
	"github.com/adityarohilla/househelp-api/internal/leave"
	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/observability"
	"github.com/adityarohilla/househelp-api/internal/offers"
	"github.com/adityarohilla/househelp-api/internal/outbox"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/payroll"
	"github.com/adityarohilla/househelp-api/internal/places"
	"github.com/adityarohilla/househelp-api/internal/reengagement"
	"github.com/adityarohilla/househelp-api/internal/referral"
	"github.com/adityarohilla/househelp-api/internal/reviews"
	"github.com/adityarohilla/househelp-api/internal/roomies"
	"github.com/adityarohilla/househelp-api/internal/segments"
	"github.com/adityarohilla/househelp-api/internal/appversion"
	servicesmod "github.com/adityarohilla/househelp-api/internal/services"
	"github.com/adityarohilla/househelp-api/internal/shift"
	slotsmod "github.com/adityarohilla/househelp-api/internal/slots"
	"github.com/adityarohilla/househelp-api/internal/wallet"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
	zonesmod "github.com/adityarohilla/househelp-api/internal/zones"
	"github.com/adityarohilla/househelp-api/internal/zop"
	"github.com/adityarohilla/househelp-api/pkg/config"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/logger"
	"github.com/jackc/pgx/v5"

	"github.com/gofiber/fiber/v2"
	fiberrecover "github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/rs/zerolog/log"
)

// loadSafeLayouts reads every safe-layout JSON file from disk and returns a map
// keyed by filename without extension (e.g. "home.json" → "home"). The dir is
// resolved relative to the binary's working directory and falls back to
// scanning a few common locations so dev/prod layouts both work. Best-effort:
// a missing or malformed file is logged and skipped — handlers degrade to a
// minimal empty-page envelope.
func loadSafeLayouts() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	candidates := []string{
		"static/safe_layouts",
		"./static/safe_layouts",
		"../static/safe_layouts",
		"../../static/safe_layouts",
	}
	var dir string
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			dir = c
			break
		}
	}
	if dir == "" {
		log.Warn().Msg("[sdui] safe_layouts directory not found")
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Warn().Err(err).Msg("[sdui] read safe layouts dir")
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			log.Warn().Err(err).Str("file", e.Name()).Msg("[sdui] read safe layout failed")
			continue
		}
		key := strings.TrimSuffix(e.Name(), ".json")
		out[key] = json.RawMessage(raw)
	}
	return out
}

func main() {
	// Load configuration.
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	// Initialize logger.
	logger.Init(cfg.Env)
	log.Info().Str("env", cfg.Env).Msg("starting househelp-api")

	// Initialise Sentry error tracking. No-op when SENTRY_DSN is unset
	// so dev / CI runs don't need a Sentry project. The returned flush
	// is deferred so pending events ship before process exit.
	flushSentry := observability.Init(cfg.Env)
	defer flushSentry()

	// Optional pprof endpoint, bound to localhost so it's never reachable from
	// outside the host. Enable with ENABLE_PPROF=1 (dev or perf-test runs only).
	if os.Getenv("ENABLE_PPROF") == "1" {
		pprofAddr := "127.0.0.1:6060"
		go func() {
			log.Info().Str("addr", pprofAddr).Msg("pprof listening")
			// Explicit timeouts so the pprof listener can't be wedged by a
			// slow client (gosec G114). 30s is generous for an internal
			// debug endpoint serving small profile responses.
			pprofSrv := &http.Server{
				Addr:         pprofAddr,
				Handler:      nil, // DefaultServeMux (pprof handlers register there)
				ReadTimeout:  30 * time.Second,
				WriteTimeout: 30 * time.Second,
			}
			if err := pprofSrv.ListenAndServe(); err != nil {
				log.Warn().Err(err).Msg("pprof server exited")
			}
		}()
	}

	// Connect to PostgreSQL.
	ctx := context.Background()
	dbPool, err := database.NewPostgresPool(ctx, cfg.DatabaseURL, database.PostgresPoolConfig{
		MinConns:          cfg.DBPoolMinConns,
		MaxConns:          cfg.DBPoolMaxConns,
		MaxConnLifetime:   time.Duration(cfg.DBPoolMaxConnLife) * time.Minute,
		MaxConnIdleTime:   time.Duration(cfg.DBPoolMaxConnIdle) * time.Minute,
		HealthCheckPeriod: time.Duration(cfg.DBPoolHealthCheck) * time.Second,
	})
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to PostgreSQL")
	}
	defer dbPool.Close()

	// Connect to Redis.
	rdb, err := database.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to Redis")
	}
	defer func() {
		if closeErr := rdb.Close(); closeErr != nil {
			log.Error().Err(closeErr).Msg("failed to close Redis connection")
		}
	}()

	// Initialize Fiber app with security settings.
	//
	// WriteTimeout MUST be >= the longest per-handler Timeout middleware
	// value, otherwise Fiber kills the connection mid-response and the
	// client sees garbage. Audit E2-3. Current per-handler ceilings:
	//   - /api/v1/zop/chat        : mw.Timeout(90s)  — LLM streaming
	//   - /me/export              : variable; bounded only by client patience
	//   - everything else (default): mw.DefaultRequestTimeout (12s)
	// 120s gives 30s buffer past the 90s Zop ceiling — covers slow networks
	// without giving runaway handlers more rope. ReadTimeout = 60s for
	// large body uploads (banner images, etc.); IdleTimeout = 120s to
	// match WriteTimeout for HTTP keep-alive consistency.
	app := fiber.New(fiber.Config{
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
		BodyLimit:    4 * 1024 * 1024, // 4MB
		ErrorHandler: func(ctx *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			message := "internal server error"
			var e *fiber.Error
			if errors.As(err, &e) {
				code = e.Code
				message = e.Message
			} else {
				log.Error().Err(err).Msg("unhandled request error")
			}
			return ctx.Status(code).JSON(fiber.Map{"error": message})
		},
	})

	// --- Global middleware ---
	// Recover MUST be first so panics in any later middleware or handler
	// are caught before they crash the worker (audit B2-01 / E2-1).
	// Stack traces only in dev; prod logs the error without leaking
	// internals into the response body (ErrorHandler turns it into 500).
	app.Use(fiberrecover.New(fiberrecover.Config{
		EnableStackTrace: cfg.IsDevelopment(),
		StackTraceHandler: func(c *fiber.Ctx, e interface{}) {
			// Forward panics to Sentry before the recover middleware
			// swallows them. No-op when Sentry is uninitialised.
			err, ok := e.(error)
			if !ok {
				err = fmt.Errorf("panic: %v", e)
			}
			observability.CaptureError(err, map[string]string{
				"path":      c.Path(),
				"method":    c.Method(),
				"requestID": c.GetRespHeader("X-Request-ID"),
			})
		},
	}))
	app.Use(mw.RequestID())
	app.Use(mw.SecurityHeaders(cfg.IsProduction()))
	app.Use(mw.CORS(cfg.AllowedOrigins))
	app.Use(mw.CSRF(cfg.IsProduction()))
	// Zop AI chat is exempt from the global 12s budget — DeepSeek + multi-iter
	// agent loops can legitimately take 30-60s. The Zop group installs its
	// own longer Timeout below.
	app.Use(mw.TimeoutWithSkip(mw.DefaultRequestTimeout, func(c *fiber.Ctx) bool {
		return strings.HasPrefix(c.Path(), "/api/v1/zop")
	}))
	app.Use(mw.RequestLogger())
	// Gzip responses only when worth it — body >= 1KB and client supports it.
	// Avoids burning CPU compressing tiny error envelopes (429s, health pings).
	app.Use(mw.CompressIfLarge())

	// Public rate limiter.
	publicLimiter := mw.RateLimiter(rdb, mw.PublicRateLimit, "ip")
	authPublicLimiter := mw.RateLimiter(rdb, mw.SensitivePublicRateLimit, "ip")
	dbBoundLimiter := mw.DBConcurrencyLimiter(
		cfg.DBBoundMaxInFlight,
		time.Duration(cfg.DBBoundQueueWaitMS)*time.Millisecond,
	)

	// --- Health check ---
	app.Get("/health", publicLimiter, func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":  "ok",
			"service": "househelp-api",
		})
	})

	// --- Readiness probe (DB + Redis) ---
	app.Get("/ready", publicLimiter, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.Context(), 1*time.Second)
		defer cancel()
		if err := dbPool.Ping(ctx); err != nil {
			return c.Status(503).JSON(fiber.Map{"status": "db_unreachable"})
		}
		if err := rdb.Ping(ctx).Err(); err != nil {
			return c.Status(503).JSON(fiber.Map{"status": "redis_unreachable"})
		}
		return c.JSON(fiber.Map{"status": "ready"})
	})

	// --- Initialize services ---

	// Auth.
	authRepo := auth.NewRepository(dbPool)
	authService := auth.NewService(authRepo, rdb, cfg.JWTSecret, cfg.JWTSecretID, cfg.JWTExpiryHours, cfg.IsDevelopment(), cfg.IsProduction())

	// Post-Firebase Message Central wiring. Each piece is independent
	// so the boot keeps working when Message Central is dev-mode and
	// refresh-token migrations are pending. The handlers fail-loud at
	// request time if any of them is missing.
	mcClient := auth.NewMessageCentralClient(auth.MessageCentralConfig{
		CustomerID: cfg.MessageCentralCustomerID,
		AuthToken:  cfg.MessageCentralAuthToken,
		BaseURL:       cfg.MessageCentralBaseURL,
		DevMode:       cfg.OTPDevMode,
		IsDevelopment: cfg.IsDevelopment(),
	})
	tokenIssuer := auth.NewTokenIssuer(auth.TokenIssuerConfig{
		AccessSecret:   cfg.JWTAccessSecret,
		AccessSecretID: cfg.JWTSecretID,
		AccessTTL:      time.Duration(cfg.JWTAccessTTLHours) * time.Hour,
		RefreshTTL:     time.Duration(cfg.JWTRefreshTTLDays) * 24 * time.Hour,
	})
	refreshRepo := auth.NewRefreshRepo(dbPool)
	otpLimiter := auth.NewOTPRateLimiter(rdb)
	authService.SetOTPVendor(mcClient)
	authService.SetTokenIssuer(tokenIssuer)
	authService.SetRefreshRepo(refreshRepo)
	authService.SetOTPRateLimiter(otpLimiter)

	authHandler := auth.NewHandler(authService, rdb, cfg.IsProduction())

	// Compliance + audit. The compliance service backs DSAR endpoints
	// (GET /me/export streams a JSON portability dump). The audit
	// recorder writes a `user.data_export` row to crm_audit_log on
	// every accepted request so DPDP §11 access requests have a
	// forensic trail.
	complianceRegistry := compliance.NewRegistry()
	compliance.RegisterDefaultPolicies(complianceRegistry)
	complianceService := compliance.NewService(dbPool, complianceRegistry)
	complianceService.SetRedis(rdb)
	auditRecorder := audit.NewRecorder(dbPool)
	authHandler.SetCompliance(complianceService)
	authHandler.SetAudit(auditRecorder)

	jwtVerificationKeys := make([]mw.JWTKey, 0, len(cfg.JWTPreviousSecrets)+2)
	for _, key := range cfg.JWTVerificationSecrets() {
		jwtVerificationKeys = append(jwtVerificationKeys, mw.JWTKey{
			ID:     key.ID,
			Secret: key.Secret,
		})
	}
	// OTP-flow access tokens may be signed with a distinct
	// JWT_ACCESS_SECRET. Add it to the verification set so middleware
	// accepts both legacy Firebase-era tokens and new OTP-flow tokens
	// during the cut-over. Falls back to JWT_SECRET when unset (see
	// pkg/config.Load).
	if cfg.JWTAccessSecret != "" && cfg.JWTAccessSecret != cfg.JWTSecret {
		jwtVerificationKeys = append(jwtVerificationKeys, mw.JWTKey{
			ID:     cfg.JWTSecretID,
			Secret: cfg.JWTAccessSecret,
		})
	}

	// Notification.
	notificationService := notification.NewService(context.Background(), dbPool)
	// Wire the token resolver so dead FCM tokens get pruned on send.
	// Audit C-8 / B2-03 chunk 18 — mirrors the cmd/crm-api wiring.
	notificationService.SetTokenResolver(notification.NewTokenResolver(dbPool))

	// Outbound webhook dispatcher (shared with cmd/crm-api). Domain services
	// call webhookDispatcher.Dispatch(ctx, event, payload) for fan-out;
	// individual services receive it via SetWebhooks below.
	webhookDispatcher := webhooks.New(dbPool, webhooks.WithAllowedDomains(cfg.WebhookAllowedDomains))

	// Admin.
	adminRepo := admin.NewRepository(dbPool)
	adminService := admin.NewService(adminRepo, notificationService)
	adminHandler := admin.NewHandler(adminService)

	// Content.
	contentRepo := content.NewRepository(dbPool)
	contentService := content.NewService(contentRepo, rdb)
	contentHandler := content.NewHandler(contentService)

	// Config manager.
	configRepo := config_manager.NewRepository(dbPool)
	configService := config_manager.NewService(configRepo, rdb)
	configHandler := config_manager.NewHandler(configService)

	// Matching engine. The scoring/batch pipeline is retired by the unified JIT
	// assigner (spec §9); the Engine now only owns the legacy Redis invite-set
	// surface that the pro app's pending-offers poll still reads.
	matchEngine := matching.NewEngine(dbPool, rdb)

	// Google Maps client. Required: the assigner's travel-feasibility check
	// calls the Distance Matrix API. Boot fails loud if the key is missing so
	// we never silently assign a pro who is hours away from the customer.
	mapsAPIKey := os.Getenv("GOOGLE_MAPS_API_KEY")
	if mapsAPIKey == "" {
		log.Fatal().Msg("GOOGLE_MAPS_API_KEY is required — the assigner gates on walking-time feasibility")
	}
	mapsClient := googlemaps.NewClient(mapsAPIKey, rdb)
	log.Info().Msg("Google Maps client initialised")

	// Analytics.
	analyticsSvc := analytics.NewService(dbPool)
	analyticsHandler := analytics.NewHandler(analyticsSvc)
	rollupWorker := analytics.NewRollupWorker(dbPool, time.Minute)
	rollupWorker.Start()
	defer rollupWorker.Stop()

	// Re-engagement reminders.
	reengagementRepo := reengagement.NewRepository(dbPool)
	reengagementSvc := reengagement.NewService(reengagementRepo, notificationService, 30*time.Minute)
	reengagementWorker := reengagement.NewWorker(reengagementSvc, 5*time.Minute)
	reengagementWorker.Start()
	defer reengagementWorker.Stop()

	// Segment worker — recomputes users.segment (NEW/RETURNING/AT_RISK/CHURNED)
	// once per day. Cheap single-statement UPDATE; safe to run on the main pool.
	segmentWorker := segments.NewWorker(segments.NewService(dbPool), 24*time.Hour)
	segmentWorker.Start()
	defer segmentWorker.Stop()

	outboxWorker := outbox.NewWorker(dbPool, 5*time.Second)
	for eventType, h := range outbox.DefaultHandlers() {
		outboxWorker.Register(eventType, h)
	}
	for eventType, h := range outbox.BookingHandlers(notificationService, dbPool) {
		outboxWorker.Register(eventType, h)
	}
	outboxWorker.Start()
	defer outboxWorker.Stop()

	// Booking.
	bookingRepo := booking.NewRepository(dbPool)
	bookingService := booking.NewService(bookingRepo, dbPool, rdb, configService, matchEngine)

	bookingService.SetMapsClient(mapsClient)
	bookingService.SetAnalytics(analyticsSvc)
	bookingService.SetWebhooks(webhookDispatcher)
	paymentsLedger := payments.NewLedger(dbPool)
	bookingService.SetPaymentsLedger(paymentsLedger)

	// Cashfree PG gateway. Returns nil when CASHFREE_PG_APP_ID is unset, in
	// which case refunds fall back to ManualGateway and the booking-flow
	// collection routes (added in a follow-up phase) return 503.
	cashfreeGW := payments.NewCashfreeGateway(cfg)
	if cashfreeGW != nil {
		log.Info().Str("env", cfg.CashfreePGEnv).Msg("[payments] cashfree PG gateway active")
	} else {
		log.Info().Msg("[payments] cashfree PG gateway not configured (manual fallback)")
	}

	// Closed-loop wallet. The service is the canonical entry point for
	// every wallet mutation (Credit / Debit / *Tx variants); booking +
	// payments handlers receive narrow interface adapters so the wallet
	// package stays import-free in those modules.
	walletRepo := wallet.NewRepository(dbPool)
	walletSvc := wallet.NewService(walletRepo)
	bookingService.SetWallet(bookingWalletAdapter{svc: walletSvc})
	bookingHandler := booking.NewHandler(bookingService)

	// Location.
	locationService := location.NewService(rdb, dbPool)
	locationHandler := location.NewHandler(locationService, jwtVerificationKeys, dbPool, authRepo)

	// Addresses.
	addressRepo := addresses.NewRepository(dbPool)
	addressService := addresses.NewService(addressRepo)
	addressHandler := addresses.NewHandler(addressService)

	// Services catalog.
	servicesRepo := servicesmod.NewRepository(dbPool)
	servicesCatalog := servicesmod.NewService(servicesRepo)
	servicesHandler := servicesmod.NewHandler(servicesCatalog)

	// Cart.
	cartRepo := cartmod.NewRepository(dbPool)
	cartService := cartmod.NewService(cartRepo)
	cartService.SetAnalytics(analyticsSvc)
	cartHandler := cartmod.NewHandler(cartService)

	// Helper (pro-side profile, invites, location, status).
	helperRepo := helpermod.NewRepository(dbPool)
	helperService := helpermod.NewService(helperRepo, locationService, matchEngine, rdb)
	helperService.SetWebhooks(webhookDispatcher)
	helperService.SetAnalytics(analyticsSvc)
	helperHandler := helpermod.NewHandler(helperService, helperRepo)
	proApprovedMW := helpermod.RequireApproved(helperRepo)

	// Time slots.
	slotsRepo := slotsmod.NewRepository(dbPool)
	slotsService := slotsmod.NewService(slotsRepo)
	slotsHandler := slotsmod.NewHandler(slotsService)

	// Service zones.
	zonesRepo := zonesmod.NewRepository(dbPool)
	zonesService := zonesmod.NewService(zonesRepo)
	zonesHandler := zonesmod.NewHandler(zonesService)

	// --- Route groups ---
	api := app.Group("/api/v1")

	// Auth routes (public).
	authGroup := api.Group("/auth", authPublicLimiter)
	authHandler.RegisterRoutes(authGroup)

	// App content routes (public, cached).
	appGroup := api.Group("/app", publicLimiter)
	contentHandler.RegisterPublicRoutes(appGroup)
	configHandler.RegisterPublicRoutes(appGroup)

	// App version-check (public, so a forced client can always recover) plus a
	// 426 force-update middleware applied to transactional routes below. Both
	// read the admin-set policy in crm_app_versions. Optional updates never 426;
	// they surface only through this endpoint as a dismissable prompt.
	appVersionSvc := appversion.NewService(dbPool)
	appversion.NewHandler(appVersionSvc).RegisterPublicRoutes(appGroup)
	appVersionMW := appVersionSvc.Middleware()

	// Phase 7 shift system. Notifier wraps notification.Service via a
	// thin adapter (PushClient interface) so the shift package stays
	// decoupled from the FCM-specific return types.
	shiftRepo := shift.NewRepository(dbPool)
	shiftService := shift.NewService(shiftRepo)
	shiftService.SetNotifier(shift.NewNotifier(&shiftPushAdapter{n: notificationService}))
	// Customer-facing side effect of a pro cancellation. Refund + auto
	// re-dispatch are intentionally deferred (product decision).
	shiftService.SetCancelHooks(notificationService)
	shiftHandler := shift.NewHandler(shiftService)
	shiftCron := shift.NewCron(shiftService)
	shiftCron.Start(context.Background())
	defer shiftCron.Stop()

	// Payroll engine — computes per-pro pay at 01:00 IST on the 15th
	// and last day of each month. Manual replay handler mounted on
	// adminGroup further down.
	payrollRepo := payroll.NewRepository(dbPool)
	payrollService := payroll.NewService(payrollRepo)
	payrollHandler := payroll.NewHandler(payrollService)
	payrollCron := payroll.NewCron(payrollService)
	payrollCron.Start(context.Background())
	defer payrollCron.Stop()

	// Authenticated routes with rate limiting by user ID.
	authMiddleware := mw.AuthMiddleware(jwtVerificationKeys, authRepo)
	authLimiter := mw.RateLimiter(rdb, mw.AuthRateLimit, "user")

	// Booking routes (requires JWT).
	bookingGroup := api.Group("/bookings", authMiddleware, appVersionMW, authLimiter, dbBoundLimiter)
	bookingIdem := mw.Idempotency(rdb, 60*time.Second, 10*time.Minute)
	bookingCreateLimiter := mw.NamedRateLimiter(rdb, mw.BookingCreateRateLimit, "user", "booking-create")
	bookingHandler.RegisterRoutes(bookingGroup, bookingIdem, bookingCreateLimiter, proApprovedMW)
	reviews.NewHandler(reviews.NewService(dbPool, analyticsSvc)).RegisterRoutes(bookingGroup)

	// Tracking WebSocket — replaces the 5s REST poll on the customer side.
	// Auth is enforced inside the WS via {"type":"auth","token":...} so no
	// JWT header middleware here; we only need the public limiter to soak up
	// pre-upgrade abuse.
	bookingTrackWS := booking.NewTrackingWSHandler(bookingService, jwtVerificationKeys, authRepo)
	bookingTrackWS.RegisterTrackingWS(api.Group("/bookings", publicLimiter))

	// Location routes (requires JWT).
	locationGroup := api.Group("/location", authMiddleware, authLimiter, dbBoundLimiter)
	locationHandler.RegisterRoutes(locationGroup)

	// Addresses routes (requires JWT).
	addressGroup := api.Group("/addresses", authMiddleware, authLimiter, dbBoundLimiter)
	addressHandler.RegisterRoutes(addressGroup)

	// Services catalog routes (public).
	servicesGroup := api.Group("/services", publicLimiter, dbBoundLimiter)
	servicesHandler.RegisterPublicRoutes(servicesGroup)

	// Cart routes (requires JWT).
	cartGroup := api.Group("/cart", authMiddleware, appVersionMW, authLimiter, dbBoundLimiter)
	cartHandler.RegisterRoutes(cartGroup)

	// Offers routes (requires JWT).
	offersGroup := api.Group("", authMiddleware, appVersionMW, authLimiter, dbBoundLimiter)
	offers.NewHandler(dbPool).RegisterRoutes(offersGroup)

	// Disputes routes (requires JWT — customer files, CRM resolves).
	disputesGroup := api.Group("", authMiddleware, authLimiter, dbBoundLimiter)
	disputes.NewHandler(dbPool).RegisterRoutes(disputesGroup)

	// Time slots routes (requires JWT).
	slotsGroup := api.Group("/slots", authMiddleware, authLimiter, dbBoundLimiter)
	slotsHandler.RegisterRoutes(slotsGroup)

	// Zop AI assistant — natural-language booking surface for the customer
	// app. Uses OpenRouter (Gemma for cleaning + Llama for chat). Requires
	// OPENROUTER_API_KEY; if unset Zop still mounts but falls open on cleans
	// and the chat loop will surface an error reply.
	zopService := zop.NewService(rdb, bookingService, addressService, slotsService, cartService, servicesCatalog, authService, os.Getenv("OPENROUTER_API_KEY"))
	// Wire the CRM audit recorder so every Zop tool dispatch produces a
	// persistent audit row. Audit NEW-A2-002 item a.
	zopService.SetAuditRecorder(auditRecorder)
	zopHandler := zop.NewHandler(zopService)
	// Wipe Zop state (history, rate limit, session set) on account deletion.
	authService.RegisterPostDeleteHook(zopService.DeleteUserData)
	// Zop is a customer-facing assistant. All 12 tools are scoped to the
	// caller's customer-side data (cart, bookings, addresses); helpers /
	// admins authenticated with the same JWT scheme have no business hitting
	// the chat endpoint and would only see empty data anyway. Gate the route
	// to role=customer so the surface isn't reachable by other roles.
	// Audit NEW-A2-002 item d.
	zopGroup := api.Group("/zop", mw.Timeout(90*time.Second), authMiddleware, mw.RequireRole("customer"), authLimiter, dbBoundLimiter)
	zopHandler.RegisterRoutes(zopGroup)

	// Places autocomplete proxy (requires JWT — key must not be public).
	placesHandler := places.NewHandler(mapsClient)
	placesGroup := api.Group("/places", authMiddleware, authLimiter)
	placesHandler.RegisterRoutes(placesGroup)

	// Payment helpers — Cashfree Payouts (VPA validation) shares the handler
	// with Cashfree PG (collection: order, status, refunds, webhook). Gateway
	// keys are server-side only; the client never sees them.
	paymentsHandler := payments.NewHandler()
	paymentsHandler.SetCollectionDeps(dbPool, paymentsLedger, cashfreeGW, cfg.PublicBaseURL)
	paymentsHandler.SetWallet(paymentsWalletAdapter{svc: walletSvc})

	paymentsGroup := api.Group("/payments", authMiddleware, authLimiter)
	paymentsHandler.RegisterRoutes(paymentsGroup)

	// Webhook group — NO auth middleware. Authentication is the
	// x-webhook-signature header, validated inside CashfreeWebhook.
	paymentsWebhookGroup := api.Group("/payments")
	paymentsHandler.RegisterWebhookRoutes(paymentsWebhookGroup)

	// Wallet routes — auth-protected. /wallet/topup delegates to the
	// payments handler's wallet-topup branch via a small adapter.
	walletHandler := wallet.NewHandler(walletSvc, walletTopupAdapter{ph: paymentsHandler})
	walletGroup := api.Group("/wallet", authMiddleware, authLimiter, dbBoundLimiter)
	walletHandler.RegisterRoutes(walletGroup)

	// Zones routes (public check).
	zonesGroup := api.Group("/zones", publicLimiter)
	zonesHandler.RegisterPublicRoutes(zonesGroup)

	// Localities — public read for the pro-app onboarding + My Area dropdown.
	// Auth-free so onboarding (pre-login) can fetch the list.
	localitiesRepoPub := localities.NewRepository(dbPool)
	localitiesHandlerPub := localities.NewHandler(localitiesRepoPub, nil)
	localitiesHandlerPub.RegisterPublicRoutes(api.Group("/localities", publicLimiter))

	// Insights — public stats for the home pill (nearby pros, avg rating, ETA).
	insightsRepo := insights.NewRepository(dbPool)
	insightsService := insights.NewService(insightsRepo, rdb)
	insightsHandler := insights.NewHandler(insightsService)
	insightsGroup := api.Group("/insights", publicLimiter, dbBoundLimiter)
	insightsHandler.RegisterPublicRoutes(insightsGroup)

	// Profile routes (requires JWT).
	meGroup := api.Group("/me", authMiddleware, authLimiter, dbBoundLimiter)
	authHandler.RegisterMeRoutes(meGroup)
	insightsHandler.RegisterMeRoutes(meGroup)

	// Your Experts — preferred-helpers list backing the scheduled-dispatch
	// invite chain (Phase 1).
	expertsRepo := experts.NewRepository(dbPool)
	expertsService := experts.NewService(expertsRepo)
	expertsHandler := experts.NewHandler(expertsService)
	expertsHandler.RegisterRoutes(meGroup)

	// Referral system: shareable links, Rs 100 referee + Rs 200 referrer on first booking.
	referralRepo := referral.NewRepository(dbPool)
	referralSvc := referral.NewService(referralRepo, dbPool, walletSvc)
	referralHandler := referral.NewHandler(referralSvc)
	authService.SetCodeGenerator(referralSvc)
	bookingService.SetReferralCompleter(referralSvc)
	referralHandler.RegisterMeRoutes(meGroup)
	referralsGroup := api.Group("/referrals", authMiddleware, authLimiter, dbBoundLimiter)
	referralHandler.RegisterRoutes(referralsGroup)

	// Dispatch crons (unified JIT model — spec §5.1, §9).
	//   - AssignerCron:  60s tick, claims due bookings + force-assigns; the
	//     no-pro terminal path cancels + refunds at slot start. Replaces the
	//     retired nightly ScheduledDispatcher, per-minute StealthDispatcher,
	//     5s batcher, and the pending-action sweeper.
	//   - RebookScanner: per-5-minute "pros are back" nudge (kept).
	cronCtx, cancelCrons := context.WithCancel(context.Background())
	assigner := matching.NewAssigner(
		dbPool, rdb, notificationService, expertsService, mapsClient,
		func(ctx context.Context) matching.DispatchConfig {
			return matching.LoadDispatchConfig(ctx, configService)
		},
	)
	// Wire the assigner into the booking service for the ASAP synchronous-assign
	// path (spec §3.2, §5), plus the wallet repo for the no-pro refund rail.
	bookingService.SetSyncAssigner(assigner)
	bookingService.SetWalletRepo(walletRepo)
	assignerCron := matching.NewAssignerCron(assigner, walletRepo)
	assignerCron.Start(cronCtx)
	dispatcher := matching.NewDispatcher(dbPool, rdb, notificationService, expertsService)
	go matching.NewRebookScanner(dispatcher).Start(cronCtx)

	// Refund worker: drives queued booking-cancellation refunds against the
	// Cashfree gateway. pending_refunds rows are produced on cancel but only
	// the gateway can move the money; without this, prod cancellation refunds
	// stranded (only the non-deployed CRM processed them). Runs only when a real
	// gateway is configured; coexists safely with the CRM via atomic claim.
	if cashfreeGW != nil {
		refundWorker := payments.NewRefundWorker(dbPool, cashfreeGW)
		refundWorker.Start(cronCtx)
		defer refundWorker.Stop()
	}
	defer cancelCrons()

	// Device-token routes (requires JWT). New per-device push registration —
	// the legacy single-token PUT /me/fcm-token continues to work alongside
	// this surface and now mirrors writes into device_tokens too.
	devicesGroup := api.Group("/devices", authMiddleware, authLimiter, dbBoundLimiter)
	authHandler.RegisterDeviceRoutes(devicesGroup)

	// Helper routes (requires JWT + pro role).
	helpersGroup := api.Group("/helpers", authMiddleware, authLimiter, dbBoundLimiter)
	helperHandler.RegisterRoutes(helpersGroup)

	// Pro leave routes (requires JWT). Pro role guard not strictly needed —
	// non-pros calling these endpoints get a 0 balance / no leaves rather
	// than an error, since the helpers row simply won't exist for them.
	leaveRepo := leave.NewRepository(dbPool)
	leaveCustNotifier := &leave.CustomerNotifierAdapter{Sender: notificationService}
	// Route per-cancellation alerts through the CRM notification centre so the
	// admin bell-icon feed lights up immediately when a booking auto-cancels.
	crmNotifRecorder := notifications.NewRecorder(dbPool)
	leaveCRMNotifier := &leave.RecorderCRMNotifier{Recorder: crmNotifRecorder}
	leaveSvc := leave.NewService(leaveRepo, leaveCRMNotifier, leaveCustNotifier)
	leaveSvc.SetWebhooks(webhookDispatcher)
	// Notify the replacement pro they were force-assigned a booking.
	leaveSvc.SetProNotifier(&leave.ProNotifierAdapter{Sender: notificationService})
	leaveHandler := leave.NewHandler(leaveSvc)
	// Leave routes: chain RequireRole("pro") + RequireApproved.
	// Audit A1-F7 (leave routes lacked role gate) + A1-F3 (approval
	// gate). Customers hitting /pro/leave/* now 403 from RequireRole;
	// pending/rejected helpers 403 from RequireApproved.
	leaveGroup := api.Group("/pro/leave", authMiddleware, authLimiter, dbBoundLimiter,
		mw.RequireRole("pro"), proApprovedMW)
	leaveHandler.RegisterRoutes(leaveGroup)
	// Hourly cron — idempotent monthly balance refill for every helper.
	// Stop hook wired below the server-listen block (audit NEW-B1-001).
	leaveWorker := leave.NewWorker(leaveRepo)
	leaveWorker.Start(ctx)

	// Admin routes (requires JWT + admin role + specific permissions).
	adminMiddleware := mw.AdminMiddleware(dbPool, rdb)
	adminLimiter := mw.RateLimiter(rdb, mw.AdminRateLimit, "user")
	adminGroup := api.Group("/admin", authMiddleware, adminMiddleware, adminLimiter, dbBoundLimiter)
	adminHandler.RegisterRoutes(adminGroup)
	shiftHandler.RegisterAdminRoutes(adminGroup)
	payrollHandler.RegisterAdminRoutes(adminGroup)

	// Pro-only shift routes. AuthMiddleware sets userType in locals;
	// RequireRole("pro") rejects customers + admins. proApprovedMW
	// (declared earlier) gates on helpers.approval_status='approved'.
	proGroup := api.Group("/pro", authMiddleware, mw.RequireRole("pro"), proApprovedMW, authLimiter, dbBoundLimiter)
	shiftHandler.RegisterProRoutes(proGroup)

	// Phase 10 — pro-side job lifecycle endpoints. Mounted alongside
	// (not replacing) the legacy /api/v1/bookings/:id/{accept,...}
	// surface so existing app builds keep working.
	bookingService.SetNotifier(&bookingNotifierAdapter{n: notificationService})
	jobsHandler := booking.NewJobsHandler(bookingService)
	// Mount the idempotency middleware on the pro job-lifecycle group so the
	// app's automatic timeout-retry (apiFetch reuses the same Idempotency-Key
	// across its internal retries) replays the cached 2xx instead of
	// re-executing a non-idempotent accept/complete — the "accept succeeded
	// yet reports 'offer expired'" race. GET routes carry no key and no-op.
	jobsHandler.RegisterRoutes(proGroup.Group("/jobs", bookingIdem))
	contentHandler.RegisterAdminContentRoutes(adminGroup)
	configHandler.RegisterAdminRoutes(adminGroup)
	zonesHandler.RegisterAdminRoutes(adminGroup.Group("/zones"))
	analyticsHandler.RegisterAdminRoutes(adminGroup)
	servicesHandler.RegisterAdminRoutes(adminGroup.Group("/services"))
	adminGroup.Get("/runtime/metrics", mw.RequirePermission(admin.PermViewAnalytics), func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"db_pool":          database.PoolStats(dbPool),
			"rate_limiter":     mw.RateLimiterMetrics(),
			"db_concurrency":   mw.DBConcurrencyMetrics(),
			"analytics_rollup": rollupWorker.Metrics(),
			"cashfree_webhook": payments.WebhookMetrics(),
		})
	})

	// --- SDUI (server-driven UI) ---
	bffRepo := bff.NewRepository(dbPool)
	bffWhitelist := bff.NewActionWhitelist(dbPool, rdb)
	bffCircuit := bff.NewCircuit()
	bffReg, bffBatches := bff.BuildRegistries(bff.SourceDeps{
		DB:       dbPool,
		Insights: insightsService,
		Services: servicesCatalog,
	})
	bffCircuit.InitForRegistry(bffReg)

	bffValidator, err := bff.NewValidator("schemas/sdui_page_config.json", bffReg, bffWhitelist)
	if err != nil {
		log.Fatal().Err(err).Msg("[sdui] failed to load page config schema")
	}

	bffHydrator := bff.NewHydrator(bffReg, bffBatches, bffCircuit, rdb, "v1")
	bffResolver := bff.NewResolver(bffReg, func(string) (json.RawMessage, error) {
		return nil, fmt.Errorf("includes not configured")
	}, "", "")

	safeLayouts := loadSafeLayouts()

	bffHandler := bff.NewHandler(bffRepo, bffValidator, bffHydrator, bffResolver, rdb, safeLayouts)
	bffHandler.LazyFetcher = func(
		ctx context.Context,
		pageID, sectionID, cursor string,
		limit int,
		rc bff.RequestContext,
	) (any, string, bool, error) {
		// MVP: only "popular" service grid is paginated; everything else returns empty.
		if servicesCatalog == nil {
			return map[string]any{"items": []any{}}, "", false, nil
		}
		all, err := servicesCatalog.List(ctx)
		if err != nil {
			return nil, "", false, err
		}
		offset := 0
		if strings.HasPrefix(cursor, "off:") {
			fmt.Sscanf(cursor[4:], "%d", &offset)
		}
		if offset < 0 {
			offset = 0
		}
		if offset >= len(all) {
			return map[string]any{"services": []any{}}, "", false, nil
		}
		end := offset + limit
		if end > len(all) {
			end = len(all)
		}
		page := all[offset:end]
		hasMore := end < len(all)
		next := ""
		if hasMore {
			next = fmt.Sprintf("off:%d", end)
		}
		return map[string]any{"services": page}, next, hasMore, nil
	}

	bffAdminHandler := bff.NewAdminHandler(
		bffRepo, bffValidator, rdb, bffWhitelist,
		bffHydrator, bffResolver, safeLayouts,
	)

	// SDUI routes — JWT required. Was public to match other static catalog
	// endpoints, but the SDUI page IDs are guessable strings ("home", "cart",
	// "service:...") and an unauthenticated scraper could enumerate the full
	// app layout + every backed source. Locking behind authMiddleware prevents
	// that without breaking the app, which always carries a token by this point.
	bffHandler.RegisterRoutes(api.Group("/sdui", authMiddleware, authLimiter, dbBoundLimiter))

	// Admin SDUI routes: nested under /api/v1/admin so they inherit JWT,
	// admin-role, and the standard admin limiter. The SDUI-specific 60req/min
	// rate limiter applies only to this sub-group, not the rest of /admin.
	bffAdminHandler.RegisterRoutes(adminGroup.Group("", mw.SduiAdminAuth(rdb)))

	// Client-side analytics event ingestion (authenticated users, auth rate
	// limiter). Mounted with explicit path prefixes so the auth middleware
	// does not leak to sibling routes registered under /api/v1.
	analyticsClientGroup := api.Group("/events", authMiddleware, authLimiter, dbBoundLimiter)
	analyticsClientGroup.Post("/", analyticsHandler.TrackCanonicalEvent)
	analyticsLegacyGroup := api.Group("/analytics/events", authMiddleware, authLimiter, dbBoundLimiter)
	analyticsLegacyGroup.Post("/", analyticsHandler.TrackClientEvent)

	// --- Roomies add-on module ---
	roomiesRepo := roomies.NewRepository(dbPool)
	roomiesService := roomies.NewService(roomiesRepo, dbPool, rdb)
	roomiesHandler := roomies.NewHandler(roomiesService)
	roomiesGroup := api.Group("/roomies", authMiddleware, authLimiter, dbBoundLimiter)
	roomiesHandler.RegisterRoutes(roomiesGroup)
	// Stop hook wired below the server-listen block (audit NEW-B1-001).
	roomiesWorker := roomies.NewWorker(roomiesService)
	roomiesWorker.Start(ctx)

	// --- Start server with graceful shutdown ---
	go func() {
		addr := fmt.Sprintf(":%s", cfg.Port)
		log.Info().Str("addr", addr).Msg("server starting")
		if listenErr := app.Listen(addr); listenErr != nil {
			log.Fatal().Err(listenErr).Msg("server failed to start")
		}
	}()

	// Wait for interrupt signal.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	log.Info().Str("signal", sig.String()).Msg("shutting down server")

	// Graceful shutdown with 10s timeout.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := app.ShutdownWithContext(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("server shutdown error")
	}

	dispatcherCtx, dispatcherCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dispatcherCancel()
	if err := webhookDispatcher.Close(dispatcherCtx); err != nil {
		log.Error().Err(err).Msg("webhook dispatcher drain error")
	}

	// Drain background cron workers (audit NEW-B1-001). Each gets up to 5s
	// to finish an in-flight DB call; ctx-cancel itself is immediate so the
	// next ticker iteration never starts.
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer drainCancel()
	// The assigner cron drains first: its in-flight tick may be inside the
	// no-pro cancel+refund transaction, which must finish (or hit the deadline)
	// rather than be cut off by the deferred cancelCrons() when main returns.
	if err := assignerCron.Stop(drainCtx); err != nil {
		log.Warn().Err(err).Msg("assigner cron stop deadline exceeded")
	}
	if err := leaveWorker.Stop(drainCtx); err != nil {
		log.Warn().Err(err).Msg("leave worker stop deadline exceeded")
	}
	if err := roomiesWorker.Stop(drainCtx); err != nil {
		log.Warn().Err(err).Msg("roomies worker stop deadline exceeded")
	}

	log.Info().Msg("server stopped")
}

// ── Wallet/booking/payments adapters ─────────────────────────────────────
// These adapters bridge the concrete *wallet.Service against the narrow
// interfaces declared by the booking and payments packages. The interfaces
// take `kind string` so neither package needs to import internal/wallet
// for type definitions; the adapters cast to wallet.Kind here.

type bookingWalletAdapter struct{ svc *wallet.Service }

func (a bookingWalletAdapter) DebitTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise int64,
	kind string,
	bookingID *string,
	note string,
) error {
	_, err := a.svc.DebitTx(ctx, tx, userID, amountPaise, wallet.Kind(kind), bookingID, note)
	return err
}

type paymentsWalletAdapter struct{ svc *wallet.Service }

func (a paymentsWalletAdapter) CreditTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	amountPaise int64,
	kind string,
	paymentID, bookingID *string,
	note string,
) error {
	_, err := a.svc.CreditTx(ctx, tx, userID, amountPaise, wallet.Kind(kind), paymentID, bookingID, note)
	return err
}

type walletTopupAdapter struct{ ph *payments.Handler }

func (a walletTopupAdapter) HandleWalletTopup(c *fiber.Ctx, userID string, amountPaise int64) error {
	return a.ph.HandleWalletTopup(c, userID, amountPaise)
}

// bookingNotifierAdapter narrows notification.Service down to
// booking.Notifier (which only needs SendData). Wired by main into
// bookingService.SetNotifier so the /pro/jobs/en-route + /arrived
// paths can push the customer.
type bookingNotifierAdapter struct{ n *notification.Service }

func (a *bookingNotifierAdapter) SendData(ctx context.Context, userID string, data map[string]string) error {
	return a.n.SendData(ctx, userID, data)
}

// shiftPushAdapter narrows notification.Service down to shift.PushClient.
// notification.Service.SendToAdmins returns (*MulticastReport, error);
// shift only needs the error, so we discard the report. The CRM-login
// migration to topic-based admin fan-out lands without changing this
// signature.
type shiftPushAdapter struct{ n *notification.Service }

func (a *shiftPushAdapter) SendToAdmins(ctx context.Context, title, body string, data map[string]string) error {
	_, err := a.n.SendToAdmins(ctx, title, body, data)
	return err
}

func (a *shiftPushAdapter) SendToProByID(ctx context.Context, proID, title, body string, data map[string]string) error {
	return a.n.SendToProByID(ctx, proID, title, body, data)
}
