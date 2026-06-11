import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { acceptJob, declineJob, listActiveJobs } from '../../api/jobs';
import { onShiftEvent, type OfferPayload } from '../../utils/shiftEvents';
import { showError, showInfo } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t } from '../../i18n';

interface OfferTask {
  service_name: string;
  duration_minutes: number;
  quantity: number;
  display_order: number;
}

const DEFAULT_TTL_SEC = 25;

export default function JobOfferScreen() {
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'JobOffer'>>();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const bookingID = route.params.booking_id;

  const [payload, setPayload] = useState<OfferPayload | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number>(Date.now() + DEFAULT_TTL_SEC * 1000);
  const [remainingSec, setRemainingSec] = useState<number>(DEFAULT_TTL_SEC);
  const [busy, setBusy] = useState(false);
  const [alreadyActive, setAlreadyActive] = useState(false);
  const submittedRef = useRef(false);

  // Subscribe to live offer pushes so a late-arriving SCHEDULED_INVITE
  // for this same booking refreshes the timer.
  useEffect(() => {
    const unsub = onShiftEvent((ev) => {
      if (ev.type === 'booking_offer' && ev.payload.booking_id === bookingID) {
        setPayload(ev.payload);
        const ttl = (ev.payload.time_remaining_sec ?? DEFAULT_TTL_SEC) * 1000;
        setExpiresAtMs(ev.payload.received_at_ms + ttl);
      }
    });
    return unsub;
  }, [bookingID]);

  // Defensive: if pro is already on an active job, surface a warning
  // banner. Server shouldn't have offered this in the first place.
  useEffect(() => {
    listActiveJobs()
      .then((rows) => {
        if (rows.some((b) => b.id !== bookingID && (b.status === 'accepted' || b.status === 'in_progress' || b.status === 'arrived'))) {
          setAlreadyActive(true);
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [bookingID]);

  // Local countdown driven off expiresAtMs. Server-side auto-decline
  // is authoritative; this UI is decorative.
  useEffect(() => {
    const id = setInterval(() => {
      const sec = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
      setRemainingSec(sec);
      if (sec === 0 && !submittedRef.current) {
        // Server has already auto-declined by now. Drop the screen.
        submittedRef.current = true;
        showInfo(t('offer.expired'));
        if (navigation.canGoBack()) navigation.goBack();
      }
    }, 500);
    return () => clearInterval(id);
  }, [expiresAtMs, navigation]);

  // Block hardware back during the offer — only Accept/Decline exits.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  async function onAccept() {
    if (busy || submittedRef.current) return;
    submittedRef.current = true;
    setBusy(true);
    try {
      haptics.success();
      await acceptJob(bookingID);
      navigation.replace('JobDetail', { booking_id: bookingID });
    } catch (e: any) {
      submittedRef.current = false;
      if (e?.status === 409) {
        showInfo(t('offer.expired'));
        navigation.goBack();
      } else {
        showError(e?.message ?? t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDecline() {
    if (busy || submittedRef.current) return;
    submittedRef.current = true;
    setBusy(true);
    try {
      await declineJob(bookingID);
    } catch { /* fall through — UX same regardless */ }
    finally {
      navigation.goBack();
    }
  }

  const tasks: OfferTask[] = useMemo(() => {
    if (!payload?.task_list_json) return [];
    try {
      const parsed = JSON.parse(payload.task_list_json);
      if (!Array.isArray(parsed)) return [];
      return [...parsed].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    } catch {
      return [];
    }
  }, [payload?.task_list_json]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.timerWrap}>
        <Text style={styles.timerLabel}>{t('offer.title')}</Text>
        <Text style={styles.timerValue}>{remainingSec}s</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {alreadyActive && (
          <View style={styles.warningBox}>
            <Feather name="alert-triangle" size={16} color={c.warning} />
            <Text style={styles.warningText}>{t('offer.busyWarning')}</Text>
          </View>
        )}

        <View style={styles.customerCard}>
          <Text style={styles.customerName}>{payload?.customer_first_name ?? 'Customer'}</Text>
          {payload?.address_summary && (
            <Text style={styles.addressLine}>{payload.address_summary}</Text>
          )}
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>{t('offer.durationLabel')}</Text>
            <Text style={styles.metaValue}>
              {t('offer.minutesShort', { n: payload?.estimated_duration_minutes ?? 0 })}
            </Text>
          </View>
          <View style={styles.metaDivider} />
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>{t('offer.earningsLabel')}</Text>
            <Text style={[styles.metaValue, { color: c.accent }]}>
              ₹{Math.round((payload?.estimated_earnings_paise ?? 0) / 100)}
            </Text>
          </View>
        </View>

        {tasks.length > 0 && (
          <View style={styles.tasksCard}>
            {tasks.map((task, idx) => (
              <View
                key={`${task.service_name}-${idx}`}
                style={[
                  styles.taskRow,
                  idx < tasks.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.border },
                ]}
              >
                <Text style={styles.taskName}>
                  {t('offer.serviceLine', {
                    name: task.service_name || 'Service',
                    qty: `${task.quantity}× · ${task.duration_minutes}min`,
                  })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.declineBtn, busy && { opacity: 0.5 }]}
          onPress={onDecline}
          disabled={busy}
        >
          <Text style={styles.declineText}>{t('offer.decline')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.acceptBtn, busy && { opacity: 0.5 }]}
          onPress={onAccept}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#1a1a1a" />
          ) : (
            <Text style={styles.acceptText}>{t('offer.accept')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    timerWrap: {
      alignItems: 'center', paddingVertical: Spacing.xl,
      borderBottomWidth: 1, borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    timerLabel: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textSecondary, marginBottom: 4 },
    timerValue: { fontFamily: FontFamily.bold, fontSize: 56, color: c.accent },
    scroll: { padding: Spacing.lg, gap: Spacing.base, paddingBottom: Spacing['3xl'] },
    warningBox: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
      backgroundColor: c.warningBg, padding: Spacing.sm, borderRadius: Radius.md,
    },
    warningText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.warning },
    customerCard: { gap: 4, padding: Spacing.lg, backgroundColor: c.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border },
    customerName: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text },
    addressLine: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary },
    metaRow: {
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: c.surface, borderRadius: Radius.lg, padding: Spacing.lg,
      borderWidth: 1, borderColor: c.border,
    },
    metaCell: { flex: 1, gap: 4 },
    metaDivider: { width: 1, height: 32, backgroundColor: c.border },
    metaLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    metaValue: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    tasksCard: { backgroundColor: c.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border },
    taskRow: { padding: Spacing.lg },
    taskName: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text },
    actions: { flexDirection: 'row', gap: Spacing.base, padding: Spacing.lg, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface },
    declineBtn: {
      flex: 1, paddingVertical: Spacing.base, alignItems: 'center',
      borderWidth: 1, borderColor: c.border, borderRadius: Radius.lg,
    },
    declineText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    acceptBtn: {
      flex: 1.6, paddingVertical: Spacing.base, alignItems: 'center',
      backgroundColor: c.accent, borderRadius: Radius.lg,
    },
    acceptText: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: '#1a1a1a' },
  });
}
