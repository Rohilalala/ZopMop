package flags

// DefaultRegistry is the seed flag list. Add new flags here. The CRM UI
// renders one card per flag, grouped by Category.
//
// IMPORTANT: changing a flag's Key here is a breaking change — the user-app
// reads keys directly from Redis. Add new keys; never rename existing ones
// without a migration script.
func DefaultRegistry() []FlagDef {
	num := func(v float64) *float64 { return &v }
	return []FlagDef{
		// ── Booking ─────────────────────────────────────────────────
		{
			Key: "feature.scheduled_bookings", Name: "Scheduled Bookings",
			Description: "Allow users to schedule bookings for a future time slot.",
			Category:    "Booking", Type: TypeBool, Default: true,
		},
		{
			Key: "feature.instant_matching", Name: "Instant Matching",
			Description: "Match orders to nearby pros in real time vs falling back to scheduled-only.",
			Category:    "Booking", Type: TypeBool, Default: true,
		},
		{
			Key: "booking.search_radius_km", Name: "Search Radius (km)",
			Description: "How far instant matching looks for pros.",
			Category:    "Booking", Type: TypeNumber, Default: 5.0,
			Min: num(1), Max: num(50),
		},
		{
			Key: "booking.assignment_timeout_seconds", Name: "Assignment Timeout (seconds)",
			Description: "How long a pro has to accept an assignment before it rolls to the next candidate.",
			Category:    "Booking", Type: TypeNumber, Default: 30.0,
			Min: num(10), Max: num(300),
		},

		// ── Payments ────────────────────────────────────────────────
		{
			Key: "payments.cod_enabled", Name: "Cash on Delivery",
			Description: "Allow customers to pay in cash after the job.",
			Category:    "Payments", Type: TypeBool, Default: true,
		},
		{
			Key: "payments.upi_enabled", Name: "UPI",
			Description: "Allow UPI as a payment method.",
			Category:    "Payments", Type: TypeBool, Default: true,
		},

		// ── UI ──────────────────────────────────────────────────────
		{
			Key: "ui.home_layout", Name: "Home Layout",
			Description: "Which SDUI home layout users see.",
			Category:    "UI", Type: TypeEnum, Default: "default",
			EnumOptions: []string{"default", "minimal", "promo_heavy"},
		},
		{
			Key: "ui.live_pill_enabled", Name: "Live Pill",
			Description: "Show the 'X pros nearby' live pill on the home screen.",
			Category:    "UI", Type: TypeBool, Default: true,
		},

		// ── Workers ─────────────────────────────────────────────────
		{
			Key: "workers.min_rating_to_accept", Name: "Min Rating to Accept",
			Description: "Pros below this rating cannot accept new orders.",
			Category:    "Workers", Type: TypeNumber, Default: 3.5,
			Min: num(0), Max: num(5),
		},
		{
			Key: "workers.gps_offline_threshold_seconds", Name: "GPS Offline Threshold (seconds)",
			Description: "Time without a ping before a pro is marked offline on the live map.",
			Category:    "Workers", Type: TypeNumber, Default: 90.0,
			Min: num(30), Max: num(600),
		},

		// ── Notifications ───────────────────────────────────────────
		{
			Key: "notifications.push_enabled", Name: "Push Notifications",
			Description: "Master switch for outbound push notifications.",
			Category:    "Notifications", Type: TypeBool, Default: true,
		},

		// ── Experimental ────────────────────────────────────────────
		{
			Key: "experimental.ab_testing_enabled", Name: "A/B Testing",
			Description: "Enable the experiment framework. When off, all users see control.",
			Category:    "Experimental", Type: TypeBool, Default: false,
		},
		{
			Key: "experimental.maintenance_mode", Name: "Maintenance Mode",
			Description: "Block all user-facing requests with a maintenance page.",
			Category:    "Experimental", Type: TypeBool, Default: false,
		},
	}
}
