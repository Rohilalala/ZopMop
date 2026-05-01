# Server-Driven UI — Requirements & Build Plan

**Stack:** Go (Fiber v2, pgx v5, Redis) · React Native (Expo, FlashList)  
**Branch:** `feature/sdui`  
**Status:** Planning complete. Not started.

---

## 1. What This Is

Replace hardcoded screen layouts with a JSON-driven system where the server controls:
- Which sections appear and in what order
- Section content, sizing, spacing, and visibility
- Promo carousel copy without an app release
- A/B experiments and rollouts scoped by user segment or app version

The client becomes a renderer. The server becomes the source of truth for layout.

---

## 2. Architecture — 7 Layers

```
┌─────────────────────────────────────────────┐
│  1. Design System    tokens.ts               │
│     Colors, Typography, Spacing, Radius      │
├─────────────────────────────────────────────┤
│  2. SDUI JSON Schema  types.ts               │
│     SduiPage · SduiSection · SduiAction      │
├─────────────────────────────────────────────┤
│  3. Data Sources      sources.go             │
│     SourceDef registry · BatchDef registry  │
├─────────────────────────────────────────────┤
│  4. BFF Layer         internal/bff/          │
│     Hydrate · Resolve · Cache · Validate     │
├─────────────────────────────────────────────┤
│  5. Page Config       sdui_page_configs DB   │
│     Versioned JSON · draft→staged→active     │
├─────────────────────────────────────────────┤
│  6. Renderer          SectionRenderer.tsx    │
│     Registry · ErrorBoundary · Safeguards    │
├─────────────────────────────────────────────┤
│  7. Page UI           HomeScreen.tsx         │
│     FlashList · useSduiPage · skeleton       │
└─────────────────────────────────────────────┘
```

---

## 3. File Structure (everything to create)

```
App/househelp-api/
├── migrations/
│   └── 035_sdui_tables.sql
├── schemas/
│   └── sdui_page_config.json          ← JSON Schema for gojsonschema
├── static/safe_layouts/
│   └── home.json                      ← go:embed fallback, no external deps
├── internal/bff/
│   ├── types.go
│   ├── sources.go                     ← SourceDef + BatchDef registries
│   ├── validator.go                   ← schema + refs + limits + linter
│   ├── security.go                    ← dynamic action whitelist from DB
│   ├── circuit.go                     ← gobreaker wrappers, init at startup
│   ├── migrations/                    ← config schema migrations
│   │   ├── migrate.go
│   │   ├── v1_to_v2.go
│   │   └── ...
│   ├── metrics.go                     ← zerolog structured wrappers
│   ├── repository.go                  ← full lifecycle CRUD + audit log
│   ├── hydrator.go                    ← singleflight + semaphore + Redis + batch
│   ├── resolver.go                    ← $ref + $include + type validation
│   ├── handler.go                     ← GET /page/:id
│   ├── lazy_handler.go               ← GET /page/:id/section/:id
│   └── admin_handler.go              ← admin REST + preview + kill-switch
├── internal/middleware/
│   └── admin_auth.go                  ← role check + rate limits

App/zopmop-app/src/
├── sdui/
│   ├── tokens.ts                      ← design tokens (light + dark)
│   ├── types.ts                       ← all TypeScript types
│   ├── safeguards.ts                  ← sanitizeLayout + safeSection
│   ├── registry.ts                    ← type → component map
│   ├── ActionHandler.ts               ← discriminated union executor
│   ├── SectionRenderer.tsx            ← React.memo + ErrorBoundary
│   └── sections/
│       ├── HeroCarouselSection.tsx
│       ├── LivePillSection.tsx
│       ├── UsualsRowSection.tsx
│       ├── ServiceGridSection.tsx
│       └── FooterSection.tsx
├── analytics/
│   ├── context.ts                     ← session_id + user context
│   └── impressionTracker.ts           ← fire-once per session
└── hooks/
    └── useSduiPage.ts                 ← fetch + cache + lazy + ETag
```

---

## 4. Database Schema

