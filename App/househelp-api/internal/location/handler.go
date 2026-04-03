package location

import (
	"context"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP/WebSocket requests for the location module.
type Handler struct {
	service   *Service
	jwtSecret string
}

// NewHandler creates a new location handler.
func NewHandler(service *Service, jwtSecret string) *Handler {
	return &Handler{service: service, jwtSecret: jwtSecret}
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

// websocketUpgradeCheck validates the JWT token before allowing WebSocket upgrade.
// The token can be passed via query parameter "token" since WebSocket
// doesn't support custom headers during the handshake.
func (h *Handler) websocketUpgradeCheck(c *fiber.Ctx) error {
	if !websocket.IsWebSocketUpgrade(c) {
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
			"error": "WebSocket upgrade required",
		})
	}

	// Validate JWT from query parameter.
	tokenString := c.Query("token")
	if tokenString == "" {
		// Also check Authorization header for backwards compatibility.
		authHeader := c.Get("Authorization")
		if authHeader != "" {
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 {
				tokenString = parts[1]
			}
		}
	}

	if tokenString == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "authentication required",
		})
	}

	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(h.jwtSecret), nil
	})
	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "authentication required",
		})
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "authentication required",
		})
	}

	// Store user info for the WebSocket handler.
	userID, _ := claims["user_id"].(string)
	role, _ := claims["role"].(string)
	c.Locals("userID", userID)
	c.Locals("role", role)

	return c.Next()
}

// HandleWebSocket handles WebSocket connections for real-time location updates.
// Only helpers can send location updates. Messages should be JSON-encoded with lat/lng fields.
// Expected message format: {"lat": 40.7128, "lng": -74.0060}
func (h *Handler) HandleWebSocket(c *websocket.Conn) {
	// Extract authenticated user info from context locals.
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		log.Warn().Msg("WebSocket connection attempt without userID")
		c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}

	role, ok := c.Locals("role").(string)
	if !ok {
		role = ""
	}

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
		if role == "helper" || role == "admin" {
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
				"lat": update.Lat,
				"lng": update.Lng,
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

	location, err := h.service.GetHelperLocation(c.Context(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper location")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "helper location not found",
		})
	}

	return c.JSON(location)
}
