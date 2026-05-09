package googlemaps

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/pkg/database"
	"github.com/adityarohilla/househelp-api/pkg/httpx"
)

// DirectionsResult holds the parsed response from the Directions API.
type DirectionsResult struct {
	DurationMinutes int
	DistanceMeters  int
	EncodedPolyline string
}

// Client wraps Google Maps REST APIs with Redis caching.
type Client struct {
	apiKey string
	rdb    *redis.Client
	http   *http.Client
}

// NewClient creates a ready-to-use Google Maps client.
// rdb may be nil; caching is skipped if so.
func NewClient(apiKey string, rdb *redis.Client) *Client {
	return &Client{
		apiKey: apiKey,
		rdb:    rdb,
		http:   httpx.NewClient(5 * time.Second),
	}
}

// roundCoord rounds a coordinate to 4 decimal places (~11m precision)
// so nearby points share the same cache key.
func roundCoord(v float64) float64 {
	return math.Round(v*10000) / 10000
}

// cacheKey builds a Redis cache key for a distance/directions lookup.
func cacheKey(prefix string, oLat, oLng, dLat, dLng float64) string {
	return fmt.Sprintf("%s:%.4f:%.4f:%.4f:%.4f", prefix, oLat, oLng, dLat, dLng)
}

// ── Distance Matrix ───────────────────────────────────────────────────────────

// GetTravelMinutes returns the walking travel time in minutes between two
// coordinates.  Results are cached in Redis for 5 minutes.
// Returns (0, nil) if the API key is empty or the request fails — callers
// should treat 0 as "unknown" and skip any time-based filtering.
func (c *Client) GetTravelMinutes(ctx context.Context, oLat, oLng, dLat, dLng float64) (int, error) {
	oLat = roundCoord(oLat)
	oLng = roundCoord(oLng)
	dLat = roundCoord(dLat)
	dLng = roundCoord(dLng)

	// Redis cache check. redis.Nil = miss, anything else = Redis down → warn
	// and fall through to the live API.
	if c.rdb != nil {
		key := cacheKey("gmaps:dt", oLat, oLng, dLat, dLng)
		cached, err := c.rdb.Get(ctx, key).Int()
		if err == nil {
			return cached, nil
		}
		if database.IsRedisDown(err) {
			log.Warn().Err(err).Str("key", key).Msg("[gmaps] cache GET failed; falling through to API")
		}
	}

	params := url.Values{}
	params.Set("origins", fmt.Sprintf("%.4f,%.4f", oLat, oLng))
	params.Set("destinations", fmt.Sprintf("%.4f,%.4f", dLat, dLng))
	params.Set("mode", "walking")
	params.Set("key", c.apiKey)

	apiURL := "https://maps.googleapis.com/maps/api/distancematrix/json?" + params.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	resp, err := c.http.Do(req)
	if err != nil {
		log.Warn().Err(err).Msg("[gmaps] distance matrix request failed")
		return 0, nil
	}
	defer resp.Body.Close()

	var body struct {
		Status string `json:"status"`
		Rows   []struct {
			Elements []struct {
				Status   string `json:"status"`
				Duration struct {
					Value int `json:"value"` // seconds
				} `json:"duration"`
			} `json:"elements"`
		} `json:"rows"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		log.Warn().Err(err).Msg("[gmaps] failed to decode distance matrix response")
		return 0, nil
	}
	if body.Status != "OK" || len(body.Rows) == 0 || len(body.Rows[0].Elements) == 0 {
		log.Warn().Str("status", body.Status).Msg("[gmaps] distance matrix non-OK status")
		return 0, nil
	}
	elem := body.Rows[0].Elements[0]
	if elem.Status != "OK" {
		return 0, nil
	}
	minutes := (elem.Duration.Value + 59) / 60 // ceil to minutes

	// Cache for 5 minutes.
	if c.rdb != nil {
		key := cacheKey("gmaps:dt", oLat, oLng, dLat, dLng)
		_ = c.rdb.Set(ctx, key, minutes, 5*time.Minute).Err()
	}

	// Round further (~1.1km) for log fields so logs don't carry precise PII
	// even though the cache key uses 4-decimal precision.
	log.Debug().
		Float64("oLat", math.Round(oLat*100)/100).Float64("oLng", math.Round(oLng*100)/100).
		Float64("dLat", math.Round(dLat*100)/100).Float64("dLng", math.Round(dLng*100)/100).
		Int("minutes", minutes).
		Msg("[gmaps] travel time")

	return minutes, nil
}

// ── Directions ────────────────────────────────────────────────────────────────

// GetDirections returns the walking route between two coordinates including an
// encoded polyline and duration.  Results are cached in Redis for 90 seconds.
// Returns a zero-value result (no error) if the API key is empty or the request
// fails — callers should display the map without a route in that case.
func (c *Client) GetDirections(ctx context.Context, oLat, oLng, dLat, dLng float64) (*DirectionsResult, error) {
	oLat = roundCoord(oLat)
	oLng = roundCoord(oLng)
	dLat = roundCoord(dLat)
	dLng = roundCoord(dLng)

	// Redis cache check. redis.Nil = miss, anything else = Redis down → warn
	// and fall through to the live API.
	if c.rdb != nil {
		key := cacheKey("gmaps:dir", oLat, oLng, dLat, dLng)
		cached, err := c.rdb.Get(ctx, key).Bytes()
		if err == nil {
			var result DirectionsResult
			if json.Unmarshal(cached, &result) == nil {
				return &result, nil
			}
		} else if database.IsRedisDown(err) {
			log.Warn().Err(err).Str("key", key).Msg("[gmaps] cache GET failed; falling through to API")
		}
	}

	params := url.Values{}
	params.Set("origin", fmt.Sprintf("%.4f,%.4f", oLat, oLng))
	params.Set("destination", fmt.Sprintf("%.4f,%.4f", dLat, dLng))
	params.Set("mode", "walking")
	params.Set("key", c.apiKey)

	apiURL := "https://maps.googleapis.com/maps/api/directions/json?" + params.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	resp, err := c.http.Do(req)
	if err != nil {
		log.Warn().Err(err).Msg("[gmaps] directions request failed")
		return &DirectionsResult{}, nil
	}
	defer resp.Body.Close()

	var body struct {
		Status string `json:"status"`
		Routes []struct {
			OverviewPolyline struct {
				Points string `json:"points"`
			} `json:"overview_polyline"`
			Legs []struct {
				Duration struct {
					Value int `json:"value"` // seconds
				} `json:"duration"`
				Distance struct {
					Value int `json:"value"` // meters
				} `json:"distance"`
			} `json:"legs"`
		} `json:"routes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		log.Warn().Err(err).Msg("[gmaps] failed to decode directions response")
		return &DirectionsResult{}, nil
	}
	if body.Status != "OK" || len(body.Routes) == 0 || len(body.Routes[0].Legs) == 0 {
		log.Warn().Str("status", body.Status).Msg("[gmaps] directions non-OK status")
		return &DirectionsResult{}, nil
	}

	route := body.Routes[0]
	leg := route.Legs[0]
	result := &DirectionsResult{
		DurationMinutes: (leg.Duration.Value + 59) / 60,
		DistanceMeters:  leg.Distance.Value,
		EncodedPolyline: route.OverviewPolyline.Points,
	}

	// Cache for 90 seconds.
	if c.rdb != nil {
		key := cacheKey("gmaps:dir", oLat, oLng, dLat, dLng)
		if data, err := json.Marshal(result); err == nil {
			_ = c.rdb.Set(ctx, key, data, 90*time.Second).Err()
		}
	}

	log.Debug().
		Float64("oLat", oLat).Float64("oLng", oLng).
		Float64("dLat", dLat).Float64("dLng", dLng).
		Int("eta_minutes", result.DurationMinutes).
		Int("distance_m", result.DistanceMeters).
		Msg("[gmaps] directions")

	return result, nil
}

