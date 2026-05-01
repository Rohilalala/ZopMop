package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/content"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	helpermod "github.com/adityarohilla/househelp-api/internal/helper"
	"github.com/adityarohilla/househelp-api/internal/insights"
	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/places"
	"github.com/adityarohilla/househelp-api/internal/reengagement"
	"github.com/adityarohilla/househelp-api/internal/roomies"
	servicesmod "github.com/adityarohilla/househelp-api/internal/services"
	slotsmod "github.com/adityarohilla/househelp-api/internal/slots"
	zonesmod "github.com/adityarohilla/househelp-api/internal/zones"
	"github.com/adityarohilla/househelp-api/pkg/config"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/logger"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
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
	app := fiber.New(fiber.Config{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
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
	app.Use(mw.RequestLogger())

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
	authHandler := auth.NewHandler(authService, cfg.IsProduction())

	jwtVerificationKeys := make([]mw.JWTKey, 0, len(cfg.JWTPreviousSecrets)+1)
	for _, key := range cfg.JWTVerificationSecrets() {
		jwtVerificationKeys = append(jwtVerificationKeys, mw.JWTKey{
			ID:     key.ID,
			Secret: key.Secret,
		})
	}

	// Notification.
	notificationService := notification.NewService(context.Background(), dbPool)

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

	// Google Maps client (optional — gracefully skipped if key not set).
	var mapsClient *googlemaps.Client
	if mapsAPIKey := os.Getenv("GOOGLE_MAPS_API_KEY"); mapsAPIKey != "" {
		mapsClient = googlemaps.NewClient(mapsAPIKey, rdb)
		log.Info().Msg("Google Maps client initialised")
	} else {
		log.Warn().Msg("GOOGLE_MAPS_API_KEY not set — walking-time filter and live ETA disabled")
	}
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

	// Booking.
	bookingRepo := booking.NewRepository(dbPool)
	bookingService := booking.NewService(bookingRepo, dbPool, rdb, configService, notificationService, matchBatcher)
	bookingService.SetMapsClient(mapsClient)
	bookingService.SetAnalytics(analyticsSvc)
	bookingHandler := booking.NewHandler(bookingService)

	// Location.
	locationService := location.NewService(rdb)
	locationHandler := location.NewHandler(locationService, jwtVerificationKeys, dbPool)

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
	helperHandler := helpermod.NewHandler(helperService)

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
	authMiddleware := mw.AuthMiddleware(jwtVerificationKeys)
	authLimiter := mw.RateLimiter(rdb, mw.AuthRateLimit, "user")

	// Booking routes (requires JWT).
	bookingGroup := api.Group("/bookings", authMiddleware, authLimiter, dbBoundLimiter)
	bookingIdem := mw.Idempotency(rdb, 10*time.Minute)
	bookingHandler.RegisterRoutes(bookingGroup, bookingIdem)

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

	// Places autocomplete proxy (requires JWT — key must not be public).
	placesHandler := places.NewHandler(mapsClient)
	placesGroup := api.Group("/places", authMiddleware, authLimiter)
	placesHandler.RegisterRoutes(placesGroup)

	// Zones routes (public check).
	zonesGroup := api.Group("/zones", publicLimiter)
	zonesHandler.RegisterPublicRoutes(zonesGroup)

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

	// Helper routes (requires JWT + pro role).
	helpersGroup := api.Group("/helpers", authMiddleware, authLimiter, dbBoundLimiter)
	helperHandler.RegisterRoutes(helpersGroup)

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

	// Public SDUI routes: mounted under /api/v1 to match the rest of the public
	// surface. The handler does its own optional auth via c.Locals("userID").
	bffHandler.RegisterRoutes(api.Group("/sdui", compress.New(), publicLimiter))

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

	log.Info().Msg("server stopped")
}
