package location

import (
	"context"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/rs/zerolog/log"
)

// wsAuthDeadline bounds how long an unauthenticated WebSocket connection may
// sit idle before we drop it. Prevents socket exhaustion by callers that
// upgrade but never send the auth message.
const wsAuthDeadline = 5 * time.Second

// Handler handles HTTP/WebSocket requests for the location module.
type Handler struct {
	service *Service
	jwtKeys []middleware.JWTKey
}

// NewHandler creates a new location handler.
func NewHandler(service *Service, jwtKeys []middleware.JWTKey) *Handler {
	return &Handler{service: service, jwtKeys: jwtKeys}
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
	if isSuspended, ok := claims["is_suspended"].(bool); ok && isSuspended {
		_ = c.WriteJSON(fiber.Map{"error": "account suspended"})
		c.Close()
		return
	}

	// Clear the auth deadline — from here we rely on application-level
	// heartbeats/idle timeouts rather than a hard read deadline.
	if err := c.SetReadDeadline(time.Time{}); err != nil {
		log.Warn().Err(err).Msg("WebSocket SetReadDeadline(clear) failed")
	}

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
				Float64("lat", update.Lat).
				Float64("lng", update.Lng).
				Msg("helper location updated")
		} else {
			c.WriteJSON(fiber.Map{"error": "only helpers can update locations"})
		}
	}

	log.Info().Str("user_id", userID).Msg("WebSocket connection closed")
}

// GetHelperLocation handles GET /location/helper/:id.
func (h *Handler) GetHelperLocation(c *fiber.Ctx) error {
	helperID := c.Params("id")
	if !validator.IsUUID(helperID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid helper id",
		})
	}

	location, err := h.service.GetHelperLocation(c.Context(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper location")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "helper location not found",
		})
	}

	return c.JSON(location)
}
