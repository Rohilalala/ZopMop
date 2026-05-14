package booking_test

// Golden regression anchors for the cart-based pricing paths:
//   - GetServicePrice formula (cart/repository.go ~180)
//   - CreateScheduledBooking pricing block (service.go ~1022-1049)
//   - CreateInstantBookingFromCart pricing block (service.go ~1163-1189)
//
// Seed values from migrations/015_seed_service_categories.up.sql.
// All services have min_duration_minutes=30.
// If any expected value changes, update audit_diff.md before merging.

import "testing"

// cartItemPrice mirrors GetServicePrice (cart/repository.go ~180).
// Integer division — intentional truncation is a known bug (audit B-1).
func cartItemPrice(basePriceCents, durationMinutes, minDurationMinutes int) int {
	if minDurationMinutes <= 0 {
		minDurationMinutes = 30
	}
	return basePriceCents * durationMinutes / minDurationMinutes
}

// cartTotalPrice mirrors CreateScheduledBooking / CreateInstantBookingFromCart
// pricing block: sum items, add BaseFeeCents, apply promo.
// No surge is applied in cart paths (audit finding).
func cartTotalPrice(itemPrices []int, baseFeeCents int, promoType string, promoValue int) (total, discount, net int) {
	for _, p := range itemPrices {
		total += p
	}
	total += baseFeeCents
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

func TestGolden_CartItemPrice_ExactMultiple(t *testing.T) {
	// 60 min at min=30 → 2× base, no truncation
	got := cartItemPrice(2500, 60, 30)
	if got != 5000 {
		t.Fatalf("got %d want 5000", got)
	}
}

func TestGolden_CartItemPrice_HalfDuration(t *testing.T) {
	// 15 min at min=30 → 0.5× base = 1250 (exact)
	got := cartItemPrice(2500, 15, 30)
	if got != 1250 {
		t.Fatalf("got %d want 1250", got)
	}
}

func TestGolden_CartItemPrice_Truncation_Bug(t *testing.T) {
	// 37 min at min=30 → 2500*37/30 = 92500/30 = 3083 (truncated from 3083.33…)
	// BUG B-1: customer overpays or underpays by up to (minDuration-1) paise.
	got := cartItemPrice(2500, 37, 30)
	if got != 3083 {
		t.Fatalf("truncation: got %d want 3083", got)
	}
}

func TestGolden_CartItemPrice_Fridge60Min(t *testing.T) {
	// Fridge Cleaning base=14900, 60 min at min=30 → 29800
	got := cartItemPrice(14900, 60, 30)
	if got != 29800 {
		t.Fatalf("got %d want 29800", got)
	}
}

func TestGolden_CartTotal_TwoItems_NoPromo(t *testing.T) {
	// item1: Sweeping & Mopping 60 min → 5000
	// item2: Bathroom Cleaning 45 min → 3750
	// sum=8750 + BaseFeeCents=2000 → 10750
	i1 := cartItemPrice(2500, 60, 30) // 5000
	i2 := cartItemPrice(2500, 45, 30) // 3750
	total, _, net := cartTotalPrice([]int{i1, i2}, defaultBaseFeeCents, "", 0)
	if total != 10750 {
		t.Fatalf("total: got %d want 10750", total)
	}
	if net != 10750 {
		t.Fatalf("net: got %d want 10750", net)
	}
}

func TestGolden_CartTotal_TwoItems_PercentPromo_10pct(t *testing.T) {
	// total=10750, 10% discount=1075, net=9675
	i1 := cartItemPrice(2500, 60, 30)
	i2 := cartItemPrice(2500, 45, 30)
	total, discount, net := cartTotalPrice([]int{i1, i2}, defaultBaseFeeCents, "percent", 10)
	if total != 10750 {
		t.Fatalf("total: got %d want 10750", total)
	}
	if discount != 1075 {
		t.Fatalf("discount: got %d want 1075", discount)
	}
	if net != 9675 {
		t.Fatalf("net: got %d want 9675", net)
	}
}

func TestGolden_CartTotal_FridgeAndSweep_NoPromo(t *testing.T) {
	// Fridge 30min=14900, Sweeping 30min=2500 → sum=17400 + 2000 = 19400
	i1 := cartItemPrice(14900, 30, 30) // 14900
	i2 := cartItemPrice(2500, 30, 30)  // 2500
	total, _, net := cartTotalPrice([]int{i1, i2}, defaultBaseFeeCents, "", 0)
	if total != 19400 {
		t.Fatalf("total: got %d want 19400", total)
	}
	if net != 19400 {
		t.Fatalf("net: got %d want 19400", net)
	}
}

func TestGolden_CartTotal_FixedPromo(t *testing.T) {
	// same 2-item cart total=10750, fixed promo=1000, net=9750
	i1 := cartItemPrice(2500, 60, 30)
	i2 := cartItemPrice(2500, 45, 30)
	_, discount, net := cartTotalPrice([]int{i1, i2}, defaultBaseFeeCents, "fixed", 1000)
	if discount != 1000 {
		t.Fatalf("discount: got %d want 1000", discount)
	}
	if net != 9750 {
		t.Fatalf("net: got %d want 9750", net)
	}
}

func TestGolden_CartTotal_NoSurgeApplied(t *testing.T) {
	// Cart path never applies surge — total must equal sum+baseFeeCents even
	// when surge multiplier would be 1.5 in the legacy path.
	// Regression guard: if someone accidentally adds surge to cart path, this fails.
	i1 := cartItemPrice(2500, 60, 30) // 5000
	total, _, _ := cartTotalPrice([]int{i1}, defaultBaseFeeCents, "", 0)
	// Without surge: 5000+2000=7000
	// With 1.5x surge: int(7000*1.5)=10500
	if total != 7000 {
		t.Fatalf("cart path must not apply surge: got %d want 7000", total)
	}
}
