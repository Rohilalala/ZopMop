// Pro-side booking cancellation flow. Three-tier salary-impact warning
// before calling /pro/bookings/:id/cancel:
//
//   tier 1 (cancellations 1–3 in last 30d): soft reminder
//   tier 4: amber warning, next cancel will deduct
//   tier 5+: cash deduction explicit
//
// Penalty estimate is calculated client-side from estimated job duration
// (₹80/hr) since the backend doesn't surface a pre-cancel quote. Real
// penalty applied is returned in CancelBookingResult.

import { Alert } from 'react-native';
import { cancelProBooking, getFortnightProgress, type CancelBookingResult } from '../api/shifts';
import { showInfo, showError } from './toast';
import { friendlyError } from './errors';
import { t } from '../i18n';

const BASE_RATE_PER_HOUR = 80; // ₹80/hr — must match backend `BaseRatePaisePerHour`.

export function estimatedPenaltyRupees(estimatedJobMinutes: number | undefined): number {
  if (!estimatedJobMinutes || estimatedJobMinutes <= 0) return 80;
  return Math.round((estimatedJobMinutes / 60) * BASE_RATE_PER_HOUR);
}

interface Args {
  bookingId: string;
  estimatedJobMinutes?: number;
  onCancelled: (result: CancelBookingResult) => void;
}

/**
 * Confirms with the user (with tiered copy) then calls the cancel endpoint.
 * Shows a salary-impact warning at every tier. Surfaces the actual
 * penalty (₹) via toast if the 5-strike rule kicked in.
 */
export async function startProBookingCancel({ bookingId, estimatedJobMinutes, onCancelled }: Args): Promise<void> {
  // Look up the pro's current cancellation count so the copy is honest.
  // If this fetch fails we still let them cancel — just with generic copy.
  let count30d = 0;
  try {
    const prog = await getFortnightProgress();
    count30d = prog.cancellation_count_30d ?? 0;
  } catch { /* fall through with count=0 */ }

  const nextCount = count30d + 1;
  const penalty = estimatedPenaltyRupees(estimatedJobMinutes);

  let body: string;
  if (nextCount <= 3) {
    body = t('cancel.tier1Body', { n: nextCount });
  } else if (nextCount === 4) {
    body = t('cancel.tier4Body', { penalty });
  } else {
    body = t('cancel.tier5Body', { penalty });
  }

  Alert.alert(
    t('cancel.title'),
    body,
    [
      { text: t('cancel.keep'), style: 'cancel' },
      {
        text: t('cancel.confirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            const result = await cancelProBooking(bookingId);
            if (result.penalty_applied) {
              showInfo(
                t('cancel.penaltyToast', { penalty: Math.round(result.penalty_amount_paise / 100) }),
              );
            }
            onCancelled(result);
          } catch (e: any) {
            showError(friendlyError(e, 'Couldn’t cancel this job right now. Please try again.'));
          }
        },
      },
    ],
  );
}