```sql
-- migrations/035_sdui_tables.sql

-- Page configs (versioned, lifecycle-controlled)
CREATE TABLE sdui_page_configs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  env           TEXT        NOT NULL DEFAULT 'production'
                            CHECK (env IN ('production', 'staging')),
  status        TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'staged', 'active', 'archived')),
  schema_version INT        NOT NULL DEFAULT 1,
  config_json   JSONB       NOT NULL,
  -- Metadata
  name          TEXT,
  description   TEXT,
  change_notes  TEXT,
  experiment_id TEXT,
  -- Audit trail
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  staged_by     TEXT,
  staged_at     TIMESTAMPTZ,
  activated_by  TEXT,
  activated_at  TIMESTAMPTZ,
  archived_by   TEXT,
  archived_at   TIMESTAMPTZ,
  UNIQUE(page_id, version, env)
);

-- Only one active config per (page_id, env) — DB enforces this
CREATE UNIQUE INDEX sdui_single_active
  ON sdui_page_configs(page_id, env)
  WHERE status = 'active';

CREATE INDEX ON sdui_page_configs(page_id, env, status);

-- Audit log (every lifecycle event)
CREATE TABLE sdui_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     TEXT        NOT NULL,
  config_id   UUID        REFERENCES sdui_page_configs(id),
  action      TEXT        NOT NULL,  -- created|staged|activated|rolled_back|deleted|previewed|kill_switch
  actor       TEXT        NOT NULL,
  note        TEXT,
  snapshot    JSONB,                 -- config_json at time of action
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sdui_audit_log(page_id, created_at DESC);

-- Applied config schema migrations
CREATE TABLE sdui_config_migrations (
  config_id    UUID REFERENCES sdui_page_configs(id),
  from_version INT  NOT NULL,
  to_version   INT  NOT NULL,
  applied_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (config_id, to_version)
);

-- Dynamic action whitelist (admin-editable, cached in Redis)
CREATE TABLE sdui_allowed_actions (
  id          UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    TEXT     NOT NULL UNIQUE,
  methods     TEXT[]   NOT NULL,
  is_active   BOOLEAN  NOT NULL DEFAULT true,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Promo slides for hero carousel
CREATE TABLE home_promos (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT  NOT NULL UNIQUE,
  eyebrow       TEXT  NOT NULL,
  title         TEXT  NOT NULL,
  body          TEXT  NOT NULL,
  cta           TEXT  NOT NULL,
  bg_color      TEXT  NOT NULL DEFAULT '#EEF2FF',
  accent_color  TEXT  NOT NULL DEFAULT '#4F46E5',
  emoji         TEXT  NOT NULL,
  screen        TEXT  NOT NULL,
  screen_params JSONB,
  display_order INT   NOT NULL DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. TypeScript Types (complete)

```typescript
// src/sdui/types.ts

// ── Design token refs ────────────────────────────────────────────────────────

export type ColorToken =
  | 'brand-primary' | 'brand-secondary'
  | 'surface' | 'surface-alt'
  | 'text-primary' | 'text-muted'
  | 'border';

// ── Layout (whitelist — server cannot send arbitrary ViewStyle) ────────────

export interface SduiLayout {
  height?:            number;
  width?:             number | string;   // number or "100%"
  flex?:              number;
  flexDirection?:     'row' | 'column';
  alignItems?:        'flex-start' | 'center' | 'flex-end' | 'stretch';
  justifyContent?:    'flex-start' | 'center' | 'flex-end' | 'space-between';
  gap?:               number;
  zIndex?:            number;
  marginTop?:         number;
  marginBottom?:      number;
  marginHorizontal?:  number;
  paddingHorizontal?: number;
  paddingVertical?:   number;
  borderRadius?:      number;
  overflow?:          'hidden' | 'visible';
  // NOT allowed: position, top, left, right, bottom, transform
}

export interface SduiStyle {
  bg?:     ColorToken;
  fg?:     ColorToken;
  radius?: 'sm' | 'md' | 'lg' | 'full';
}

// ── Actions (discriminated union) ────────────────────────────────────────────

type Trigger = 'tap' | 'long_press';

export type SduiAction =
  | { trigger: Trigger; type: 'navigate';     screen: string; params?: Record<string, unknown> }
  | { trigger: Trigger; type: 'bottom_sheet'; sheet_id: string; props?: Record<string, unknown> }
  | { trigger: Trigger; type: 'toast';        message: string; variant?: 'info' | 'success' | 'error' }
  | { trigger: Trigger; type: 'api_call';     endpoint: string; method: 'POST' | 'DELETE'; body?: Record<string, unknown> }
  | { trigger: Trigger; type: 'deep_link';    url: string }
  | { trigger: 'auto' | 'tap'; type: 'load_more'; section_id: string; cursor: string; endpoint: string };

