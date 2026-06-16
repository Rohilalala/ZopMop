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
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { listActiveJobs, listPendingOffers } from '../../api/jobs';
import { getHelperToday, type HelperBooking } from '../../api/pro';
import { onShiftEvent, type OfferPayload } from '../../utils/shiftEvents';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t, useLocale } from '../../i18n';

const ACTIVE_STATUSES = new Set(['accepted', 'arrived', 'in_progress']);

interface OfferState extends OfferPayload {
  // expiresAtMs derived from received_at_ms + time_remaining_sec*1000
  expiresAtMs: number;
}

export default function JobsListScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [offers, setOffers] = useState<Record<string, OfferState>>({});
  const [active, setActive] = useState<HelperBooking[]>([]);
  const [completed, setCompleted] = useState<HelperBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    const [activeRes, pendingRes, todayRes] = await Promise.allSettled([
      listActiveJobs(),
      listPendingOffers(),
      getHelperToday(token ?? ''),
    ]);
    if (activeRes.status === 'fulfilled') {
      setActive(activeRes.value.filter((b) => ACTIVE_STATUSES.has(b.status)));
    }
    if (todayRes.status === 'fulfilled') {
      setCompleted(todayRes.value.filter((b) => b.status === 'completed'));
    }
    // Surface a real fetch failure as an error/retry state instead of the
    // 'No jobs' empty state. If every request failed (offline / backend
    // down) we have no trustworthy data to render.
    setLoadError(
      activeRes.status === 'rejected' &&
      pendingRes.status === 'rejected' &&
      todayRes.status === 'rejected',
    );
    // For pending offers we only have IDs from the server; rich offer
    // metadata comes via FCM push (booking_offer event). Prune stale
    // local cache entries whose IDs are no longer in the pending set
    // — handles server-side auto-decline cleanly.
    if (pendingRes.status === 'fulfilled') {
      const liveIds = new Set(pendingRes.value);
      const nowMs = Date.now();
      setOffers((prev) => {
        const next: Record<string, OfferState> = {};
        // Keep cached (push-enriched) offers still live on the server.
        for (const id of Object.keys(prev)) {
          if (liveIds.has(id)) next[id] = prev[id];
        }
        // Add a minimal row for any server-live offer we have no cached
        // payload for (cold-start / relaunch mid-invite, where the FCM
        // push fired before the app subscribed). Without this the Jobs
        // screen showed empty while the offer was still acceptable.
        for (const id of liveIds) {
          if (!next[id]) {
            next[id] = {
              booking_id: id,
              received_at_ms: nowMs,
              time_remaining_sec: 25,
              expiresAtMs: nowMs + 25 * 1000,
            };
          }
        }
        return next;
      });
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Refetch whenever the tab regains focus — the pro's own
  // accept/start/complete happens on the JobDetail stack screen, and
  // returning here without a refetch left the Active/Today sections stale.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Subscribe to push events: append new offers, refresh on status change.
  useEffect(() => {
    return onShiftEvent((ev) => {
      if (ev.type === 'booking_offer') {
        const p = ev.payload;
        setOffers((prev) => ({
          ...prev,
          [p.booking_id]: {
            ...p,
            expiresAtMs: p.received_at_ms + (p.time_remaining_sec ?? 25) * 1000,
          },
        }));
      } else if (ev.type === 'booking_status_change') {
        load();
      }
    });
  }, [load]);

  // Tick every 1s so countdowns update + expired offers drop out.
  useEffect(() => {
    const id = setInterval(() => {
      forceTick((n) => n + 1);
      setOffers((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, OfferState> = {};
        for (const [id, o] of Object.entries(prev)) {
          if (now >= o.expiresAtMs) {
            changed = true;
            continue;
          }
          next[id] = o;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const offerList = Object.values(offers);

  const isEmpty = !loading && !loadError && offerList.length === 0 && active.length === 0 && completed.length === 0;

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

        {offerList.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('jobs.sectionNewOffer')}</Text>
            {offerList.map((o) => (
              <OfferRow
                key={o.booking_id}
                offer={o}
                colors={c}
                onPress={() => navigation.navigate('JobOffer', { booking_id: o.booking_id })}
              />
            ))}
          </View>
        )}

        {active.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('jobs.sectionActive')}</Text>
            {active.map((b) => (
              <ActiveRow
                key={b.id}
                booking={b}
                colors={c}
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

        {!loading && loadError && (
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIconRing}>
              <Feather name="wifi-off" size={32} color={c.danger} />
            </View>
            <Text style={styles.emptyTitle}>{t('common.error')}</Text>
            <Text style={styles.emptySub}>{t('jobs.loadErrorBody')}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
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

function OfferRow({
  offer, colors, onPress,
}: { offer: OfferState; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  const remainingSec = Math.max(0, Math.ceil((offer.expiresAtMs - Date.now()) / 1000));
  return (
    <TouchableOpacity onPress={onPress} style={[localCard(colors), { borderColor: colors.accent }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: colors.text }}>
          {offer.customer_first_name ?? 'Customer'}
        </Text>
        <View style={{
          paddingHorizontal: 10, paddingVertical: 4,
          borderRadius: Radius.full, backgroundColor: colors.accent,
        }}>
          <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: '#1a1a1a' }}>
            {t('jobs.secondsShort', { n: remainingSec })}
          </Text>
        </View>
      </View>
      {offer.address_summary && (
        <Text style={{ fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 4 }}>
          {offer.address_summary}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: Spacing.lg, marginTop: Spacing.sm }}>
        {offer.estimated_duration_minutes != null && (
          <Text style={{ fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: colors.text }}>
            {t('offer.minutesShort', { n: offer.estimated_duration_minutes })}
          </Text>
        )}
        {offer.estimated_earnings_paise != null && (
          <Text style={{ fontFamily: FontFamily.bold, fontSize: FontSize.base, color: colors.accent }}>
            ₹{Math.round(offer.estimated_earnings_paise / 100)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function ActiveRow({
  booking, colors, onPress,
}: { booking: HelperBooking; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={localCard(colors)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: colors.accent, textTransform: 'uppercase' }}>
          {booking.status}
        </Text>
        <Feather name="chevron-right" size={18} color={colors.textMuted} />
      </View>
      <Text style={{ fontFamily: FontFamily.regular, fontSize: FontSize.base, color: colors.text, marginTop: 4 }}>
        {booking.address}
      </Text>
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
    retryBtn: {
      marginTop: Spacing.base, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
      borderRadius: Radius.full, borderWidth: 1, borderColor: c.accent,
    },
    retryText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.accent },
  });
}
