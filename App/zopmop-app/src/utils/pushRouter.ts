// pushRouter — routes incoming FCM data-only messages to the right screen
// based on data.type. Called by usePushNotifications onMessage handler.
//
// Type schema (set by backend in internal/notification/service.go SendData
// + internal/matching dispatch crons):
//
//   SCHEDULED_INVITE          — scheduled-job invite for a pro
//   BOOKING_ACCEPTED          — pro took the customer's job
//   BOOKING_NO_PROS_FOUND     — chain exhausted, customer must rebook
//   BOOKING_STILL_LOOKING     — stealth-instant 15-min mark, no taker yet
//   BOOKING_REBOOK_AVAILABLE  — pros came back online within 2h
//
// All types carry booking_id. SCHEDULED_INVITE additionally carries
// scheduled_time, duration_minutes, locality, customer_id.

import { navigate } from '../navigation/navigationRef';
import { showInfo, showSuccess } from './toast';

type FcmMessageData = Record<string, string> | undefined;

// PRO_TARGETED_MESSAGE_TYPES enumerates the FCM data.type values whose
// handler navigates a customer-app instance into a Pro-only screen.
// A push of one of these types delivered to a customer-role user is
// either misrouted or hostile (the customer should not have an FCM
// token registered as a pro target). We drop those silently and warn —
// see audit C-9 / CH1D-1.
//
// Today only SCHEDULED_INVITE meets that bar (it deep-links into
// ProScheduledInvite). BOOKING_ACCEPTED / NO_PROS_FOUND / STILL_LOOKING /
// REBOOK_AVAILABLE are customer-facing toasts/redirects and stay open.
// When new Pro-targeted types are added, append them here.
const PRO_TARGETED_MESSAGE_TYPES: readonly string[] = ['SCHEDULED_INVITE'];

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
    case 'SCHEDULED_INVITE': {
      if (!bookingId) return;
      const scheduledTime = data.scheduled_time ?? '';
      const durationMinutes = parseInt(data.duration_minutes ?? '60', 10) || 60;
      const customerArea = data.locality ?? 'Customer area';
      navigate('ProScheduledInvite', {
        bookingId,
        scheduledTime,
        durationMinutes,
        customerArea,
      });
      return;
    }

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

    default:
      // Unknown type — log only.
      // eslint-disable-next-line no-console
      console.warn('[pushRouter] unknown push type', data.type);
  }
}