// ── Section data shapes (one per component type) ─────────────────────────────

export interface PromoSlide {
  key: string; eyebrow: string; title: string;
  body: string; cta: string;
  bg: string; accent: string; emoji: string;
  action: SduiAction;
  image_url?: string;
}

export interface HeroCarouselData  { greeting_name: string; slides: PromoSlide[] }
export interface LivePillData       { nearby_count: number; avg_eta_min: number; avg_rating: number }
export interface UsualsRowData      { services: ApiService[] }
export interface ServiceGridData    { title: string; services: ApiService[]; has_more?: boolean; cursor?: string }

// ── Rollout control ──────────────────────────────────────────────────────────

export interface SduiRollout {
  min_client_version?: string;
  user_segment?:       'all' | 'premium' | 'new_user' | 'returning';
  percentage?:         number;
}

// ── Section (discriminated union) ────────────────────────────────────────────

type SduiSectionBase = {
  id:       string;
  layout?:  SduiLayout;
  style?:   SduiStyle;
  actions?: SduiAction[];
  visible:  boolean;          // always boolean — BFF resolves, never sends $ref here
  hydration?: 'eager' | 'lazy';
  lazy_endpoint?: string;
  rollout?: SduiRollout;
  priority?: 'high' | 'medium' | 'low';
};

export type SduiSection =
  | SduiSectionBase & { type: 'hero_carousel'; data: HeroCarouselData }
  | SduiSectionBase & { type: 'live_pill';     data: LivePillData }
  | SduiSectionBase & { type: 'usuals_row';    data: UsualsRowData }
  | SduiSectionBase & { type: 'service_grid';  data: ServiceGridData }
  | SduiSectionBase & { type: 'footer';        data: Record<string, never> };

// ── Page ────────────────────────────────────────────────────────────────────

export interface SduiPage {
  page_id:            string;
  version:            string;
  min_client_version: string;
  config_hash:        string;   // SHA256 prefix — ETag diffing
  snapshot_at:        string;   // ISO timestamp — lazy section consistency
  config_version:     string;
  experiment_id?:     string;
  sections:           SduiSection[];
}
```

---

## 6. Go Types (complete)

```go
// internal/bff/types.go

type Env      string
type Status   string
type Priority string

const (
    EnvProduction Env    = "production"
    EnvStaging    Env    = "staging"
    StatusDraft   Status = "draft"
    StatusStaged  Status = "staged"
    StatusActive  Status = "active"
    StatusArchived Status = "archived"
    PriorityHigh   Priority = "high"
    PriorityMedium Priority = "medium"
    PriorityLow    Priority = "low"
)

type RequestContext struct {
    UserID      string
    Token       string
    Lat, Lon    float64
    Locale      string
    ScreenWidth int
    AppVersion  string
    Env         Env
}

type SduiRef struct {
    Key      string `json:"$ref"`
    Default  any    `json:"$default,omitempty"`
    Required bool   `json:"$required,omitempty"`
}

type PageConfig struct {
    PageID           string            `json:"page_id"`
    Version          string            `json:"version"`
    MinClientVersion string            `json:"min_client_version"`
    ExperimentID     string            `json:"experiment_id,omitempty"`
    Sections         []json.RawMessage `json:"sections"`
}

type SourceDef struct {
    Key        string
    ReturnType string        // "string"|"number"|"bool"|"[]Service"|"[]PromoSlide"
    TTL        time.Duration
    Timeout    time.Duration
    Critical   bool          // false = hide section on fail; true = fail page
    Priority   Priority
    UserScoped bool          // true = cache key includes user_id
    Batch      string        // if set, fetched via BatchRegistry[Batch]
    Fetch      func(ctx context.Context, rc RequestContext) (any, error) // nil if Batch != ""
}

