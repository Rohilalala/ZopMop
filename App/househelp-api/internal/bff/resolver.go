package bff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// maxIncludeDepth bounds nested $include recursion. The total $include count
// reuses validator's `maxIncludeCount` to keep runtime + stage in lockstep.
const maxIncludeDepth = 5

// IncludeLoader resolves a `$include` key (e.g. "shared/footer") into raw JSON
// bytes representing either a single section or an array of sections.
type IncludeLoader func(key string) (json.RawMessage, error)

// Resolver walks a PageConfig and substitutes `$ref`/`$include`/visibility/
// rollout into a flat list of fully resolved sections. Owns no I/O — fetched
// values must already be in the `hydrated` map (from Hydrator).
type Resolver struct {
	reg        SourceRegistry
	loader     IncludeLoader
	appVersion string
	locale     string
}

// NewResolver wires the registry (for type validation) plus the include loader
// (nil means `$include` returns an error). appVersion + locale come from the
// request and feed rollout/i18n filters.
func NewResolver(reg SourceRegistry, loader IncludeLoader, appVersion, locale string) *Resolver {
	return &Resolver{
		reg:        reg,
		loader:     loader,
		appVersion: appVersion,
		locale:     locale,
	}
}

// Resolve runs steps 6 + 10–14 of the BFF pipeline against an already-hydrated
// data map. Returns a ResolvedPage ready for the handler to ETag + serve.
func (r *Resolver) Resolve(ctx context.Context, rc RequestContext, cfg *PageConfig, hydrated map[string]any, missing []string) (*ResolvedPage, error) {
	if cfg == nil {
		return nil, errors.New("resolver: nil PageConfig")
	}

	missingSet := make(map[string]struct{}, len(missing))
	for _, k := range missing {
		missingSet[k] = struct{}{}
	}

	// Step 1: inline $include.
	expanded, err := r.expandIncludes(cfg.Sections)
	if err != nil {
		return nil, err
	}

	// Step 2-4: walk each section, resolve $ref and visibility, drop hidden.
	resolved := make([]json.RawMessage, 0, len(expanded))
	for _, raw := range expanded {
		var section map[string]any
		if err := json.Unmarshal(raw, &section); err != nil {
			return nil, fmt.Errorf("resolver: bad section json: %w", err)
		}

		// Resolve all $ref nodes in the section tree (excluding the visibility
		// node itself, which is handled separately so we can default it to
		// false on miss without erroring).
		visibleNode, hasVisibleField := section["visible"]
		delete(section, "visible")

		walked, err := r.walkAndResolve(section, hydrated, missingSet)
		if err != nil {
			return nil, err
		}
		section = walked.(map[string]any)

		// Step 3: resolve visibility. Defaults true when unspecified, false on
		// missing $ref (so a flaky source hides the section rather than blow
		// up the page).
		visible := true
		if hasVisibleField {
			visible = r.resolveVisibility(visibleNode, hydrated, missingSet)
		}

		// Step 5: rollout gate.
		if !visible {
			continue
		}
		if !r.passesRollout(section, rc) {
			continue
		}
		section["visible"] = true

		// Step 6: warn on unknown section types but pass through — clients
		// filter via their registry.
		if t, ok := section["type"].(string); ok {
			if _, known := knownSectionTypes[t]; !known {
				log.Warn().Str("event", "sdui_unknown_section_type").
					Str("type", t).
					Msg("resolver: unknown section type — passing through")
			}
		}

		// Step 7: re-marshal.
		out, err := json.Marshal(section)
		if err != nil {
			return nil, fmt.Errorf("resolver: marshal section: %w", err)
		}
		resolved = append(resolved, out)
	}

	// Step 8: build ResolvedPage. ConfigHash is sha256-prefix(16 hex chars) of
	// the marshaled section list — used as ETag.
	hashInput, err := json.Marshal(resolved)
	if err != nil {
		return nil, fmt.Errorf("resolver: hash marshal: %w", err)
	}
	sum := sha256.Sum256(hashInput)
	configHash := hex.EncodeToString(sum[:])[:16]

	page := &ResolvedPage{
		PageID:           cfg.PageID,
		Version:          cfg.Version,
		MinClientVersion: cfg.MinClientVersion,
		ConfigHash:       configHash,
		SnapshotAt:       time.Now().UTC().Format(time.RFC3339),
		ConfigVersion:    cfg.Version,
		ExperimentID:     cfg.ExperimentID,
		Sections:         resolved,
	}
	return page, nil
}

