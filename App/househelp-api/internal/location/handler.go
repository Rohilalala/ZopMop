package location

import (
	"context"
	"math"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// roundLogCoord rounds a lat/lng to 2 decimals (~1.1 km precision)
// for safe structured logging. Audit C-8 / F2D-1 chunk 13. Mirrors
// the pattern already in matching/insights/zones.
func roundLogCoord(x float64) float64 { return math.Round(x*100) / 100 }

// wsAuthDeadline bounds how long an unauthenticated WebSocket connection may
// sit idle before we drop it. Prevents socket exhaustion by callers that
// upgrade but never send the auth message.
const wsAuthDeadline = 5 * time.Second

// wsReadDeadline / wsPingInterval — keep in sync with
// internal/booking/tracking_ws.go.
//
// Audit trail: D2-2 / NEW-E2-003.
const wsReadDeadline = 90 * time.Second
const wsPingInterval = 45 * time.Second

// Handler handles HTTP/WebSocket requests for the location module.
type Handler struct {
	service        *Service
	jwtKeys        []middleware.JWTKey
	db             *pgxpool.Pool
	suspensionCheck middleware.SuspensionChecker
}

// NewHandler creates a new location handler. db is required to authorize
// GetHelperLocation against an active booking between caller and helper.
// suspensionCheck performs the live is_suspended DB read at WS handshake
// (audit C-8 / A5-06 chunk 16). Optional — nil falls back to the legacy
// JWT-claim check; tests + older binaries unaffected.
func NewHandler(service *Service, jwtKeys []middleware.JWTKey, db *pgxpool.Pool, suspensionCheck middleware.SuspensionChecker) *Handler {
	return &Handler{service: service, jwtKeys: jwtKeys, db: db, suspensionCheck: suspensionCheck}
}

// RegisterRoutes mounts location routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	// WebSocket upgrade endpoint for real-time location updates.
	// JWT must be validated BEFORE the WebSocket upgrade.
	router.Use("/ws", h.websocketUpgradeCheck)
	router.Get("/ws", websocket.New(h.HandleWebSocket))

	// REST endpoint to get a helper's current location.
	router.Get("/helper/:id", h.GetHelperLocation)
}

// websocketUpgradeCheck confirms the HTTP request is a WebSocket upgrade.
//
// We intentionally do NOT extract a JWT from the query string or the
// Authorization header at this layer. Tokens in URLs leak into access logs,
// proxy logs, browser history, and APM traces. Authentication is enforced by
// HandleWebSocket as the first message on the socket: the caller must send
// {"type":"auth","token":"<JWT>"} within wsAuthDeadline or the connection is
// closed. This matches the contract documented in the RN client
// (getLocationWsUrl in src/api/matching.ts).
func (h *Handler) websocketUpgradeCheck(c *fiber.Ctx) error {
	if !websocket.IsWebSocketUpgrade(c) {
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
			"error": "WebSocket upgrade required",
		})
	}
	return c.Next()
}

// wsAuthMessage is the expected first message from a WebSocket client.
type wsAuthMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

