package payroll

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler exposes the admin-side payroll surface. The cycle-close
// computation is normally driven by Cron; the manual trigger here
// is used for backfills or to re-run after a fix lands.
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterAdminRoutes mounts /payroll/run on the supplied router.
// Caller must already have adminMiddleware + authMiddleware
// chained on the parent group — this handler trusts that gate.
func (h *Handler) RegisterAdminRoutes(r fiber.Router) {
	r.Post("/payroll/run", h.RunCycle)
}

type runCycleRequest struct {
	CycleStart string `json:"cycle_start"` // YYYY-MM-DD
	CycleEnd   string `json:"cycle_end"`   // YYYY-MM-DD
}

// RunCycle accepts an explicit (cycle_start, cycle_end) so an admin
// can recompute or backfill a window. If both fields are empty the
// handler runs the cycle for today (must be a close date).
func (h *Handler) RunCycle(c *fiber.Ctx) error {
	var req runCycleRequest
	if err := c.BodyParser(&req); err != nil {
		// Empty body is allowed — falls through to RunForToday.
		req = runCycleRequest{}
	}

	if req.CycleStart == "" && req.CycleEnd == "" {
		res, err := h.svc.RunForToday(c.UserContext())
		if err == ErrNotCycleClose {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "today is not a cycle close date (15th or last-of-month). Pass cycle_start + cycle_end to run an arbitrary cycle.",
			})
		}
		if err != nil {
			log.Error().Err(err).Msg("[payroll] admin RunForToday failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(res)
	}

	start, err := time.ParseInLocation("2006-01-02", req.CycleStart, istLocation)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cycle_start: expected YYYY-MM-DD"})
	}
	end, err := time.ParseInLocation("2006-01-02", req.CycleEnd, istLocation)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cycle_end: expected YYYY-MM-DD"})
	}

	res, err := h.svc.RunCycle(c.UserContext(), CycleClose{Start: start, End: end})
	if err != nil {
		log.Error().Err(err).Msg("[payroll] admin RunCycle failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(res)
}
