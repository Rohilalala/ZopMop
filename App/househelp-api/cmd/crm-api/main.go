// Command crm-api is the standalone Zopmop CRM admin backend. It runs as a
// separate process from cmd/api, on its own port, with its own DB pool and
// JWT secret. The user-facing app is unaffected by anything that happens
// here.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/alerts"
	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/auth"
	"github.com/adityarohilla/househelp-api/internal/crm/dashboard"
	"github.com/adityarohilla/househelp-api/internal/crm/flags"
	crmmw "github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/crm/analytics"
	"github.com/adityarohilla/househelp-api/internal/crm/banners"
	"github.com/adityarohilla/househelp-api/internal/crm/experiments"
	"github.com/adityarohilla/househelp-api/internal/crm/growth"
	"github.com/adityarohilla/househelp-api/internal/crm/orders"
	"github.com/adityarohilla/househelp-api/internal/crm/payouts"
	"github.com/adityarohilla/househelp-api/internal/crm/platform"
	"github.com/adityarohilla/househelp-api/internal/crm/promos"
	"github.com/adityarohilla/househelp-api/internal/crm/refunds"
	"github.com/adityarohilla/househelp-api/internal/crm/trustsafety"
	"github.com/adityarohilla/househelp-api/internal/crm/users"
	"github.com/adityarohilla/househelp-api/internal/crm/workers"
	"github.com/adityarohilla/househelp-api/internal/crm/zones"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/pkg/crmconfig"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/logger"
)

