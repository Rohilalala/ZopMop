package config_manager

import "strconv"

// AppConfig represents a dynamic configuration entry.
type AppConfig struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	ValueType   string `json:"value_type"` // string, int, float, bool, json
	Description string `json:"description"`
	UpdatedBy   string `json:"updated_by,omitempty"`
	UpdatedAt   string `json:"updated_at"`
}

// toFloat parses the Value as a float64, returning 0 on failure.
func (c AppConfig) toFloat() float64 {
	f, _ := strconv.ParseFloat(c.Value, 64)
	return f
}

// toInt parses the Value as an int, returning 0 on failure.
func (c AppConfig) toInt() int {
	i, _ := strconv.Atoi(c.Value)
	return i
}

// Config key constants — all business logic variables controlled from admin panel.
const (
	// Matching. Distance is expressed as a maximum walking time from the
	// customer's pickup point — there is no "radius" concept any more. The
	// engine derives the geo-search km bound internally from this value.
	ConfigMatchingMaxWalkMinutes     = "matching.max_walk_minutes"
	ConfigMatchingTimeoutSeconds     = "matching.timeout_seconds"
	ConfigMatchingMaxHelpersNotified = "matching.max_helpers_notified"

	// Pricing.
	ConfigPricingBaseFeeCents    = "pricing.base_fee_cents"
	ConfigPricingSurgeMultiplier = "pricing.surge_multiplier"
	ConfigPricingSurgeEnabled    = "pricing.surge_enabled"

	// Booking.
	ConfigBookingCancellationWindowMinutes = "booking.cancellation_window_minutes"
	ConfigBookingMaxActivePerCustomer      = "booking.max_active_per_customer"
	ConfigBookingMaxActivePerHelper        = "booking.max_active_per_helper"

	// Scheduling (slot-capacity pilot). Admin-managed so the pilot's society and
	// service close aren't baked into code.
	ConfigSchedulingServiceCloseMin       = "scheduling.service_close_min"
	ConfigSchedulingCapacityPilotLocality = "scheduling.capacity_pilot_locality"

	// Dispatch (unified slot dispatch — spec §2).
	ConfigDispatchLeadMin           = "dispatch.lead_min"
	ConfigDispatchTravelBufferMin   = "dispatch.travel_buffer_min"
	ConfigDispatchAsapEtaPadMin     = "dispatch.asap_eta_pad_min"
	ConfigDispatchAsapMaxPromiseMin = "dispatch.asap_max_promise_min"
	ConfigDispatchMinSlotLeadMin    = "dispatch.min_slot_lead_min"

	// App.
	ConfigAppMaintenanceMode   = "app.maintenance_mode"
	ConfigAppMinVersionIOS     = "app.min_app_version_ios"
	ConfigAppMinVersionAndroid = "app.min_app_version_android"
	ConfigAppSupportPhone      = "app.support_phone"
	ConfigAppSupportEmail      = "app.support_email"

	// Helper.
	ConfigHelperMinRatingToAppear = "helper.min_rating_to_appear"
)

