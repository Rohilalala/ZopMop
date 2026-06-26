import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  AppState,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import * as Location from 'expo-location';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { showError } from '../../utils/toast';
import { friendlyError } from '../../utils/errors';
import { haptics } from '../../utils/haptics';
import { captureSelfieForApproval } from '../../utils/photoCapture';
import {
  getActiveShift,
  listCommitments,
  goOnline,
  goOffline,
  type Commitment,
  type Session,
  type GoOnlineResult,
} from '../../api/shifts';
import { getHelperActive, type HelperBooking } from '../../api/pro';
import { t, useLocale } from '../../i18n';
import { onShiftEvent } from '../../utils/shiftEvents';

type DashState =
  | { kind: 'loading' }
  | { kind: 'nextShift'; commitment: Commitment; isToday: boolean }
  | { kind: 'canGoOnline'; commitment: Commitment }
  | { kind: 'online'; session: Session; commitment: Commitment }
  | { kind: 'onlineWithJob'; session: Session; commitment: Commitment; booking: HelperBooking }
  | { kind: 'noShift'; absenceLogged: boolean }
  | { kind: 'approvalPending'; commitment: Commitment };

const ONLINE_TICK_MS = 60 * 1000;
const FOREGROUND_REFRESH_MS = 5 * 60 * 1000;
const COUNTDOWN_TICK_MS = 30 * 1000;

