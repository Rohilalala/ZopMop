package bff

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/rs/zerolog/log"
	"github.com/xeipuuv/gojsonschema"
)

// Validator runs the full /stage validation pipeline against a raw config_json
// blob: size limit, JSON Schema, ref/include/action linting.
type Validator struct {
	schema    *gojsonschema.Schema
	registry  SourceRegistry
	whitelist *ActionWhitelist
}

// ValidationResult holds errors (block) and warnings (non-blocking) collected
// during one Validate pass.
type ValidationResult struct {
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

// OK reports whether the config passed all blocking checks.
func (r *ValidationResult) OK() bool { return len(r.Errors) == 0 }

const (
	maxConfigBytes  = 50 * 1024
	maxSectionCount = 20
	warnSectionSoft = 15
	maxIncludeCount = 5
	warnHeroHeight  = 400
)

var knownSectionTypes = map[string]struct{}{
	"hero_carousel":    {},
	"live_pill":        {},
	"usuals_row":       {},
	"service_grid":     {},
	"footer":           {},
	"greeting_hero":    {},
	"header_promo":     {},
	"upcoming_booking": {},
}

// NewValidator loads the JSON schema from disk and binds the source registry +
// action whitelist for downstream linting.
func NewValidator(schemaPath string, reg SourceRegistry, whitelist *ActionWhitelist) (*Validator, error) {
	loader := gojsonschema.NewReferenceLoader("file://" + schemaPath)
	schema, err := gojsonschema.NewSchema(loader)
	if err != nil {
		return nil, fmt.Errorf("load sdui schema: %w", err)
	}
	return &Validator{
		schema:    schema,
		registry:  reg,
		whitelist: whitelist,
	}, nil
}

// Validate runs every stage check on the given raw config_json. Returns a
// non-nil ValidationResult even on internal error (the error is unrelated to
// the spec — it covers JSON parse / schema invocation failures).
func (v *Validator) Validate(ctx context.Context, raw []byte) (*ValidationResult, error) {
	res := &ValidationResult{Errors: []string{}, Warnings: []string{}}

	// 1. Size cap.
	if len(raw) > maxConfigBytes {
		res.Errors = append(res.Errors, fmt.Sprintf("config exceeds %d bytes (got %d)", maxConfigBytes, len(raw)))
		return res, nil
	}
	if len(raw) == 0 {
		res.Errors = append(res.Errors, "config is empty")
		return res, nil
	}

	// 2. JSON Schema validation.
	docLoader := gojsonschema.NewBytesLoader(raw)
	result, err := v.schema.Validate(docLoader)
	if err != nil {
		return res, fmt.Errorf("schema validate: %w", err)
	}
	if !result.Valid() {
		for _, e := range result.Errors() {
			res.Errors = append(res.Errors, fmt.Sprintf("schema: %s", e.String()))
		}
		// Schema failure is enough to abort; downstream walkers assume shape.
		return res, nil
	}

	// 3. Parse to PageConfig + walk.
	var cfg PageConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("parse: %s", err.Error()))
		return res, nil
	}

	if len(cfg.Sections) > maxSectionCount {
		res.Errors = append(res.Errors, fmt.Sprintf("section count %d exceeds limit %d", len(cfg.Sections), maxSectionCount))
	}
	if len(cfg.Sections) > warnSectionSoft {
		res.Warnings = append(res.Warnings, fmt.Sprintf("section count %d > soft limit %d", len(cfg.Sections), warnSectionSoft))
	}

	includeKeys := map[string]struct{}{}
	hasHero := false

	for idx, raw := range cfg.Sections {
		var node any
		if err := json.Unmarshal(raw, &node); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("section[%d]: invalid JSON: %s", idx, err.Error()))
			continue
		}

		// Detect $include nodes at the top level.
		if obj, ok := node.(map[string]any); ok {
			if inc, ok := obj["$include"].(string); ok {
				if _, dup := includeKeys[inc]; dup {
					res.Errors = append(res.Errors, fmt.Sprintf("section[%d]: cyclic/duplicate $include %q", idx, inc))
				}
				includeKeys[inc] = struct{}{}
				continue
			}
			// Not an include — must be a section.
			v.lintSection(ctx, idx, obj, res)
			if t, _ := obj["type"].(string); t == "hero_carousel" || t == "greeting_hero" {
				hasHero = true
			}
		}
	}

	if len(includeKeys) > maxIncludeCount {
		res.Errors = append(res.Errors, fmt.Sprintf("include count %d exceeds limit %d", len(includeKeys), maxIncludeCount))
	}
	if !hasHero {
		res.Warnings = append(res.Warnings, "no hero section found (hero_carousel or greeting_hero)")
	}

	log.Debug().
		Str("event", "sdui_validate").
		Int("errors", len(res.Errors)).
		Int("warnings", len(res.Warnings)).
		Msg("sdui validate complete")

	return res, nil
}

