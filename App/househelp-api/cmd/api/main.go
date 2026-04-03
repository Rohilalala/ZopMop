package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/auth"
	"github.com/adityarohilla/househelp-api/internal/booking"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/content"
	"github.com/adityarohilla/househelp-api/internal/location"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
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

	// Admin.
	adminRepo := admin.NewRepository(dbPool)
	adminService := admin.NewService(adminRepo)
	adminHandler := admin.NewHandler(adminService)

	// Content.
	contentRepo := content.NewRepository(dbPool)
	contentService := content.NewService(contentRepo, rdb)
	contentHandler := content.NewHandler(contentService)

	// Config manager.
	configRepo := config_manager.NewRepository(dbPool)
	configService := config_manager.NewService(configRepo, rdb)
	configHandler := config_manager.NewHandler(configService)

	// Notification.
	notificationService := notification.NewService()

	// Booking.
	bookingRepo := booking.NewRepository(dbPool)
	bookingService := booking.NewService(bookingRepo, dbPool, rdb, configService, notificationService)
	bookingHandler := booking.NewHandler(bookingService)

	// Location.
	locationService := location.NewService(rdb)
	locationHandler := location.NewHandler(locationService, cfg.JWTSecret)

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

	// Admin routes (requires JWT + admin role + specific permissions).
	adminMiddleware := mw.AdminMiddleware(dbPool, rdb)
	adminLimiter := mw.RateLimiter(rdb, mw.AdminRateLimit, "user")
	adminGroup := api.Group("/admin", authMiddleware, adminMiddleware, adminLimiter)
	adminHandler.RegisterRoutes(adminGroup)
	contentHandler.RegisterAdminContentRoutes(adminGroup)
	configHandler.RegisterAdminRoutes(adminGroup)

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
