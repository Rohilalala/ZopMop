// Package httpx provides a shared HTTP transport tuned for service-to-service
// calls from a single Go binary. Using one shared Transport across all outbound
// clients lets the connection pool be shared, avoiding the 2-conn-per-host
// ceiling of http.DefaultTransport (audit NEW-D4-001 / D2-1).
package httpx

import (
	"net/http"
	"time"
)

// SharedTransport is a singleton *http.Transport sized for a backend service
// that makes concurrent outbound calls to several external APIs (Cashfree,
// Google Maps, Firebase). Values are deliberately conservative to avoid
// exhausting file descriptors on small VMs.
var SharedTransport = &http.Transport{
	MaxIdleConns:        200,
	MaxIdleConnsPerHost: 50,
	IdleConnTimeout:     90 * time.Second,
	// TLSHandshakeTimeout and ResponseHeaderTimeout carry over from the
	// Go stdlib defaults (10s each). Explicit here so they survive
	// future stdlib changes.
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 10 * time.Second,
}

// NewClient returns an *http.Client backed by SharedTransport with the
// supplied timeout. All service clients should use this instead of
// constructing a bare &http.Client{} (which uses DefaultTransport).
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: SharedTransport,
		Timeout:   timeout,
	}
}
