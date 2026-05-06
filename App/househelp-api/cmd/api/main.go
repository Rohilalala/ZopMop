package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	_ "net/http/pprof"
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
	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/localities"
	"github.com/adityarohilla/househelp-api/internal/experts"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/content"
	"github.com/adityarohilla/househelp-api/internal/crm/notifications"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	helpermod "github.com/adityarohilla/househelp-api/internal/helper"
	"github.com/adityarohilla/househelp-api/internal/insights"
	"github.com/adityarohilla/househelp-api/internal/leave"
	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
	"github.com/adityarohilla/househelp-api/internal/places"
	"github.com/adityarohilla/househelp-api/internal/reengagement"
	"github.com/adityarohilla/househelp-api/internal/reviews"
	"github.com/adityarohilla/househelp-api/internal/roomies"
	"github.com/adityarohilla/househelp-api/internal/segments"
	servicesmod "github.com/adityarohilla/househelp-api/internal/services"
	slotsmod "github.com/adityarohilla/househelp-api/internal/slots"
	"github.com/adityarohilla/househelp-api/internal/wallet"
	"github.com/adityarohilla/househelp-api/internal/zop"
	zonesmod "github.com/adityarohilla/househelp-api/internal/zones"
	"github.com/adityarohilla/househelp-api/pkg/config"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/jackc/pgx/v5"
	"github.com/adityarohilla/househelp-api/pkg/logger"

	"github.com/gofiber/fiber/v2"
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

	// Optional pprof endpoint, bound to localhost so it's never reachable from
	// outside the host. Enable with ENABLE_PPROF=1 (dev or perf-test runs only).
	if os.Getenv("ENABLE_PPROF") == "1" {
		pprofAddr := "127.0.0.1:6060"
		go func() {
			log.Info().Str("addr", pprofAddr).Msg("pprof listening")
			if err := http.ListenAndServe(pprofAddr, nil); err != nil {
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
	authService := auth.NewService(authRepo, rdb, cfg.JWTSecret, cfg.JWTSecretID, cfg.JWTExpiryHours, cfg.IsDevelopment())
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

	jwtVerificationKeys := make([]mw.JWTKey, 0, len(cfg.JWTPreviousSecrets)+1)
	for _, key := range cfg.JWTVerificationSecrets() {
		jwtVerificationKeys = append(jwtVerificationKeys, mw.JWTKey{
			ID:     key.ID,
			Secret: key.Secret,
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
	webhookDispatcher := webhooks.New(dbPool)

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

	// Matching engine + batcher (instant bookings only).
	matchEngine := matching.NewEngine(dbPool, rdb, configService)
	matchBatcher := matching.NewBatcher(matchEngine, 5*time.Second)
	matchBatcher.Start()
	defer matchBatcher.Stop()

	// Google Maps client. Required: instant-booking eligibility is decided
	// purely by the walking-time filter, which calls the Distance Matrix API.
	// Boot fails loud if the key is missing so we never silently match a pro
	// who is hours away from the customer.
	mapsAPIKey := os.Getenv("GOOGLE_MAPS_API_KEY")
	if mapsAPIKey == "" {
		log.Fatal().Msg("GOOGLE_MAPS_API_KEY is required — instant booking matches on walking-time only")
	}
	mapsClient := googlemaps.NewClient(mapsAPIKey, rdb)
	log.Info().Msg("Google Maps client initialised")
	matchEngine.SetMapsClient(mapsClient)

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

	// Booking.
	bookingRepo := booking.NewRepository(dbPool)
	bookingService := booking.NewService(bookingRepo, dbPool, rdb, configService, notificationService, matchBatcher)
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
	locationService := location.NewService(rdb)
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

	// Authenticated routes with rate limiting by user ID.
	authMiddleware := mw.AuthMiddleware(jwtVerificationKeys, authRepo)
	authLimiter := mw.RateLimiter(rdb, mw.AuthRateLimit, "user")

	// Booking routes (requires JWT).
	bookingGroup := api.Group("/bookings", authMiddleware, authLimiter, dbBoundLimiter)
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
	cartGroup := api.Group("/cart", authMiddleware, authLimiter, dbBoundLimiter)
	cartHandler.RegisterRoutes(cartGroup)

	// Time slots routes (requires JWT).
	slotsGroup := api.Group("/slots", authMiddleware, authLimiter, dbBoundLimiter)
	slotsHandler.RegisterRoutes(slotsGroup)

	// Zop AI assistant — natural-language booking surface for the customer
	// app. Uses OpenRouter (Gemma for cleaning + Llama for chat). Requires
	// OPENROUTER_API_KEY; if unset Zop still mounts but falls open on cleans
	// and the chat loop will surface an error reply.
	zopService := zop.NewService(rdb, bookingService, addressService, slotsService, cartService, servicesCatalog, authService, os.Getenv("OPENROUTER_API_KEY"))
	zopHandler := zop.NewHandler(zopService)
	// Wipe Zop state (history, rate limit, session set) on account deletion.
	authService.RegisterPostDeleteHook(zopService.DeleteUserData)
	zopGroup := api.Group("/zop", mw.Timeout(90*time.Second), authMiddleware, authLimiter, dbBoundLimiter)
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

	// Scheduled-booking dispatch crons. All three share the same Dispatcher.
	//   - ScheduledDispatcher: nightly 22:00 IST batch
	//   - StealthDispatcher:   per-minute after-8pm bookings
	//   - RebookScanner:       per-5-minute "pros are back" nudge
	cronCtx, cancelCrons := context.WithCancel(context.Background())
	dispatcher := matching.NewDispatcher(dbPool, rdb, notificationService, expertsService)
	go matching.NewScheduledDispatcher(dispatcher).Start(cronCtx)
	go matching.NewStealthDispatcher(dispatcher).Start(cronCtx)
	go matching.NewRebookScanner(dispatcher).Start(cronCtx)
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
	leaveHandler := leave.NewHandler(leaveSvc)
	// Leave routes: chain RequireRole("pro") + RequireApproved.
	// Audit A1-F7 (leave routes lacked role gate) + A1-F3 (approval
	// gate). Customers hitting /pro/leave/* now 403 from RequireRole;
	// pending/rejected helpers 403 from RequireApproved.
	leaveGroup := api.Group("/pro/leave", authMiddleware, authLimiter, dbBoundLimiter,
		mw.RequireRole("pro"), proApprovedMW)
	leaveHandler.RegisterRoutes(leaveGroup)
	// Hourly cron — idempotent monthly balance refill for every helper.
	leave.StartMonthlyResetCron(leaveRepo)

	// Admin routes (requires JWT + admin role + specific permissions).
	adminMiddleware := mw.AdminMiddleware(dbPool, rdb)
	adminLimiter := mw.RateLimiter(rdb, mw.AdminRateLimit, "user")
	adminGroup := api.Group("/admin", authMiddleware, adminMiddleware, adminLimiter, dbBoundLimiter)
	adminHandler.RegisterRoutes(adminGroup)
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
	roomies.StartAutoSettleCron(roomiesService)

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
