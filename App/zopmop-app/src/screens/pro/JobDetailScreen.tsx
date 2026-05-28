import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import * as Location from 'expo-location';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import {
  jobArrived,
  jobComplete,
  jobEnRoute,
  jobStart,
  listBookingServices,
  getJobDetail,
  startService,
  completeService,
  skipService,
  fetchCustomerContact,
  type CustomerContact,
  type JobServiceLine,
} from '../../api/jobs';
import { onShiftEvent } from '../../utils/shiftEvents';
import { showError, showInfo, showSuccess } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { startProBookingCancel } from '../../utils/proBookingCancel';
import { t } from '../../i18n';
import { OTPInput } from '../../components/ui/OTPInput';

const ARRIVED_RADIUS_METERS = 100;

interface JobDetail {
  id: string;
  customer_id: string;
  status: string;
  address: string;
  lat: number;
  lng: number;
  // Net amount the customer owes (or paid). Used by 4c to populate the
  // cash banner and the paid/cash chip labels.
  price_paise?: number;
  discount_paise?: number;
  en_route_at?: string | null;
  arrived_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  pro_earnings_paise?: number;
  actual_duration_minutes?: number;
  customer_rating_pending?: boolean;
  // Phase 1 Step 4 — payment + OTP-verification state used to derive
  // the State-A/B/C1/C2/D render branch.
  payment_status?: 'pending' | 'paid' | 'failed' | 'refunded' | null;
  payment_method?: 'cashfree' | 'wallet' | 'cash' | 'cod' | null;
  cash_collected_at?: string | null;
  start_otp_verified_at?: string | null;
  end_otp_verified_at?: string | null;
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const v = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(v));
}

