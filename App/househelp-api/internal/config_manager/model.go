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
	// Matching.
	ConfigMatchingRadiusKm         = "matching.radius_km"
	ConfigMatchingMaxRadiusKm      = "matching.max_radius_km"
	ConfigMatchingTimeoutSeconds   = "matching.timeout_seconds"
	ConfigMatchingMaxHelpersNotified = "matching.max_helpers_notified"

	// Pricing.
	ConfigPricingBaseFeeCents    = "pricing.base_fee_cents"
	ConfigPricingSurgeMultiplier = "pricing.surge_multiplier"
	ConfigPricingSurgeEnabled    = "pricing.surge_enabled"

	// Booking.
	ConfigBookingCancellationWindowMinutes = "booking.cancellation_window_minutes"
	ConfigBookingMaxActivePerCustomer      = "booking.max_active_per_customer"
	ConfigBookingMaxActivePerHelper        = "booking.max_active_per_helper"

	// App.
	ConfigAppMaintenanceMode       = "app.maintenance_mode"
	ConfigAppMinVersionIOS         = "app.min_app_version_ios"
	ConfigAppMinVersionAndroid     = "app.min_app_version_android"
	ConfigAppSupportPhone          = "app.support_phone"
	ConfigAppSupportEmail          = "app.support_email"

	// Helper.
	ConfigHelperMinRatingToAppear = "helper.min_rating_to_appear"
)

// DefaultConfigs maps each config key to its default value and metadata.
var DefaultConfigs = map[string]AppConfig{
	ConfigMatchingRadiusKm:                 {Key: ConfigMatchingRadiusKm, Value: "3", ValueType: "float", Description: "Default helper search radius in km"},
	ConfigMatchingMaxRadiusKm:              {Key: ConfigMatchingMaxRadiusKm, Value: "5", ValueType: "float", Description: "Expanded radius after timeout in km"},
	ConfigMatchingTimeoutSeconds:           {Key: ConfigMatchingTimeoutSeconds, Value: "90", ValueType: "int", Description: "Seconds before expanding search radius"},
	ConfigMatchingMaxHelpersNotified:       {Key: ConfigMatchingMaxHelpersNotified, Value: "3", ValueType: "int", Description: "How many helpers to notify at once"},
	ConfigPricingBaseFeeCents:              {Key: ConfigPricingBaseFeeCents, Value: "2000", ValueType: "int", Description: "Platform base fee in cents"},
	ConfigPricingSurgeMultiplier:           {Key: ConfigPricingSurgeMultiplier, Value: "1.0", ValueType: "float", Description: "Surge pricing multiplier"},
	ConfigPricingSurgeEnabled:              {Key: ConfigPricingSurgeEnabled, Value: "false", ValueType: "bool", Description: "Whether surge pricing is active"},
	ConfigBookingCancellationWindowMinutes: {Key: ConfigBookingCancellationWindowMinutes, Value: "5", ValueType: "int", Description: "Free cancellation window in minutes"},
	ConfigBookingMaxActivePerCustomer:      {Key: ConfigBookingMaxActivePerCustomer, Value: "2", ValueType: "int", Description: "Max simultaneous bookings per customer"},
	ConfigBookingMaxActivePerHelper:        {Key: ConfigBookingMaxActivePerHelper, Value: "3", ValueType: "int", Description: "Max simultaneous bookings per helper"},
	ConfigAppMaintenanceMode:               {Key: ConfigAppMaintenanceMode, Value: "false", ValueType: "bool", Description: "Show maintenance screen to all users"},
	ConfigAppMinVersionIOS:                 {Key: ConfigAppMinVersionIOS, Value: "1.0.0", ValueType: "string", Description: "Minimum supported iOS app version"},
	ConfigAppMinVersionAndroid:             {Key: ConfigAppMinVersionAndroid, Value: "1.0.0", ValueType: "string", Description: "Minimum supported Android app version"},
	ConfigAppSupportPhone:                  {Key: ConfigAppSupportPhone, Value: "", ValueType: "string", Description: "Support phone number shown in app"},
	ConfigAppSupportEmail:                  {Key: ConfigAppSupportEmail, Value: "", ValueType: "string", Description: "Support email shown in app"},
	ConfigHelperMinRatingToAppear:          {Key: ConfigHelperMinRatingToAppear, Value: "3.0", ValueType: "float", Description: "Helpers below this rating are hidden"},
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
	RadiusKm           float64 `json:"radius_km"`
	MaxRadiusKm        float64 `json:"max_radius_km"`
	TimeoutSeconds     int     `json:"timeout_seconds"`
	MaxHelpersNotified int     `json:"max_helpers_notified"`
}

// PricingConfig holds pricing-related configuration values.
type PricingConfig struct {
	BaseFeeCents    int     `json:"base_fee_cents"`
	SurgeMultiplier float64 `json:"surge_multiplier"`
	SurgeEnabled    bool    `json:"surge_enabled"`
}

// BulkConfigUpdate is the input for bulk config updates.
type BulkConfigUpdate struct {
	Configs map[string]string `json:"configs" validate:"required"`
}