func main() {
	cfg, err := crmconfig.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[crm] failed to load config: %v\n", err)
		os.Exit(1)
	}

	logger.Init(cfg.Env)
	log.Info().Str("env", cfg.Env).Str("port", cfg.Port).Msg("[crm] starting crm-api")

	ctx := context.Background()

	// CRM-dedicated write pool. Capped low so we never starve the user-app pool.
	dbPool, err := database.NewPostgresPool(ctx, cfg.DatabaseURL, database.PostgresPoolConfig{
		MinConns:          cfg.DBPoolMinConns,
		MaxConns:          cfg.DBPoolMaxConns,
		MaxConnLifetime:   cfg.DBPoolMaxConnLife,
		MaxConnIdleTime:   cfg.DBPoolMaxConnIdle,
		HealthCheckPeriod: cfg.DBPoolHealthCheck,
	})
	if err != nil {
		log.Fatal().Err(err).Msg("[crm] failed to connect to PostgreSQL (write pool)")
	}
	defer dbPool.Close()

	// Read pool. Falls back to the same DSN as write when CRM_DATABASE_READ_URL
	// is not set; the read pool always exists so analytics queries have a
	// stable target regardless of replica configuration.
	readPool, err := database.NewPostgresPool(ctx, cfg.DatabaseReadURL, database.PostgresPoolConfig{
		MinConns:          cfg.DBPoolMinConns,
		MaxConns:          cfg.DBPoolMaxConns,
		MaxConnLifetime:   cfg.DBPoolMaxConnLife,
		MaxConnIdleTime:   cfg.DBPoolMaxConnIdle,
		HealthCheckPeriod: cfg.DBPoolHealthCheck,
	})
	if err != nil {
		log.Fatal().Err(err).Msg("[crm] failed to connect to PostgreSQL (read pool)")
	}
	defer readPool.Close()

	rdb, err := database.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Msg("[crm] failed to connect to Redis")
	}
	defer func() {
		if closeErr := rdb.Close(); closeErr != nil {
			log.Error().Err(closeErr).Msg("[crm] failed to close Redis")
		}
	}()

	app := fiber.New(fiber.Config{
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		BodyLimit:    8 * 1024 * 1024, // 8MB — banner uploads.
		ErrorHandler: func(ctx *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			message := "internal server error"
			var fe *fiber.Error
			if errors.As(err, &fe) {
				code = fe.Code
				message = fe.Message
			} else {
				log.Error().Err(err).Msg("[crm] unhandled request error")
			}
			return ctx.Status(code).JSON(fiber.Map{"error": message})
		},
	})

	app.Use(requestID())
	app.Use(securityHeaders(cfg.IsProduction()))
	app.Use(corsMiddleware(cfg.AllowedOrigins))
	app.Use(requestLogger())

	// Public health check. No auth, no rate limit — used by k8s probes.
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "service": "crm-api"})
	})
	app.Get("/ready", func(c *fiber.Ctx) error {
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

	// ── Wire up CRM modules ────────────────────────────────────────
	auditRecorder := audit.NewRecorder(dbPool)

	authRepo := auth.NewRepository(dbPool)
	authSvc := auth.NewService(authRepo, auth.Config{
		JWTSecret:        cfg.JWTSecret,
		JWTSecretID:      cfg.JWTSecretID,
		AccessTokenTTL:   cfg.AccessTokenTTL,
		RefreshTokenTTL:  cfg.RefreshTokenTTL,
		TOTPIssuer:       cfg.TOTPIssuer,
		LockoutThreshold: cfg.LockoutThreshold,
		LockoutDuration:  cfg.LockoutDuration,
	})
	authHandler := auth.NewHandler(authSvc, auditRecorder, auth.CookieOptions{
		Domain: cfg.RefreshCookieDomain,
		Secure: cfg.RefreshCookieSecure,
		Path:   "/",
	})

	flagsSvc := flags.NewService(dbPool, rdb, cfg.RedisNamespace, flags.DefaultRegistry())
	flagsHandler := flags.NewHandler(flagsSvc, auditRecorder)

	alertsSvc := alerts.NewService(readPool)
	alertsHandler := alerts.NewHandler(alertsSvc)

	dashSvc := dashboard.NewService(readPool)
	dashHandler := dashboard.NewHandler(dashSvc)

	usersRepo := users.NewRepository(readPool, dbPool)
	usersHandler := users.NewHandler(usersRepo, auditRecorder)

	workersRepo := workers.NewRepository(readPool, dbPool)
	workersHandler := workers.NewHandler(workersRepo, auditRecorder)

	ordersRepo := orders.NewRepository(readPool, dbPool)
	ordersHandler := orders.NewHandler(ordersRepo, auditRecorder)

	refundsRepo := refunds.NewRepository(readPool, dbPool)
	refundsHandler := refunds.NewHandler(refundsRepo, auditRecorder)

	promosRepo := promos.NewRepository(readPool, dbPool)
	promosHandler := promos.NewHandler(promosRepo, auditRecorder)

	bannersRepo := banners.NewRepository(readPool, dbPool)
	bannersHandler := banners.NewHandler(bannersRepo, auditRecorder)

	expRepo := experiments.NewRepository(readPool, dbPool)
	expHandler := experiments.NewHandler(expRepo, auditRecorder)

	analyticsSvc := analytics.NewService(readPool)
	analyticsHandler := analytics.NewHandler(analyticsSvc)

	notifSvc := notification.NewService(ctx, dbPool)
	growthSvc := growth.NewService(readPool, dbPool, notifSvc)
	growthHandler := growth.NewHandler(growthSvc, auditRecorder)

	zonesRepo := zones.NewRepository(readPool, dbPool)
	zonesHandler := zones.NewHandler(zonesRepo, auditRecorder)

	payoutsRepo := payouts.NewRepository(readPool, dbPool)
	payoutsHandler := payouts.NewHandler(payoutsRepo, auditRecorder)

	tsSvc := trustsafety.NewService(readPool, dbPool)
	tsHandler := trustsafety.NewHandler(tsSvc, auditRecorder)

	platformSvc := platform.NewService(readPool, dbPool)
	platformHandler := platform.NewHandler(platformSvc, auditRecorder)

	// ── Routes ─────────────────────────────────────────────────────
	api := app.Group("/admin")

	// Public auth endpoints (login, totp/verify, refresh, logout). These do
	// NOT pass through the JWT middleware — login must work without one.
	authPublic := api.Group("/auth")
	authHandler.RegisterPublicRoutes(authPublic)

	// Authed group. Every write below must call the audit recorder; the
	// handlers do this individually rather than via a global decorator so
	// the before/after diff is precise.
	jwtMW := crmmw.JWT(crmmw.JWTConfig{Secret: cfg.JWTSecret, DB: dbPool})
	authed := api.Group("", jwtMW)

	// Same /auth prefix, but the authenticated subset (sessions, /me).
	authedAuthGroup := authed.Group("/auth")
	authHandler.RegisterAuthedRoutes(authedAuthGroup)

	flagsHandler.RegisterRoutes(authed)
	alertsHandler.RegisterRoutes(authed)
	dashHandler.RegisterRoutes(authed)
	usersHandler.RegisterRoutes(authed)
	workersHandler.RegisterRoutes(authed)
	ordersHandler.RegisterRoutes(authed)
	refundsHandler.RegisterRoutes(authed)
	promosHandler.RegisterRoutes(authed)
	bannersHandler.RegisterRoutes(authed)
	expHandler.RegisterRoutes(authed)
	analyticsHandler.RegisterRoutes(authed)
	growthHandler.RegisterRoutes(authed)
	zonesHandler.RegisterRoutes(authed)
	payoutsHandler.RegisterRoutes(authed)
	tsHandler.RegisterRoutes(authed)
	platformHandler.RegisterRoutes(authed)

	// Module stub handler — every other module of the CRM lands here until
	// the dedicated package is wired in. Keeps the SPA's nav working even
	// when the backend hasn't shipped that module yet.
	authed.Get("/_stub/:module", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"module":  c.Params("module"),
			"status":  "not_implemented",
			"message": "this CRM module has not yet been shipped",
		})
	})

	// ── Start server with graceful shutdown ────────────────────────
	go func() {
		addr := fmt.Sprintf(":%s", cfg.Port)
		log.Info().Str("addr", addr).Msg("[crm] server starting")
		if err := app.Listen(addr); err != nil {
			log.Fatal().Err(err).Msg("[crm] server failed to start")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	log.Info().Str("signal", sig.String()).Msg("[crm] shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := app.ShutdownWithContext(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("[crm] shutdown error")
	}
	log.Info().Msg("[crm] stopped")
}
