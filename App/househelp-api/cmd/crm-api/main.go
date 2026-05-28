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
	fiberrecover "github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/alerts"
	"github.com/adityarohilla/househelp-api/internal/crm/analytics"
	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/auth"
	"github.com/adityarohilla/househelp-api/internal/crm/banners"
	"github.com/adityarohilla/househelp-api/internal/crm/cash"
	"github.com/adityarohilla/househelp-api/internal/crm/dashboard"
	"github.com/adityarohilla/househelp-api/internal/crm/experiments"
	"github.com/adityarohilla/househelp-api/internal/crm/flags"
	"github.com/adityarohilla/househelp-api/internal/crm/growth"
	"github.com/adityarohilla/househelp-api/internal/crm/healthmetrics"
	"github.com/adityarohilla/househelp-api/internal/crm/leaves"
	"github.com/adityarohilla/househelp-api/internal/crm/localities"
	crmmw "github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/crm/notifications"
	"github.com/adityarohilla/househelp-api/internal/crm/orders"
	"github.com/adityarohilla/househelp-api/internal/crm/payouts"
	crmpayroll "github.com/adityarohilla/househelp-api/internal/crm/payroll"
	"github.com/adityarohilla/househelp-api/internal/crm/platform"
	"github.com/adityarohilla/househelp-api/internal/crm/promos"
	"github.com/adityarohilla/househelp-api/internal/crm/refunds"
	"github.com/adityarohilla/househelp-api/internal/crm/trustsafety"
	"github.com/adityarohilla/househelp-api/internal/crm/users"
	"github.com/adityarohilla/househelp-api/internal/crm/workers"
	"github.com/adityarohilla/househelp-api/internal/crm/zoneapprovals"
	"github.com/adityarohilla/househelp-api/internal/crm/zones"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/payroll"
	"github.com/adityarohilla/househelp-api/internal/shift"
	"github.com/adityarohilla/househelp-api/internal/wallet"

	"github.com/adityarohilla/househelp-api/internal/webhooks"
	"github.com/adityarohilla/househelp-api/pkg/crmconfig"
	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/logger"
	"github.com/jackc/pgx/v5"
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

	// WriteTimeout MUST be >= the longest per-handler Timeout middleware
	// (audit E2-3). CRM has no equivalent of cmd/api's 90s Zop AI
	// timeout today, but matching the customer-API value (120s) keeps
	// the two binaries aligned so a future long-running CRM endpoint
	// (analytics export, bulk push) doesn't silently get killed at the
	// connection level. ReadTimeout 60s for large body uploads
	// (banner images at 8MB BodyLimit can take time on slow links);
	// IdleTimeout 120s to match WriteTimeout.
	app := fiber.New(fiber.Config{
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
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

	// In-memory sliding-window metrics for the CRM dashboard health strip.
	// Constructed early so the middleware below captures every request.
	metricsCollector := healthmetrics.New(5 * time.Minute)

	// Recover MUST be first so panics in any later middleware or handler
	// are caught before they crash the worker (audit B2-01 / E2-2).
	app.Use(fiberrecover.New(fiberrecover.Config{
		EnableStackTrace: cfg.IsDevelopment(),
	}))
	app.Use(requestID())
	app.Use(securityHeaders(cfg.IsProduction()))
	app.Use(corsMiddleware(cfg.AllowedOrigins))
	app.Use(requestLogger())
	app.Use(metricsCollector.Middleware())

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

	// Convert the crmconfig rotation set (active + previous secrets) into
	// the auth.JWTKey shape the parsers consume. Keeps neither package
	// coupled to the other's struct internals (audit NEW-A3-001).
	jwtKeys := make([]auth.JWTKey, 0, len(cfg.JWTPreviousSecrets)+1)
	for _, e := range cfg.JWTVerificationSecrets() {
		jwtKeys = append(jwtKeys, auth.JWTKey{ID: e.ID, Secret: e.Secret})
	}

	authRepo := auth.NewRepository(dbPool)
	authSvc := auth.NewService(authRepo, auth.Config{
		JWTSecret:        cfg.JWTSecret,
		JWTSecretID:      cfg.JWTSecretID,
		JWTKeys:          jwtKeys,
		AccessTokenTTL:   cfg.AccessTokenTTL,
		RefreshTokenTTL:  cfg.RefreshTokenTTL,
		TOTPIssuer:       cfg.TOTPIssuer,
		LockoutThreshold: cfg.LockoutThreshold,
		LockoutDuration:  cfg.LockoutDuration,
	})
	// Wire the audit recorder so refresh-token replay detection can write
	// auth.session_replay_detected rows (audit C-2 / A1-F1).
	authSvc.SetRecorder(auditRecorder)
	authHandler := auth.NewHandler(authSvc, auditRecorder, auth.CookieOptions{
		Domain: cfg.RefreshCookieDomain,
		Secure: cfg.RefreshCookieSecure,
		Path:   "/",
	})

	flagsSvc := flags.NewService(dbPool, rdb, cfg.RedisNamespace, flags.DefaultRegistry())
	flagsHandler := flags.NewHandler(flagsSvc, auditRecorder)

	alertsSvc := alerts.NewService(readPool)
	alertsHandler := alerts.NewHandler(alertsSvc)

	notificationsSvc := notifications.NewService(dbPool)
	notificationsHandler := notifications.NewHandler(notificationsSvc)

	leavesRepo := leaves.NewRepository(readPool, dbPool)
	leavesSvc := leaves.NewService(leavesRepo)
	leavesHandler := leaves.NewHandler(leavesSvc, auditRecorder)

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

	// Phase 1 Step 3 — cash owes + settle. Read-only "who owes how much"
	// + a per-pro batch settle action that writes a crm_audit_log row.
	cashRepo := cash.NewRepository(dbPool)
	cashHandler := cash.NewHandler(cashRepo, auditRecorder)

	analyticsSvc := analytics.NewService(readPool)
	analyticsHandler := analytics.NewHandler(analyticsSvc)

	notifSvc := notification.NewService(ctx, dbPool)
	// Token resolver reads device_tokens through the read pool — counts /
	// fan-out queries don't need to hit the write pool. DeleteToken uses
	// the same pool because device-token cleanup is low-volume.
	tokenResolver := notification.NewTokenResolver(readPool)
	growthSvc := growth.NewService(readPool, dbPool, notifSvc)
	growthSvc.SetTokenResolver(tokenResolver)
	growthHandler := growth.NewHandler(growthSvc, auditRecorder)

	// Scheduled-push cron. Uses the write pool for FOR UPDATE SKIP LOCKED.
	// Stopped before the dispatcher + DB pools in the shutdown block below.
	pushScheduler := growth.NewScheduler(growthSvc, dbPool)
	pushScheduler.Start(ctx)

	zonesRepo := zones.NewRepository(readPool, dbPool)
	zonesHandler := zones.NewHandler(zonesRepo, auditRecorder)

	// Localities — operational areas the CRM admin manages and the pro app
	// reads via a public endpoint mounted in cmd/api.
	localitiesRepo := localities.NewRepository(dbPool)
	localitiesHandler := localities.NewHandler(localitiesRepo, auditRecorder)

	payoutsRepo := payouts.NewRepository(readPool, dbPool)
	payoutsHandler := payouts.NewHandler(payoutsRepo, auditRecorder)

	tsSvc := trustsafety.NewService(readPool, dbPool)
	tsHandler := trustsafety.NewHandler(tsSvc, auditRecorder)

	webhookDispatcher := webhooks.New(dbPool)

	// Fan dispatcher out to every module that fires admin events. SetDispatcher
	// is nil-safe in the handlers, but always set it here so events flow.
	usersHandler.SetDispatcher(webhookDispatcher)
	workersHandler.SetDispatcher(webhookDispatcher)
	flagsHandler.SetDispatcher(webhookDispatcher)
	promosHandler.SetDispatcher(webhookDispatcher)
	zonesHandler.SetDispatcher(webhookDispatcher)
	refundsHandler.SetDispatcher(webhookDispatcher)
	refundsHandler.SetNotification(notifSvc)
	walletRepo := wallet.NewRepository(dbPool)
	walletSvc := wallet.NewService(walletRepo)
	refundsHandler.SetWallet(refundsWalletAdapter{svc: walletSvc})

	// Pick the active payment gateway. Cashfree activates when CASHFREE_PG_APP_ID
	// is configured (full key set validated by pkg/config); otherwise the manual
	// gateway marks every approved refund as processed_manual for ops to settle
	// offline. Cashfree gateway implementation lands in a follow-up phase; until
	// then the manual gateway is the only available option.
	var refundGateway payments.Gateway = &payments.ManualGateway{}
	log.Info().Msg("[payments] using manual gateway (cashfree gateway not yet wired)")
	refundsHandler.SetGateway(refundGateway)

	ordersHandler.SetDispatcher(webhookDispatcher)
	ordersHandler.SetRedis(rdb)
	ordersHandler.SetNotification(notifSvc)

	platformSvc := platform.NewService(readPool, dbPool, webhookDispatcher)
	platformHandler := platform.NewHandler(platformSvc, auditRecorder)

	healthHandler := healthmetrics.NewHandler(metricsCollector, cfg.AppAPIURL)

	// Zone approvals — reuses the shift package's service so the state
	// machine + notifier-driven FCM stay identical to cmd/api. Audit
	// writes flow through the crm_audit_log via auditRecorder so the
	// SPA's audit page sees these actions.
	shiftRepo := shift.NewRepository(dbPool)
	shiftSvc := shift.NewService(shiftRepo)
	shiftSvc.SetNotifier(shift.NewNotifier(&shiftPushAdapter{n: notifSvc}))

	// Payroll admin surface — per-worker payouts list, mark-paid /
	// mark-failed reversal, single-row recompute. Engine is shared
	// with cmd/api so the calculation rule lives in exactly one place.
	payrollRepo := payroll.NewRepository(dbPool)
	payrollSvc := payroll.NewService(payrollRepo)
	crmPayrollRepo := crmpayroll.NewRepository(readPool, dbPool)
	crmPayrollHandler := crmpayroll.NewHandler(crmPayrollRepo, payrollSvc, auditRecorder)
	zoneApprovalsHandler := zoneapprovals.NewHandler(shiftSvc, auditRecorder)

	// ── Routes ─────────────────────────────────────────────────────
	api := app.Group("/admin")

	// Rate limiters (audit A1-F2 + A5-01). Two bands:
	//   1. Login (per-IP, strict): 5 attempts / 15 minutes. Suppresses
	//      X-RateLimit-* headers so attackers can't probe the cap.
	//      Audit-logged on 429 with target_id=ip.
	//   2. Authenticated (per-admin): 60 / minute, fail-closed.
	//      Audit-logged on 429 with target_id=adminID.
	// Both use the customer-side mw.NamedRateLimiter (Redis sliding-
	// window with Lua atomicity, in-process token-bucket pre-filter,
	// fail-closed when Redis is unreachable). Bucket names keep CRM
	// counters in their own namespace (ratelimit:crm-login:*,
	// ratelimit:crm-admin:*).
	crmLoginLimiter := mw.NamedRateLimiter(rdb, mw.RateLimitConfig{
		MaxRequests:     5,
		Window:          15 * time.Minute,
		FailureMode:     "fail-closed",
		SuppressHeaders: true,
		OnReject: func(c *fiber.Ctx) {
			auditRecorder.Log(c.UserContext(), audit.Entry{
				Action:     "ratelimit.exceeded",
				Module:     "crm-auth",
				TargetType: "ip",
				TargetID:   c.IP(),
				IPAddress:  c.IP(),
				UserAgent:  c.Get("User-Agent"),
				RequestID:  c.Get("X-Request-ID"),
			})
		},
	}, "ip", "crm-login")
	// Refresh band (per-IP, generous): 60 / minute. Active sessions hit
	// /admin/auth/refresh silently on token expiry; it MUST NOT share the
	// strict login bucket or normal navigation evicts the user (and the
	// shared 429 then blocks re-login). Own bucket: ratelimit:crm-refresh:*.
	crmRefreshLimiter := mw.NamedRateLimiter(rdb, mw.RateLimitConfig{
		MaxRequests:     60,
		Window:          time.Minute,
		FailureMode:     "fail-closed",
		SuppressHeaders: true,
		OnReject: func(c *fiber.Ctx) {
			auditRecorder.Log(c.UserContext(), audit.Entry{
				Action:     "ratelimit.exceeded",
				Module:     "crm-auth",
				TargetType: "ip",
				TargetID:   c.IP(),
				IPAddress:  c.IP(),
				UserAgent:  c.Get("User-Agent"),
				RequestID:  c.Get("X-Request-ID"),
			})
		},
	}, "ip", "crm-refresh")
	crmAdminLimiter := mw.NamedRateLimiter(rdb, mw.RateLimitConfig{
		MaxRequests: 60,
		Window:      time.Minute,
		FailureMode: "fail-closed",
		OnReject: func(c *fiber.Ctx) {
			adminID, _ := c.Locals("crmAdminID").(string)
			adminEmail, _ := c.Locals("crmAdminEmail").(string)
			auditRecorder.Log(c.UserContext(), audit.Entry{
				AdminID:    adminID,
				AdminEmail: adminEmail,
				Action:     "ratelimit.exceeded",
				Module:     "crm",
				TargetType: "admin",
				TargetID:   adminID,
				IPAddress:  c.IP(),
				UserAgent:  c.Get("User-Agent"),
				RequestID:  c.Get("X-Request-ID"),
			})
		},
	}, "crmAdmin", "crm-admin")

	// Public auth endpoints (login, totp/verify, refresh, logout). These do
	// NOT pass through the JWT middleware — login must work without one.
	// Login limiter chained here so brute-force / credential-stuffing get
	// 429'd before they reach the bcrypt verify.
	// No group-level limiter: /refresh must bypass the strict login bucket
	// entirely (Fiber runs group middleware on every child route), so each
	// public auth route binds its own limiter inside RegisterPublicRoutes.
	authPublic := api.Group("/auth")
	authHandler.RegisterPublicRoutes(authPublic, crmLoginLimiter, crmRefreshLimiter)

	// Authed group. Every write below must call the audit recorder; the
	// handlers do this individually rather than via a global decorator so
	// the before/after diff is precise.
	//
	// Limiter ordering: jwtMW first so c.Locals("crmAdminID") is set
	// before the limiter reads it; chain the per-admin limiter after.
	jwtMW := crmmw.JWT(crmmw.JWTConfig{Keys: jwtKeys, DB: dbPool})
	authed := api.Group("", jwtMW, crmAdminLimiter)

	// Same /auth prefix, but the authenticated subset (sessions, /me).
	authedAuthGroup := authed.Group("/auth")
	authHandler.RegisterAuthedRoutes(authedAuthGroup)

	flagsHandler.RegisterRoutes(authed)
	alertsHandler.RegisterRoutes(authed)
	notificationsHandler.RegisterRoutes(authed)
	leavesHandler.RegisterRoutes(authed)
	dashHandler.RegisterRoutes(authed)
	usersHandler.RegisterRoutes(authed)
	workersHandler.RegisterRoutes(authed)
	ordersHandler.RegisterRoutes(authed)
	refundsHandler.RegisterRoutes(authed)
	cashHandler.RegisterRoutes(authed)
	promosHandler.RegisterRoutes(authed)
	bannersHandler.RegisterRoutes(authed)
	expHandler.RegisterRoutes(authed)
	analyticsHandler.RegisterRoutes(authed)
	growthHandler.RegisterRoutes(authed)
	zonesHandler.RegisterRoutes(authed)
	localitiesHandler.RegisterRoutes(authed)
	payoutsHandler.RegisterRoutes(authed)
	crmPayrollHandler.RegisterRoutes(authed)
	tsHandler.RegisterRoutes(authed)
	platformHandler.RegisterRoutes(authed)
	healthHandler.RegisterRoutes(authed)
	zoneApprovalsHandler.RegisterRoutes(authed)

	// Module stub handler — gated behind ENABLE_STUB_ENUMERATOR=1
	// (audit E2-4). The route exposed the CRM module taxonomy to anyone
	// with a CRM JWT, which is information leakage with no production
	// purpose. Kept for dev convenience but disabled by default.
	if os.Getenv("ENABLE_STUB_ENUMERATOR") == "1" {
		authed.Get("/_stub/:module", func(c *fiber.Ctx) error {
			return c.JSON(fiber.Map{
				"module":  c.Params("module"),
				"status":  "not_implemented",
				"message": "this CRM module has not yet been shipped",
			})
		})
	}

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
	// Stop the push scheduler before the dispatcher + DB pools — gives any
	// in-flight Tick (and the SendPush it's running) up to 30s to drain.
	schedulerCtx, schedulerCancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := pushScheduler.Stop(schedulerCtx); err != nil {
		log.Error().Err(err).Msg("[crm] push scheduler stop error")
	}
	schedulerCancel()
	dispatcherCtx, dispatcherCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dispatcherCancel()
	if err := webhookDispatcher.Close(dispatcherCtx); err != nil {
		log.Error().Err(err).Msg("[crm] webhook dispatcher drain error")
	}
	log.Info().Msg("[crm] stopped")
}

// refundsWalletAdapter bridges the concrete *wallet.Service to the narrow
// WalletCrediter interface declared in internal/crm/refunds. Lets the
// refunds package stay free of an internal/wallet import.
type refundsWalletAdapter struct{ svc *wallet.Service }

func (a refundsWalletAdapter) Credit(
	ctx context.Context,
	userID string,
	amountPaise int64,
	kind string,
	paymentID, bookingID *string,
	note string,
) error {
	_, err := a.svc.Credit(ctx, userID, amountPaise, wallet.Kind(kind), paymentID, bookingID, note)
	return err
}

// _ keeps the pgx import alive for tx-bound adapters that may land here in
// future passes (the refunds dispatcher does not currently take a tx).
var _ = pgx.ErrNoRows

// shiftPushAdapter narrows notification.Service down to shift.PushClient.
// Mirrors the adapter on cmd/api so zone-approval pushes fire identically
// from either entry point.
type shiftPushAdapter struct{ n *notification.Service }

func (a *shiftPushAdapter) SendToAdmins(ctx context.Context, title, body string, data map[string]string) error {
	_, err := a.n.SendToAdmins(ctx, title, body, data)
	return err
}

func (a *shiftPushAdapter) SendToProByID(ctx context.Context, proID, title, body string, data map[string]string) error {
	return a.n.SendToProByID(ctx, proID, title, body, data)
}