// expandIncludes flattens any `{"$include": "key"}` nodes in the top-level
// section list, prefixing included section IDs with "<key>:" to keep them
// unique. Enforces depth ≤ 5 and total includes ≤ 5 with cycle detection.
func (r *Resolver) expandIncludes(in []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(in))
	count := 0
	for _, raw := range in {
		// Quick check: only objects can be $include.
		var probe map[string]any
		if err := json.Unmarshal(raw, &probe); err != nil {
			return nil, fmt.Errorf("resolver: bad section json: %w", err)
		}
		incVal, isInclude := probe["$include"]
		if !isInclude {
			out = append(out, raw)
			continue
		}
		key, _ := incVal.(string)
		if key == "" {
			return nil, errors.New("resolver: $include missing key")
		}
		count++
		if count > maxIncludeCount {
			return nil, fmt.Errorf("resolver: too many $include directives (>%d)", maxIncludeCount)
		}

		visited := map[string]struct{}{key: {}}
		expanded, err := r.loadInclude(key, 1, visited)
		if err != nil {
			return nil, err
		}
		out = append(out, expanded...)
	}
	return out, nil
}

// loadInclude resolves one $include key recursively. Section IDs in the
// returned slice are rewritten to "<key>:<originalID>" to avoid collisions
// across include sources.
func (r *Resolver) loadInclude(key string, depth int, visited map[string]struct{}) ([]json.RawMessage, error) {
	if depth > maxIncludeDepth {
		return nil, fmt.Errorf("resolver: $include depth exceeded (%d) at %q", maxIncludeDepth, key)
	}
	if r.loader == nil {
		return nil, fmt.Errorf("resolver: $include %q but no loader configured", key)
	}
	raw, err := r.loader(key)
	if err != nil {
		return nil, fmt.Errorf("resolver: $include %q: %w", key, err)
	}

	// Loaded payload may be either a single section object or an array.
	var asArr []json.RawMessage
	if err := json.Unmarshal(raw, &asArr); err == nil {
		// Recurse to handle nested $include inside the loaded payload.
		out := make([]json.RawMessage, 0, len(asArr))
		for _, item := range asArr {
			var probe map[string]any
			if err := json.Unmarshal(item, &probe); err != nil {
				return nil, fmt.Errorf("resolver: $include %q: bad section json: %w", key, err)
			}
			if nested, isInc := probe["$include"]; isInc {
				nestedKey, _ := nested.(string)
				if _, cycle := visited[nestedKey]; cycle {
					return nil, fmt.Errorf("resolver: $include cycle at %q", nestedKey)
				}
				visited[nestedKey] = struct{}{}
				sub, err := r.loadInclude(nestedKey, depth+1, visited)
				if err != nil {
					return nil, err
				}
				out = append(out, sub...)
				continue
			}
			rewritten, err := rewriteSectionID(item, key, probe)
			if err != nil {
				return nil, err
			}
			out = append(out, rewritten)
		}
		return out, nil
	}

	// Single-object payload.
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, fmt.Errorf("resolver: $include %q: bad json: %w", key, err)
	}
	if nested, isInc := probe["$include"]; isInc {
		nestedKey, _ := nested.(string)
		if _, cycle := visited[nestedKey]; cycle {
			return nil, fmt.Errorf("resolver: $include cycle at %q", nestedKey)
		}
		visited[nestedKey] = struct{}{}
		return r.loadInclude(nestedKey, depth+1, visited)
	}
	rewritten, err := rewriteSectionID(raw, key, probe)
	if err != nil {
		return nil, err
	}
	return []json.RawMessage{rewritten}, nil
}

