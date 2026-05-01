package bff

import (
	"time"

	"github.com/rs/zerolog/log"
)

// LogResolve emits a structured log line for one /page/:id resolve cycle.
// Threshold: alert if err rate > 1% over 5m.
func LogResolve(pageID, configVersion string, latency time.Duration, fromCache bool, err error) {
	evt := log.Info()
	if err != nil {
		evt = log.Warn().Err(err)
	}
	evt.
		Str("event", "sdui_resolve").
		Str("page_id", pageID).
		Str("config_version", configVersion).
		Int64("latency_ms", latency.Milliseconds()).
		Bool("from_cache", fromCache).
		Msg("sdui resolve")
}

// LogPageLatency records an end-to-end page latency. Threshold: p99 > 800ms.
func LogPageLatency(pageID string, latencyMs int64) {
	log.Info().
		Str("event", "sdui_page_latency_ms").
		Str("page_id", pageID).
		Int64("latency_ms", latencyMs).
		Msg("sdui page latency")
}

// LogLazySectionFailed marks a lazy-section endpoint that exhausted retries.
// Threshold: alert if > 5% of lazy fetches.
func LogLazySectionFailed(pageID, sectionID string, err error) {
	log.Warn().
		Err(err).
		Str("event", "sdui_lazy_section_failed").
		Str("page_id", pageID).
		Str("section_id", sectionID).
		Msg("lazy section failed")
}

// LogKillSwitchHit records a kill-switch fallback service.
func LogKillSwitchHit(pageID string) {
	log.Warn().
		Str("event", "sdui_kill_switch_activated").
		Str("page_id", pageID).
		Msg("kill switch hit — serving safe layout")
}

// LogCircuitStateChange logs gobreaker open/close transitions.
func LogCircuitStateChange(name, from, to string) {
	log.Warn().
		Str("event", "sdui_circuit_state").
		Str("source", name).
		Str("from", from).
		Str("to", to).
		Msg("circuit breaker state change")
}

// LogSourceFetch records one source.Fetch call.
func LogSourceFetch(key string, latency time.Duration, fromCache bool, err error) {
	evt := log.Debug()
	if err != nil {
		evt = log.Warn().Err(err)
	}
	evt.
		Str("event", "sdui_source_fetch").
		Str("source", key).
		Int64("latency_ms", latency.Milliseconds()).
		Bool("from_cache", fromCache).
		Msg("source fetch")
}
