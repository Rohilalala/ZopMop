// Money / number formatters. All paise-denominated values pass through here
// so null / undefined / NaN don't leak "₹NaN" into the UI.
//
// All admin-facing summary cards drop fractional paise — admins don't need
// 0.50p precision on LTV / earnings / refund totals. Per-row order amount
// detail (rare) can call formatRupeesExact instead.

export function formatRupees(paise: number | null | undefined): string {
  if (paise == null || Number.isNaN(paise)) return '—';
  return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Two-decimal variant for places where the precision matters (deduction
// audit, refund modal pre-fill).
export function formatRupeesExact(paise: number | null | undefined): string {
  if (paise == null || Number.isNaN(paise)) return '—';
  return '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ── IST datetime-local helpers ──────────────────────────────────────────
// ZopMop is IST-only (Asia/Kolkata, fixed UTC+5:30, no DST). A
// <input type="datetime-local"> has no timezone — the string is a bare wall
// clock. Slicing a UTC RFC3339 string straight into the input (and re-parsing
// with `new Date(...).toISOString()`) treats the UTC clock as the admin's
// local clock, shifting every value by the offset on each save. These two
// helpers pin the input to IST wall-clock on both legs.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// UTC RFC3339 → "YYYY-MM-DDTHH:mm" wall clock in IST, for filling the input.
export function utcToISTInput(rfc3339: string | null | undefined): string {
  if (!rfc3339) return '';
  const t = new Date(rfc3339).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 16);
}

// "YYYY-MM-DDTHH:mm" IST wall clock → UTC RFC3339 string, for submitting.
export function istInputToUTC(local: string | null | undefined): string | null {
  if (!local) return null;
  // Parse the bare wall clock as UTC parts, then subtract the IST offset to
  // recover the true UTC instant.
  const asUTC = new Date(local + ':00Z').getTime();
  if (Number.isNaN(asUTC)) return null;
  return new Date(asUTC - IST_OFFSET_MS).toISOString();
}
