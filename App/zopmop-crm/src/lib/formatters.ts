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
