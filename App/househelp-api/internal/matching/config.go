package matching

import (
	"context"
	"strconv"

	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/config_manager"
)

// DispatchConfig holds the five spec-§2 dispatch knobs, all in minutes.
// Every field is read through config_manager with a hardcoded fallback so the
// dispatcher never stalls on a missing or malformed config row.
type DispatchConfig struct {
	// LeadMin is the minutes before scheduled_time that assignment fires.
	LeadMin int
	// TravelBufferMin is the flat planning travel buffer used in all window
	// math and shift-runway checks.
	TravelBufferMin int
	// AsapEtaPadMin pads the walking ETA for the customer-facing promise.
	AsapEtaPadMin int
	// AsapMaxPromiseMin caps the ASAP promise; pros whose ETA+pad exceeds it
	// are ineligible for that ASAP booking.
	AsapMaxPromiseMin int
	// MinSlotLeadMin is the closest a customer may book a regular slot.
	MinSlotLeadMin int
}

// Spec-§2 defaults. Used per-key whenever config_manager is missing the row or
// returns an unparseable value.
const (
	defaultDispatchLeadMin           = 30
	defaultDispatchTravelBufferMin   = 15
	defaultDispatchAsapEtaPadMin     = 5
	defaultDispatchAsapMaxPromiseMin = 15
	defaultDispatchMinSlotLeadMin    = 45
)

// configGetter is the subset of config_manager.Service that LoadDispatchConfig
// needs. Declaring it locally keeps the loader unit-testable with a fake while
// the public signature still takes the concrete *config_manager.Service.
type configGetter interface {
	GetConfig(ctx context.Context, key string) (string, error)
}

// LoadDispatchConfig reads the five dispatch knobs (spec §2) through
// config_manager. It never errors: each key falls back independently to its
// hardcoded default, logging once per failing key. A nil service yields all
// defaults.
func LoadDispatchConfig(ctx context.Context, cfg *config_manager.Service) DispatchConfig {
	if cfg == nil {
		return DispatchConfig{
			LeadMin:           defaultDispatchLeadMin,
			TravelBufferMin:   defaultDispatchTravelBufferMin,
			AsapEtaPadMin:     defaultDispatchAsapEtaPadMin,
			AsapMaxPromiseMin: defaultDispatchAsapMaxPromiseMin,
			MinSlotLeadMin:    defaultDispatchMinSlotLeadMin,
		}
	}
	return loadDispatchConfig(ctx, cfg)
}

// loadDispatchConfig is the testable core: it reads through any configGetter.
func loadDispatchConfig(ctx context.Context, cfg configGetter) DispatchConfig {
	return DispatchConfig{
		LeadMin:           dispatchInt(ctx, cfg, config_manager.ConfigDispatchLeadMin, defaultDispatchLeadMin),
		TravelBufferMin:   dispatchInt(ctx, cfg, config_manager.ConfigDispatchTravelBufferMin, defaultDispatchTravelBufferMin),
		AsapEtaPadMin:     dispatchInt(ctx, cfg, config_manager.ConfigDispatchAsapEtaPadMin, defaultDispatchAsapEtaPadMin),
		AsapMaxPromiseMin: dispatchInt(ctx, cfg, config_manager.ConfigDispatchAsapMaxPromiseMin, defaultDispatchAsapMaxPromiseMin),
		MinSlotLeadMin:    dispatchInt(ctx, cfg, config_manager.ConfigDispatchMinSlotLeadMin, defaultDispatchMinSlotLeadMin),
	}
}

// dispatchInt fetches one int config key, falling back to def on any error or
// unparseable value. Logs once per failing key so misconfiguration is visible
// without spamming on the hot path.
func dispatchInt(ctx context.Context, cfg configGetter, key string, def int) int {
	v, err := cfg.GetConfig(ctx, key)
	if err != nil {
		log.Warn().Err(err).Str("key", key).Int("default", def).Msg("dispatch config missing, using default")
		return def
	}
	i, parseErr := strconv.Atoi(v)
	if parseErr != nil {
		log.Warn().Str("key", key).Str("value", v).Int("default", def).Msg("invalid dispatch config value, using default")
		return def
	}
	return i
}
