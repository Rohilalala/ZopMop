package bff

import "encoding/json"

// jsonUnmarshalSafe unmarshals into v but never panics; returns the underlying error.
func jsonUnmarshalSafe(data []byte, v any) error {
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, v)
}
