package webhooks

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ErrSSRFRejected is returned when a webhook target resolves to a private,
// link-local, or loopback address. Caller persists this as the response_body
// of a status=0 delivery row so admins can see WHY the webhook didn't fire
// (audit NEW-A2-001 / A2-2).
var ErrSSRFRejected = errors.New("webhook target rejected: private address")

// privateRanges are the IP ranges we never allow webhook targets to resolve
// to. The two important ones are 169.254.0.0/16 (cloud instance metadata)
// and 127.0.0.0/8 (loopback / pprof / admin _stub). The rest cover
// RFC1918 + IPv6 link-local + ULA.
var privateRanges = func() []*net.IPNet {
	cidrs := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"169.254.0.0/16", // link-local + IMDS
		"127.0.0.0/8",    // loopback
		"0.0.0.0/8",      // current network
		"::1/128",        // IPv6 loopback
		"fc00::/7",       // IPv6 ULA
		"fe80::/10",      // IPv6 link-local
	}
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(fmt.Sprintf("invalid CIDR %q in privateRanges: %v", c, err))
		}
		out = append(out, n)
	}
	return out
}()

// ErrWebhookNotAllowed is returned when a webhook target's domain is not in
// the ALLOWED_WEBHOOK_DOMAINS allowlist.
var ErrWebhookNotAllowed = errors.New("webhook target rejected: domain not in allowlist")

// validateWebhookTarget returns nil if the URL is structurally OK, none of
// its resolved IPs are private, and (when allowedDomains is non-empty) the
// hostname is in the allowlist.
//
// Note: this does NOT defend against DNS rebinding (the IP can change
// between LookupIP and the actual http.Do). Defense in depth is provided
// by binding outbound traffic to a network policy that drops RFC1918
// destinations at the cluster level. Here we only catch the obvious cases.
func validateWebhookTarget(rawURL string, allowedDomains []string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("%w: parse: %v", ErrSSRFRejected, err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("%w: unsupported scheme %q", ErrSSRFRejected, u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%w: empty host", ErrSSRFRejected)
	}

	// Domain allowlist check: if configured, host must match exactly or be a
	// subdomain of an allowlisted entry (e.g. "example.com" allows "api.example.com").
	if len(allowedDomains) > 0 {
		allowed := false
		for _, d := range allowedDomains {
			if host == d || strings.HasSuffix(host, "."+d) {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("%w: %s", ErrWebhookNotAllowed, host)
		}
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("%w: dns: %v", ErrSSRFRejected, err)
	}
	for _, ip := range ips {
		for _, r := range privateRanges {
			if r.Contains(ip) {
				return fmt.Errorf("%w: resolved %s -> private %s", ErrSSRFRejected, host, ip)
			}
		}
	}
	return nil
}
