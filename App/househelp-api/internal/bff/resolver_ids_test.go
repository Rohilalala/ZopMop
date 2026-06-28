package bff

import (
	"reflect"
	"testing"
)

// typedItem mimics an in-process fetcher's struct slice element (e.g.
// services.Service) — filterByIDs must handle these via the JSON round-trip.
type typedItem struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Paise int    `json:"base_price_paise"`
}

func TestFilterByIDs(t *testing.T) {
	source := []typedItem{
		{ID: "a", Name: "Alpha", Paise: 2500},
		{ID: "b", Name: "Beta", Paise: 2500},
		{ID: "c", Name: "Gamma", Paise: 2500},
	}

	t.Run("filters and orders by $ids", func(t *testing.T) {
		got := filterByIDs(source, []any{"c", "a"})
		items, ok := got.([]any)
		if !ok {
			t.Fatalf("want []any, got %T", got)
		}
		if len(items) != 2 {
			t.Fatalf("want 2 items, got %d", len(items))
		}
		first := items[0].(map[string]any)
		second := items[1].(map[string]any)
		if first["id"] != "c" || second["id"] != "a" {
			t.Errorf("want order [c a], got [%v %v]", first["id"], second["id"])
		}
		// Live values survive the filter.
		if first["base_price_paise"] != float64(2500) {
			t.Errorf("want base_price_paise 2500, got %v", first["base_price_paise"])
		}
	})

	t.Run("drops ids missing from source", func(t *testing.T) {
		got := filterByIDs(source, []any{"a", "deactivated", "b"})
		items := got.([]any)
		if len(items) != 2 {
			t.Fatalf("want 2 items (missing id dropped), got %d", len(items))
		}
	})

	t.Run("passes through on malformed $ids", func(t *testing.T) {
		if got := filterByIDs(source, "not-an-array"); !reflect.DeepEqual(got, source) {
			t.Errorf("non-array $ids must pass value through unchanged")
		}
		if got := filterByIDs(source, []any{}); !reflect.DeepEqual(got, source) {
			t.Errorf("empty $ids must pass value through unchanged")
		}
	})

	t.Run("passes through non-slice values", func(t *testing.T) {
		if got := filterByIDs("scalar", []any{"a"}); got != "scalar" {
			t.Errorf("non-slice value must pass through unchanged, got %v", got)
		}
	})

	t.Run("handles []any source from cache", func(t *testing.T) {
		cached := []any{
			map[string]any{"id": "x", "name": "Xi"},
			map[string]any{"id": "y", "name": "Yi"},
		}
		got := filterByIDs(cached, []any{"y"})
		items := got.([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != "y" {
			t.Errorf("want [y], got %v", got)
		}
	})
}

func TestWalkRefsIDsValidation(t *testing.T) {
	v := &Validator{registry: SourceRegistry{"services.popular": {Key: "services.popular"}}}

	check := func(node map[string]any) []string {
		res := &ValidationResult{}
		v.walkRefs("$", node, res)
		return res.Errors
	}

	if errs := check(map[string]any{"$ref": "services.popular", "$ids": []any{"a", "b"}}); len(errs) != 0 {
		t.Errorf("valid $ids must pass, got %v", errs)
	}
	if errs := check(map[string]any{"$ref": "services.popular", "$ids": "a"}); len(errs) == 0 {
		t.Error("non-array $ids must error")
	}
	if errs := check(map[string]any{"$ref": "services.popular", "$ids": []any{}}); len(errs) == 0 {
		t.Error("empty $ids must error")
	}
	if errs := check(map[string]any{"$ref": "services.popular", "$ids": []any{"a", 7}}); len(errs) == 0 {
		t.Error("non-string $ids element must error")
	}
}
