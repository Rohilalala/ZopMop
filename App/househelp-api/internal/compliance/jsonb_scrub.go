package compliance

import "strings"

// ScrubKeys is the case-insensitive set of JSONB keys whose VALUES
// must be redacted as PII when found anywhere (top-level or nested)
// in a JSONB blob. Audit C-8 / F2D-1 chunk 12.
//
// Selection rationale:
//   - Listed keys are PII regardless of context — phone numbers,
//     names, addresses, KYC IDs, financial identifiers — and should
//     never appear in long-lived audit/campaign blobs.
//   - Generic identifiers (id, user_id, customer_id, target_id, etc.)
//     are intentionally OMITTED. They're context-dependent: in a
//     bookings audit row "id" is the booking UUID, not the user.
//     Scrubbing them would corrupt legitimate records. The deleted
//     user's UUID is handled separately by chunk-6 target_id
//     anonymization + chunk-12 user_ids array filtering.
//   - Match is case-insensitive: Phone == phone == PHONE.
var ScrubKeys = map[string]struct{}{
	// Contact info.
	"phone": {}, "phone_number": {}, "mobile": {},
	"email": {}, "email_address": {},
	// Names.
	"name": {}, "first_name": {}, "last_name": {},
	"full_name": {}, "display_name": {},
	"receiver_name": {}, "receiver_phone": {},
	// Addresses.
	"address": {}, "street": {}, "building": {},
	"building_name": {}, "flat_no": {}, "floor": {},
	"landmark": {}, "full_address": {},
	// Location coordinates.
	"lat": {}, "lng": {}, "latitude": {}, "longitude": {},
	"location": {},
	// Device push tokens (stable cross-session identifiers).
	"fcm_token": {}, "device_token": {}, "push_token": {},
	// Identity documents.
	"dob": {}, "date_of_birth": {},
	"aadhaar": {}, "aadhaar_number": {},
	"pan": {}, "pan_number": {},
	"kyc_id": {}, "kyc_number": {},
	// Financial identifiers.
	"account_number": {}, "bank_account": {},
	"upi_id": {}, "vpa": {},
	// Network identifiers.
	"ip_address": {},
}

// RedactedValue is the sentinel substituted in place of a PII value.
// Preserving the key (rather than removing it) keeps any downstream
// reader's assumed shape intact while making the redaction obvious.
const RedactedValue = "<redacted>"

// ScrubJSONB walks a parsed JSON value recursively, replacing values
// of keys in ScrubKeys with RedactedValue. Mutates the input.
//
// Returns true if at least one redaction occurred. Callers can use
// the return to skip a no-op UPDATE when nothing changed.
//
// Handles four shapes seen in real audit/campaign payloads:
//   - flat objects                                {"phone": "+91..."}
//   - nested objects                              {"user": {"phone": ...}}
//   - arrays of objects                           {"addresses": [{"flat_no": ...}]}
//   - arrays of primitives (walked, no-op unless caller renders a key)
//
// Idempotent: re-running on an already-scrubbed value re-sets the
// same RedactedValue. Caller-side equality check still detects no
// content delta.
func ScrubJSONB(v any) bool {
	changed := false
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if _, isPII := ScrubKeys[strings.ToLower(k)]; isPII {
				if t[k] != RedactedValue {
					t[k] = RedactedValue
					changed = true
				}
				continue
			}
			if ScrubJSONB(val) {
				changed = true
			}
		}
	case []any:
		for _, item := range t {
			if ScrubJSONB(item) {
				changed = true
			}
		}
	}
	return changed
}
