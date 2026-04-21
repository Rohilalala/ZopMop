package analytics

import (
	"errors"
	"fmt"
	"strings"
)

var allowedDevices = map[string]struct{}{
	"ios":     {},
	"android": {},
	"web":     {},
}

// ValidateCanonicalEvent validates required fields for canonical client ingestion payloads.
func ValidateCanonicalEvent(req *CanonicalEventRequest) error {
	if req == nil {
		return errors.New("request body is required")
	}
	req.EventName = strings.TrimSpace(req.EventName)
	req.EventID = strings.TrimSpace(req.EventID)
	req.UserID = strings.TrimSpace(req.UserID)
	req.Location.Area = strings.TrimSpace(req.Location.Area)

	if req.EventName == "" {
		return errors.New("event_name is required")
	}
	if req.EventID == "" {
		return errors.New("event_id is required")
	}
	if req.EventVersion < 1 {
		return errors.New("event_version is required")
	}
	if req.UserID == "" {
		return errors.New("user_id is required")
	}
	if req.Timestamp.IsZero() {
		return errors.New("timestamp is required")
	}
	if req.Location.Lat == nil {
		return errors.New("location.lat is required")
	}
	if req.Location.Lng == nil {
		return errors.New("location.lng is required")
	}
	if req.Location.Area == "" {
		return errors.New("location.area is required")
	}
	if *req.Location.Lat < -90 || *req.Location.Lat > 90 {
		return fmt.Errorf("location.lat must be between -90 and 90")
	}
	if *req.Location.Lng < -180 || *req.Location.Lng > 180 {
		return fmt.Errorf("location.lng must be between -180 and 180")
	}

	device := strings.ToLower(strings.TrimSpace(req.Device))
	if _, ok := allowedDevices[device]; !ok {
		return errors.New("device must be one of ios, android, web")
	}
	req.Device = device

	if ContainsSensitiveKeys(req.Metadata) || ContainsSensitiveKeys(req.Properties) {
		return errors.New("sensitive keys are not allowed")
	}

	return nil
}