function parseShiftStart(c: Commitment): Date {
  const [y, m, d] = c.shift_date.split('-').map((n) => parseInt(n, 10));
  const [hh, mm] = c.start_time.split(':').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function parseShiftEnd(c: Commitment): Date {
  const [y, m, d] = c.shift_date.split('-').map((n) => parseInt(n, 10));
  const [hh, mm] = c.end_time.split(':').map((n) => parseInt(n, 10));
  const end = new Date(y, m - 1, d, hh, mm, 0, 0);
  // End-of-day rollover: 22:00→06:00 means end is next day.
  if (end < parseShiftStart(c)) end.setDate(end.getDate() + 1);
  return end;
}

function todayYMD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function tomorrowYMD(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtHM(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function isPast3amIST(): boolean {
  // Approximation — device locale is the user's actual phone locale. Backend
  // is the source of truth for the actual lock; this just hides the change-
  // shift button proactively when the user is in India.
  const now = new Date();
  return now.getHours() >= 3;
}

export default function ProDashboardScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { user, token, signOut } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [state, setState] = useState<DashState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPendingModal, setShowPendingModal] = useState<HelperBooking[] | null>(null);
  const [, forceTick] = useState(0);
  const approvalPendingRef = useRef<string | null>(null);

  // Tick the UI every 30s so the countdown copy updates without a full refetch.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const computeState = useCallback(async (): Promise<DashState> => {
    const tk = token ?? '';
    const [activeRes, commitments, bookings] = await Promise.all([
      getActiveShift().catch(() => ({ session: null, commitment: null })),
      listCommitments().catch(() => [] as Commitment[]),
      getHelperActive(tk).catch(() => [] as HelperBooking[]),
    ]);

    // State 3 / 4 — session open.
    if (activeRes.session && !activeRes.session.offline_at && activeRes.commitment) {
      const activeBooking = bookings.find((b) => b.status === 'accepted' || b.status === 'in_progress');
      if (activeBooking) {
        return {
          kind: 'onlineWithJob',
          session: activeRes.session,
          commitment: activeRes.commitment,
          booking: activeBooking,
        };
      }
      return { kind: 'online', session: activeRes.session, commitment: activeRes.commitment };
    }

    // State 6 — pending approval (local flag survives across refreshes).
    const pendingCommit = approvalPendingRef.current
      ? commitments.find((x) => x.id === approvalPendingRef.current)
      : undefined;
    if (pendingCommit) {
      return { kind: 'approvalPending', commitment: pendingCommit };
    }

    // Find today's commitment and tomorrow's.
    const today = todayYMD();
    const tomorrow = tomorrowYMD();
    const todayCommit = commitments.find((x) => x.shift_date === today);
    const tomorrowCommit = commitments
      .filter((x) => x.shift_date >= tomorrow)
      .sort((a, b) => a.shift_date.localeCompare(b.shift_date))[0];

    if (todayCommit) {
      const now = new Date();
      const start = parseShiftStart(todayCommit);
      const end = parseShiftEnd(todayCommit);
      const earlyWindow = new Date(start.getTime() - 30 * 60 * 1000);
      if (now < earlyWindow) {
        return { kind: 'nextShift', commitment: todayCommit, isToday: true };
      }
      if (now <= end) {
        return { kind: 'canGoOnline', commitment: todayCommit };
      }
      // past end → no active shift
      return { kind: 'noShift', absenceLogged: false };
    }

    if (tomorrowCommit) {
      return { kind: 'nextShift', commitment: tomorrowCommit, isToday: false };
    }

    return { kind: 'noShift', absenceLogged: isPast3amIST() };
  }, [token]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await computeState();
      setState(next);
    } catch (e) {
      if (__DEV__) console.warn('[ProDashboard] refresh:', e);
    } finally {
      setRefreshing(false);
    }
  }, [computeState]);

  // Initial load + periodic refetch + on-foreground refetch.
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, FOREGROUND_REFRESH_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [refresh]);

  // Shift-event listener — zone_approval_granted clears the pending flag
  // and refetches. Fed by pushRouter via emitShiftEvent.
  useEffect(() => {
    const unsub = onShiftEvent((ev) => {
      if (ev.type === 'zone_approval_granted') {
        approvalPendingRef.current = null;
        refresh();
      } else if (ev.type === 'zone_approval_rejected') {
        // Admin rejected the out-of-zone request. Clear the pending flag
        // so the pro leaves the "Waiting for approval" state, surface the
        // reason, and refetch. Previously this push had no handler and the
        // pro sat on the waiting screen the whole shift.
        approvalPendingRef.current = null;
        showError(ev.reason || t('zoneApproval.rejected'));
        refresh();
      }
    });
    return unsub;
  }, [refresh]);

  async function handleGoOnline(commitment: Commitment) {
    if (busy) return;
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        showError(t('dashboard.locationDenied'));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const selfie = await captureSelfieForApproval();
      if (!selfie) {
        showError('A selfie is required to go online.');
        return;
      }
      const result: GoOnlineResult = await goOnline(commitment.id, pos.coords.latitude, pos.coords.longitude, selfie.dataUrl);
      if (!result.location_ok && result.requires_manual_approval) {
        // A request is already queued — go straight to the waiting state
        // rather than re-prompting for a selfie (the resubmit 409s).
        if (result.approval_pending) {
          approvalPendingRef.current = commitment.id;
          await refresh();
          return;
        }
        navigation.navigate('ZoneApprovalRequest', {
          commitment_id: commitment.id,
          current_lat: pos.coords.latitude,
          current_lng: pos.coords.longitude,
          distance_meters: result.distance_meters ?? 0,
        });
        approvalPendingRef.current = commitment.id;
        refresh();
        return;
      }
      // Location rejected but not manually approvable — don't fake success.
      if (!result.location_ok) {
        showError("You're outside your committed zone. Move closer and try again.");
        return;
      }
      haptics.success();
      await refresh();
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t take you online. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoOffline(commitment: Commitment) {
    if (busy) return;
    setBusy(true);
    try {
      const active = await getHelperActive(token ?? '').catch(() => [] as HelperBooking[]);
      const pending = active.filter((b) => b.status === 'accepted' || b.status === 'in_progress');
      if (pending.length > 0) {
        setShowPendingModal(pending);
        return;
      }
      const selfie = await captureSelfieForApproval();
      if (!selfie) {
        showError('A selfie is required to go offline.');
        return;
      }
      await goOffline(commitment.id, selfie.dataUrl);
      haptics.success();
      await refresh();
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t take you offline. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  function renderState(): React.ReactNode {
    if (state.kind === 'loading') {
      return (
        <View style={styles.centerWrap}>
          <ActivityIndicator color={c.accent} />
        </View>
      );
    }

    const name = user?.name?.split(' ')[0] ?? '';
    const greeting = (
      <Text style={styles.greeting}>{t('dashboard.greeting', { name })}</Text>
    );

    if (state.kind === 'nextShift') {
      const start = parseShiftStart(state.commitment);
      const diffMs = start.getTime() - Date.now();
      const totalMin = Math.max(0, Math.floor(diffMs / 60_000));
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      const headerKey = state.isToday ? 'dashboard.nextShiftToday' : 'dashboard.nextShiftTomorrow';
      const cantChange = state.isToday && isPast3amIST();
      return (
        <View style={styles.contentPad}>
          {greeting}
          <View style={styles.cardGlass}>
            <Text style={styles.cardLine}>{t(headerKey, { start: fmtHM(start) })}</Text>
            <Text style={styles.countdown}>{t('dashboard.countdown', { h, m })}</Text>
          </View>
          <TouchableOpacity
            style={[styles.secondaryBtn, cantChange && styles.disabled]}
            disabled={cantChange}
            onPress={() => navigation.navigate('CommitShift')}
          >
            <Text style={[styles.secondaryBtnText, cantChange && styles.disabledText]}>
              {t('dashboard.changeShift')}
            </Text>
          </TouchableOpacity>
          {cantChange && (
            <Text style={styles.helperText}>{t('dashboard.cantChangeAfter3am')}</Text>
          )}
        </View>
      );
    }

    if (state.kind === 'canGoOnline') {
      return (
        <View style={styles.contentPad}>
          {greeting}
          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.disabled]}
            disabled={busy}
            onPress={() => handleGoOnline(state.commitment)}
          >
            <Text style={styles.primaryBtnText}>{t('dashboard.goOnline')}</Text>
          </TouchableOpacity>
          <Text style={styles.helperText}>{t('dashboard.goOnlineHelper')}</Text>
        </View>
      );
    }

    if (state.kind === 'online') {
      const onlineAt = new Date(state.session.online_at);
      const minutes = Math.max(0, Math.floor((Date.now() - onlineAt.getTime()) / 60_000));
      return (
        <View style={styles.contentPad}>
          {greeting}
          <View style={[styles.cardGlass, styles.onlineCard]}>
            <View style={styles.row}>
              <View style={styles.dotPulse} />
              <Text style={styles.onlineLabel}>{t('dashboard.online')}</Text>
            </View>
            <Text style={styles.onlineCounter}>{t('dashboard.onlineNowChip', { minutes })}</Text>
            <Text style={styles.readyLine}>{t('dashboard.readyForBooking')}</Text>
          </View>
          <TouchableOpacity
            style={[styles.secondaryBtn, busy && styles.disabled]}
            disabled={busy}
            onPress={() => handleGoOffline(state.commitment)}
          >
            <Text style={styles.secondaryBtnText}>{t('dashboard.goOffline')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (state.kind === 'onlineWithJob') {
      const b = state.booking;
      return (
        <View style={styles.contentPad}>
          {greeting}
          <View style={[styles.cardGlass, styles.jobCard]}>
            <Text style={styles.jobHeader}>{t('dashboard.activeJob')}</Text>
            <Text style={styles.jobAddress}>{b.address}</Text>
            {/* No per-job earnings — pay is time-based (hours online +
                working), shown on the Money tab, not per booking. */}
          </View>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('JobDetail', { booking_id: b.id })}
          >
            <Text style={styles.primaryBtnText}>{t('dashboard.completeJob')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (state.kind === 'noShift') {
      return (
        <View style={styles.contentPad}>
          {greeting}
          <View style={styles.cardGlass}>
            <Text style={styles.cardLine}>{t('dashboard.noShiftToday')}</Text>
          </View>
          {state.absenceLogged && (
            <View style={[styles.cardGlass, styles.warningCard]}>
              <Text style={styles.warningText}>{t('dashboard.absenceLogged')}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('CommitShift')}>
            <Text style={styles.primaryBtnText}>{t('dashboard.planTomorrow')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // approvalPending
    return (
      <View style={styles.contentPad}>
        {greeting}
        <View style={[styles.cardGlass, styles.warningCard]}>
          <Feather name="clock" size={28} color={c.accent} />
          <Text style={styles.cardLine}>{t('dashboard.zoneVerificationPending')}</Text>
          <Text style={styles.helperText}>{t('dashboard.zoneVerificationSubtext')}</Text>
        </View>
        <TouchableOpacity
          style={[styles.secondaryBtn, busy && styles.disabled]}
          disabled={busy}
          onPress={() => handleGoOnline(state.commitment)}
        >
          <Text style={styles.secondaryBtnText}>{t('dashboard.retryGoOnline')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.accent} />}
      >
        {renderState()}

        <View style={styles.utilRow}>
          <TouchableOpacity style={styles.utilBtn} onPress={() => navigation.navigate('ProMoney')}>
            <Feather name="dollar-sign" size={16} color={c.accent} />
            <Text style={styles.utilText}>{t('money.title')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.utilBtn} onPress={() => navigation.navigate('ProProfile')}>
            <Feather name="user" size={16} color={c.text} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.utilBtn} onPress={signOut}>
            <Feather name="log-out" size={16} color={c.danger} />
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal
        transparent
        visible={!!showPendingModal}
        animationType="fade"
        onRequestClose={() => setShowPendingModal(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: c.surface }]}>
            <Text style={styles.modalTitle}>
              {t('dashboard.pendingBookingsTitle', { n: showPendingModal?.length ?? 0 })}
            </Text>
            <Text style={styles.modalBody}>{t('dashboard.pendingBookingsBody')}</Text>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => setShowPendingModal(null)}
            >
              <Text style={styles.secondaryBtnText}>{t('common.ok')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    scroll: { flexGrow: 1, paddingBottom: Spacing['2xl'] },
    contentPad: { padding: Spacing.lg, gap: Spacing.base },
    centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: Spacing['4xl'] },
    greeting: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xl,
      color: c.text,
      marginBottom: Spacing.sm,
    },
    cardGlass: {
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      padding: Spacing.lg,
      borderWidth: 1,
      borderColor: c.border,
      gap: Spacing.sm,
      ...Shadow.sm,
    },
    onlineCard: { borderColor: c.accent },
    jobCard: { borderColor: c.info },
    warningCard: { borderColor: c.warning, alignItems: 'center' },
    cardLine: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text },
    countdown: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.accent,
    },
    primaryBtn: {
      backgroundColor: c.accent,
      borderRadius: Radius.lg,
      paddingVertical: Spacing.base,
      alignItems: 'center',
      ...Shadow.md,
    },
    primaryBtnText: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: '#1a1a1a' },
    secondaryBtn: {
      backgroundColor: 'transparent',
      borderRadius: Radius.lg,
      paddingVertical: Spacing.base,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    secondaryBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    disabled: { opacity: 0.5 },
    disabledText: { color: c.textMuted },
    helperText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    dotPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.success },
    onlineLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.success },
    onlineCounter: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text },
    readyLine: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    jobHeader: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.info },
    jobAddress: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.text },
    jobMeta: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    warningText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.warning, textAlign: 'center' },
    utilRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: Spacing.lg, gap: Spacing.sm },
    utilBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingVertical: Spacing.sm, paddingHorizontal: Spacing.base,
      borderRadius: Radius.full, borderWidth: 1, borderColor: c.border,
    },
    utilText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.text },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
    modalCard: { width: '100%', maxWidth: 400, padding: Spacing.lg, borderRadius: Radius.xl, gap: Spacing.base },
    modalTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    modalBody: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, lineHeight: 22 },
  });
}
