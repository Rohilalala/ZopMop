// Tiny event bus for shift-system FCM pushes. Screens subscribe; the
// pushRouter (or any caller) calls emit(). Avoids re-importing
// @react-native-firebase/messaging inside individual screens and keeps
// the route-level FCM listener in one place (usePushNotifications).

export interface OfferPayload {
  booking_id: string;
  customer_first_name?: string;
  address_summary?: string;
  task_list_json?: string;
  estimated_earnings_paise?: number;
  estimated_duration_minutes?: number;
  time_remaining_sec?: number;
  /** Wall-clock epoch ms when the offer push was received locally —
   *  used by the offer screen to derive a live countdown without
   *  relying on the device clock vs. server clock. */
  received_at_ms: number;
}

type ShiftEvent =
  | { type: 'zone_approval_granted'; request_id?: string; commitment_id?: string }
  | { type: 'zone_drift_warning'; commitment_id?: string }
  | { type: 'booking_offer'; payload: OfferPayload }
  | { type: 'booking_status_change'; booking_id: string; status?: string };

type Listener = (ev: ShiftEvent) => void;

const listeners = new Set<Listener>();

export function emitShiftEvent(ev: ShiftEvent) {
  listeners.forEach((fn) => {
    try { fn(ev); } catch { /* keep going */ }
  });
}

export function onShiftEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
