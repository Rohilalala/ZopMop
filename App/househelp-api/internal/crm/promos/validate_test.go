package promos

import "testing"

func TestValidateCreateRequest(t *testing.T) {
	cases := []struct {
		name    string
		req     CreateRequest
		wantErr bool
	}{
		{"percent min ok", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 1}, false},
		{"percent 100 boundary ok", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 100}, false},
		{"percent 101 reject", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 101}, true},
		{"percent huge reject (LB-5 typo)", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10000}, true},
		{"fixed min ok", CreateRequest{Code: "C", DiscountType: "fixed", DiscountValue: 1}, false},
		{"fixed 1m boundary ok", CreateRequest{Code: "C", DiscountType: "fixed", DiscountValue: 1000000}, false},
		{"fixed 1m+1 reject", CreateRequest{Code: "C", DiscountType: "fixed", DiscountValue: 1000001}, true},
		{"fixed int32-fits-but-huge reject", CreateRequest{Code: "C", DiscountType: "fixed", DiscountValue: 2000000000}, true},
		{"zero reject", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 0}, true},
		{"negative reject", CreateRequest{Code: "C", DiscountType: "fixed", DiscountValue: -1}, true},
		{"missing code reject", CreateRequest{Code: "", DiscountType: "percent", DiscountValue: 10}, true},
		{"unknown type reject", CreateRequest{Code: "C", DiscountType: "bogus", DiscountValue: 10}, true},

		// Caps non-negativity (CRM promos P0 fix). Negative caps could weaken
		// per-user / total redemption limits at booking time.
		{"caps zero ok", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10, MinOrderCents: 0, MaxUses: 0, MaxPerUser: 0}, false},
		{"positive caps ok", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10, MinOrderCents: 5000, MaxUses: 100, MaxPerUser: 2}, false},
		{"negative min_order reject", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10, MinOrderCents: -100}, true},
		{"negative max_uses reject", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10, MaxUses: -5}, true},
		{"negative max_per_user reject", CreateRequest{Code: "C", DiscountType: "percent", DiscountValue: 10, MaxPerUser: -1}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateCreateRequest(tc.req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateCreateRequest(%+v) err=%v, wantErr=%v", tc.req, err, tc.wantErr)
			}
		})
	}
}