type BatchDef struct {
    Fetch func(ctx context.Context, rc RequestContext, keys []string) (map[string]any, error)
}
```

---

## 7. Source Registry (all known $ref keys)

| Key | Type | TTL | Critical | UserScoped | Batch |
|-----|------|-----|----------|------------|-------|
| `user.first_name` | string | 5m | false | true | — |
| `user.has_bookings` | bool | 2m | false | true | — |
| `user.usuals` | []Service | 2m | false | true | — |
| `insights.nearby_count` | number | 15s | false | false | insights |
| `insights.avg_eta_min` | number | 15s | false | false | insights |
| `insights.avg_rating` | number | 15s | false | false | insights |
| `services.popular` | []Service | 5m | false | false | — |
| `promos.active` | []PromoSlide | 10m | false | false | — |
| `i18n.*` | string | 1h | false | false | i18n |

**Singleflight key rules:**
- UserScoped=true → key includes `user_id` (never shared across users)
- UserScoped=false → key includes lat/lon zone (safe to share across requests)
- Batch sources → singleflight at batch level, not per key

---

## 8. API Contracts

### Client endpoints

```
GET /page/:page_id
    Headers: Authorization: Bearer <token> (optional)
             X-Client-Version: 2.1.0
             X-Screen-Width: 390
             X-Sdui-Env: staging  (admin only)
             Accept-Language: en-IN
             If-None-Match: <etag>
    Query:   lat=28.4357&lon=77.0763
    Response: SduiPage JSON
              ETag: <config_hash>
              Cache-Control: no-store
              Warning: 199 - (if stale fallback served)
    304: if ETag matches (nothing changed)

GET /page/:page_id/section/:section_id
    Query: cursor=<opaque>&limit=12&lat=&lon=&snapshot_at=<ISO>
    Enforces: limit ≤ 50
    Response: { section_id, type, data, cursor, has_more }
```

### Admin endpoints

```
GET    /admin/pages
GET    /admin/pages/:page_id/configs
POST   /admin/pages/:page_id/configs          body: { name, description, change_notes, config_json }
GET    /admin/pages/:page_id/configs/:version
PATCH  /admin/pages/:page_id/configs/:version  headers: If-Match required
DELETE /admin/pages/:page_id/configs/:version  (draft only)

PUT    /admin/pages/:page_id/configs/:version/stage     → draft→staged (runs all validation)
PUT    /admin/pages/:page_id/configs/:version/activate  → staged→active (requires If-Match)
PUT    /admin/pages/:page_id/configs/:version/rollback  → active→archived, prev→active (single tx)

GET    /admin/pages/:page_id/configs/:version/preview?user_id=&lat=&lon=
GET    /admin/pages/:page_id/audit-log

POST   /admin/pages/:page_id/kill-switch       → SET sdui:kill:<id> 1 EX 86400
DELETE /admin/pages/:page_id/kill-switch
GET    /admin/pages/:page_id/kill-switch

POST   /admin/experiments/:exp_id/kill-switch
DELETE /admin/experiments/:exp_id/kill-switch

GET    /admin/allowed-actions
POST   /admin/allowed-actions
DELETE /admin/allowed-actions/:id
```

---

## 9. Config JSON Format

```json
{
  "page_id": "home",
  "version": "1.0",
  "min_client_version": "2.1.0",
  "experiment_id": "home_hero_v2",
  "sections": [
    {
      "id": "hero",
      "type": "hero_carousel",
      "priority": "high",
      "hydration": "eager",
      "layout": { "height": 280 },
      "data": {
        "greeting_name": { "$ref": "user.first_name", "$default": "there" },
        "slides":         { "$ref": "promos.active",  "$required": true }
      }
    },
    {
      "id": "live",
      "type": "live_pill",
      "priority": "high",
      "layout": { "marginHorizontal": 20, "marginTop": 16 },
      "data": {
        "nearby_count": { "$ref": "insights.nearby_count", "$default": 0 },
        "avg_eta_min":  { "$ref": "insights.avg_eta_min",  "$default": 0 },
        "avg_rating":   { "$ref": "insights.avg_rating",   "$default": 5.0 }
      }
    },
    {
      "id": "usuals",
      "type": "usuals_row",
      "priority": "medium",
      "visible": { "$ref": "user.has_bookings" },
      "data": {
        "services": { "$ref": "user.usuals", "$default": [] }
      }
    },
    {
      "id": "popular",
      "type": "service_grid",
      "priority": "medium",
      "hydration": "lazy",
      "lazy_endpoint": "/page/home/section/popular",
      "data": {
        "title":    "Popular services",
        "services": { "$ref": "services.popular", "$required": true }
      }
    },
    {
      "$include": "shared/footer"
    }
  ]
}
```

**Ref rules:**
- `$required: true` + no `$default` → staging fails if source not in registry
- `$required: true` + runtime fetch fails → page request returns error
- `$default` present → runtime fetch fails → substitute default, hide section if needed
- `visible` with `$ref` → BFF resolves to boolean before returning to client

---

## 10. BFF Processing Pipeline (per request)

```
1. Kill switch check (Redis, ~1ms)
   └─ hit → return staticSafeLayout (go:embed)

