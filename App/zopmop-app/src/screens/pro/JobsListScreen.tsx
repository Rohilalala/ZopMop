import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { listActiveJobs } from '../../api/jobs';
import { getHelperToday, type HelperBooking } from '../../api/pro';
import { onShiftEvent } from '../../utils/shiftEvents';
import { loadAcknowledgedJobs, markJobAcknowledged } from '../../utils/assignedAckStore';
import { t } from '../../i18n';

const ACTIVE_STATUSES = new Set(['accepted', 'arrived', 'in_progress']);

export default function JobsListScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [active, setActive] = useState<HelperBooking[]>([]);
  const [completed, setCompleted] = useState<HelperBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Booking ids that landed via a booking_assigned push since this screen
  // opened, and the ids already acknowledged ("Got it") in prior sessions.
  // A row shows the NEW badge + Got it button when it is newly-assigned and
  // not yet acknowledged.
  const [newlyAssigned, setNewlyAssigned] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [activeRes, todayRes] = await Promise.allSettled([
      listActiveJobs(),
      getHelperToday(token ?? ''),
    ]);
    if (activeRes.status === 'fulfilled') {
      setActive(activeRes.value.filter((b) => ACTIVE_STATUSES.has(b.status)));
    }
    if (todayRes.status === 'fulfilled') {
      setCompleted(todayRes.value.filter((b) => b.status === 'completed'));
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Hydrate the acknowledged set once on mount.
  useEffect(() => {
    let alive = true;
    loadAcknowledgedJobs().then((s) => { if (alive) setAcknowledged(s); });
    return () => { alive = false; };
  }, []);

  // Subscribe to push events: flag new assignments, refresh on status change.
  useEffect(() => {
    return onShiftEvent((ev) => {
      if (ev.type === 'booking_assigned') {
        // Flag the row as newly arrived; the paired booking_status_change
        // emit (from pushRouter) drives the actual refetch below.
        setNewlyAssigned((prev) => {
          const next = new Set(prev);
          next.add(ev.booking_id);
          return next;
        });
      } else if (ev.type === 'booking_status_change') {
        load();
      }
    });
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const onAck = useCallback((bookingId: string) => {
    markJobAcknowledged(bookingId);
    setAcknowledged((prev) => {
      const next = new Set(prev);
      next.add(bookingId);
      return next;
    });
  }, []);

  const isEmpty = !loading && active.length === 0 && completed.length === 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('jobs.headerTitle')}</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />}
      >
        {loading && (
          <View style={styles.center}><ActivityIndicator color={c.accent} /></View>
        )}

        {active.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('jobs.sectionActive')}</Text>
            {active.map((b) => (
              <ActiveRow
                key={b.id}
                booking={b}
                colors={c}
                isNew={newlyAssigned.has(b.id) && !acknowledged.has(b.id)}
                onAck={() => onAck(b.id)}
                onPress={() => navigation.navigate('JobDetail', { booking_id: b.id })}
              />
            ))}
          </View>
        )}

        {completed.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('jobs.sectionToday')}</Text>
            {completed.map((b) => (
              <CompletedRow
                key={b.id}
                booking={b}
                colors={c}
                onPress={() => navigation.navigate('JobDetail', { booking_id: b.id })}
              />
            ))}
          </View>
        )}

        {isEmpty && (
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIconRing}>
              <Feather name="briefcase" size={32} color={c.accent} />
            </View>
            <Text style={styles.emptyTitle}>{t('jobs.empty.title')}</Text>
            <Text style={styles.emptySub}>{t('jobs.empty.subtitle')}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActiveRow({
  booking, colors, isNew, onAck, onPress,
}: {
  booking: HelperBooking;
  colors: ReturnType<typeof useColors>;
  isNew: boolean;
  onAck: () => void;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[localCard(colors), isNew && { borderColor: colors.accent }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
          <Text style={{ fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: colors.accent, textTransform: 'uppercase' }}>
            {booking.status}
          </Text>
          {isNew && (
            <View style={{
              paddingHorizontal: 8, paddingVertical: 2,
              borderRadius: Radius.full, backgroundColor: colors.accent,
            }}>
              <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.xs, color: '#1a1a1a' }}>
                {t('jobs.newBadge')}
              </Text>
            </View>
          )}
        </View>
        <Feather name="chevron-right" size={18} color={colors.textMuted} />
      </View>
      <Text style={{ fontFamily: FontFamily.regular, fontSize: FontSize.base, color: colors.text, marginTop: 4 }}>
        {booking.address}
      </Text>
      {isNew && (
        <TouchableOpacity
          onPress={onAck}
          style={{
            marginTop: Spacing.sm, alignSelf: 'flex-start',
            paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
            borderRadius: Radius.full, backgroundColor: colors.accent,
          }}
        >
          <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: '#1a1a1a' }}>
            {t('jobs.gotIt')}
          </Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

function CompletedRow({
  booking, colors, onPress,
}: { booking: HelperBooking; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={localCard(colors)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: colors.textSecondary }}>
          {booking.address}
        </Text>
        <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.base, color: colors.text }}>
          ₹{Math.round(booking.price_paise / 100)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function localCard(colors: ReturnType<typeof useColors>) {
  return {
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: Spacing.sm,
  } as const;
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: { padding: Spacing.lg, borderBottomWidth: 1, borderBottomColor: c.border },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text },
    scroll: { padding: Spacing.lg, flexGrow: 1 },
    section: { marginBottom: Spacing.lg },
    sectionTitle: {
      fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.textSecondary,
      textTransform: 'uppercase', letterSpacing: 1, marginBottom: Spacing.sm,
    },
    center: { paddingTop: Spacing['4xl'], alignItems: 'center' },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: Spacing['4xl'], gap: Spacing.base },
    emptyIconRing: {
      width: 88, height: 88, borderRadius: 44,
      backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    emptyTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center', paddingHorizontal: Spacing.lg },
  });
}