// ── Places Autocomplete ───────────────────────────────────────────────────────

// PlaceResult is a single result from the Places Autocomplete API.
type PlaceResult struct {
	PlaceID     string  `json:"place_id"`
	Description string  `json:"description"`
	MainText    string  `json:"main_text"`
	SecondText  string  `json:"secondary_text"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
}

// PlacesAutocomplete returns address suggestions for the given input string.
// It calls Autocomplete then fetches coordinates for each result via Geocoding.
// Results are NOT cached (queries are highly variable).
func (c *Client) PlacesAutocomplete(ctx context.Context, input string) ([]PlaceResult, error) {
	params := url.Values{}
	params.Set("input", input)
	params.Set("types", "geocode")
	params.Set("components", "country:in")
	params.Set("key", c.apiKey)

	apiURL := "https://maps.googleapis.com/maps/api/place/autocomplete/json?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("autocomplete request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("autocomplete request: %w", err)
	}
	defer resp.Body.Close()

	var body struct {
		Status      string `json:"status"`
		Predictions []struct {
			PlaceID              string `json:"place_id"`
			Description          string `json:"description"`
			StructuredFormatting struct {
				MainText      string `json:"main_text"`
				SecondaryText string `json:"secondary_text"`
			} `json:"structured_formatting"`
		} `json:"predictions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("autocomplete decode: %w", err)
	}
	if body.Status != "OK" && body.Status != "ZERO_RESULTS" {
		return nil, fmt.Errorf("autocomplete status: %s", body.Status)
	}

	if len(body.Predictions) == 0 {
		return []PlaceResult{}, nil
	}

	// Fetch coordinates for each prediction via Geocoding API.
	results := make([]PlaceResult, 0, len(body.Predictions))
	for _, p := range body.Predictions {
		lat, lon, err := c.geocodePlaceID(ctx, p.PlaceID)
		if err != nil {
			log.Warn().Err(err).Str("place_id", p.PlaceID).Msg("[gmaps] geocode failed for prediction")
			continue
		}
		results = append(results, PlaceResult{
			PlaceID:    p.PlaceID,
			Description: p.Description,
			MainText:   p.StructuredFormatting.MainText,
			SecondText: p.StructuredFormatting.SecondaryText,
			Lat:        lat,
			Lon:        lon,
		})
	}
	return results, nil
}

// geocodePlaceID resolves a place_id to lat/lon via the Geocoding API.
func (c *Client) geocodePlaceID(ctx context.Context, placeID string) (float64, float64, error) {
	params := url.Values{}
	params.Set("place_id", placeID)
	params.Set("key", c.apiKey)

	apiURL := "https://maps.googleapis.com/maps/api/geocode/json?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return 0, 0, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	var body struct {
		Status  string `json:"status"`
		Results []struct {
			Geometry struct {
				Location struct {
					Lat float64 `json:"lat"`
					Lng float64 `json:"lng"`
				} `json:"location"`
			} `json:"geometry"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, 0, err
	}
	if body.Status != "OK" || len(body.Results) == 0 {
		return 0, 0, fmt.Errorf("geocode status: %s", body.Status)
	}
	loc := body.Results[0].Geometry.Location
	return loc.Lat, loc.Lng, nil
}