export default function JobDetailScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'JobDetail'>>();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const bookingID = route.params.booking_id;

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [services, setServices] = useState<JobServiceLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gpsNearby, setGpsNearby] = useState(false);
  const [, forceTick] = useState(0);

  // Phase 1 Step 4b — Start OTP entry state. Owned at this level so that
  // a transient state change in renderStateBody (refresh, route param
  // tick) doesn't blow away the digits the pro just typed. Cleared after
  // a successful start; preserved through OTP_INVALID so the pro sees
  // their wrong code in the red boxes and can edit, not retype from
  // scratch.
  const [startOtp, setStartOtp] = useState('');
  const [startOtpError, setStartOtpError] = useState(false);
  const [startOtpLockedOut, setStartOtpLockedOut] = useState(false);

  // Phase 1 Step 4c — End OTP entry state. Same ownership rationale as
  // Start. paymentNotResolved is a NON-error wait state that pivots the
  // panel into a "waiting" copy without flipping the OTP boxes red.
  const [endOtp, setEndOtp] = useState('');
  const [endOtpError, setEndOtpError] = useState(false);
  const [endOtpLockedOut, setEndOtpLockedOut] = useState(false);
  const [endOtpPaymentNotResolved, setEndOtpPaymentNotResolved] = useState(false);
  const completeNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Customer contact cache. Populated lazily on first Call tap, kept for
  // the lifetime of this screen mount. Discarded automatically when the
  // booking transitions to a terminal state (completed/cancelled).
  const [contactCache, setContactCache] = useState<CustomerContact | null>(null);
  const [callBusy, setCallBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        getJobDetail(bookingID),
        listBookingServices(bookingID),
      ]);
      setDetail(d as JobDetail);
      setServices(s);
    } catch (e: any) {
      showError(e?.message ?? t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [bookingID]);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-fetch when backend pushes a status change for this booking.
  useEffect(() => {
    return onShiftEvent((ev) => {
      if (ev.type === 'booking_status_change' && ev.booking_id === bookingID) {
        refresh();
      }
    });
  }, [bookingID, refresh]);

  // Tick every 5s so elapsed-time display updates + GPS-to-customer is
  // re-evaluated while pro is en route.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  // GPS polling for the en-route → arrived gate. Cheap because expo
  // Location is allowed to coalesce reads to the cached fix.
  useEffect(() => {
    if (!detail || !detail.en_route_at || detail.arrived_at) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return;
        const pos = await Location.getLastKnownPositionAsync({ maxAge: 30_000 })
          ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!pos || cancelled || !detail) return;
        const dist = haversineMeters(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          { lat: detail.lat, lng: detail.lng },
        );
        setGpsNearby(dist <= ARRIVED_RADIUS_METERS);
      } catch { /* keep gpsNearby unchanged */ }
    }

    poll();
    timer = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [detail?.en_route_at, detail?.arrived_at, detail?.lat, detail?.lng]);

  // After the booking flips to 'completed', show summary briefly then
  // return to the JobsList.
  useEffect(() => {
    if (detail?.status === 'completed' && !completeNavTimerRef.current) {
      completeNavTimerRef.current = setTimeout(() => {
        if (navigation.canGoBack()) navigation.goBack();
      }, 5000);
    }
    return () => {
      if (completeNavTimerRef.current && detail?.status !== 'completed') {
        clearTimeout(completeNavTimerRef.current);
        completeNavTimerRef.current = null;
      }
    };
  }, [detail?.status, navigation]);

  async function tapEnRoute() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      let lat: number | undefined;
      let lng: number | undefined;
      if (perm.status === 'granted') {
        try {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        } catch { /* lat/lng are optional */ }
      }
      await jobEnRoute(bookingID, lat, lng);
      haptics.success();
      await refresh();
    } catch (e: any) {
      showError(e?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function tapArrived() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        showError(t('dashboard.locationDenied'));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await jobArrived(bookingID, pos.coords.latitude, pos.coords.longitude);
      haptics.success();
      await refresh();
    } catch (e: any) {
      if (e?.code === 'OUTSIDE_ARRIVED_RADIUS') {
        Alert.alert(t('jobDetail.arrivedTooFarTitle'), t('jobDetail.arrivedTooFarBody'));
      } else {
        showError(e?.message ?? t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  }

  // Submit the Start OTP entered by the pro. Replaces the prior
  // Alert.alert("Start service?") confirmation: the OTP itself is the
  // confirmation now, and the backend gates the transition on its
  // verification (Phase 1 Step 1).
  //
  // Error mapping (codes come back via expectOk on the err.code field):
  //   OTP_INVALID            — wrong code. Flip the boxes to red and
  //                            let the pro fix the digits in place. Do
  //                            NOT clear the value or unfocus.
  //   OTP_REQUIRED           — defensive; button is disabled until 6
  //                            digits, so this should never fire from
  //                            the UI. Treat as generic error.
  //   OTP_SERVICE_UNAVAILABLE — backend misconfig. Toast and keep the
  //                            value so the pro can retry.
  //   other                  — generic toast with backend message.
  async function handleStartSubmit() {
    if (!detail || busy || startOtp.length < 6 || startOtpLockedOut) return;
    setBusy(true);
    setStartOtpError(false);
    try {
      await jobStart(bookingID, startOtp);
      haptics.success();
      setStartOtp('');
      setStartOtpLockedOut(false);
      await refresh();
    } catch (e: any) {
      const code = e?.code;
      if (code === 'OTP_INVALID') {
        setStartOtpError(true);
        haptics.error();
      } else if (code === 'OTP_TOO_MANY_ATTEMPTS') {
        // Per docs/phase-1-payment-gated-flow.md: time-honest copy + the
        // State E support link must surface persistently (not toast-only).
        // The panel pivots into a lockout view that promotes the support
        // contact alongside the wait-and-try-again message. The 5-min
        // window self-heals via Redis TTL backend-side; UI doesn't poll
        // a "unlocked yet?" endpoint — pro just retries when ready.
        setStartOtpLockedOut(true);
        setStartOtpError(false);
        haptics.error();
      } else if (code === 'OTP_SERVICE_UNAVAILABLE') {
        showError(t('jobDetail.startOtpServiceUnavailable'));
      } else {
        showError(e?.message ?? t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  }

  // End OTP submission. Reaches the backend gate at
  // POST /pro/jobs/:id/complete which checks (a) the End OTP and (b)
  // payment-resolution (payment_status='paid' OR cash_collected_at).
  // Under normal flow the End OTP only exists post-payment, so
  // PAYMENT_NOT_RESOLVED is RARE — typically a race where TrackLive
  // self-heal re-issued the OTP after a payment-state flip rolled back
  // (very edge-case). Treated as a non-error wait state per the Phase 1
  // plan: pivot the UI to "Waiting for payment to clear" + keep the
  // pro on the screen, do NOT show the OTP-invalid red boxes.
  async function handleEndSubmit() {
    if (!detail || busy || endOtp.length < 6 || endOtpLockedOut) return;
    setBusy(true);
    setEndOtpError(false);
    setEndOtpPaymentNotResolved(false);
    try {
      const res = await jobComplete(bookingID, endOtp);
      haptics.success();
      showSuccess(`₹${Math.round(res.pro_earnings_paise / 100)}`);
      setEndOtp('');
      setEndOtpLockedOut(false);
      await refresh();
    } catch (e: any) {
      const code = e?.code;
      if (code === 'OTP_INVALID') {
        setEndOtpError(true);
        haptics.error();
      } else if (code === 'OTP_TOO_MANY_ATTEMPTS') {
        setEndOtpLockedOut(true);
        setEndOtpError(false);
        haptics.error();
      } else if (code === 'PAYMENT_NOT_RESOLVED') {
        // Non-error: payment didn't land yet. Don't redden the boxes.
        setEndOtpPaymentNotResolved(true);
        // Do not clear the typed digits; the pro can resubmit once the
        // refresh below shows the payment flipped to paid.
      } else if (code === 'OTP_SERVICE_UNAVAILABLE') {
        showError(t('jobDetail.endOtpServiceUnavailable'));
      } else {
        showError(e?.message ?? t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  }

  // tel:${SUPPORT_PHONE} matches the existing pattern in
  // ProProfileScreen.tsx / ZoneApprovalRequestScreen.tsx. Booking ID is
  // surfaced near the link (rendered in the panel) so the pro can read
  // it to support during the call — there's no pre-fill mechanism for a
  // tel: URI. The State E screen (Step 4d) will surface the booking ID
  // more prominently; for 4c the panel's existing header is enough.
  function tapContactSupport() {
    const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '+918000000000';
    const tel = `tel:${SUPPORT_PHONE}`;
    Linking.canOpenURL(tel).then((ok) => {
      if (ok) Linking.openURL(tel).catch(() => { /* ignore */ });
    });
  }

  // tapStart kept as a no-op shim so renderStateBody's RenderArgs type
  // does not need to change in 4b. State A no longer uses it; the OTP
  // submit IS the start trigger. Removable in 4c when the in_progress
  // branch is split into C1/C2/D.
  function tapStart() {}

  function tapFinish() {
    // Step 4c wires this through the End OTP entry — the Finish button
    // is hidden in State B for 4b (renderStateBody returns the
    // awaiting-payment placeholder instead). Keeping the function shell
    // so RenderArgs doesn't change shape; the empty-string OTP arg
    // would always 400 OTP_REQUIRED if this somehow fired.
    Alert.alert(t('jobDetail.finishConfirmTitle'), t('jobDetail.finishConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('jobDetail.finishJob'),
        onPress: async () => {
          if (!detail || busy) return;
          setBusy(true);
          try {
            // Step 4c: replace '' with the End OTP digits entered by
            // the pro on the State D panel.
            const res = await jobComplete(bookingID, '');
            haptics.success();
            showSuccess(`₹${Math.round(res.pro_earnings_paise / 100)}`);
            await refresh();
          } catch (e: any) {
            showError(e?.message ?? t('common.error'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  async function tapServiceStart(s: JobServiceLine) {
    if (busy) return;
    setBusy(true);
    try {
      await startService(bookingID, s.id);
      await refresh();
    } catch (e: any) {
      showError(e?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function tapServiceComplete(s: JobServiceLine) {
    if (busy) return;
    setBusy(true);
    try {
      await completeService(bookingID, s.id);
      haptics.light();
      await refresh();
    } catch (e: any) {
      showError(e?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  function tapServiceSkip(s: JobServiceLine) {
    Alert.prompt
      ? // iOS supports Alert.prompt for free-text input
        Alert.prompt(
          t('jobDetail.skipReasonTitle'),
          undefined,
          async (reason: string) => {
            try {
              await skipService(bookingID, s.id, reason ?? '');
              await refresh();
            } catch (e: any) {
              showError(e?.message ?? t('common.error'));
            }
          },
        )
      : (async () => {
          // Android fallback: skip without a reason.
          try {
            await skipService(bookingID, s.id, '');
            await refresh();
          } catch (e: any) {
            showError(e?.message ?? t('common.error'));
          }
        })();
  }

  // Status set that the server-side guard allows. Keep this in sync with
  // the backend RevealCustomerContact switch — drift means the button
  // looks tappable but the request 409s.
  const callAllowedStatuses = ['accepted', 'in_progress', 'arrived'];
  const callEnabled =
    !!detail &&
    !callBusy &&
    callAllowedStatuses.includes(detail.status);

  // Drop the cached contact when the booking enters a terminal state so
  // a re-entry into JobDetail (rare but possible via deep link) doesn't
  // reuse stale data after the privacy window has closed.
  useEffect(() => {
    if (!detail) return;
    if (detail.status === 'completed' || detail.status === 'cancelled') {
      setContactCache(null);
    }
  }, [detail?.status]);

  async function tapCallCustomer() {
    if (!detail || !callEnabled) return;
    // Cached: dial immediately.
    if (contactCache?.customer_phone) {
      Linking.openURL(`tel:${contactCache.customer_phone}`).catch(() => {});
      return;
    }
    setCallBusy(true);
    try {
      const contact = await fetchCustomerContact(bookingID);
      setContactCache(contact);
      if (!contact.customer_phone) {
        showError(t('jobDetail.callUnavailable'));
        return;
      }
      Linking.openURL(`tel:${contact.customer_phone}`).catch(() => {});
    } catch (e: any) {
      const status = e?.status;
      if (status === 403 || status === 409) {
        showError(t('jobDetail.callUnavailable'));
      } else {
        showError(t('jobDetail.callNetworkError'));
      }
    } finally {
      setCallBusy(false);
    }
  }

  function navigateInMaps() {
    if (!detail) return;
    const lat = detail.lat;
    const lng = detail.lng;
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${lat},${lng}`,
      default: `geo:${lat},${lng}?q=${lat},${lng}`,
    });
    if (url) Linking.openURL(url).catch(() => { /* ignore */ });
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.center}><ActivityIndicator color={c.accent} /></View>
      </SafeAreaView>
    );
  }

  if (!detail) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.center}><Text style={{ color: c.text }}>{t('common.error')}</Text></View>
      </SafeAreaView>
    );
  }

  const stepLabel = (() => {
    if (detail.status === 'completed') return t('jobDetail.headerStepCompleted');
    if (detail.status === 'in_progress') return t('jobDetail.headerStepInProgress');
    if (detail.arrived_at) return t('jobDetail.headerStepArrived');
    if (detail.en_route_at) return t('jobDetail.headerStepEnRoute');
    return t('jobDetail.headerStepAccepted');
  })();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ padding: 4 }}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.stepIndicator}>{stepLabel}</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.addressCard}>
          <Text style={styles.address}>{detail.address}</Text>
          <View style={styles.iconRow}>
            <TouchableOpacity style={styles.iconBtn} onPress={navigateInMaps}>
              <Feather name="navigation" size={16} color={c.accent} />
              <Text style={styles.iconBtnText}>{t('jobDetail.navigate')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconBtn, !callEnabled && { opacity: 0.5 }]}
              onPress={tapCallCustomer}
              disabled={!callEnabled}
            >
              {callBusy ? (
                <ActivityIndicator size="small" color={c.accent} />
              ) : (
                <Feather name="phone" size={16} color={callEnabled ? c.accent : c.text} />
              )}
              <Text style={styles.iconBtnText}>{t('jobDetail.call')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {detail.arrived_at && !detail.started_at && detail.status === 'accepted' ? (
          <StartOtpPanel
            c={c}
            styles={styles}
            busy={busy}
            value={startOtp}
            error={startOtpError}
            lockedOut={startOtpLockedOut}
            onChange={(v) => {
              // Clear the error state the moment the pro edits a digit so
              // the red boxes don't persist across the next attempt.
              if (startOtpError) setStartOtpError(false);
              // Editing under lockout doesn't clear lockout — only TIME
              // does. The lockout view stays until the pro submits and
              // the 5-min Redis TTL has lapsed (then the next submit
              // gets an honest mismatch response, not 429).
              setStartOtp(v);
            }}
            onSubmit={handleStartSubmit}
            onContactSupport={tapContactSupport}
            bookingID={bookingID}
          />
        ) : detail.status === 'in_progress' ? (
          <InProgressBody
            detail={detail}
            services={services}
            c={c}
            styles={styles}
            busy={busy}
            endOtp={endOtp}
            endOtpError={endOtpError}
            endOtpLockedOut={endOtpLockedOut}
            endOtpPaymentNotResolved={endOtpPaymentNotResolved}
            onEndOtpChange={(v) => {
              if (endOtpError) setEndOtpError(false);
              if (endOtpPaymentNotResolved) setEndOtpPaymentNotResolved(false);
              setEndOtp(v);
            }}
            onEndSubmit={handleEndSubmit}
            onContactSupport={tapContactSupport}
            bookingID={bookingID}
            onServiceStart={tapServiceStart}
            onServiceComplete={tapServiceComplete}
            onServiceSkip={tapServiceSkip}
          />
        ) : (
          renderStateBody(detail, services, {
            c, styles, busy, gpsNearby,
            tapEnRoute, tapArrived, tapStart, tapFinish,
            tapServiceStart, tapServiceComplete, tapServiceSkip,
            onCancelBooking: () =>
              startProBookingCancel({
                bookingId: bookingID,
                estimatedJobMinutes: undefined,
                onCancelled: () => navigation.goBack(),
              }),
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// StartOtpPanel — State A from the Phase 1 Step 4 mockup.
//
// Pro reads the 6-digit code off the customer's TrackLive screen and
// types it here. Submit is gated on 6 digits + non-error + non-busy +
// non-lockedOut. On OTP_INVALID the parent flips error=true; this
// component renders the red boxes + the err-helper line + the "Try
// again" CTA. On OTP_TOO_MANY_ATTEMPTS the parent flips lockedOut=true
// and the panel pivots into a lockout view that promotes the support
// contact and presents the time-honest message (no "reload" mention —
// see docs/phase-1-payment-gated-flow.md).
function StartOtpPanel({
  c, styles, busy, value, error, lockedOut, onChange, onSubmit, onContactSupport, bookingID,
}: {
  c: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  value: string;
  error: boolean;
  lockedOut: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onContactSupport: () => void;
  bookingID: string;
}) {
  const ready = value.length === 6 && !error && !lockedOut && !busy;
  return (
    <View style={styles.actionZone}>
      <Text style={styles.otpLabel}>{t('jobDetail.startOtpLabel')}</Text>
      <OTPInput
        length={6}
        value={value}
        onChange={onChange}
        error={error || lockedOut}
        disabled={busy || lockedOut}
        autoFocus={!lockedOut}
      />
      {lockedOut ? (
        <LockoutNotice styles={styles} />
      ) : (
        <Text style={[styles.otpHelper, error && { color: '#F87171' }]}>
          {error ? t('jobDetail.startOtpHelperError') : t('jobDetail.startOtpHelper')}
        </Text>
      )}
      <TouchableOpacity
        style={[styles.primaryBtn, !ready && styles.primaryBtnDisabled]}
        onPress={onSubmit}
        disabled={!ready}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#0D0D0F" />
        ) : (
          <Text style={styles.primaryBtnText}>
            {lockedOut
              ? t('jobDetail.startService')
              : error
                ? t('jobDetail.startOtpTryAgain')
                : t('jobDetail.startService')}
          </Text>
        )}
      </TouchableOpacity>
      <ContactSupportLink
        styles={styles}
        prominent={lockedOut}
        onPress={onContactSupport}
        bookingID={bookingID}
      />
    </View>
  );
}

// InProgressBody — branches between B / C1-pending / D-paid / D-cash
// based on the booking row's payment + cash fields. The pro never sets
// any of these (the customer's resolve-cash and the Cashfree webhook
// do); this body is read-only modulo the End OTP submit.
//
// Derivation precedence (cash and paid are mutually exclusive by
// design but we evaluate paid first for safety):
//   payment_status === 'paid'           -> D-paid  (green chip + OTP)
//   cash_collected_at != null           -> D-cash  (amber chip + OTP)
//   payment_method === 'cashfree'       -> C1-pending (banner + locked card)
//   otherwise                           -> B (awaiting-payment placeholder)
function InProgressBody({
  detail, services, c, styles, busy,
  endOtp, endOtpError, endOtpLockedOut, endOtpPaymentNotResolved,
  onEndOtpChange, onEndSubmit, onContactSupport, bookingID,
  onServiceStart, onServiceComplete, onServiceSkip,
}: {
  detail: JobDetail;
  services: JobServiceLine[];
  c: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  endOtp: string;
  endOtpError: boolean;
  endOtpLockedOut: boolean;
  endOtpPaymentNotResolved: boolean;
  onEndOtpChange: (v: string) => void;
  onEndSubmit: () => void;
  onContactSupport: () => void;
  bookingID: string;
  onServiceStart: (s: JobServiceLine) => void;
  onServiceComplete: (s: JobServiceLine) => void;
  onServiceSkip: (s: JobServiceLine) => void;
}) {
  const elapsedMin = detail.started_at
    ? Math.max(0, Math.floor((Date.now() - new Date(detail.started_at).getTime()) / 60_000))
    : 0;
  const netPaise = (detail.price_paise ?? 0) - (detail.discount_paise ?? 0);
  const amount = Math.round(netPaise / 100);

  const isPaidOnline = detail.payment_status === 'paid';
  const isCashCollected = !!detail.cash_collected_at;
  const isCashfreePending =
    !isPaidOnline &&
    !isCashCollected &&
    detail.payment_method === 'cashfree';

  // The End-OTP entry surfaces whenever payment has resolved (paid
  // online OR cash collected). Backend's IssueEndOTP is also gated
  // there, so this matches reality: the customer's TrackLive only
  // surfaces a Peek-able End OTP after one of those two flags flips.
  const showEndOtpEntry = isPaidOnline || isCashCollected;
  const payChipKind: 'paid' | 'cash' | null = isPaidOnline
    ? 'paid'
    : isCashCollected
      ? 'cash'
      : null;

  return (
    <>
      <View style={styles.elapsedCard}>
        <Text style={styles.elapsedLabel}>{t('jobDetail.elapsedLabel')}</Text>
        <Text style={styles.elapsedValue}>{elapsedMin} min</Text>
      </View>
      <View style={styles.taskList}>
        {services.map((s) => (
          <ServiceRow
            key={s.id}
            service={s}
            colors={c}
            styles={styles}
            busy={busy}
            onStart={() => onServiceStart(s)}
            onComplete={() => onServiceComplete(s)}
            onSkip={() => onServiceSkip(s)}
          />
        ))}
      </View>

      {isCashCollected && !isPaidOnline && (
        // C2 banner — bold amber Collect cash. Stays VISIBLE alongside
        // the End OTP entry below so the pro keeps the cash-collection
        // task visible while typing the code.
        <CashCollectBanner amount={amount} styles={styles} />
      )}

      {isCashfreePending && (
        <OnlinePaymentPendingBanner styles={styles} />
      )}

      {showEndOtpEntry && payChipKind && (
        <View style={styles.actionZone}>
          <PayChip kind={payChipKind} amount={amount} styles={styles} />
          <Text style={styles.otpLabel}>{t('jobDetail.endOtpLabel')}</Text>
          <OTPInput
            length={6}
            value={endOtp}
            onChange={onEndOtpChange}
            error={endOtpError || endOtpLockedOut}
            disabled={busy || endOtpLockedOut}
            autoFocus={!endOtpLockedOut}
          />
          {endOtpLockedOut ? (
            <LockoutNotice styles={styles} />
          ) : endOtpPaymentNotResolved ? (
            <View style={styles.payNotResolvedNotice}>
              <Text style={styles.payNotResolvedTitle}>
                {t('jobDetail.paymentNotResolvedTitle')}
              </Text>
              <Text style={styles.payNotResolvedSub}>
                {t('jobDetail.paymentNotResolvedSub')}
              </Text>
            </View>
          ) : (
            <Text style={[styles.otpHelper, endOtpError && { color: '#F87171' }]}>
              {endOtpError ? t('jobDetail.endOtpHelperError') : t('jobDetail.endOtpHelper')}
            </Text>
          )}
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              (endOtp.length < 6 || endOtpError || endOtpLockedOut || busy) && styles.primaryBtnDisabled,
            ]}
            onPress={onEndSubmit}
            disabled={endOtp.length < 6 || endOtpError || endOtpLockedOut || busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#0D0D0F" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {endOtpError
                  ? t('jobDetail.endOtpTryAgain')
                  : t('jobDetail.completeJob')}
              </Text>
            )}
          </TouchableOpacity>
          <ContactSupportLink
            styles={styles}
            prominent={endOtpLockedOut}
            onPress={onContactSupport}
            bookingID={bookingID}
          />
        </View>
      )}

      {!showEndOtpEntry && !isCashfreePending && (
        <View style={styles.awaitingPaymentCard}>
          <Text style={styles.awaitingPaymentTitle}>{t('jobDetail.awaitingPaymentTitle')}</Text>
          <Text style={styles.awaitingPaymentSub}>{t('jobDetail.awaitingPaymentSub')}</Text>
        </View>
      )}
    </>
  );
}

// PayChip — small pill at the top of the End OTP entry indicating how
// the customer paid. Visual tokens from .pay-chip in the mockup.
function PayChip({ kind, amount, styles }: { kind: 'paid' | 'cash'; amount: number; styles: ReturnType<typeof createStyles> }) {
  const isPaid = kind === 'paid';
  const bg = isPaid ? 'rgba(34,197,94,0.14)' : 'rgba(245,163,0,0.14)';
  const border = isPaid ? 'rgba(34,197,94,0.28)' : 'rgba(245,163,0,0.28)';
  const color = isPaid ? '#22C55E' : '#F5A300';
  const icon = isPaid ? 'check-circle' : 'credit-card';
  const label = isPaid
    ? t('jobDetail.payChipPaidOnline').replace('{amount}', String(amount))
    : t('jobDetail.payChipCash').replace('{amount}', String(amount));
  return (
    <View style={[styles.payChip, { backgroundColor: bg, borderColor: border }]}>
      <Feather name={icon as any} size={13} color={color} />
      <Text style={[styles.payChipText, { color }]}>{label}</Text>
    </View>
  );
}

// CashCollectBanner — prominent amber gradient banner (State C2 in the
// mockup). Read-only: pro taps NOTHING here. The cash amount is the
// booking's net price (amount_paise - discount_paise).
function CashCollectBanner({ amount, styles }: { amount: number; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.cashBanner}>
      <View style={styles.cashBannerIcon}>
        <Feather name="credit-card" size={22} color="#0D0D0F" />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.cashBannerTitle}>
          {t('jobDetail.c2CashTitle').replace('{amount}', String(amount))}
        </Text>
        <Text style={styles.cashBannerSub}>{t('jobDetail.c2CashSub')}</Text>
      </View>
    </View>
  );
}

// OnlinePaymentPendingBanner — State C1 pending. Customer initiated
// Cashfree but the webhook hasn't flipped payment_status='paid' yet.
// Spinner indicates an in-flight payment; the locked-end-OTP card
// reinforces that the next gate is payment confirmation.
function OnlinePaymentPendingBanner({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <>
      <View style={styles.pendingBanner}>
        <View style={styles.pendingBannerIcon}>
          <ActivityIndicator size="small" color="#F5A300" />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.pendingBannerTitle}>{t('jobDetail.c1PendingTitle')}</Text>
          <Text style={styles.pendingBannerSub}>{t('jobDetail.c1PendingSub')}</Text>
        </View>
      </View>
      <View style={styles.lockedEndCard}>
        <Feather name="lock" size={16} color="rgba(13,13,15,0.4)" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.lockedEndTitle}>{t('jobDetail.c1LockedTitle')}</Text>
          <Text style={styles.lockedEndSub}>{t('jobDetail.c1LockedSub')}</Text>
        </View>
      </View>
    </>
  );
}

// LockoutNotice — replaces the otp-helper line under OTP_TOO_MANY_ATTEMPTS.
// Time-honest copy: no mention of TrackLive reload (Peek returns the
// same code; reload would mislead).
function LockoutNotice({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.lockoutNotice}>
      <Text style={styles.lockoutTitle}>{t('jobDetail.otpLockoutTitle')}</Text>
      <Text style={styles.lockoutSub}>{t('jobDetail.otpLockoutSub')}</Text>
    </View>
  );
}

// ContactSupportLink — subtle by default, promoted (boxed) when the
// pro is locked out. Uses tel:${SUPPORT_PHONE} per the existing pattern
// in ProProfileScreen + ZoneApprovalRequestScreen. Booking ID is shown
// so the pro can dictate it to support on the call (no pre-fill on
// tel: URIs).
function ContactSupportLink({
  styles, prominent, onPress, bookingID,
}: {
  styles: ReturnType<typeof createStyles>;
  prominent: boolean;
  onPress: () => void;
  bookingID: string;
}) {
  if (prominent) {
    return (
      <TouchableOpacity style={styles.contactSupportProminent} onPress={onPress}>
        <Feather name="phone" size={16} color="#F5A300" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.contactSupportProminentTitle}>
            {t('jobDetail.contactSupport')}
          </Text>
          <Text style={styles.contactSupportProminentBookingID}>
            Booking #{bookingID.slice(0, 8)}
          </Text>
        </View>
        <Feather name="chevron-right" size={16} color="rgba(245,163,0,0.6)" />
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity style={styles.contactSupportSubtle} onPress={onPress}>
      <Feather name="help-circle" size={13} color="rgba(255,255,255,0.5)" />
      <Text style={styles.contactSupportSubtleText}>
        {t('jobDetail.contactSupportPrompt')}
      </Text>
    </TouchableOpacity>
  );
}

interface RenderArgs {
  c: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  gpsNearby: boolean;
  tapEnRoute: () => void;
  tapArrived: () => void;
  tapStart: () => void;
  tapFinish: () => void;
  tapServiceStart: (s: JobServiceLine) => void;
  tapServiceComplete: (s: JobServiceLine) => void;
  tapServiceSkip: (s: JobServiceLine) => void;
  onCancelBooking: () => void;
}

function renderStateBody(detail: JobDetail, services: JobServiceLine[], args: RenderArgs) {
  const { c, styles, busy, gpsNearby } = args;

  // Completed — summary.
  if (detail.status === 'completed') {
    return (
      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{t('jobDetail.summaryDuration')}</Text>
          <Text style={styles.summaryValue}>
            {detail.actual_duration_minutes ?? 0}min
          </Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{t('jobDetail.summaryServices')}</Text>
          <Text style={styles.summaryValue}>{services.length}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{t('jobDetail.summaryEarnings')}</Text>
          <Text style={[styles.summaryValue, { color: c.accent }]}>
            ₹{Math.round((detail.pro_earnings_paise ?? 0) / 100)}
          </Text>
        </View>
        {detail.customer_rating_pending && (
          <Text style={styles.awaiting}>{t('jobDetail.awaitingRating')}</Text>
        )}
      </View>
    );
  }

  // In-progress is rendered INLINE by InProgressBody in the main
  // JobDetailScreen return so the End OTP state + handlers can live
  // alongside the rest of the screen's state. Reaching this branch
  // would mean the main return guard misfired; defensive null return
  // avoids rendering stale 4b copy if it ever does.
  if (detail.status === 'in_progress') {
    return null;
  }

  // Arrived — State A is rendered INLINE in JobDetailScreen (not here)
  // because it owns the OTP input state. Reaching this branch means
  // arrived_at is set but the State A panel rendered upstream; fall
  // through to the en-route default below for safety.
  if (detail.arrived_at && detail.started_at) {
    // Defensive: arrived + started should land us in the in_progress
    // branch above; if we get here something's stale, render nothing.
    return null;
  }

  // En route — arrived gate.
  if (detail.en_route_at) {
    return (
      <>
        <TouchableOpacity
          style={[styles.primaryBtn, (!gpsNearby || busy) && { opacity: 0.5 }]}
          onPress={args.tapArrived}
          disabled={!gpsNearby || busy}
        >
          <Text style={styles.primaryBtnText}>{t('jobDetail.iveArrived')}</Text>
        </TouchableOpacity>
        {!gpsNearby && (
          <Text style={styles.helperText}>{t('jobDetail.arrivedDisabled')}</Text>
        )}
        <TouchableOpacity style={styles.cancelLink} onPress={args.onCancelBooking}>
          <Text style={styles.cancelLinkText}>{t('jobDetail.cancelJob')}</Text>
        </TouchableOpacity>
      </>
    );
  }

  // Default: accepted, not yet en-route.
  return (
    <>
      <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.5 }]} onPress={args.tapEnRoute} disabled={busy}>
        <Text style={styles.primaryBtnText}>{t('jobDetail.onMyWay')}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.cancelLink} onPress={args.onCancelBooking}>
        <Text style={styles.cancelLinkText}>{t('jobDetail.cancelJob')}</Text>
      </TouchableOpacity>
    </>
  );
}

function ServiceRow({
  service, colors, styles, busy, onStart, onComplete, onSkip,
}: {
  service: JobServiceLine;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const isCompleted = service.status === 'completed';
  const isSkipped = service.status === 'skipped';
  const isStruck = isCompleted || isSkipped;

  return (
    <View style={styles.serviceRow}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[styles.serviceName, isStruck && styles.serviceStruck]}>
          {service.duration_minutes}min · {service.quantity}×
        </Text>
        {isSkipped && (
          <Text style={styles.skippedTag}>{t('jobDetail.serviceSkippedLabel')}</Text>
        )}
      </View>
      {isCompleted && <Feather name="check-circle" size={20} color={colors.success} />}
      {!isStruck && service.status === 'pending' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            style={styles.servicePrimary}
            onPress={onStart}
            disabled={busy}
          >
            <Text style={styles.servicePrimaryText}>{t('jobDetail.serviceStart')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.serviceSkipBtn} onPress={onSkip} disabled={busy}>
            <Text style={styles.serviceSkipText}>{t('jobDetail.serviceSkip')}</Text>
          </TouchableOpacity>
        </View>
      )}
      {service.status === 'in_progress' && (
        <TouchableOpacity style={styles.servicePrimary} onPress={onComplete} disabled={busy}>
          <Text style={styles.servicePrimaryText}>{t('jobDetail.serviceDone')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: Spacing.base, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    stepIndicator: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.accent },
    scroll: { padding: Spacing.lg, gap: Spacing.base, paddingBottom: Spacing['3xl'] },
    addressCard: {
      padding: Spacing.lg, backgroundColor: c.surface,
      borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border, gap: Spacing.base,
    },
    address: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text },
    iconRow: { flexDirection: 'row', gap: Spacing.base },
    iconBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm,
      borderWidth: 1, borderColor: c.border, borderRadius: Radius.full,
    },
    iconBtnText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.text },
    primaryBtn: { backgroundColor: c.accent, borderRadius: Radius.lg, paddingVertical: Spacing.base, alignItems: 'center' },
    primaryBtnText: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: '#1a1a1a' },
    primaryBtnDisabled: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    // Phase 1 Step 4b — action zone wraps the OTP entry + helper + CTA.
    actionZone: {
      padding: Spacing.lg,
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      gap: Spacing.base,
    },
    otpLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      textAlign: 'center',
    },
    otpHelper: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      textAlign: 'center',
    },
    // Phase 1 Step 4b — pre-payment placeholder in State B. Replaced by
    // the payment-method banner + End OTP entry in Step 4c.
    awaitingPaymentCard: {
      padding: Spacing.lg,
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      gap: 4,
      alignItems: 'center',
    },
    awaitingPaymentTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    awaitingPaymentSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    // Phase 1 Step 4c — payment status visuals.
    // PayChip — small pill at the top of the End OTP entry.
    payChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 99,
      borderWidth: 1,
      alignSelf: 'flex-start',
      marginBottom: 4,
    },
    payChipText: { fontFamily: FontFamily.bold, fontSize: 12 },
    // CashCollectBanner — bold amber. Background uses a flat amber per
    // the mockup gradient's midpoint (#F5A300) since RN's StyleSheet
    // doesn't natively support gradients without an extra dep, and the
    // hard rule on this step is no new deps. Visual difference vs the
    // gradient is small enough that it doesn't compromise the "this is
    // the urgent state" affordance.
    cashBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 16,
      borderRadius: 16,
      backgroundColor: '#F5A300',
    },
    cashBannerIcon: {
      width: 42,
      height: 42,
      borderRadius: 12,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    cashBannerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#0D0D0F' },
    cashBannerSub: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: 'rgba(13,13,15,0.7)' },
    // Pending banner — amber soft (matches .pay-banner.pending in the
    // mockup), spinner inside the icon circle.
    pendingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 16,
      borderRadius: 16,
      backgroundColor: 'rgba(245,163,0,0.08)',
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.20)',
    },
    pendingBannerIcon: {
      width: 42,
      height: 42,
      borderRadius: 12,
      backgroundColor: 'rgba(245,163,0,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingBannerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#F5A300' },
    pendingBannerSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    // Locked End OTP card — dashed-border placeholder. Lives only in C1
    // pending. Once payment_status='paid' the parent renders the real
    // End OTP entry instead.
    lockedEndCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: c.border,
    },
    lockedEndTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    lockedEndSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    // Lockout notice — replaces helper text under the OTP boxes when
    // OTP_TOO_MANY_ATTEMPTS fires. Time-honest copy; no reload mention.
    lockoutNotice: {
      padding: 12,
      borderRadius: 10,
      backgroundColor: 'rgba(248,113,113,0.08)',
      borderWidth: 1,
      borderColor: 'rgba(248,113,113,0.24)',
      gap: 4,
    },
    lockoutTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.sm,
      color: '#F87171',
      textAlign: 'center',
    },
    lockoutSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textSecondary,
      textAlign: 'center',
    },
    // PAYMENT_NOT_RESOLVED — non-error wait state. Uses amber, not red.
    payNotResolvedNotice: {
      padding: 12,
      borderRadius: 10,
      backgroundColor: 'rgba(245,163,0,0.06)',
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.20)',
      gap: 4,
    },
    payNotResolvedTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.sm,
      color: '#F5A300',
      textAlign: 'center',
    },
    payNotResolvedSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textSecondary,
      textAlign: 'center',
    },
    // Contact support — subtle (idle) + prominent (lockout) variants.
    contactSupportSubtle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: Spacing.sm,
    },
    contactSupportSubtleText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textSecondary },
    contactSupportProminent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: 'rgba(245,163,0,0.10)',
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.30)',
    },
    contactSupportProminentTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#F5A300',
    },
    contactSupportProminentBookingID: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textSecondary,
    },
    helperText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    cancelLink: { paddingVertical: Spacing.sm, alignItems: 'center' },
    cancelLinkText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.danger },
    elapsedCard: {
      padding: Spacing.lg, backgroundColor: c.surface, borderRadius: Radius.lg,
      borderWidth: 1, borderColor: c.border, alignItems: 'center',
    },
    elapsedLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    elapsedValue: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text },
    taskList: { backgroundColor: c.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
    serviceRow: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.base,
      padding: Spacing.base, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    serviceName: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text },
    serviceStruck: { textDecorationLine: 'line-through', color: c.textMuted },
    skippedTag: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },
    servicePrimary: { backgroundColor: c.accent, paddingHorizontal: Spacing.base, paddingVertical: 6, borderRadius: Radius.md },
    servicePrimaryText: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: '#1a1a1a' },
    serviceSkipBtn: { paddingHorizontal: Spacing.base, paddingVertical: 6, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border },
    serviceSkipText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textSecondary },
    summaryCard: {
      padding: Spacing.lg, backgroundColor: c.surface, borderRadius: Radius.lg,
      borderWidth: 1, borderColor: c.border, gap: Spacing.sm,
    },
    summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    summaryLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    summaryValue: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    awaiting: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.accent, textAlign: 'center', marginTop: Spacing.sm },
  });
}
