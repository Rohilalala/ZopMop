package payroll

import (
	"errors"
	"testing"
	"time"
)

func TestComputePay_Zero(t *testing.T) {
	p, err := ComputePay(0, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.BasePayPaise != 0 || p.BonusPayPaise != 0 || p.GrossPayPaise != 0 || p.NetPayPaise != 0 {
		t.Fatalf("expected all-zero pay, got %+v", p)
	}
}

func TestComputePay_FullCycle(t *testing.T) {
	// 80h online, 40h working: 80 × ₹80 + 40 × ₹80 = ₹6400 + ₹3200 = ₹9600 = 960000 paise.
	p, err := ComputePay(80*60, 40*60)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.BasePayPaise != 640000 {
		t.Fatalf("base: want 640000, got %d", p.BasePayPaise)
	}
	if p.BonusPayPaise != 320000 {
		t.Fatalf("bonus: want 320000, got %d", p.BonusPayPaise)
	}
	if p.GrossPayPaise != 960000 || p.NetPayPaise != 960000 {
		t.Fatalf("gross/net: want 960000, got gross=%d net=%d", p.GrossPayPaise, p.NetPayPaise)
	}
}

func TestComputePay_PartialMidJoin(t *testing.T) {
	// Pro joined mid-cycle: 35h online, 18h working.
	// base = 35*60*8000/60 = 280000; bonus = 18*60*8000/60 = 144000.
	p, err := ComputePay(35*60, 18*60)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.BasePayPaise != 280000 {
		t.Fatalf("base: want 280000, got %d", p.BasePayPaise)
	}
	if p.BonusPayPaise != 144000 {
		t.Fatalf("bonus: want 144000, got %d", p.BonusPayPaise)
	}
}

func TestComputePay_WorkingExceedsOnline(t *testing.T) {
	_, err := ComputePay(60, 90)
	if !errors.Is(err, ErrInvalidActivity) {
		t.Fatalf("want ErrInvalidActivity, got %v", err)
	}
}

func TestComputePay_OddMinutes(t *testing.T) {
	// 7 min online, 0 working. base = 7*8000/60 = 933 (integer trunc).
	p, err := ComputePay(7, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.BasePayPaise != 933 {
		t.Fatalf("base: want 933, got %d", p.BasePayPaise)
	}
}

func TestCycleForCloseDate_Fifteenth(t *testing.T) {
	t15 := time.Date(2026, time.May, 15, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t15)
	if !ok {
		t.Fatalf("expected 15th to be a close date")
	}
	if c.StartDate() != "2026-05-01" || c.EndDate() != "2026-05-15" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_LastDay31(t *testing.T) {
	t31 := time.Date(2026, time.May, 31, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t31)
	if !ok {
		t.Fatalf("expected 31st (May) to be a close date")
	}
	if c.StartDate() != "2026-05-16" || c.EndDate() != "2026-05-31" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_LastDay30(t *testing.T) {
	// April has 30 days, not 31.
	t30 := time.Date(2026, time.April, 30, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t30)
	if !ok {
		t.Fatalf("expected 30th (April) to be a close date")
	}
	if c.StartDate() != "2026-04-16" || c.EndDate() != "2026-04-30" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_FebNonLeap(t *testing.T) {
	// 2025 — non-leap. Feb has 28 days. The 28th is the cycle close.
	t28 := time.Date(2025, time.February, 28, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t28)
	if !ok {
		t.Fatalf("expected Feb 28 (non-leap) to be a close date")
	}
	if c.StartDate() != "2025-02-16" || c.EndDate() != "2025-02-28" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
	// And the 29th should NOT be a close date in a non-leap year (it
	// doesn't exist; Go normalises it to March 1, which IS day 1 and
	// is also not a close date).
	_, ok29 := CycleForCloseDate(time.Date(2025, time.February, 29, 1, 0, 0, 0, istLocation))
	if ok29 {
		t.Fatalf("Feb 29 2025 normalised to Mar 1 — should not be a close date")
	}
}

func TestCycleForCloseDate_FebLeap(t *testing.T) {
	// 2028 is a leap year — Feb has 29 days.
	t29 := time.Date(2028, time.February, 29, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t29)
	if !ok {
		t.Fatalf("expected Feb 29 (leap year) to be a close date")
	}
	if c.StartDate() != "2028-02-16" || c.EndDate() != "2028-02-29" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
	// Feb 28 in a leap year is NOT a close date (29 is).
	_, ok28 := CycleForCloseDate(time.Date(2028, time.February, 28, 1, 0, 0, 0, istLocation))
	if ok28 {
		t.Fatalf("Feb 28 in a leap year should not be a close date")
	}
}

func TestCycleForCloseDate_NotClose(t *testing.T) {
	for _, d := range []int{1, 5, 14, 16, 20, 28} {
		// Use July (always 31 days; none of these are last-of-month).
		_, ok := CycleForCloseDate(time.Date(2026, time.July, d, 1, 0, 0, 0, istLocation))
		if ok {
			t.Fatalf("July %d should not be a close date", d)
		}
	}
}

func TestNextCloseAfter(t *testing.T) {
	// 1 May 02:00 → next close is 15 May 01:00 IST.
	from := time.Date(2026, time.May, 1, 2, 0, 0, 0, istLocation)
	next := NextCloseAfter(from)
	want := time.Date(2026, time.May, 15, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next close after %s: want %s, got %s", from, want, next)
	}

	// 15 May 01:00 (the close moment itself) → next is 31 May 01:00,
	// because NextCloseAfter is strictly after.
	from = time.Date(2026, time.May, 15, 1, 0, 0, 0, istLocation)
	next = NextCloseAfter(from)
	want = time.Date(2026, time.May, 31, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next close after 15 May 01:00: want %s, got %s", want, next)
	}

	// 31 Jan 02:00 → next is 15 Feb 01:00 (skips over Feb 28/29).
	from = time.Date(2026, time.January, 31, 2, 0, 0, 0, istLocation)
	next = NextCloseAfter(from)
	want = time.Date(2026, time.February, 15, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next close after 31 Jan 02:00: want %s, got %s", want, next)
	}
}

func TestLastDayOfMonth(t *testing.T) {
	cases := []struct {
		y    int
		m    time.Month
		want int
	}{
		{2026, time.January, 31},
		{2026, time.February, 28}, // non-leap
		{2028, time.February, 29}, // leap
		{2026, time.April, 30},
		{2026, time.December, 31},
		{2100, time.February, 28}, // century non-leap
		{2400, time.February, 29}, // 400-year leap
	}
	for _, tc := range cases {
		got := lastDayOfMonth(tc.y, tc.m)
		if got != tc.want {
			t.Errorf("lastDayOfMonth(%d, %s): want %d, got %d", tc.y, tc.m, tc.want, got)
		}
	}
}