// lintSection runs the per-section checks: type, hero height, refs, actions.
func (v *Validator) lintSection(ctx context.Context, idx int, sec map[string]any, res *ValidationResult) {
	prefix := fmt.Sprintf("section[%d]", idx)
	if id, ok := sec["id"].(string); ok && id != "" {
		prefix = fmt.Sprintf("section[%d](%s)", idx, id)
	}

	if t, _ := sec["type"].(string); t != "" {
		if _, ok := knownSectionTypes[t]; !ok {
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s: unknown section.type %q", prefix, t))
		}
		if t == "hero_carousel" {
			if layout, ok := sec["layout"].(map[string]any); ok {
				if h, ok := layout["height"].(float64); ok && h > warnHeroHeight {
					res.Warnings = append(res.Warnings, fmt.Sprintf("%s: hero height %.0f > %d", prefix, h, warnHeroHeight))
				}
			}
		}
	}

	// Walk every nested $ref.
	v.walkRefs(prefix, sec, res)

	// Action whitelist check.
	if actions, ok := sec["actions"].([]any); ok {
		for ai, a := range actions {
			act, ok := a.(map[string]any)
			if !ok {
				continue
			}
			endpoint, _ := act["endpoint"].(string)
			method, _ := act["method"].(string)
			if endpoint == "" || method == "" {
				continue // non-api actions don't need whitelist check
			}
			ok2, err := v.whitelist.Allows(ctx, endpoint, method)
			if err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("%s.actions[%d]: whitelist lookup failed: %s", prefix, ai, err.Error()))
				continue
			}
			if !ok2 {
				// Distinguish unknown endpoint vs method-not-allowed.
				known, _ := v.whitelist.Allows(ctx, endpoint, "GET")
				_ = known
				if v.endpointKnown(ctx, endpoint) {
					res.Errors = append(res.Errors, fmt.Sprintf("%s.actions[%d]: method %s not allowed for %s", prefix, ai, method, endpoint))
				} else {
					res.Errors = append(res.Errors, fmt.Sprintf("%s.actions[%d]: unknown endpoint %s", prefix, ai, endpoint))
				}
			}
		}
	}
}

// endpointKnown reports whether the endpoint exists in the whitelist at all
// (regardless of method). Used to give a clearer error message.
func (v *Validator) endpointKnown(ctx context.Context, endpoint string) bool {
	list, err := v.whitelist.All(ctx)
	if err != nil {
		return false
	}
	for _, a := range list {
		if a.Endpoint == endpoint {
			return true
		}
	}
	return false
}

// walkRefs descends into nested objects/arrays and validates every $ref node.
func (v *Validator) walkRefs(path string, node any, res *ValidationResult) {
	switch n := node.(type) {
	case map[string]any:
		// $ref node?
		if rawKey, ok := n["$ref"]; ok {
			key, _ := rawKey.(string)
			if key == "" {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: $ref must be a non-empty string", path))
				return
			}
			// i18n.* keys resolve via batch — accept any sub-key.
			if !strings.HasPrefix(key, "i18n.") {
				if _, ok := v.registry[key]; !ok {
					res.Errors = append(res.Errors, fmt.Sprintf("%s: unknown $ref %q", path, key))
				}
			}
			_, hasDefault := n["$default"]
			req, _ := n["$required"].(bool)
			if req && hasDefault {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: $required:true and $default are mutually exclusive", path))
			}
			if rawIDs, ok := n["$ids"]; ok {
				ids, isArr := rawIDs.([]any)
				if !isArr || len(ids) == 0 {
					res.Errors = append(res.Errors, fmt.Sprintf("%s: $ids must be a non-empty array of strings", path))
				} else {
					for i, id := range ids {
						if s, ok := id.(string); !ok || s == "" {
							res.Errors = append(res.Errors, fmt.Sprintf("%s: $ids[%d] must be a non-empty string", path, i))
						}
					}
				}
			}
			return
		}
		for k, child := range n {
			v.walkRefs(path+"."+k, child, res)
		}
	case []any:
		for i, child := range n {
			v.walkRefs(fmt.Sprintf("%s[%d]", path, i), child, res)
		}
	}
}