// HandleWebSocket handles WebSocket connections for real-time location updates.
// The first message MUST be {"type":"auth","token":"<JWT>"} within
// wsAuthDeadline. Only helpers/pros can send location updates.
// Subsequent messages: {"lat": 40.7128, "lng": -74.0060}.
func (h *Handler) HandleWebSocket(c *websocket.Conn) {
	// Bound the auth handshake: if the client does not send a valid auth
	// message within wsAuthDeadline, close the socket. Prevents socket
	// exhaustion via silent/stalled unauthenticated connections.
	if err := c.SetReadDeadline(time.Now().Add(wsAuthDeadline)); err != nil {
		log.Warn().Err(err).Msg("WebSocket SetReadDeadline failed")
		c.Close()
		return
	}

	var authMsg wsAuthMessage
	if err := c.ReadJSON(&authMsg); err != nil {
		log.Debug().Err(err).Msg("WebSocket auth message not received")
		_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}
	if authMsg.Type != "auth" || authMsg.Token == "" {
		_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}

	claims, err := middleware.ParseJWTClaims(authMsg.Token, h.jwtKeys)
	if err != nil {
		_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}

	userID, _ := claims["user_id"].(string)
	if userID == "" {
		_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}
	role, _ := claims["role"].(string)
	// Live suspension check at WS handshake (audit A5-06). Falls back
	// to JWT-claim read when no checker wired (tests / legacy).
	if h.suspensionCheck != nil {
		uid, parseErr := uuid.Parse(userID)
		if parseErr != nil {
			_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
			c.Close()
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		suspended, err := h.suspensionCheck.IsSuspended(ctx, uid)
		cancel()
		if err != nil {
			log.Error().Err(err).Str("user_id", userID).Msg("[location.ws] suspension check failed; failing closed")
			_ = c.WriteJSON(fiber.Map{"error": "service temporarily unavailable", "code": "AUTH_CHECK_FAILED"})
			c.Close()
			return
		}
		if suspended {
			_ = c.WriteJSON(fiber.Map{"error": "account suspended", "code": "ACCOUNT_SUSPENDED"})
			c.Close()
			return
		}
	} else if isSuspended, ok := claims["is_suspended"].(bool); ok && isSuspended {
		_ = c.WriteJSON(fiber.Map{"error": "account suspended", "code": "ACCOUNT_SUSPENDED"})
		c.Close()
		return
	}

	// Set initial read deadline + register pong handler that rotates the
	// deadline on each pong (audit D2-2 / NEW-E2-003). Read loop below
	// also rotates on every successful ReadJSON since healthy helpers
	// send location every 10s — pongs are the fallback for stale clients.
	_ = c.SetReadDeadline(time.Now().Add(wsReadDeadline))
	c.SetPongHandler(func(string) error {
		return c.SetReadDeadline(time.Now().Add(wsReadDeadline))
	})

	// Server-side ping ticker (audit D2-2). Closed via pingDone in defer
	// so it exits when the handler returns (read-loop break unwinds
	// through the websocket library's cleanup path).
	pingDone := make(chan struct{})
	defer close(pingDone)
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pingDone:
				return
			case <-ticker.C:
				if err := c.WriteControl(
					websocket.PingMessage,
					nil,
					time.Now().Add(5*time.Second),
				); err != nil {
					return
				}
			}
		}
	}()

	_ = c.WriteJSON(fiber.Map{"status": "authenticated"})

	// Log connection.
	log.Info().Str("user_id", userID).Str("role", role).Msg("WebSocket connection established")

	// Read messages in a loop until connection closes.
	for {
		var update LocationUpdate
		err := c.ReadJSON(&update)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Error().Err(err).Str("user_id", userID).Msg("WebSocket error")
			}
			break
		}

		// Rotate the read deadline on every successful read (audit D2-2).
		// Healthy helpers send a LocationUpdate every 10s; this keeps the
		// deadline rolling on real traffic, not just pongs.
		_ = c.SetReadDeadline(time.Now().Add(wsReadDeadline))

		// Validate location data.
		if update.Lat < -90 || update.Lat > 90 {
			c.WriteJSON(fiber.Map{"error": "invalid latitude"})
			continue
		}
		if update.Lng < -180 || update.Lng > 180 {
			c.WriteJSON(fiber.Map{"error": "invalid longitude"})
			continue
		}

		// Update location in Redis (available for helpers and admins).
		if role == "helper" || role == "pro" || role == "admin" {
			// Use context with timeout for location update.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := h.service.UpdateHelperLocation(ctx, userID, update.Lat, update.Lng); err != nil {
				cancel()
				log.Error().Err(err).Str("user_id", userID).Msg("failed to update helper location")
				c.WriteJSON(fiber.Map{"error": "failed to update location"})
				continue
			}
			cancel()

			// Acknowledge successful update.
			c.WriteJSON(fiber.Map{
				"status": "success",
				"lat":    update.Lat,
				"lng":    update.Lng,
			})

			log.Debug().
				Str("user_id", userID).
				Float64("lat", roundLogCoord(update.Lat)).
				Float64("lng", roundLogCoord(update.Lng)).
				Msg("helper location updated")
		} else {
			c.WriteJSON(fiber.Map{"error": "only helpers can update locations"})
		}
	}

	log.Info().Str("user_id", userID).Msg("WebSocket connection closed")
}

// GetHelperLocation handles GET /location/helper/:id.
//
// SECURITY: a helper's live coordinates are sensitive PII. Access is restricted to:
//   - the helper themselves,
//   - admins,
//   - a customer who has an ACTIVE booking with this helper
//     (status in 'accepted','in_progress','arrived').
//
// Any other caller receives 403 Forbidden.
func (h *Handler) GetHelperLocation(c *fiber.Ctx) error {
	helperID := c.Params("id")
	if !validator.IsUUID(helperID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid helper id",
		})
	}

	callerID, _ := c.Locals("userID").(string)
	callerRole, _ := c.Locals("role").(string)

	allowed := callerRole == "admin" || callerID == helperID
	if !allowed {
		// Active booking check: caller must be the customer on a live booking
		// with this helper.
		ctx, cancel := context.WithTimeout(c.UserContext(), 3*time.Second)
		defer cancel()
		var exists bool
		err := h.db.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM bookings
			    WHERE customer_id = $1
			      AND helper_id   = $2
			      AND status IN ('accepted','in_progress','arrived')
			 )`,
			callerID, helperID,
		).Scan(&exists)
		if err != nil {
			log.Error().Err(err).Str("helper_id", helperID).Str("caller_id", callerID).Msg("active booking check failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "authorization check failed"})
		}
		allowed = exists
	}

	if !allowed {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "forbidden"})
	}

	location, err := h.service.GetHelperLocation(c.UserContext(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper location")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "helper location not found",
		})
	}

	return c.JSON(location)
}
