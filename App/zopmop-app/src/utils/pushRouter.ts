// pushRouter — routes incoming FCM data-only messages to the right screen
// based on data.type. Called by usePushNotifications onMessage handler.
//
// Type schema (set by backend in internal/notification/service.go SendData
// + internal/matching dispatch crons):
//
//   BOOKING_ACCEPTED          — pro took the customer's job
//   BOOKING_NO_PROS_FOUND     — chain exhausted, customer must rebook
//   BOOKING_STILL_LOOKING     — stealth-instant 15-min mark, no taker yet
//   BOOKING_REBOOK_AVAILABLE  — pros came back online within 2h
//   booking_assigned          — job force-assigned into a pro's roster
//
// All types carry booking_id.

import { navigate } from '../navigation/navigationRef';
import { showInfo, showSuccess } from './toast';
import { emitShiftEvent } from './shiftEvents';

type FcmMessageData = Record<string, string> | undefined;

// PRO_TARGETED_MESSAGE_TYPES enumerates the FCM data.type values whose
// handler navigates a customer-app instance into a Pro-only screen.
// A push of one of these types delivered to a customer-role user is
// either misrouted or hostile (the customer should not have an FCM
// token registered as a pro target). We drop those silently and warn —
// see audit C-9 / CH1D-1.
//
// Today only booking_assigned meets that bar (it refreshes a pro's
// roster). BOOKING_ACCEPTED / NO_PROS_FOUND / STILL_LOOKING /
// REBOOK_AVAILABLE are customer-facing toasts/redirects and stay open.
// When new Pro-targeted types are added, append them here.
const PRO_TARGETED_MESSAGE_TYPES: readonly string[] = ['booking_assigned'];

export function routeFcmMessage(data: FcmMessageData, userRole?: string | null) {
  if (!data || !data.type) return;
  const bookingId = data.booking_id ?? '';

  if (PRO_TARGETED_MESSAGE_TYPES.includes(data.type) && userRole !== 'helper') {
    // Pro-targeted push delivered to a non-helper. Drop without UI side-
    // effects: navigating would land them on a Pro screen, toasting would
    // acknowledge a misrouted message we don't want to surface.
    // eslint-disable-next-line no-console
    console.warn('[pushRouter] Pro-targeted push for non-helper user, dropping', {
      type: data.type,
      userRole: userRole ?? '<unauthenticated>',
    });
    return;
  }

  switch (data.type) {
    // The unified assigner is the sole producer of the customer "accepted" push
    // and sends data.type as lowercase 'booking_accepted' (notification SendData);
    // the legacy uppercase string is kept for any in-flight pushes. Both land on
    // the same confirmation toast.
    case 'booking_accepted':
    case 'BOOKING_ACCEPTED': {
      const helperName = data.helper_name ?? 'Your pro';
      showSuccess(`${helperName} has accepted your booking.`, { title: 'Booking confirmed' });
      // No navigation push — customer is likely on Bookings or Home; the
      // toast + a list refresh on focus is enough.
      return;
    }

    case 'BOOKING_NO_PROS_FOUND': {
      showInfo(data.body ?? "We couldn't find a pro. Tap to try again.", {
        title: data.title ?? 'Booking unfilled',
      });
      // The booking is now cancelled; tapping the system tray push deep-links
      // here. We surface the toast + leave navigation to the user.
      return;
    }

    case 'BOOKING_STILL_LOOKING': {
      // Soft nudge — booking-status feed will reflect 'searching' on next
      // poll/focus. A toast is plenty.
      showInfo(data.body ?? "Still looking for a pro.", {
        title: data.title ?? 'Still searching',
      });
      return;
    }

    case 'BOOKING_REBOOK_AVAILABLE': {
      showInfo(data.body ?? 'Pros are now available in your area.', {
        title: data.title ?? 'Pros available',
      });
      // Navigate to bookings list so the user can find the cancelled row +
      // tap to rebook from there. A direct slot-picker deep-link would
      // require knowing the original cart shape, which the push doesn't
      // carry — keep it simple.
      navigate('Bookings');
      return;
    }

    case 'zone_approval_granted': {
      emitShiftEvent({
        type: 'zone_approval_granted',
        request_id: data.request_id,
        commitment_id: data.commitment_id,
      });
      return;
    }

    case 'zone_drift_warning': {
      emitShiftEvent({
        type: 'zone_drift_warning',
        commitment_id: data.commitment_id,
      });
      return;
    }

    case 'booking_assigned': {
      // Force-assigned roster job (no offer/accept). Mark the row as newly
      // arrived (drives the NEW badge + "Got it" ack in JobsList) and trigger
      // a roster refetch via the shared status-change event, then surface a
      // high-visibility in-app toast on top of the FCM tray notification.
      if (bookingId) emitShiftEvent({ type: 'booking_assigned', booking_id: bookingId });
      emitShiftEvent({ type: 'booking_status_change', booking_id: bookingId });
      showSuccess('New job added to your roster', { title: 'Job assigned' });
      return;
    }

    case 'booking_status_change':
    case 'pro_en_route':
    case 'pro_arrived':
    case 'job_started':
    case 'job_completed': {
      emitShiftEvent({
        type: 'booking_status_change',
        booking_id: bookingId,
        status: data.status,
      });
      return;
    }

    default:
      // Unknown type — log only.
      // eslint-disable-next-line no-console
      console.warn('[pushRouter] unknown push type', data.type);
  }
}
