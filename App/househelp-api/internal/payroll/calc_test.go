package payroll

import (
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

func TestComputePay_WorkingExceedsOnline_Caps(t *testing.T) {
	// 60 online, 90 working → working is capped at online (60). Both legs
	// pay ₹80/hr: base 60min=8000, bonus 60min=8000, gross 16000. No error.
	p, err := ComputePay(60, 90)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.WorkingMinutes != 60 {
		t.Fatalf("working: want capped to 60, got %d", p.WorkingMinutes)
	}
	if p.BasePayPaise != 8000 || p.BonusPayPaise != 8000 {
		t.Fatalf("pay: want base 8000 / bonus 8000, got base %d / bonus %d", p.BasePayPaise, p.BonusPayPaise)
	}
	if p.GrossPayPaise != 16000 {
		t.Fatalf("gross: want 16000, got %d", p.GrossPayPaise)
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

func TestCycleForCloseDate_Sixteenth(t *testing.T) {
	// The 16th is the run day that closes the 1st–15th cycle.
	t16 := time.Date(2026, time.May, 16, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t16)
	if !ok {
		t.Fatalf("expected the 16th to be a payroll run day")
	}
	if c.StartDate() != "2026-05-01" || c.EndDate() != "2026-05-15" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_FirstAfter31(t *testing.T) {
	// June 1 closes the May 16–31 cycle.
	t1 := time.Date(2026, time.June, 1, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t1)
	if !ok {
		t.Fatalf("expected June 1 to be a payroll run day")
	}
	if c.StartDate() != "2026-05-16" || c.EndDate() != "2026-05-31" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_FirstAfter30(t *testing.T) {
	// April has 30 days; May 1 closes Apr 16–30.
	t1 := time.Date(2026, time.May, 1, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t1)
	if !ok {
		t.Fatalf("expected May 1 to be a payroll run day")
	}
	if c.StartDate() != "2026-04-16" || c.EndDate() != "2026-04-30" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_FebNonLeap(t *testing.T) {
	// 2025 — non-leap. Feb has 28 days. Mar 1 closes Feb 16–28.
	t1 := time.Date(2025, time.March, 1, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t1)
	if !ok {
		t.Fatalf("expected Mar 1 (non-leap) to be a payroll run day")
	}
	if c.StartDate() != "2025-02-16" || c.EndDate() != "2025-02-28" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_FebLeap(t *testing.T) {
	// 2028 is a leap year — Feb has 29 days. Mar 1 closes Feb 16–29.
	t1 := time.Date(2028, time.March, 1, 1, 0, 0, 0, istLocation)
	c, ok := CycleForCloseDate(t1)
	if !ok {
		t.Fatalf("expected Mar 1 (leap year) to be a payroll run day")
	}
	if c.StartDate() != "2028-02-16" || c.EndDate() != "2028-02-29" {
		t.Fatalf("bad cycle: start=%s end=%s", c.StartDate(), c.EndDate())
	}
}

func TestCycleForCloseDate_NotRunDay(t *testing.T) {
	for _, d := range []int{2, 5, 14, 15, 20, 28, 31} {
		// Use July (always 31 days). The 15th and 31st are cycle CLOSE
		// days but NOT run days — the run fires the morning after.
		_, ok := CycleForCloseDate(time.Date(2026, time.July, d, 1, 0, 0, 0, istLocation))
		if ok {
			t.Fatalf("July %d should not be a payroll run day", d)
		}
	}
}

func TestNextCloseAfter(t *testing.T) {
	// 2 May 02:00 → next run is 16 May 01:00 IST (closes May 1–15).
	from := time.Date(2026, time.May, 2, 2, 0, 0, 0, istLocation)
	next := NextCloseAfter(from)
	want := time.Date(2026, time.May, 16, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next run after %s: want %s, got %s", from, want, next)
	}

	// 16 May 01:00 (the run moment itself) → next is 1 Jun 01:00,
	// because NextCloseAfter is strictly after.
	from = time.Date(2026, time.May, 16, 1, 0, 0, 0, istLocation)
	next = NextCloseAfter(from)
	want = time.Date(2026, time.June, 1, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next run after 16 May 01:00: want %s, got %s", want, next)
	}

	// 31 Jan 02:00 → next is 1 Feb 01:00 (closes Jan 16–31).
	from = time.Date(2026, time.January, 31, 2, 0, 0, 0, istLocation)
	next = NextCloseAfter(from)
	want = time.Date(2026, time.February, 1, 1, 0, 0, 0, istLocation)
	if !next.Equal(want) {
		t.Fatalf("next run after 31 Jan 02:00: want %s, got %s", want, next)
	}
}

func TestComputeEffectiveStartDate(t *testing.T) {
	cases := []struct {
		now  time.Time
		want string
		desc string
	}{
		{time.Date(2026, time.May, 21, 2, 59, 0, 0, istLocation), "2026-05-21", "02:59 IST → today"},
		{time.Date(2026, time.May, 21, 3, 0, 0, 0, istLocation), "2026-05-22", "03:00 IST → tomorrow"},
		{time.Date(2026, time.May, 21, 3, 1, 0, 0, istLocation), "2026-05-22", "03:01 IST → tomorrow"},
		{time.Date(2025, time.February, 28, 4, 0, 0, 0, istLocation), "2025-03-01", "Feb 28 (non-leap) 04:00 → Mar 1"},
		{time.Date(2028, time.February, 28, 4, 0, 0, 0, istLocation), "2028-02-29", "Feb 28 (leap) 04:00 → Feb 29"},
		{time.Date(2028, time.February, 29, 4, 0, 0, 0, istLocation), "2028-03-01", "Feb 29 (leap) 04:00 → Mar 1"},
		{time.Date(2026, time.December, 31, 4, 0, 0, 0, istLocation), "2027-01-01", "Dec 31 04:00 → Jan 1 next year"},
		{time.Date(2026, time.December, 31, 2, 0, 0, 0, istLocation), "2026-12-31", "Dec 31 02:00 → same day"},
	}
	for _, tc := range cases {
		got := ComputeEffectiveStartDate(tc.now)
		if got != tc.want {
			t.Errorf("%s: want %s, got %s", tc.desc, tc.want, got)
		}
	}
}

func TestProratedTargetHours(t *testing.T) {
	loc := istLocation
	cycleStart := time.Date(2026, time.May, 16, 0, 0, 0, 0, loc)
	cycleEnd := time.Date(2026, time.May, 31, 0, 0, 0, 0, loc)
	cases := []struct {
		effective   time.Time
		deactivated time.Time
		want        int
		desc        string
	}{
		{time.Date(2026, time.May, 21, 0, 0, 0, 0, loc), time.Time{}, 63, "joined May 21 → 11 days → ceil(80/14*11)=63"},
		{time.Date(2026, time.May, 30, 0, 0, 0, 0, loc), time.Time{}, 12, "joined May 30 → 2 days → ceil(80/14*2)=12"},
		{time.Date(2026, time.June, 1, 0, 0, 0, 0, loc), time.Time{}, 0, "effective after cycle_end → 0"},
		{time.Date(2026, time.May, 1, 0, 0, 0, 0, loc), time.Time{}, 92, "full 16-day cycle → ceil(80/14*16)=92"},
		{time.Date(2026, time.May, 1, 0, 0, 0, 0, loc),
			time.Date(2026, time.May, 20, 0, 0, 0, 0, loc), 29, "deactivated May 20 → days 16-20 = 5 → ceil(80/14*5)=29"},
		{time.Date(2026, time.May, 18, 0, 0, 0, 0, loc),
			time.Date(2026, time.May, 22, 0, 0, 0, 0, loc), 29, "joined+left mid-cycle (18-22) = 5 → 29"},
	}
	for _, tc := range cases {
		got := ProratedTargetHours(tc.effective, tc.deactivated, cycleStart, cycleEnd)
		if got != tc.want {
			t.Errorf("%s: want %d, got %d", tc.desc, tc.want, got)
		}
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

func TestIsCanonicalCycle(t *testing.T) {
	mk := func(sy int, sm time.Month, sd, ey int, em time.Month, ed int) CycleClose {
		return CycleClose{
			Start: time.Date(sy, sm, sd, 0, 0, 0, 0, istLocation),
			End:   time.Date(ey, em, ed, 0, 0, 0, 0, istLocation),
		}
	}
	// Canonical cycles.
	if !IsCanonicalCycle(mk(2026, time.May, 1, 2026, time.May, 15)) {
		t.Error("1st–15th must be canonical")
	}
	if !IsCanonicalCycle(mk(2026, time.May, 16, 2026, time.May, 31)) {
		t.Error("16th–31st must be canonical")
	}
	if !IsCanonicalCycle(mk(2026, time.February, 16, 2026, time.February, 28)) {
		t.Error("Feb 16th–28th (non-leap) must be canonical")
	}
	// Non-canonical / overlapping windows that would double-pay.
	if IsCanonicalCycle(mk(2026, time.May, 1, 2026, time.May, 20)) {
		t.Error("1st–20th must be rejected (overlaps the 16th–EOM cycle)")
	}
	if IsCanonicalCycle(mk(2026, time.May, 10, 2026, time.May, 25)) {
		t.Error("10th–25th must be rejected")
	}
	if IsCanonicalCycle(mk(2026, time.May, 1, 2026, time.May, 31)) {
		t.Error("whole-month 1st–31st must be rejected")
	}
}
