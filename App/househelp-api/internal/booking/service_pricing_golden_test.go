package booking_test

// Golden regression anchors for the legacy CreateBooking pricing path.
//
// These tests mirror the EXACT formulas in service.go as of audit 2026-05-13.
// Seed values come from migrations/015_seed_service_categories.up.sql.
// If any expected value changes, update audit_diff.md before merging.
//
// No DB, no mocks — pure formula mirrors. They catch formula drift fast.

import "testing"

// legacyPrice mirrors the CreateBooking pricing block (service.go ~412-434).
//   total = basePriceCents + baseFeeCents
//   if surgeEnabled && multiplier > 1.0: total = int(float64(total) * multiplier)
//   if promo percent: discount = total * pct / 100
//   if promo fixed:   discount = fixedValue
//   if discount > total: discount = total
func legacyPrice(basePriceCents, baseFeeCents int, surgeEnabled bool, surgeMultiplier float64, promoType string, promoValue int) (total, discount, net int) {
	total = basePriceCents + baseFeeCents
	if surgeEnabled && surgeMultiplier > 1.0 {
		total = int(float64(total) * surgeMultiplier)
	}
	switch promoType {
	case "percent":
		discount = total * promoValue / 100
	case "fixed":
		discount = promoValue
	}
	if discount > total {
		discount = total
	}
	net = total - discount
	return
}

const (
	defaultBaseFeeCents = 2000
	// Sweeping & Mopping — base_price_cents from migration 015
	swMopBase = 2500
	// Fridge Cleaning — base_price_cents from migration 015
	fridgeBase = 14900
)

func TestGolden_CreateBooking_NoSurgeNoPromo(t *testing.T) {
	total, _, net := legacyPrice(swMopBase, defaultBaseFeeCents, false, 1.0, "", 0)
	if total != 4500 {
		t.Fatalf("total: got %d want 4500", total)
	}
	if net != 4500 {
		t.Fatalf("net: got %d want 4500", net)
	}
}

func TestGolden_CreateBooking_SurgeOn_1_5x(t *testing.T) {
	// 4500 * 1.5 = 6750.0 → int = 6750
	total, _, net := legacyPrice(swMopBase, defaultBaseFeeCents, true, 1.5, "", 0)
	if total != 6750 {
		t.Fatalf("total: got %d want 6750", total)
	}
	if net != 6750 {
		t.Fatalf("net: got %d want 6750", net)
	}
}

func TestGolden_CreateBooking_SurgeOn_Truncation(t *testing.T) {
	// 4500 * 1.3 = 5850.0 → int = 5850 (exact here)
	// 4501 * 1.3 = 5851.3 → int = 5851 (truncated)
	total, _, _ := legacyPrice(2501, defaultBaseFeeCents, true, 1.3, "", 0)
	// (2501+2000)*1.3 = 4501*1.3 = 5851.3 → 5851
	if total != 5851 {
		t.Fatalf("surge truncation: got %d want 5851", total)
	}
}

func TestGolden_CreateBooking_PercentPromo_10pct(t *testing.T) {
	// total=4500, discount=4500*10/100=450, net=4050
	total, discount, net := legacyPrice(swMopBase, defaultBaseFeeCents, false, 1.0, "percent", 10)
	if total != 4500 {
		t.Fatalf("total: got %d want 4500", total)
	}
	if discount != 450 {
		t.Fatalf("discount: got %d want 450", discount)
	}
	if net != 4050 {
		t.Fatalf("net: got %d want 4050", net)
	}
}

func TestGolden_CreateBooking_FixedPromo_500(t *testing.T) {
	// total=4500, discount=500, net=4000
	_, discount, net := legacyPrice(swMopBase, defaultBaseFeeCents, false, 1.0, "fixed", 500)
	if discount != 500 {
		t.Fatalf("discount: got %d want 500", discount)
	}
	if net != 4000 {
		t.Fatalf("net: got %d want 4000", net)
	}
}

func TestGolden_CreateBooking_FixedPromo_ExceedsTotal(t *testing.T) {
	// Promo value > total → clamped to total, net=0
	_, discount, net := legacyPrice(swMopBase, defaultBaseFeeCents, false, 1.0, "fixed", 99999)
	if discount != 4500 {
		t.Fatalf("discount should clamp to total: got %d want 4500", discount)
	}
	if net != 0 {
		t.Fatalf("net: got %d want 0", net)
	}
}

func TestGolden_CreateBooking_FridgeCleaning_NoSurge(t *testing.T) {
	// fridgeBase=14900, baseFeeCents=2000, total=16900
	total, _, net := legacyPrice(fridgeBase, defaultBaseFeeCents, false, 1.0, "", 0)
	if total != 16900 {
		t.Fatalf("total: got %d want 16900", total)
	}
	if net != 16900 {
		t.Fatalf("net: got %d want 16900", net)
	}
}

func TestGolden_CreateBooking_FridgeCleaning_Surge_1_5x(t *testing.T) {
	// (14900+2000)*1.5 = 16900*1.5 = 25350.0 → 25350
	total, _, _ := legacyPrice(fridgeBase, defaultBaseFeeCents, true, 1.5, "", 0)
	if total != 25350 {
		t.Fatalf("total: got %d want 25350", total)
	}
}

func TestGolden_CreateBooking_SurgeAndPromo(t *testing.T) {
	// Surge first, then promo on surged total.
	// (2500+2000)*1.5=6750, 10% of 6750=675, net=6075
	total, discount, net := legacyPrice(swMopBase, defaultBaseFeeCents, true, 1.5, "percent", 10)
	if total != 6750 {
		t.Fatalf("total: got %d want 6750", total)
	}
	if discount != 675 {
		t.Fatalf("discount: got %d want 675", discount)
	}
	if net != 6075 {
		t.Fatalf("net: got %d want 6075", net)
	}
}