// DefaultConfigs maps each config key to its default value and metadata.
var DefaultConfigs = map[string]AppConfig{
	ConfigMatchingMaxWalkMinutes:           {Key: ConfigMatchingMaxWalkMinutes, Value: "25", ValueType: "int", Description: "Maximum walking minutes from customer to helper"},
	ConfigMatchingTimeoutSeconds:           {Key: ConfigMatchingTimeoutSeconds, Value: "90", ValueType: "int", Description: "Seconds before a pending booking is escalated"},
	ConfigMatchingMaxHelpersNotified:       {Key: ConfigMatchingMaxHelpersNotified, Value: "3", ValueType: "int", Description: "How many helpers to notify at once"},
	ConfigPricingBaseFeeCents:              {Key: ConfigPricingBaseFeeCents, Value: "2000", ValueType: "int", Description: "Platform base fee in cents"},
	ConfigPricingSurgeMultiplier:           {Key: ConfigPricingSurgeMultiplier, Value: "1.0", ValueType: "float", Description: "Surge pricing multiplier"},
	ConfigPricingSurgeEnabled:              {Key: ConfigPricingSurgeEnabled, Value: "false", ValueType: "bool", Description: "Whether surge pricing is active"},
	ConfigBookingCancellationWindowMinutes: {Key: ConfigBookingCancellationWindowMinutes, Value: "5", ValueType: "int", Description: "Free cancellation window in minutes"},
	ConfigBookingMaxActivePerCustomer:      {Key: ConfigBookingMaxActivePerCustomer, Value: "2", ValueType: "int", Description: "Max simultaneous bookings per customer"},
	ConfigBookingMaxActivePerHelper:        {Key: ConfigBookingMaxActivePerHelper, Value: "3", ValueType: "int", Description: "Max simultaneous bookings per helper"},
	ConfigDispatchLeadMin:                  {Key: ConfigDispatchLeadMin, Value: "30", ValueType: "int", Description: "Minutes before scheduled_time that assignment fires"},
	ConfigDispatchTravelBufferMin:          {Key: ConfigDispatchTravelBufferMin, Value: "15", ValueType: "int", Description: "Planning travel buffer used in window math and shift-runway checks"},
	ConfigDispatchAsapEtaPadMin:            {Key: ConfigDispatchAsapEtaPadMin, Value: "5", ValueType: "int", Description: "Pad added to walking ETA for the customer-facing arrival promise"},
	ConfigDispatchAsapMaxPromiseMin:        {Key: ConfigDispatchAsapMaxPromiseMin, Value: "15", ValueType: "int", Description: "Max promise for ASAP; pros whose ETA+pad exceeds this are ineligible"},
	ConfigDispatchMinSlotLeadMin:           {Key: ConfigDispatchMinSlotLeadMin, Value: "45", ValueType: "int", Description: "Minimum lead before a regular slot is bookable (= lead + travel buffer)"},
	ConfigAppMaintenanceMode:               {Key: ConfigAppMaintenanceMode, Value: "false", ValueType: "bool", Description: "Show maintenance screen to all users"},
	ConfigAppMinVersionIOS:                 {Key: ConfigAppMinVersionIOS, Value: "1.0.0", ValueType: "string", Description: "Minimum supported iOS app version"},
	ConfigAppMinVersionAndroid:             {Key: ConfigAppMinVersionAndroid, Value: "1.0.0", ValueType: "string", Description: "Minimum supported Android app version"},
	ConfigAppSupportPhone:                  {Key: ConfigAppSupportPhone, Value: "", ValueType: "string", Description: "Support phone number shown in app"},
	ConfigAppSupportEmail:                  {Key: ConfigAppSupportEmail, Value: "", ValueType: "string", Description: "Support email shown in app"},
	ConfigHelperMinRatingToAppear:          {Key: ConfigHelperMinRatingToAppear, Value: "3.0", ValueType: "float", Description: "Helpers below this rating are hidden"},
	ConfigSchedulingServiceCloseMin:        {Key: ConfigSchedulingServiceCloseMin, Value: "1230", ValueType: "int", Description: "IST service close in minutes-from-midnight (1230 = 20:30). Scheduled jobs must finish by this; the slot grid and booking gate enforce it."},
	ConfigSchedulingCapacityPilotLocality:  {Key: ConfigSchedulingCapacityPilotLocality, Value: "Orchid Island Gurugram", ValueType: "string", Description: "Fallback locality for slot-capacity gating when an address can't be mapped to a seeded locality (single-society pilot). Empty disables the fallback."},
}

// PublicConfigKeys are safe to expose to the client app.
var PublicConfigKeys = []string{
	ConfigAppMaintenanceMode,
	ConfigAppMinVersionIOS,
	ConfigAppMinVersionAndroid,
	ConfigAppSupportPhone,
	ConfigAppSupportEmail,
}

// MatchingConfig holds matching-related configuration values.
type MatchingConfig struct {
	// MaxWalkMinutes is the only spatial bound that matters: a helper is
	// eligible if their walking ETA to the pickup point is within this many
	// minutes. The engine derives an internal km bound for the geo-index
	// pre-filter (5 km/h × minutes/60 with a slack factor) but the actual
	// matching decision is made on walking time.
	MaxWalkMinutes     int `json:"max_walk_minutes"`
	TimeoutSeconds     int `json:"timeout_seconds"`
	MaxHelpersNotified int `json:"max_helpers_notified"`
}

// PricingConfig holds pricing-related configuration values.
type PricingConfig struct {
	BaseFeeCents    int     `json:"base_fee_paise"`
	SurgeMultiplier float64 `json:"surge_multiplier"`
	SurgeEnabled    bool    `json:"surge_enabled"`
}

// BulkConfigUpdate is the input for bulk config updates.
type BulkConfigUpdate struct {
	Configs map[string]string `json:"configs" validate:"required"`
}