2. Version gate
   └─ client version < min_client_version → return fallback config

3. Env gate
   └─ staging env requires admin token

4. Load active config from DB (or Redis L2 cache)

5. Apply schema migrations (in-memory, async write-back)

6. Inline $include sections (cycle check, depth limit 5, max 5 includes)
   └─ prefix included section IDs with include key

7. Extract + deduplicate $ref keys

8. Classify refs: user-scoped vs global, batched vs individual

9. Hydrate (errgroup, per-request semaphore=6):
   └─ Per source: singleflight → Redis → circuit breaker → fetch (per-source timeout)
   └─ Batch sources: singleflight at batch level
   └─ Global budget: 800ms

10. Resolve $refs in config tree:
    └─ Type-validate each resolved value against SourceDef.ReturnType
    └─ $required miss at runtime → page error
    └─ non-critical source nil → section.visible = false

11. Resolve visibility ($ref → bool)

12. Apply rollout rules (drop sections for ineligible clients)

13. Optimize image URLs (declared fields only, per section type)

14. Resolve i18n refs (locale from Accept-Language)

15. Compute config_hash (SHA256 prefix)
    └─ If-None-Match matches → 304

16. Cache last_good response (24h TTL)

17. Return SduiPage JSON + ETag header
```

---

## 11. Client Processing Pipeline (per response)

```
1. Check If-None-Match / ETag → 304 → no re-render

2. Parse response → safeSection() each section:
   └─ must have string id + string type
   └─ visible defaults true if missing
   └─ sanitizeLayout() whitelist filter
   └─ actions defaults []

3. Compare config_hash against AsyncStorage cache
   └─ match → skip state update (stable reference, no re-render)

4. Write to AsyncStorage with CACHE_SCHEMA_VERSION

5. Render via FlashList:
   └─ key = page_id + section.id + index
   └─ SectionRenderer (React.memo)
   └─ section.visible === false → null
   └─ type not in REGISTRY → log + null (prod) / placeholder (dev)
   └─ ErrorBoundary per section

6. Impression tracking (module-level Set, fire once per session per section)

7. Lazy sections:
   └─ render skeleton
   └─ fetch on viewport entry
   └─ timeout 5s, retry 2x (400ms/800ms backoff)
   └─ all retries fail → visible = false (auto-hide)

8. load_more sections:
   └─ trigger 'auto' at list end
   └─ append to section.data.items
   └─ update cursor
```

---

## 12. Validation Rules (all run at /stage)

| Check | Limit | Error or Warning |
|-------|-------|-----------------|
| Config size | ≤ 50 KB | error |
| Section count | ≤ 20 | error |
| Include count | ≤ 5 | error |
| Cyclic includes | — | error |
| Unknown $ref key | — | error |
| $required + $default on same ref | — | error |
| Unknown section type | — | warning |
| Hero section missing | — | warning |
| Section count > 15 | — | warning |
| Hero height > 400 | — | warning |
| Unknown action endpoint (not in whitelist) | — | error |
| Action method not in whitelist for endpoint | — | error |

Warnings returned in response body, do not block staging.  
All errors block staging — config cannot be activated without passing stage.

---

## 13. Resilience Design

### Fallback chain (server)
```
1. Fresh resolve succeeds          → serve
2. Resolve fails, Redis last_good  → serve stale + Warning header
3. Redis miss, all sources down    → serve staticSafeLayout (go:embed)
```

### Fallback chain (client)
```
1. Network success                 → render fresh
2. Network fails, AsyncStorage hit → render cached
3. AsyncStorage miss               → render HomeSkeleton
```

### Per-source failure
- `Critical: false` source fails → section `visible: false`, page renders
- `Critical: true` source fails → server returns error → client uses cached page

### Constants
| Constant | Value |
|----------|-------|
| Global hydration budget | 800ms |
| Per-source timeout | 200–400ms (varies per source) |
| Per-request semaphore | 6 concurrent fetches |
| Circuit breaker threshold | 5 consecutive failures |
| Circuit breaker cooldown | 10s |
| Max singleflight wait | parent context timeout |
| Client lazy section timeout | 5s |
| Client lazy section retries | 2 (400ms, 800ms backoff) |

---

## 14. Cache Design

### Redis key structure
```
sdui:page:<page_id>:last_good           TTL: 24h  — stale fallback
sdui:page:<page_id>:etag                TTL: 24h  — client diffing
sdui:kill:<page_id>                     TTL: 24h  — kill switch
sdui:kill:exp:<experiment_id>           TTL: 24h  — experiment kill switch
sdui:action_whitelist                   TTL: 5m   — allowed actions

