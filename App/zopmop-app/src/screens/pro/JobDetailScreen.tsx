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
  jobCollectCash,
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
import { friendlyError } from '../../utils/errors';
import { useLocationPublisher } from '../../hooks/useLocationPublisher';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { OtpSheet } from '../../components/OtpSheet';
import { t, useLocale } from '../../i18n';

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
  payment_status?: string;
  payment_method?: string;
  price_paise?: number;
  discount_paise?: number;
  wallet_applied_paise?: number;
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
  useLocale(); // live-update strings on language change
  useProRoleGate();
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
  const completeNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Customer contact cache. Populated lazily on first Call tap, kept for
  // the lifetime of this screen mount. Discarded automatically when the
  // booking transitions to a terminal state (completed/cancelled).
  const [contactCache, setContactCache] = useState<CustomerContact | null>(null);
  const [callBusy, setCallBusy] = useState(false);

  // OTP entry sheet (start | finish) + payment state for the completion gate.
  const [otpMode, setOtpMode] = useState<null | 'start' | 'finish'>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const isPaid = detail?.payment_status === 'paid';
  const outstandingPaise = detail
    ? Math.max(
        0,
        (detail.price_paise ?? 0) - (detail.discount_paise ?? 0) - (detail.wallet_applied_paise ?? 0),
      )
    : 0;
  const outstandingRupees = (outstandingPaise / 100).toFixed(0);

  // Stream live GPS to /location/ws once the pro is en-route, through the job,
  // until it ends. This is the only path that feeds the customer's live map
  // and the CRM live-pins map during a job — the one-shot en-route/arrived
  // stamps alone left the pro frozen at their go-online position.
  const isStreaming =
    !!detail?.en_route_at &&
    detail?.status !== 'completed' &&
    detail?.status !== 'cancelled';
  useLocationPublisher(isStreaming);

  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        getJobDetail(bookingID),
        listBookingServices(bookingID),
      ]);
      setDetail(d as JobDetail);
      setServices(s);
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t load this job. Pull to refresh or try again.'));
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

  // While the job is in progress but unpaid, poll so the screen flips to the
  // finish-OTP path the moment the customer pays online (no payment SSE exists).
  useEffect(() => {
    if (detail?.status !== 'in_progress' || isPaid) return;
    const id = setInterval(() => { refresh(); }, 5000);
    return () => clearInterval(id);
  }, [detail?.status, isPaid, refresh]);

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
      // Clear UNCONDITIONALLY. The old guard (`status !== 'completed'`)
      // left the timer alive when the screen unmounted while still
      // completed, so it fired 5s later and popped an unrelated screen
      // (and auto-kicked a pro who merely opened an already-completed job).
      if (completeNavTimerRef.current) {
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
      showError(friendlyError(e, 'Couldn’t mark you on the way. Please try again.'));
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
        showError(friendlyError(e, 'Couldn’t mark you as arrived. Please try again.'));
      }
    } finally {
      setBusy(false);
    }
  }

  // Start/Finish open the OTP entry sheet (the customer reads the code aloud);
  // the actual transition happens in the submit handlers below.
  function tapStart() {
    setOtpError(null);
    setOtpMode('start');
  }

  async function submitStartOtp(otp: string) {
    if (!detail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      await jobStart(bookingID, otp);
      haptics.success();
      setOtpMode(null);
      await refresh();
    } catch (e: any) {
      if (e?.code === 'invalid_otp') setOtpError(t('jobDetail.otpWrong'));
      else {
        setOtpMode(null);
        showError(friendlyError(e, 'Couldn’t start the job. Please try again.'));
      }
    } finally {
      setOtpBusy(false);
    }
  }

  function tapFinish() {
    setOtpError(null);
    setOtpMode('finish');
  }

  async function submitFinishOtp(otp: string) {
    if (!detail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      await jobComplete(bookingID, otp);
      haptics.success();
      setOtpMode(null);
      // Pay is time-based (hours online + working), not per-job — show a
      // plain completion confirmation, no per-job rupee figure.
      showSuccess(t('jobDetail.headerStepCompleted'));
      await refresh();
    } catch (e: any) {
      if (e?.code === 'invalid_otp') setOtpError(t('jobDetail.otpWrong'));
      else if (e?.code === 'payment_required') {
        setOtpMode(null);
        showError(t('jobDetail.awaitingPaymentBody'));
      } else {
        setOtpMode(null);
        showError(friendlyError(e, 'Couldn’t finish the job. Please try again.'));
      }
    } finally {
      setOtpBusy(false);
    }
  }

  function tapCollectCash() {
    Alert.alert(
      t('jobDetail.collectCashConfirmTitle'),
      t('jobDetail.collectCashConfirmBody', { amount: outstandingRupees }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('jobDetail.collectCash', { amount: outstandingRupees }),
          onPress: async () => {
            if (busy) return;
            setBusy(true);
            try {
              await jobCollectCash(bookingID);
              haptics.success();
              await refresh(); // payment_status flips → finish OTP becomes available
            } catch (e: any) {
              showError(friendlyError(e, 'Couldn’t record the cash payment. Please try again.'));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  async function tapServiceStart(s: JobServiceLine) {
    if (busy) return;
    setBusy(true);
    try {
      await startService(bookingID, s.id);
      await refresh();
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t start this service. Please try again.'));
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
      showError(friendlyError(e, 'Couldn’t mark this service done. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function performSkip(s: JobServiceLine, reason: string) {
    if (busy) return;
    setBusy(true);
    try {
      await skipService(bookingID, s.id, reason);
      await refresh();
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t skip this service. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  function tapServiceSkip(s: JobServiceLine) {
    if (busy) return;
    if (Alert.prompt) {
      // iOS supports Alert.prompt for free-text input (with its own
      // Cancel/OK confirm step).
      Alert.prompt(
        t('jobDetail.skipReasonTitle'),
        undefined,
        (reason: string) => performSkip(s, reason ?? ''),
      );
      return;
    }
    // Android has no Alert.prompt. Skipping permanently strikes a paid
    // service line, so require an explicit confirm tap (reason omitted)
    // instead of firing on a single tap of the small Skip button.
    Alert.alert(
      t('jobDetail.skipConfirmTitle'),
      t('jobDetail.skipConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('jobDetail.serviceSkip'),
          style: 'destructive',
          onPress: () => performSkip(s, ''),
        },
      ],
    );
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

        {renderStateBody(detail, services, {
          c, styles, busy, gpsNearby,
          isPaid, outstandingRupees, tapCollectCash,
          tapEnRoute, tapArrived, tapStart, tapFinish,
          tapServiceStart, tapServiceComplete, tapServiceSkip,
          onCancelBooking: () =>
            startProBookingCancel({
              bookingId: bookingID,
              estimatedJobMinutes: undefined,
              onCancelled: () => navigation.goBack(),
            }),
          onGoBack: () => { if (navigation.canGoBack()) navigation.goBack(); },
        })}
      </ScrollView>
      <OtpSheet
        visible={otpMode !== null}
        title={otpMode === 'start' ? t('jobDetail.startOtpTitle') : t('jobDetail.endOtpTitle')}
        cta={otpMode === 'start' ? t('jobDetail.startOtpCta') : t('jobDetail.endOtpCta')}
        busy={otpBusy}
        error={otpError}
        onSubmit={otpMode === 'start' ? submitStartOtp : submitFinishOtp}
        onClose={() => {
          setOtpMode(null);
          setOtpError(null);
        }}
      />
    </SafeAreaView>
  );
}

interface RenderArgs {
  c: ReturnType<typeof useColors>;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  gpsNearby: boolean;
  isPaid: boolean;
  outstandingRupees: string;
  tapCollectCash: () => void;
  tapEnRoute: () => void;
  tapArrived: () => void;
  tapStart: () => void;
  tapFinish: () => void;
  tapServiceStart: (s: JobServiceLine) => void;
  tapServiceComplete: (s: JobServiceLine) => void;
  tapServiceSkip: (s: JobServiceLine) => void;
  onCancelBooking: () => void;
  onGoBack: () => void;
}

function renderStateBody(detail: JobDetail, services: JobServiceLine[], args: RenderArgs) {
  const { c, styles, busy, gpsNearby } = args;

  // Cancelled — terminal. The customer (or an admin/leave reassign)
  // cancelled or reassigned this job. Render a dead-end state instead of
  // live En-Route/Arrived/Start buttons that all error on tap.
  if (detail.status === 'cancelled') {
    return (
      <View style={styles.summaryCard}>
        <Feather name="x-circle" size={28} color={c.danger ?? c.text} style={{ alignSelf: 'center', marginBottom: 8 }} />
        <Text style={[styles.summaryValue, { textAlign: 'center' }]}>{t('jobDetail.cancelledTitle')}</Text>
        <Text style={[styles.summaryLabel, { textAlign: 'center', marginTop: 4 }]}>{t('jobDetail.cancelledBody')}</Text>
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 16 }]} onPress={args.onGoBack}>
          <Text style={styles.primaryBtnText}>{t('jobDetail.backToJobs')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

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
        {detail.customer_rating_pending && (
          <Text style={styles.awaiting}>{t('jobDetail.awaitingRating')}</Text>
        )}
      </View>
    );
  }

  // In progress — task checklist + finish.
  if (detail.status === 'in_progress') {
    const allDone = services.length > 0 && services.every((s) => s.status === 'completed' || s.status === 'skipped');
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
        {args.isPaid ? (
          <TouchableOpacity
            style={[styles.primaryBtn, (!allDone || busy) && { opacity: 0.5 }]}
            onPress={args.tapFinish}
            disabled={!allDone || busy}
          >
            <Text style={styles.primaryBtnText}>{t('jobDetail.finishJob')}</Text>
          </TouchableOpacity>
        ) : (
          <View>
            <Text style={styles.awaitingTitle}>{t('jobDetail.awaitingPaymentTitle')}</Text>
            <Text style={styles.awaitingBody}>{t('jobDetail.awaitingPaymentBody')}</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
              onPress={args.tapCollectCash}
              disabled={busy}
            >
              <Text style={styles.primaryBtnText}>
                {t('jobDetail.collectCash', { amount: args.outstandingRupees })}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </>
    );
  }

  // Arrived — start job.
  if (detail.arrived_at) {
    return (
      <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.5 }]} onPress={args.tapStart} disabled={busy}>
        <Text style={styles.primaryBtnText}>{t('jobDetail.startJob')}</Text>
      </TouchableOpacity>
    );
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
          {service.service_name || t('jobDetail.serviceFallbackName')}
        </Text>
        <Text style={[styles.serviceMeta, isStruck && styles.serviceStruck]}>
          {service.duration_minutes}min{service.quantity > 1 ? ` · ×${service.quantity}` : ''}
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
    helperText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    awaitingTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text, marginBottom: Spacing.xs },
    awaitingBody: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, marginBottom: Spacing.sm },
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
    serviceMeta: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
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
