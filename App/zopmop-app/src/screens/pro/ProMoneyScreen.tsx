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
import { Feather } from '@expo/vector-icons';

import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { getFortnightProgress, getActiveShift, type FortnightProgress } from '../../api/shifts';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t, useLocale } from '../../i18n';

function minutesToHours(m: number): number {
  return Math.round((m / 60) * 10) / 10;
}

// Render the full paise value to two decimals so sub-rupee amounts are
// never silently rounded away (a ₹80.50/hr line was previously shown as
// ₹81 / ₹80, making the breakdown rows fail to sum to the headline).
function paiseToRupees(p: number): string {
  return `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(ymd: string): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function ProMoneyScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [data, setData] = useState<FortnightProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [onlineMinutesToday, setOnlineMinutesToday] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [prog, active] = await Promise.all([
        getFortnightProgress(),
        getActiveShift().catch(() => ({ session: null, commitment: null } as any)),
      ]);
      setData(prog);
      if (active?.session && !active.session.offline_at) {
        const onlineAt = new Date(active.session.online_at);
        setOnlineMinutesToday(Math.max(0, Math.floor((Date.now() - onlineAt.getTime()) / 60_000)));
      } else {
        setOnlineMinutesToday(null);
      }
    } catch (e) {
      if (__DEV__) console.warn('[ProMoney] load:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.center}><ActivityIndicator color={c.accent} /></View>
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.center}>
          <Text style={{ color: c.text }}>{t('common.error')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Per-pro tunable target comes from the backend (target_minutes). Fall
  // back to the legacy 80h only if the field is missing/zero on an older
  // server build.
  const targetH = data.target_minutes > 0 ? data.target_minutes / 60 : 80;
  const onlineH = minutesToHours(data.online_minutes);
  const overtimeH = minutesToHours(data.overtime_minutes);
  const jobH = minutesToHours(data.job_minutes);
  const regularH = Math.max(0, Math.min(onlineH, targetH));
  const totalEarn = paiseToRupees(data.projected_pay_paise);
  const payoutDate = fmtDate(data.fortnight_end);
  const progressPct = Math.min(100, Math.round((onlineH / targetH) * 100));

  const showOvertime = overtimeH > 0;
  const showAbsence = data.absence_deductions_paise > 0;
  const showCancellation = data.cancellation_deductions_paise > 0;
  const showDeductionsHeader = showAbsence || showCancellation;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('money.title')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />}
      >
        <Text style={styles.fortnightHeader}>
          {fmtDate(data.fortnight_start)} – {fmtDate(data.fortnight_end)}
        </Text>

        {onlineMinutesToday != null && (
          <View style={styles.chip}>
            <View style={styles.dot} />
            <Text style={styles.chipText}>{t('money.onlineChip', { minutes: onlineMinutesToday })}</Text>
          </View>
        )}

        <Text style={styles.bigEarn}>{totalEarn}</Text>
        <Text style={styles.subText}>{t('money.payoutLine', { date: payoutDate })}</Text>

        <View style={styles.progressCard}>
          <Text style={styles.progressLabel}>
            {t('money.progressLine', { current: onlineH, target: targetH })}
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
          </View>
          {showOvertime && (
            <View style={styles.overtimeBox}>
              <Text style={styles.overtimeText}>{t('money.overtimeLine', { hours: overtimeH })}</Text>
            </View>
          )}
        </View>

        <View style={styles.breakdownCard}>
          <BreakdownRow
            colors={c}
            label={t('money.onlinePay', { hours: regularH })}
            amount={paiseToRupees(data.online_pay_paise)}
          />
          {showOvertime && (
            <BreakdownRow
              colors={c}
              label={t('money.overtimePay', { hours: overtimeH })}
              amount={paiseToRupees(data.overtime_pay_paise)}
            />
          )}
          <BreakdownRow
            colors={c}
            label={t('money.jobPay', { hours: jobH })}
            amount={paiseToRupees(data.job_pay_paise)}
          />

          {showDeductionsHeader && (
            <>
              <View style={styles.divider} />
              <Text style={styles.deductionsHeader}>{t('money.deductionsHeader')}</Text>
              {showAbsence && (
                <BreakdownRow
                  colors={c}
                  label={t('money.absenceDeduction')}
                  amount={`-${paiseToRupees(data.absence_deductions_paise)}`}
                  negative
                />
              )}
              {showCancellation && (
                <BreakdownRow
                  colors={c}
                  label={t('money.cancellationDeduction')}
                  amount={`-${paiseToRupees(data.cancellation_deductions_paise)}`}
                  negative
                />
              )}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function BreakdownRow({
  colors,
  label,
  amount,
  negative,
}: { colors: ReturnType<typeof useColors>; label: string; amount: string; negative?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ flex: 1, color: colors.textSecondary, fontFamily: FontFamily.regular, fontSize: FontSize.sm }}>{label}</Text>
      <Text style={{
        color: negative ? colors.danger : colors.text,
        fontFamily: FontFamily.semibold,
        fontSize: FontSize.base,
      }}>{amount}</Text>
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: Spacing.base, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    backBtn: { padding: 4 },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    scroll: { padding: Spacing.lg, gap: Spacing.base, paddingBottom: Spacing['3xl'] },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    fortnightHeader: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      alignSelf: 'center',
      paddingHorizontal: Spacing.base, paddingVertical: 6,
      backgroundColor: c.successBg, borderRadius: Radius.full,
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.success },
    chipText: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: c.success },
    bigEarn: { fontFamily: FontFamily.bold, fontSize: 48, color: c.text, textAlign: 'center', marginTop: Spacing.base },
    subText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    progressCard: {
      backgroundColor: c.surface, borderRadius: Radius.lg, padding: Spacing.lg,
      gap: Spacing.sm, borderWidth: 1, borderColor: c.border, marginTop: Spacing.base,
    },
    progressLabel: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text },
    progressTrack: {
      height: 10, backgroundColor: c.border, borderRadius: 5, overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: c.accent },
    overtimeBox: {
      marginTop: Spacing.sm, padding: Spacing.sm,
      backgroundColor: c.warningBg, borderRadius: Radius.md,
    },
    overtimeText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.warning },
    breakdownCard: {
      backgroundColor: c.surface, borderRadius: Radius.lg, padding: Spacing.lg,
      gap: Spacing.sm, borderWidth: 1, borderColor: c.border,
    },
    divider: { height: 1, backgroundColor: c.border, marginVertical: Spacing.sm },
    deductionsHeader: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.danger },
  });
}
