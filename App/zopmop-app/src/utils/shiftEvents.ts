// Tiny event bus for shift-system FCM pushes. Screens subscribe; the
// pushRouter (or any caller) calls emit(). Avoids re-importing
// @react-native-firebase/messaging inside individual screens and keeps
// the route-level FCM listener in one place (usePushNotifications).

type ShiftEvent =
  | { type: 'zone_approval_granted'; request_id?: string; commitment_id?: string }
  | { type: 'zone_approval_rejected'; request_id?: string; commitment_id?: string; reason?: string }
  | { type: 'zone_drift_warning'; commitment_id?: string }
  | { type: 'booking_assigned'; booking_id: string }
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
