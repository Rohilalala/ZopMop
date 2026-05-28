// decoupling_test.go — enforces the Phase 1 Step 3 hard rule that
// pro payroll is fully decoupled from customer payment, cash
// collection, and any settlement state. A grep-style guard test that
// fails if payroll code ever starts importing or referencing the
// cash / payment_status columns.
//
// The rule:
//
//   Pro pay is salaried on online/working minutes (ComputePay). The
//   cash a pro owes the company (cash_collected_by_pro /
//   cash_collected_at / cash_settled_at) is a SEPARATE LEDGER tracked
//   in internal/crm/cash. They never net against each other; the pro
//   is paid identically whether the customer paid via Cashfree, in
//   cash, or not at all.
//
// If this test fails, somebody coupled payroll to cash/payment. STOP
// and rip out the coupling. See docs/phase-1-payment-gated-flow.md.

package payroll

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// forbiddenSymbols are substrings that must NOT appear in any *.go
// file under internal/payroll/. They span the payment_status enum,
// the cash columns, the payments + ledger packages, and the CRM cash
// module. Comments are stripped via the simple cleaner below — a
// reference in a // comment is still a coupling smell (someone is
// THINKING about coupling them).
var forbiddenSymbols = []string{
	"payment_status",
	"payment_method",
	"cash_collected",
	"cash_settled",
	"internal/payments",
	"internal/wallet",
	"internal/crm/cash",
	"PaymentMethod",
	"Cashfree",
}

func TestPayrollDecoupledFromCustomerPayment(t *testing.T) {
	t.Parallel()

	// Walk every Go file under this package's directory. Skip this
	// test file itself — it intentionally NAMES the symbols.
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read payroll dir: %v", err)
	}
	var checked int
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		if name == "decoupling_test.go" {
			continue
		}
		path := filepath.Join(".", name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		body := string(data)
		for _, sym := range forbiddenSymbols {
			if strings.Contains(body, sym) {
				t.Errorf("%s references forbidden symbol %q — pro payroll must not couple to customer payment / cash state. See docs/phase-1-payment-gated-flow.md.", path, sym)
			}
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("expected to scan at least one .go file in internal/payroll/ — directory empty?")
	}
}
