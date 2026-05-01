package bff

import (
	"context"
	"encoding/json"
	"time"
)

// Env names a deployment context. Staging is admin-gated.
type Env string

// Status names a config lifecycle stage.
type Status string

// Priority names a section's hydration importance.
type Priority string

const (
	EnvProduction Env    = "production"
	EnvStaging    Env    = "staging"
	StatusDraft    Status = "draft"
	StatusStaged   Status = "staged"
	StatusActive   Status = "active"
	StatusArchived Status = "archived"
	PriorityHigh   Priority = "high"
	PriorityMedium Priority = "medium"
	PriorityLow    Priority = "low"
)

// RequestContext carries the per-request inputs the BFF needs to hydrate refs,
// resolve rollouts, and pick caches. Built once at the top of the handler.
type RequestContext struct {
	UserID      string
	Token       string
	Lat, Lon    float64
	Locale      string
	ScreenWidth int
	AppVersion  string
	Env         Env
}

// SduiRef is the on-disk shape for a {"$ref":"..."} object in config_json.
// At hydrate time, refs are extracted, fetched, then substituted in place.
type SduiRef struct {
	Key      string `json:"$ref"`
	Default  any    `json:"$default,omitempty"`
	Required bool   `json:"$required,omitempty"`
}

// PageConfig is the shape persisted in sdui_page_configs.config_json.
// Sections stay raw so the validator + resolver can walk them generically.
type PageConfig struct {
	PageID           string            `json:"page_id"`
	Version          string            `json:"version"`
	MinClientVersion string            `json:"min_client_version"`
	ExperimentID     string            `json:"experiment_id,omitempty"`
	SchemaVersion    int               `json:"schema_version,omitempty"`
	Sections         []json.RawMessage `json:"sections"`
}

// SourceDef describes a single key in the data-source registry.
// Either Fetch or Batch must be set (not both).
type SourceDef struct {
	Key        string
	ReturnType string // "string"|"number"|"bool"|"[]Service"|"[]PromoSlide"|"any"
	TTL        time.Duration
	Timeout    time.Duration
	Critical   bool
	Priority   Priority
	UserScoped bool
	Batch      string
	Fetch      func(ctx context.Context, rc RequestContext) (any, error)
}

// BatchDef fetches multiple keys for one batch in a single call.
type BatchDef struct {
	Fetch func(ctx context.Context, rc RequestContext, keys []string) (map[string]any, error)
}

// ResolvedPage is what the handler returns to the client. It mirrors the
// SduiPage TypeScript interface.
type ResolvedPage struct {
	PageID           string            `json:"page_id"`
	Version          string            `json:"version"`
	MinClientVersion string            `json:"min_client_version"`
	ConfigHash       string            `json:"config_hash"`
	SnapshotAt       string            `json:"snapshot_at"`
	ConfigVersion    string            `json:"config_version"`
	ExperimentID     string            `json:"experiment_id,omitempty"`
	Sections         []json.RawMessage `json:"sections"`
}
