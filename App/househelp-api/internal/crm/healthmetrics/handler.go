package healthmetrics

import (
	"context"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/pkg/httpx"
)

type Handler struct {
	collector  *Collector
	httpClient *http.Client
	appURL     string // base URL of user-app, e.g. https://api.zopmop.com
}

func NewHandler(c *Collector, appURL string) *Handler {
	return &Handler{
		collector:  c,
		httpClient: httpx.NewClient(3 * time.Second),
		appURL:     appURL,
	}
}

type Metrics struct {
	Snapshot
	Uptime    string `json:"uptime"` // "up" | "down" | "unknown"
	AppURL    string `json:"app_url"`
	CheckedAt string `json:"checked_at"`
}

func (h *Handler) Metrics(c *fiber.Ctx) error {
	snap := h.collector.Snapshot()
	upStatus := h.probe(c.UserContext())
	return c.JSON(Metrics{
		Snapshot:  snap,
		Uptime:    upStatus,
		AppURL:    h.appURL,
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func (h *Handler) probe(ctx context.Context) string {
	if h.appURL == "" {
		return "unknown"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.appURL+"/health", nil)
	if err != nil {
		return "down"
	}
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return "down"
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return "up"
	}
	return "down"
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/health")
	g.Get("/metrics", middleware.RequirePermission("healthmetrics.read"), h.Metrics)
}
