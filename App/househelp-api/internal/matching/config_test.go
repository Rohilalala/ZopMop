package matching

import (
	"context"
	"errors"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/config_manager"
)

// fakeConfig is an in-memory configGetter. A key present in vals is returned;
// a key in errs returns an error (simulating a missing row / DB miss); anything
// else returns an error too, mirroring config_manager's "not found" behaviour.
type fakeConfig struct {
	vals map[string]string
	errs map[string]bool
}

func (f fakeConfig) GetConfig(_ context.Context, key string) (string, error) {
	if f.errs[key] {
		return "", errors.New("simulated config error")
	}
	if v, ok := f.vals[key]; ok {
		return v, nil
	}
	return "", errors.New("not found")
}

func defaults() DispatchConfig {
	return DispatchConfig{
		LeadMin:           defaultDispatchLeadMin,
		TravelBufferMin:   defaultDispatchTravelBufferMin,
		AsapEtaPadMin:     defaultDispatchAsapEtaPadMin,
		AsapMaxPromiseMin: defaultDispatchAsapMaxPromiseMin,
		MinSlotLeadMin:    defaultDispatchMinSlotLeadMin,
	}
}

func TestLoadDispatchConfig_NilService_AllDefaults(t *testing.T) {
	got := LoadDispatchConfig(context.Background(), nil)
	if got != defaults() {
		t.Fatalf("nil service: got %+v, want %+v", got, defaults())
	}
}

func TestLoadDispatchConfig_MissingKeys_AllDefaults(t *testing.T) {
	// Empty store: every GetConfig returns an error -> per-key default.
	got := loadDispatchConfig(context.Background(), fakeConfig{})
	if got != defaults() {
		t.Fatalf("missing keys: got %+v, want %+v", got, defaults())
	}
}

func TestLoadDispatchConfig_PresentKeys_Parsed(t *testing.T) {
	store := fakeConfig{vals: map[string]string{
		config_manager.ConfigDispatchLeadMin:           "40",
		config_manager.ConfigDispatchTravelBufferMin:   "20",
		config_manager.ConfigDispatchAsapEtaPadMin:     "7",
		config_manager.ConfigDispatchAsapMaxPromiseMin: "18",
		config_manager.ConfigDispatchMinSlotLeadMin:    "60",
	}}
	want := DispatchConfig{
		LeadMin:           40,
		TravelBufferMin:   20,
		AsapEtaPadMin:     7,
		AsapMaxPromiseMin: 18,
		MinSlotLeadMin:    60,
	}
	got := loadDispatchConfig(context.Background(), store)
	if got != want {
		t.Fatalf("present keys: got %+v, want %+v", got, want)
	}
}

func TestLoadDispatchConfig_GarbageValue_OnlyThatKeyDefaults(t *testing.T) {
	// LeadMin is unparseable; every other key is a valid override. Only LeadMin
	// must fall back to its default — the rest keep their parsed values.
	store := fakeConfig{vals: map[string]string{
		config_manager.ConfigDispatchLeadMin:           "not-a-number",
		config_manager.ConfigDispatchTravelBufferMin:   "20",
		config_manager.ConfigDispatchAsapEtaPadMin:     "7",
		config_manager.ConfigDispatchAsapMaxPromiseMin: "18",
		config_manager.ConfigDispatchMinSlotLeadMin:    "60",
	}}
	want := DispatchConfig{
		LeadMin:           defaultDispatchLeadMin, // garbage -> default
		TravelBufferMin:   20,
		AsapEtaPadMin:     7,
		AsapMaxPromiseMin: 18,
		MinSlotLeadMin:    60,
	}
	got := loadDispatchConfig(context.Background(), store)
	if got != want {
		t.Fatalf("garbage value: got %+v, want %+v", got, want)
	}
}

func TestLoadDispatchConfig_ErroringKey_OnlyThatKeyDefaults(t *testing.T) {
	// TravelBufferMin's row errors (e.g. missing); the others parse fine.
	store := fakeConfig{
		vals: map[string]string{
			config_manager.ConfigDispatchLeadMin:           "40",
			config_manager.ConfigDispatchAsapEtaPadMin:     "7",
			config_manager.ConfigDispatchAsapMaxPromiseMin: "18",
			config_manager.ConfigDispatchMinSlotLeadMin:    "60",
		},
		errs: map[string]bool{
			config_manager.ConfigDispatchTravelBufferMin: true,
		},
	}
	want := DispatchConfig{
		LeadMin:           40,
		TravelBufferMin:   defaultDispatchTravelBufferMin, // error -> default
		AsapEtaPadMin:     7,
		AsapMaxPromiseMin: 18,
		MinSlotLeadMin:    60,
	}
	got := loadDispatchConfig(context.Background(), store)
	if got != want {
		t.Fatalf("erroring key: got %+v, want %+v", got, want)
	}
}
