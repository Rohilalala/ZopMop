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
import { emitShiftEvent } from './shiftEvents';

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
const PRO_TARGETED_MESSAGE_TYPES: readonly string[] = ['SCHEDULED_INVITE', 'booking_offer'];

export function routeFcmMessage(data: FcmMessageData, userRole?: string | null) {
  if (!data || !data.type) return;
  const bookingId = data.booking_id ?? '';

  // Canonical JWT role for pros is 'pro' (migration 019 renamed every
  // 'helper' row and tightened the CHECK constraint — 'helper' can no
  // longer exist in the DB). Accept the legacy literal anyway in case a
  // stale pre-019 JWT is still cached on-device. Gating on 'helper'
  // alone dropped EVERY job-offer push for every pro.
  if (PRO_TARGETED_MESSAGE_TYPES.includes(data.type) && userRole !== 'pro' && userRole !== 'helper') {
    // Pro-targeted push delivered to a non-pro. Drop without UI side-
    // effects: navigating would land them on a Pro screen, toasting would
    // acknowledge a misrouted message we don't want to surface.
    // eslint-disable-next-line no-console
    console.warn('[pushRouter] Pro-targeted push for non-pro user, dropping', {
      type: data.type,
      userRole: userRole ?? '<unauthenticated>',
    });
    return;
  }

  switch (data.type) {
    // Legacy SCHEDULED_INVITE path is now handled by the
    // booking_offer case below — both share the same emit/route.

    // 'booking_accepted' (lowercase) is the durable outbox-driven
    // "Helper on the way!" push (notification/service.go); 'BOOKING_ACCEPTED'
    // is the dispatch-cron variant. Same customer-facing toast + feed refresh.
    case 'BOOKING_ACCEPTED':
    case 'booking_accepted': {
      const helperName = data.helper_name ?? 'Your pro';
      showSuccess(`${helperName} has accepted your booking.`, { title: 'Booking confirmed' });
      // Refresh any open booking feed/track screen in addition to the toast.
      if (bookingId) emitShiftEvent({ type: 'booking_status_change', booking_id: bookingId, status: data.status });
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

    // Customer's booking was cancelled (pro/admin cancel) or auto-cancelled by
    // the pending-action sweeper. Toast + refresh the booking feed so the
    // customer isn't left on a stale "searching"/"on the way" screen.
    case 'booking_cancelled':
    case 'BOOKING_AUTO_CANCELLED': {
      showInfo(data.body ?? 'Your booking has been cancelled.', {
        title: data.title ?? 'Booking cancelled',
      });
      if (bookingId) emitShiftEvent({ type: 'booking_status_change', booking_id: bookingId, status: 'cancelled' });
      return;
    }

    case 'refund_processed': {
      showInfo(data.body ?? 'Your refund has been initiated.', {
        title: data.title ?? 'Refund processed',
      });
      if (bookingId) emitShiftEvent({ type: 'booking_status_change', booking_id: bookingId, status: data.status });
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

    case 'zone_approval_rejected': {
      // Pro's out-of-zone go-online request was rejected by an admin.
      // Without this case the pro sat on "Waiting for approval" the whole
      // shift and never saw the admin's notes. The ZoneApproval screen
      // listens for this to clear approvalPendingRef + show the reason.
      emitShiftEvent({
        type: 'zone_approval_rejected',
        request_id: data.request_id,
        commitment_id: data.commitment_id,
        reason: data.reason ?? data.notes ?? data.body,
      });
      return;
    }

    case 'booking_offer':
    case 'SCHEDULED_INVITE': {
      // SCHEDULED_INVITE is the wire name from backend Phase 10; the
      // pro app treats every invite as a booking_offer regardless of
      // whether it's a stealth-instant or scheduled flow.
      if (!bookingId) return;
      const offer = {
        booking_id: bookingId,
        customer_first_name: data.customer_first_name,
        address_summary: data.address_summary,
        task_list_json: data.task_list_json,
        estimated_earnings_paise: data.estimated_earnings_paise ? parseInt(data.estimated_earnings_paise, 10) : undefined,
        estimated_duration_minutes: data.estimated_duration_minutes ? parseInt(data.estimated_duration_minutes, 10) : undefined,
        time_remaining_sec: data.time_remaining_sec ? parseInt(data.time_remaining_sec, 10) : 25,
        received_at_ms: Date.now(),
      };
      emitShiftEvent({ type: 'booking_offer', payload: offer });
      // Background-tap deep-link: navigate to JobOffer screen so the
      // pro lands on it after tapping the notification. The
      // foreground modal listener (in MainNavigator) will also fire
      // on the same emit but is a no-op if the screen is already
      // mounted.
      navigate('JobOffer', { booking_id: bookingId });
      return;
    }

    case 'booking_status_change':
    case 'pro_en_route':
    case 'pro_arrived':
    case 'job_started':
    case 'job_completed':
    // Backend sends 'booking_completed' (notification/service.go); the app's
    // legacy name was 'job_completed'. Alias both so the customer's
    // TrackLive feed refreshes to the completed/review state.
    case 'booking_completed':
    // Pro-side ownership changes — a cancelled / (re|un)assigned booking
    // must refresh the pro's job screens. Without these the pro kept
    // offering En-Route/Arrived/Start on a job they no longer own (or that
    // the customer cancelled) and every tap then errored.
    case 'booking_cancelled_for_pro':
    case 'booking_assigned':
    case 'booking_reassigned':
    case 'booking_unassigned':
    // Customer-side: their pro was swapped (CRM/leave reassign) or the
    // booking was cancelled with no coverage. Refresh the booking feed.
    case 'worker_changed':
    case 'helper_reassigned':
    case 'cancelled_no_coverage': {
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
