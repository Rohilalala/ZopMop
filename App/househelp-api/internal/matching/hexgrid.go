// Package matching implements ZopMop's geospatial matching engine.
//
// The hex grid is a simplified rectangular grid that approximates the hexagonal
// cell concept popularised by Uber's H3 library. Each cell covers approximately
// 500 m × 500 m, which is well-suited for a home-services marketplace where
// helpers travel on foot or by two-wheeler within a few kilometres.
//
// Why not H3?  The official Go binding (uber/h3-go) requires CGO and C headers
// that are unavailable in standard CI environments. This pure-Go replacement
// gives the same structural benefits — O(1) cell lookup, O(1) neighbour
// enumeration, and locality-preserving cell IDs — without external dependencies.
package matching

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// cellSizeDeg is the edge length of one grid cell in decimal degrees.
// At latitude 28° (Gurugram / NCR region):
//   1° latitude  ≈ 111.0 km  →  0.0045° ≈ 500 m
//   1° longitude ≈  97.5 km  →  0.0045° ≈ 439 m  (≈ 470 m average)
//
// Using the same value for both axes keeps the grid simple and the cells
// roughly square in the regions ZopMop serves.
const cellSizeDeg = 0.0045

// LatLngToCell converts a (lat, lng) coordinate pair into a string cell ID.
// The ID encodes the integer row and column of the grid cell: "row:col".
// Identical coordinates always produce the same ID; coordinates within the
// same 500 m square produce the same ID — that's the entire point.
func LatLngToCell(lat, lng float64) string {
	row := int64(math.Floor(lat / cellSizeDeg))
	col := int64(math.Floor(lng / cellSizeDeg))
	return fmt.Sprintf("%d:%d", row, col)
}

// CellCenter returns the geographic centroid of the cell with the given ID.
// Returns an error only if the ID is malformed (not produced by LatLngToCell).
func CellCenter(cellID string) (lat, lng float64, err error) {
	row, col, err := parseCell(cellID)
	if err != nil {
		return 0, 0, err
	}
	lat = (float64(row) + 0.5) * cellSizeDeg
	lng = (float64(col) + 0.5) * cellSizeDeg
	return lat, lng, nil
}

// NeighborCells returns all cell IDs within `rings` rings of the given cell,
// including the cell itself (rings = 0 returns just the cell).
//
//	rings = 1 → 3×3  =  9 cells  (edge ≈ 1.5 km)
//	rings = 2 → 5×5  = 25 cells  (edge ≈ 2.5 km)
//	rings = 3 → 7×7  = 49 cells  (edge ≈ 3.5 km)
//
// This is the primary mechanism for the geospatial pre-filter: instead of
// scanning every helper in the city, the engine only examines helpers whose
// last known cell is within the requested ring neighbourhood.
func NeighborCells(cellID string, rings int) []string {
	row, col, err := parseCell(cellID)
	if err != nil {
		return []string{cellID}
	}
	if rings < 0 {
		rings = 0
	}
	size := 2*rings + 1
	out := make([]string, 0, size*size)
	for dr := -rings; dr <= rings; dr++ {
		for dc := -rings; dc <= rings; dc++ {
			out = append(out, fmt.Sprintf("%d:%d", row+int64(dr), col+int64(dc)))
		}
	}
	return out
}

// RingsForRadius returns the minimum number of rings needed to cover the given
// radius. Each ring adds approximately 0.5 km of coverage in every direction.
func RingsForRadius(radiusKm float64) int {
	if radiusKm <= 0 {
		return 1
	}
	rings := int(math.Ceil(radiusKm / 0.5))
	if rings < 1 {
		return 1
	}
	if rings > 30 {
		return 30 // cap at 15 km total coverage — citywide
	}
	return rings
}

// HaversineKm computes the great-circle distance between two lat/lng points
// using the Haversine formula. Returns the distance in kilometres.
//
// Used both in the hex grid (cell-centre distance estimation) and as the
// final precision filter after the Redis GEOSEARCH pre-filter.
func HaversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const earthR = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLng := (lng2 - lng1) * math.Pi / 180.0
	lat1R := lat1 * math.Pi / 180.0
	lat2R := lat2 * math.Pi / 180.0
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1R)*math.Cos(lat2R)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthR * c
}

// ── internal helpers ──────────────────────────────────────────────────────────

func parseCell(cellID string) (row, col int64, err error) {
	parts := strings.SplitN(cellID, ":", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid cell id %q: expected row:col", cellID)
	}
	row, err = strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid cell row in %q: %w", cellID, err)
	}
	col, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid cell col in %q: %w", cellID, err)
	}
	return row, col, nil
}