// rewriteSectionID returns the section JSON with its `id` field prefixed by
// "<key>:" so included sections don't collide with sibling IDs.
func rewriteSectionID(raw json.RawMessage, includeKey string, parsed map[string]any) (json.RawMessage, error) {
	id, _ := parsed["id"].(string)
	if id == "" {
		id = "anon"
	}
	parsed["id"] = includeKey + ":" + id
	out, err := json.Marshal(parsed)
	if err != nil {
		return nil, fmt.Errorf("resolver: rewrite include id: %w", err)
	}
	return out, nil
}

// walkAndResolve recurses into maps and slices, replacing every `$ref` map
// with the hydrated value (or $default, or error per $required).
func (r *Resolver) walkAndResolve(node any, hydrated map[string]any, missing map[string]struct{}) (any, error) {
	switch v := node.(type) {
	case map[string]any:
		// Detect $ref nodes by presence of a string $ref key.
		if rawKey, hasRef := v["$ref"]; hasRef {
			refKey, _ := rawKey.(string)
			if refKey == "" {
				return nil, errors.New("resolver: $ref with empty key")
			}
			return r.resolveRef(v, refKey, hydrated, missing)
		}
		// Generic map walk.
		out := make(map[string]any, len(v))
		for k, child := range v {
			resolved, err := r.walkAndResolve(child, hydrated, missing)
			if err != nil {
				return nil, err
			}
			out[k] = resolved
		}
		return out, nil
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			resolved, err := r.walkAndResolve(child, hydrated, missing)
			if err != nil {
				return nil, err
			}
			out[i] = resolved
		}
		return out, nil
	default:
		return v, nil
	}
}

// resolveRef returns the hydrated value for one $ref node, applying $default
// and $required semantics plus light type validation against the registry.
func (r *Resolver) resolveRef(node map[string]any, refKey string, hydrated map[string]any, missing map[string]struct{}) (any, error) {
	def, hasDefault := node["$default"]
	required, _ := node["$required"].(bool)

	val, hit := hydrated[refKey]
	_, isMissing := missing[refKey]

	if hit && val != nil && !isMissing {
		// Type-validate: a mismatch on a critical source is fatal; otherwise
		// log + fall back to default (or drop).
		if !r.typeMatches(refKey, val) {
			src, known := r.reg[refKey]
			log.Warn().
				Str("event", "sdui_ref_type_mismatch").
				Str("ref", refKey).
				Str("expected", src.ReturnType).
				Msg("resolver: $ref type mismatch")
			if known && src.Critical {
				return nil, fmt.Errorf("resolver: $ref %q type mismatch (critical)", refKey)
			}
			if hasDefault {
				return def, nil
			}
			// No default → return nil; visibility/required gating handles the rest.
			return nil, nil
		}
		if rawIDs, hasIDs := node["$ids"]; hasIDs {
			return filterByIDs(val, rawIDs), nil
		}
		return val, nil
	}

	// Hydrated map miss.
	if required {
		return nil, fmt.Errorf("resolver: required $ref %q missing", refKey)
	}
	if hasDefault {
		return def, nil
	}
	// Non-required, no default — caller decides (typically: section becomes
	// invisible). Return nil so downstream JSON renders as null.
	return nil, fmt.Errorf("resolver: $ref %q missing and no $default", refKey)
}

// filterByIDs narrows a slice-valued $ref to the elements whose "id" field
// appears in $ids, returned in $ids order. Lets a config pin which items a
// list source renders (membership + order) while the values stay live — e.g.
// {"$ref": "services.popular", "$ids": [...]} shows only the configured
// services at current catalog prices. IDs absent from the source are dropped
// (a deactivated service silently disappears from the page). Non-slice values
// and malformed $ids pass through unchanged.
func filterByIDs(val any, rawIDs any) any {
	ids, ok := rawIDs.([]any)
	if !ok || len(ids) == 0 {
		return val
	}
	// Normalize through JSON so typed slices from in-process fetchers (e.g.
	// []services.Service) and []any from cache are handled uniformly.
	raw, err := json.Marshal(val)
	if err != nil {
		return val
	}
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		return val
	}
	byID := make(map[string]map[string]any, len(items))
	for _, item := range items {
		if id, _ := item["id"].(string); id != "" {
			byID[id] = item
		}
	}
	out := make([]any, 0, len(ids))
	for _, rawID := range ids {
		id, _ := rawID.(string)
		if item, ok := byID[id]; ok {
			out = append(out, item)
		}
	}
	return out
}