hydra:v<configVer>:<sourceKey>:<zone>   TTL: per source — global sources
hydra:v<configVer>:<sourceKey>:<userId> TTL: per source — user-scoped sources
batch:v<configVer>:<batchKey>:<suffix>  TTL: per batch  — batch singleflight
```

### Cache invalidation on activation
Run AFTER DB commit (not inside transaction):
```
DEL sdui:page:<page_id>:last_good
DEL sdui:page:<page_id>:etag
(versioned hydra keys expire naturally via TTL)
```

### Client cache
```
AsyncStorage key: sdui:<page_id>
Value: { schemaVersion: 3, cachedAt: <ms>, page: SduiPage }
Invalidation: schemaVersion mismatch on read → delete + re-fetch
```
Bump `CACHE_SCHEMA_VERSION` in `useSduiPage.ts` whenever `SduiSection` shape changes.

---

## 15. Security Boundaries

| Threat | Mitigation |
|--------|-----------|
| Arbitrary RN styles from server | SduiLayout whitelist (no position/transform) |
| Server-triggered unsafe API calls | Dynamic endpoint whitelist in DB + method restriction |
| Admin config overwrites | If-Match / ETag optimistic locking |
| Preview exposing other users' data | Non-super-admins preview own data only; all previews audited |
| Admin API abuse | Role check + 60 req/min rate limit (Redis-backed) |
| Staging configs reaching prod users | env column + server-side gate (only admins can request staging) |
| Malicious config JSON | gojsonschema at /stage; size limit 50KB |
| Broken configs going live | draft→staged→active lifecycle; can't skip stages |
| Cyclic $include | Depth limit 5 + visited-set check at resolve time and /stage |

---

## 16. Analytics Events

All events include this base context:
```typescript
{
  user_id:        string | 'guest',
  session_id:     string,  // nanoid, generated at app launch
  app_version:    string,
  platform:       'ios' | 'android',
  config_version: string,
  experiment_id:  string | null,
}
```

| Event | When | Key fields |
|-------|------|------------|
| `sdui_section_impression` | Section mounts (once per session per section) | section_id, section_type, position |
| `sdui_action` | User triggers action | action_type, section_id |
| `sdui_unknown_component` | Registry miss | type, page_id |
| `sdui_render_error` | ErrorBoundary fires | section_id, section_type |
| `sdui_lazy_section_failed` | All retries exhausted | section_id |
| `sdui_kill_switch_activated` | Kill switch hit | page_id |

---

## 17. Admin Observability Alerts

Run as queries on `sdui_audit_log`:

| Alert | Query | Threshold |
|-------|-------|-----------|
| Config instability | rollbacks per page in 24h | > 3 |
| Config churn | activations per page per hour | > 5 |
| Short config lifetime | avg hours between activations | < 1h |
| Admin overactivity | config changes per admin per hour | > 10 |

BFF structured log alerts (zerolog → existing monitoring):

| Log event | Alert threshold |
|-----------|----------------|
| `sdui_resolve` with err | > 1% error rate |
| `sdui_render_error` (client) | > 0.5% sessions |
| `sdui_page_latency_ms` | p99 > 800ms |
| `sdui_lazy_section_failed` | > 5% lazy fetches |
| circuit breaker state change | any open event |

---

## 18. Execution Order (29 steps)

### Foundation (steps 1–4)
- [ ] `1` `migrations/035_sdui_tables.sql`
- [ ] `2` `schemas/sdui_page_config.json`
- [ ] `3` `src/sdui/tokens.ts`
- [ ] `4` `src/sdui/types.ts`

### BFF (steps 5–19)
- [ ] `5`  `internal/bff/types.go`
- [ ] `6`  `internal/bff/sources.go` (SourceRegistry + BatchRegistry)
- [ ] `7`  `internal/bff/validator.go` (schema + refs + limits + linter)
- [ ] `8`  `internal/bff/security.go` (dynamic whitelist from DB)
- [ ] `9`  `internal/bff/circuit.go` (gobreaker, init at startup)
- [ ] `10` `internal/bff/migrations/migrate.go` (idempotent, logged, fallback-safe)
- [ ] `11` `internal/bff/metrics.go` (zerolog wrappers)
- [ ] `12` `internal/bff/repository.go` (full lifecycle + rollback tx + ETag + audit + idempotency)
- [ ] `13` `internal/bff/hydrator.go` (singleflight + semaphore + circuit + Redis + batch + priority)
- [ ] `14` `internal/bff/resolver.go` ($ref + dedup + $include + i18n + image URLs + visibility)
- [ ] `15` `internal/bff/handler.go` (kill switch + fallback chain + version/env gate + ETag)
- [ ] `16` `internal/bff/lazy_handler.go` (pagination + snapshot_at contract)
- [ ] `17` `internal/bff/admin_handler.go` (full REST + If-Match + preview + kill-switch CRUD)
- [ ] `18` `internal/middleware/admin_auth.go` (role check + rate limits)
- [ ] `19` `cmd/api/main.go` updates (wire routes + compress middleware + go:embed static layouts)

### Client (steps 20–27)
- [ ] `20` `src/sdui/safeguards.ts`
- [ ] `21` `src/analytics/context.ts` + `src/analytics/impressionTracker.ts`
- [ ] `22` `src/sdui/ActionHandler.ts`
- [ ] `23` `src/sdui/registry.ts`
- [ ] `24` `src/sdui/sections/*.tsx` (5 adapters, thin wrappers over existing components)
- [ ] `25` `src/sdui/SectionRenderer.tsx`
- [ ] `26` `src/hooks/useSduiPage.ts`
- [ ] `27` Simplify `HomeScreen.tsx` (FlashList, remove STATIC_SERVICES + hardcoded slides)

### Seed + validate (steps 28–29)
- [ ] `28` Seed `sdui_allowed_actions` table
- [ ] `29` POST draft → stage → preview → activate for home page

---

## 19. Session Checkpoint Guide

When resuming across sessions, verify these before continuing:

**After step 1 (migration):**
```sql
\d sdui_page_configs   -- check all columns + constraints
\d sdui_audit_log
\d sdui_allowed_actions
\d home_promos
SELECT indexname FROM pg_indexes WHERE tablename = 'sdui_page_configs';
-- must include sdui_single_active
```

**After step 4 (types.ts):**
```bash
cd App/zopmop-app && npx tsc --noEmit
# Must compile with zero errors
```

**After step 14 (resolver):**
```bash
cd App/househelp-api && go build ./internal/bff/...
go test ./internal/bff/... -run TestResolver
```

**After step 19 (main.go wired):**
```bash
curl http://localhost:3000/page/home?lat=28.4&lon=77.0
# Must return SduiPage JSON (not 404, not 500)
# Must have ETag header
```

**After step 27 (HomeScreen):**
- Open app in simulator
- HomeScreen must render without STATIC_SERVICES
- Skeleton shows during load
- ETag sent on second open (check network tab)
- Kill switch: `redis-cli SET sdui:kill:home 1 EX 60` → app shows static layout

**After step 29 (seed activated):**
- Change `live_pill` layout height in admin → verify client reflects on next poll
- Activate → verify old ETag returns 304, new config returns 200

---

## 20. What Requires a Release vs Not

| Change | Release needed? |
|--------|----------------|
| Promo copy, CTA, emoji | No |
| Section order | No |
| Hide/show a section | No |
| Section height/width/spacing | No |
| New promo slide | No |
| A/B experiment rollout | No |
| Kill switch any section | No |
| Add i18n string | No |
| Add new component type to registry | **Yes** |
| Change component internal behaviour | **Yes** |
| Expand SduiLayout whitelist | **Yes** |
| Add new $ref source | **Yes** (Go deploy) |
| Change SduiSection shape | **Yes** (bump CACHE_SCHEMA_VERSION) |

---

## 21. Dependencies to Add

**Go:**
```
github.com/sony/gobreaker          # circuit breaker
github.com/xeipuuv/gojsonschema   # JSON Schema validation
golang.org/x/sync                  # singleflight + semaphore (already likely present)
```

**React Native:**
```
@shopify/flash-list                # virtualized list (replaces ScrollView for sections)
nanoid                             # session_id generation
```

No other new dependencies. Everything else uses existing stack (Fiber, pgx, Redis, zerolog, Reanimated, React Navigation).
