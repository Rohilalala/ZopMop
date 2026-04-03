package validator

import (
	"fmt"
	"regexp"

	"github.com/go-playground/validator/v10"
)

// Validate is the global validator instance with custom rules.
var Validate *validator.Validate

// e164Regex matches E.164 phone numbers: + followed by 1-15 digits.
var e164Regex = regexp.MustCompile(`^\+[1-9]\d{1,14}$`)

// uuidRegex matches standard UUID v4 format.
var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func init() {
	Validate = validator.New()

	// Register custom validation: "phone" — E.164 format.
	err := Validate.RegisterValidation("phone", validatePhone)
	if err != nil {
		panic(fmt.Sprintf("failed to register phone validator: %v", err))
	}

	// Register custom validation: "coordinates" — valid lat/lng range.
	err = Validate.RegisterValidation("latitude", validateLatitude)
	if err != nil {
		panic(fmt.Sprintf("failed to register latitude validator: %v", err))
	}

	err = Validate.RegisterValidation("longitude", validateLongitude)
	if err != nil {
		panic(fmt.Sprintf("failed to register longitude validator: %v", err))
	}

	// Register custom validation: "uuid" — standard UUID format.
	err = Validate.RegisterValidation("uuid_format", validateUUID)
	if err != nil {
		panic(fmt.Sprintf("failed to register uuid validator: %v", err))
	}
}

// validatePhone checks if the field value is a valid E.164 phone number.
func validatePhone(fl validator.FieldLevel) bool {
	return e164Regex.MatchString(fl.Field().String())
}

// validateLatitude checks if the field is a valid latitude (-90 to 90).
func validateLatitude(fl validator.FieldLevel) bool {
	val := fl.Field().Float()
	return val >= -90 && val <= 90
}

// validateLongitude checks if the field is a valid longitude (-180 to 180).
func validateLongitude(fl validator.FieldLevel) bool {
	val := fl.Field().Float()
	return val >= -180 && val <= 180
}

// validateUUID checks if the field is a valid UUID format.
func validateUUID(fl validator.FieldLevel) bool {
	return uuidRegex.MatchString(fl.Field().String())
}

// FormatValidationErrors takes a validator.ValidationErrors and returns
// a user-friendly map of field -> error message.
func FormatValidationErrors(err error) map[string]string {
	errors := make(map[string]string)
	if validationErrors, ok := err.(validator.ValidationErrors); ok {
		for _, e := range validationErrors {
			switch e.Tag() {
			case "required":
				errors[e.Field()] = fmt.Sprintf("%s is required", e.Field())
			case "phone":
				errors[e.Field()] = "must be a valid E.164 phone number (e.g. +919876543210)"
			case "latitude":
				errors[e.Field()] = "must be between -90 and 90"
			case "longitude":
				errors[e.Field()] = "must be between -180 and 180"
			case "uuid_format":
				errors[e.Field()] = "must be a valid UUID"
			case "min":
				errors[e.Field()] = fmt.Sprintf("%s must be at least %s characters", e.Field(), e.Param())
			case "max":
				errors[e.Field()] = fmt.Sprintf("%s must be at most %s characters", e.Field(), e.Param())
			default:
				errors[e.Field()] = fmt.Sprintf("%s failed validation: %s", e.Field(), e.Tag())
			}
		}
	}
	return errors
}
