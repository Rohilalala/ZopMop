package booking

import (
	"context"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// trackingWSPushInterval is how often the server pushes a fresh tracking
// snapshot to the customer's WebSocket. Matches the previous client polling
// cadence; centralised on the server so the mobile client no longer wakes its
// JS thread + opens a TCP connection every 5 seconds.
const trackingWSPushInterval = 5 * time.Second

// trackingWSAuthDeadline bounds how long we wait for the auth handshake before
// dropping an idle, unauthenticated WebSocket. Mirrors the helper-side WS in
// internal/location/handler.go.
const trackingWSAuthDeadline = 5 * time.Second

// TrackingWSHandler serves the customer-side tracking WebSocket.
// Wire-format mirrors the helper WebSocket in internal/location:
//   1. Client sends {"type":"auth","token":"<JWT>"} as the first message.
//   2. Server replies {"status":"authenticated"} on success.
//   3. Server pushes a TrackingResponse JSON every trackingWSPushInterval.
type TrackingWSHandler struct {
	service         *Service
	jwtKeys         []middleware.JWTKey
	suspensionCheck middleware.SuspensionChecker
}

// NewTrackingWSHandler builds the handler used by RegisterTrackingWS.
// suspensionCheck performs the live is_suspended DB read at WS
// handshake (audit C-8 / A5-06 chunk 16). Optional — nil falls back
// to the legacy JWT-claim check.
func NewTrackingWSHandler(service *Service, jwtKeys []middleware.JWTKey, suspensionCheck middleware.SuspensionChecker) *TrackingWSHandler {
	return &TrackingWSHandler{service: service, jwtKeys: jwtKeys, suspensionCheck: suspensionCheck}
}

// RegisterTrackingWS mounts GET /:id/track/ws on the supplied router. Caller is
// expected to mount it under the same /api/v1/bookings prefix used by the REST
// handler so the bookingID param matches.
func (h *TrackingWSHandler) RegisterTrackingWS(router fiber.Router) {
	router.Use("/:id/track/ws", upgradeCheck)
	router.Get("/:id/track/ws", websocket.New(h.handle))
}

func upgradeCheck(c *fiber.Ctx) error {
	if !websocket.IsWebSocketUpgrade(c) {
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
			"error": "WebSocket upgrade required",
		})
	}
	// Stash bookingID for the websocket handler — c.Params is not available
	// once the connection is upgraded.
	c.Locals("track_booking_id", c.Params("id"))
	return c.Next()
}

type trackingAuthMsg struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func (h *TrackingWSHandler) handle(c *websocket.Conn) {
	bookingID, _ := c.Locals("track_booking_id").(string)
	if !validator.IsUUID(bookingID) {
		_ = c.WriteJSON(fiber.Map{"error": "invalid booking id"})
		c.Close()
		return
	}

	// Bound the auth handshake.
	if err := c.SetReadDeadline(time.Now().Add(trackingWSAuthDeadline)); err != nil {
		c.Close()
		return
	}

	var auth trackingAuthMsg
	if err := c.ReadJSON(&auth); err != nil || auth.Type != "auth" || auth.Token == "" {
		_ = c.WriteJSON(fiber.Map{"error": "authentication required"})
		c.Close()
		return
	}

	claims, err := middleware.ParseJWTClaims(auth.Token, h.jwtKeys)
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
			log.Error().Err(err).Str("user_id", userID).Msg("[booking.tracking_ws] suspension check failed; failing closed")
			_ = c.WriteJSON(fiber.Map{"error": "service temporarily unavailable", "code": "AUTH_CHECK_FAILED"})
			c.Close()
			return
		}
		if suspended {
			_ = c.WriteJSON(fiber.Map{"error": "account suspended", "code": "ACCOUNT_SUSPENDED"})
			c.Close()
			return
		}
	} else if suspended, ok := claims["is_suspended"].(bool); ok && suspended {
		_ = c.WriteJSON(fiber.Map{"error": "account suspended", "code": "ACCOUNT_SUSPENDED"})
		c.Close()
		return
	}

	// Clear auth deadline; long-lived push connection from here.
	_ = c.SetReadDeadline(time.Time{})
	_ = c.WriteJSON(fiber.Map{"status": "authenticated"})

	// Detect client-initiated close so the push loop exits promptly.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, rerr := c.ReadMessage(); rerr != nil {
				return
			}
		}
	}()

	push := func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		resp, terr := h.service.GetTracking(ctx, bookingID, userID)
		if terr != nil {
			// Authorisation / not-yet-active errors terminate the stream.
			_ = c.WriteJSON(fiber.Map{"error": terr.Error()})
			return false
		}
		if werr := c.WriteJSON(resp); werr != nil {
			return false
		}
		return true
	}

	if !push() {
		c.Close()
		return
	}

	ticker := time.NewTicker(trackingWSPushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			log.Debug().Str("booking_id", bookingID).Str("user_id", userID).Msg("tracking ws closed by client")
			return
		case <-ticker.C:
			if !push() {
				c.Close()
				return
			}
		}
	}
}
