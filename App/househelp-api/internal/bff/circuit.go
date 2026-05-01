package bff

import (
	"sync"
	"time"

	"github.com/sony/gobreaker"
)

// Circuit guards a SourceDef's Fetch with a per-key gobreaker. State is held
// process-wide; breakers are created lazily on first use.
type Circuit struct {
	mu       sync.Mutex
	breakers map[string]*gobreaker.CircuitBreaker
}

// NewCircuit returns an empty Circuit with no breakers initialized.
func NewCircuit() *Circuit {
	return &Circuit{breakers: map[string]*gobreaker.CircuitBreaker{}}
}

// Get returns the breaker for the given source key, creating it if needed.
// Threshold: 5 consecutive failures opens the circuit; cooldown 10s.
func (c *Circuit) Get(name string) *gobreaker.CircuitBreaker {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cb, ok := c.breakers[name]; ok {
		return cb
	}
	cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:        name,
		MaxRequests: 1,
		Interval:    30 * time.Second,
		Timeout:     10 * time.Second,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.ConsecutiveFailures >= 5
		},
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			LogCircuitStateChange(name, from.String(), to.String())
		},
	})
	c.breakers[name] = cb
	return cb
}

// InitForRegistry pre-creates breakers for every key in the registry so the
// first-request latency is consistent.
func (c *Circuit) InitForRegistry(reg map[string]SourceDef) {
	for k := range reg {
		c.Get(k)
	}
}
