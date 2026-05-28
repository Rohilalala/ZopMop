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
    if (!detail || busy || startOtp.length < 6) return;
    setBusy(true);
    setStartOtpError(false);
    try {
      await jobStart(bookingID, startOtp);
      haptics.success();
      setStartOtp('');
      await refresh();
    } catch (e: any) {
      const code = e?.code;
      if (code === 'OTP_INVALID') {
        setStartOtpError(true);
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
            onChange={(v) => {
              // Clear the error state the moment the pro edits a digit so
              // the red boxes don't persist across the next attempt.
              if (startOtpError) setStartOtpError(false);
              setStartOtp(v);
            }}
            onSubmit={handleStartSubmit}
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
// types it here. Submit is gated on 6 digits + non-error + non-busy.
// On OTP_INVALID, the parent flips error=true; this component renders
// the red boxes + the err-helper line + the "Try again" button label.
// The pro can edit any box to retry — they don't have to clear first
// (onChange in the parent clears the error on the first edit).
function StartOtpPanel({
  c, styles, busy, value, error, onChange, onSubmit,
}: {
  c: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  value: string;
  error: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const ready = value.length === 6 && !error && !busy;
  return (
    <View style={styles.actionZone}>
      <Text style={styles.otpLabel}>{t('jobDetail.startOtpLabel')}</Text>
      <OTPInput
        length={6}
        value={value}
        onChange={onChange}
        error={error}
        disabled={busy}
        autoFocus
      />
      <Text style={[styles.otpHelper, error && { color: '#F87171' }]}>
        {error ? t('jobDetail.startOtpHelperError') : t('jobDetail.startOtpHelper')}
      </Text>
      <TouchableOpacity
        style={[styles.primaryBtn, !ready && styles.primaryBtnDisabled]}
        onPress={onSubmit}
        disabled={!ready}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#0D0D0F" />
        ) : (
          <Text style={styles.primaryBtnText}>
            {error ? t('jobDetail.startOtpTryAgain') : t('jobDetail.startService')}
          </Text>
        )}
      </TouchableOpacity>
    </View>
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

  // In progress — State B. The mockup-spec'd payment-method banner
  // (C1 pending / C1 paid / C2 cash) + End-OTP entry (D) replace the
  // "Finish job" button in Step 4c. For 4b the screen shows the
  // pre-payment placeholder so the pro sees the service is live and
  // knows payment is the next gate.
  if (detail.status === 'in_progress') {
    const elapsedMin = detail.started_at
      ? Math.max(0, Math.floor((Date.now() - new Date(detail.started_at).getTime()) / 60_000))
      : 0;
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
              onStart={() => args.tapServiceStart(s)}
              onComplete={() => args.tapServiceComplete(s)}
              onSkip={() => args.tapServiceSkip(s)}
            />
          ))}
        </View>
        {/* Step 4b placeholder. Step 4c replaces this with the
            payment-method banner (pending/paid/cash) + End OTP entry. */}
        <View style={styles.awaitingPaymentCard}>
          <Text style={styles.awaitingPaymentTitle}>{t('jobDetail.awaitingPaymentTitle')}</Text>
          <Text style={styles.awaitingPaymentSub}>{t('jobDetail.awaitingPaymentSub')}</Text>
        </View>
      </>
    );
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
