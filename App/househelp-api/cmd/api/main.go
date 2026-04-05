package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adityarohilla/househelp-api/internal/addresses"
	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/auth"
	"github.com/adityarohilla/househelp-api/internal/booking"
	cartmod "github.com/adityarohilla/househelp-api/internal/cart"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/content"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	helpermod "github.com/adityarohilla/househelp-api/internal/helper"
	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	servicesmod "github.com/adityarohilla/househelp-api/internal/services"
	slotsmod "github.com/adityarohilla/househelp-api/internal/slots"
	zonesmod "github.com/adityarohilla/househelp-api/internal/zones"
	"github.com/adityarohilla/househelp-api/pkg/config"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/logger"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

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
	dbPool, err := database.NewPostgresPool(ctx, cfg.DatabaseURL)
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
			var e *fiber.Error
			if errors.As(err, &e) {
				code = e.Code
			}
			return ctx.Status(code).JSON(fiber.Map{"error": err.Error()})
		},
	})

	// --- Global middleware ---
	app.Use(mw.RequestID())
	app.Use(mw.SecurityHeaders())
	app.Use(mw.CORS(cfg.AllowedOrigins))
	app.Use(mw.RequestLogger())

	// Public rate limiter.
	publicLimiter := mw.RateLimiter(rdb, mw.PublicRateLimit, "ip")

	// --- Health check ---
	app.Get("/health", publicLimiter, func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":  "ok",
			"service": "househelp-api",
		})
	})

	// --- Initialize services ---

	// Auth.
	authRepo := auth.NewRepository(dbPool)
	authService := auth.NewService(authRepo, rdb, cfg.JWTSecret, cfg.JWTExpiryHours)
	authHandler := auth.NewHandler(authService)

	// Notification.
	notificationService := notification.NewService(context.Background())

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

	// Booking.
	bookingRepo := booking.NewRepository(dbPool)
	bookingService := booking.NewService(bookingRepo, dbPool, rdb, configService, notificationService, matchBatcher)
	bookingService.SetMapsClient(mapsClient)
	bookingHandler := booking.NewHandler(bookingService)

	// Location.
	locationService := location.NewService(rdb)
	locationHandler := location.NewHandler(locationService, cfg.JWTSecret)

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
	authGroup := api.Group("/auth", publicLimiter)
	authHandler.RegisterRoutes(authGroup)

	// App content routes (public, cached).
	appGroup := api.Group("/app", publicLimiter)
	contentHandler.RegisterPublicRoutes(appGroup)
	configHandler.RegisterPublicRoutes(appGroup)

	// Authenticated routes with rate limiting by user ID.
	authMiddleware := mw.AuthMiddleware(cfg.JWTSecret)
	authLimiter := mw.RateLimiter(rdb, mw.AuthRateLimit, "user")

	// Booking routes (requires JWT).
	bookingGroup := api.Group("/bookings", authMiddleware, authLimiter)
	bookingHandler.RegisterRoutes(bookingGroup)

	// Location routes (requires JWT).
	locationGroup := api.Group("/location", authMiddleware, authLimiter)
	locationHandler.RegisterRoutes(locationGroup)

	// Addresses routes (requires JWT).
	addressGroup := api.Group("/addresses", authMiddleware, authLimiter)
	addressHandler.RegisterRoutes(addressGroup)

	// Services catalog routes (public).
	servicesGroup := api.Group("/services", publicLimiter)
	servicesHandler.RegisterPublicRoutes(servicesGroup)

	// Cart routes (requires JWT).
	cartGroup := api.Group("/cart", authMiddleware, authLimiter)
	cartHandler.RegisterRoutes(cartGroup)

	// Time slots routes (requires JWT).
	slotsGroup := api.Group("/slots", authMiddleware, authLimiter)
	slotsHandler.RegisterRoutes(slotsGroup)

	// Zones routes (public check).
	zonesGroup := api.Group("/zones", publicLimiter)
	zonesHandler.RegisterPublicRoutes(zonesGroup)

	// Profile routes (requires JWT).
	meGroup := api.Group("/me", authMiddleware, authLimiter)
	authHandler.RegisterMeRoutes(meGroup)

	// Helper routes (requires JWT + pro role).
	helpersGroup := api.Group("/helpers", authMiddleware, authLimiter)
	helperHandler.RegisterRoutes(helpersGroup)

	// Admin routes (requires JWT + admin role + specific permissions).
	adminMiddleware := mw.AdminMiddleware(dbPool, rdb)
	adminLimiter := mw.RateLimiter(rdb, mw.AdminRateLimit, "user")
	adminGroup := api.Group("/admin", authMiddleware, adminMiddleware, adminLimiter)
	adminHandler.RegisterRoutes(adminGroup)
	contentHandler.RegisterAdminContentRoutes(adminGroup)
	configHandler.RegisterAdminRoutes(adminGroup)
	zonesHandler.RegisterAdminRoutes(adminGroup.Group("/zones"))

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
