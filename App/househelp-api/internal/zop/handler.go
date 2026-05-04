package zop

import (
	"strings"

	"github.com/gofiber/fiber/v2"
)

// Handler exposes Zop's single chat endpoint.
type Handler struct {
	service *Service
}

// NewHandler constructs a Zop handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts Zop routes onto an authenticated router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/chat", h.Chat)
	router.Delete("/history", h.ClearHistory)
}

// ClearHistory handles DELETE /api/v1/zop/history. Wipes only the user's
// chat history + session tracking from Redis. Rate limits, bookings,
// addresses, and other customer data are NOT touched.
func (h *Handler) ClearHistory(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
	}
	h.service.ClearUserHistory(c.UserContext(), userID)
	return c.JSON(fiber.Map{"ok": true})
}

// replyPrefix is the marker the cleaner uses to signal a direct-to-user
// reply, bypassing the Llama agent loop.
const replyPrefix = "REPLY:"

// stripReplyPrefix returns (replyBody, true) when s starts with the cleaner's
// REPLY: marker. Whitespace before/after the marker is tolerated.
func stripReplyPrefix(s string) (string, bool) {
	trimmed := strings.TrimSpace(s)
	if len(trimmed) < len(replyPrefix) {
		return "", false
	}
	if !strings.EqualFold(trimmed[:len(replyPrefix)], replyPrefix) {
		return "", false
	}
	return strings.TrimSpace(trimmed[len(replyPrefix):]), true
}

// chatRequest is the body of POST /api/v1/zop/chat.
type chatRequest struct {
	Message   string `json:"message"`
	SessionID string `json:"session_id"`
}

// chatResponse is the response shape of the chat endpoint.
type chatResponse struct {
	Reply        string       `json:"reply"`
	ActionTaken  interface{}  `json:"action_taken"`
	Data         interface{}  `json:"data"`
	QuickReplies []QuickReply `json:"quick_replies,omitempty"`
}

// QuickReply is a one-tap chip rendered under the assistant message. Tapping
// fires Value as the user's next chat message — the LLM then sees it as a
// normal user turn. Used for discrete-option questions (period, address,
// duration) so the user doesn't have to type "morning"/"home"/"60 min".
type QuickReply struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// Chat handles POST /api/v1/zop/chat. Two-model pipeline:
//
//   1. parse body
//   2. rate-limit per user
//   3. cleaner (Gemma) — either rewrites prompt for the chat brain OR
//      short-circuits with a "REPLY: ..." line for off-topic / abuse /
//      jailbreak / identity-probe inputs
//   4. on REPLY: short-circuit → sanitize, persist, return
//   5. otherwise → load history, run agent loop (Llama 3.3 70B on Groq)
//   6. sanitize the reply for upstream-model leaks
//   7. persist history
//   8. return
func (h *Handler) Chat(c *fiber.Ctx) error {
	var req chatRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if strings.TrimSpace(req.Message) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "message is required"})
	}

	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
	}

	ctx := c.UserContext()

	if h.service.ZopRateLimiter(ctx, userID) {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error": "You're sending too many messages. Please slow down a bit!",
		})
	}

	// Look up user's first name for personalisation. Fail-open: empty name
	// just disables the personalisation lines in the prompts.
	firstName := h.service.FirstName(ctx, userID)

	// Pre-fetch history so the cleaner can see the last assistant turn — it
	// uses that to vary REPLY-mode responses instead of repeating verbatim.
	history := h.service.ZopGetHistory(ctx, userID, req.SessionID)
	lastAssistant := ""
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "assistant" {
			lastAssistant = history[i].Content
			break
		}
	}

	cleaned := h.service.ZopCleanPrompt(ctx, firstName, req.Message, lastAssistant)

	// Cleaner short-circuit: REPLY: prefix means Gemma classified the input
	// as off-topic / abuse / jailbreak / identity-probe and produced the
	// final reply itself. Skip Llama, sanitize, persist, return.
	if reply, ok := stripReplyPrefix(cleaned); ok {
		sanitized := h.service.ZopSanitize(reply)
		// Tag this turn so future ZopAgentLoop calls treat it as off-topic
		// context, not active conversation Llama needs to address.
		h.service.ZopSaveHistory(ctx, userID, req.SessionID, req.Message, sanitized, "irrelevant")
		return c.JSON(chatResponse{
			Reply:       sanitized,
			ActionTaken: nil,
			Data:        nil,
		})
	}

	result := h.service.ZopAgentLoop(ctx, userID, firstName, cleaned, history)

	sanitized := h.service.ZopSanitize(result.Reply)

	h.service.ZopSaveHistory(ctx, userID, req.SessionID, req.Message, sanitized, "relevant")

	resp := chatResponse{Reply: sanitized}
	if result.ActionTaken != "" {
		resp.ActionTaken = result.ActionTaken
	}
	if result.Data != nil {
		resp.Data = result.Data
	}
	resp.QuickReplies = quickRepliesFor(req.Message, sanitized, result.ActionTaken, result.Data)
	return c.JSON(resp)
}

// quickRepliesFor derives one-tap chips for the user's next turn based on
// what the assistant just said + which tool ran. Heuristic; falls through to
// nil when nothing fits, in which case the frontend just doesn't show chips.
func quickRepliesFor(userMsg, reply, action string, data interface{}) []QuickReply {
	lowerReply := strings.ToLower(reply)
	lowerUser := strings.ToLower(userMsg)

	// Period question → 3 period chips.
	if action == "get_available_slots" {
		// Only show period chips if the user hasn't already named one and
		// the assistant is actually asking.
		userMentionedPeriod := strings.Contains(lowerUser, "morning") ||
			strings.Contains(lowerUser, "afternoon") ||
			strings.Contains(lowerUser, "evening")
		askedPeriod := strings.Contains(lowerReply, "morning") &&
			strings.Contains(lowerReply, "afternoon") &&
			strings.Contains(lowerReply, "evening")
		if !userMentionedPeriod && askedPeriod {
			return []QuickReply{
				{Label: "Morning", Value: "morning"},
				{Label: "Afternoon", Value: "afternoon"},
				{Label: "Evening", Value: "evening"},
			}
		}
	}

	// Now-or-scheduled question → 2 chips.
	if strings.Contains(lowerReply, "now or scheduled") ||
		strings.Contains(lowerReply, "now or later") {
		return []QuickReply{
			{Label: "Now", Value: "now"},
			{Label: "Schedule it", Value: "scheduled"},
		}
	}

	// Confirmation question → Yes/No chips.
	if (strings.Contains(lowerReply, "should i book") ||
		strings.Contains(lowerReply, "shall i book") ||
		strings.Contains(lowerReply, "confirm?") ||
		strings.Contains(lowerReply, "sound good?")) &&
		!strings.Contains(lowerReply, "booked ✅") {
		return []QuickReply{
			{Label: "Yes, confirm", Value: "yes confirm"},
			{Label: "Cancel", Value: "nevermind"},
		}
	}

	return nil
}