// resolveVisibility resolves the section.visible field. Defaults to false on
// any error/miss so a flaky source hides the section rather than crashing.
func (r *Resolver) resolveVisibility(node any, hydrated map[string]any, missing map[string]struct{}) bool {
	switch v := node.(type) {
	case bool:
		return v
	case map[string]any:
		rawKey, hasRef := v["$ref"]
		if !hasRef {
			return false
		}
		refKey, _ := rawKey.(string)
		val, hit := hydrated[refKey]
		if _, isMissing := missing[refKey]; isMissing || !hit {
			if def, ok := v["$default"]; ok {
				if b, ok := def.(bool); ok {
					return b
				}
			}
			return false
		}
		if b, ok := val.(bool); ok {
			return b
		}
		return false
	default:
		return false
	}
}

// typeMatches loosely checks a hydrated value's Go type against the registry
// declared ReturnType. JSON unmarshal will produce float64 for any number,
// []any for arrays, etc., so the matrix below is intentionally permissive.
func (r *Resolver) typeMatches(refKey string, val any) bool {
	src, ok := r.reg[refKey]
	if !ok || src.ReturnType == "" || src.ReturnType == "any" {
		return true
	}
	switch src.ReturnType {
	case "string":
		_, ok := val.(string)
		return ok
	case "number":
		switch val.(type) {
		case float64, float32, int, int32, int64:
			return true
		}
		return false
	case "bool":
		_, ok := val.(bool)
		return ok
	default:
		// Slice-typed return values — anything that arrives as a slice is fine.
		if strings.HasPrefix(src.ReturnType, "[]") {
			switch val.(type) {
			case []any:
				return true
			}
			// Concrete typed slices (e.g. []services.Service) come from in-process
			// fetchers and won't be []any — accept them as well.
			return true
		}
		return true
	}
}

// passesRollout applies section-level rollout rules: min_client_version gate,
// percentage gate (deterministic on user_id+section_id), and user_segment
// (currently pass-through for non-"all").
func (r *Resolver) passesRollout(section map[string]any, rc RequestContext) bool {
	rollout, ok := section["rollout"].(map[string]any)
	if !ok {
		return true
	}
	if minVer, ok := rollout["min_client_version"].(string); ok && minVer != "" {
		if !semverGTE(r.appVersion, minVer) {
			return false
		}
	}
	if pct, ok := rollout["percentage"].(float64); ok && pct >= 0 && pct < 100 {
		id, _ := section["id"].(string)
		bucket := bucketHash(rc.UserID + ":" + id)
		if bucket >= int(pct) {
			return false
		}
	}
	if seg, ok := rollout["user_segment"].(string); ok && seg != "" && seg != "all" {
		// Segment evaluation isn't implemented yet — pass through rather than
		// drop (drop would silently kill experiments). This is the safe
		// default until segment metadata is added to RequestContext.
		_ = seg
	}
	return true
}

// semverGTE reports whether a >= b for simple "X.Y.Z" version strings. Missing
// segments are treated as 0; non-numeric tails are ignored. This is good
// enough for client-version gating; full semver isn't worth the dep.
func semverGTE(a, b string) bool {
	pa := splitVer(a)
	pb := splitVer(b)
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x > y {
			return true
		}
		if x < y {
			return false
		}
	}
	return true
}

func splitVer(v string) []int {
	if v == "" {
		return nil
	}
	// Strip pre-release / build metadata.
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}

// bucketHash returns a stable [0,100) bucket for the given key. Uses FNV-1a
// for speed; not cryptographic, but sufficient for percentage rollouts.
func bucketHash(key string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return int(h.Sum32() % 100)
}
