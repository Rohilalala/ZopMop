import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Constants from 'expo-constants';

import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { getCurrentZone, getFortnightProgress, type ZoneInfo, type FortnightProgress } from '../../api/shifts';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t, useLocale } from '../../i18n';
import { showError } from '../../utils/toast';

const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '+918000000000';

function formatPhone10(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return `${last10.slice(0, 5)} ${last10.slice(5)}`;
}

function avatarInitial(name?: string): string {
  if (!name) return '?';
  const first = name.trim()[0];
  return first ? first.toUpperCase() : '?';
}

function shortEmployeeId(id?: string): string {
  if (!id) return '';
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function paiseToRupeesShort(p: number): string {
  return `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
}

export default function ProProfileScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { user, signOut } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [zone, setZone] = useState<ZoneInfo | null>(null);
  const [progress, setProgress] = useState<FortnightProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [zoneRes, progRes] = await Promise.allSettled([
      getCurrentZone(),
      getFortnightProgress(),
    ]);
    if (zoneRes.status === 'fulfilled') setZone(zoneRes.value);
    if (progRes.status === 'fulfilled') setProgress(progRes.value);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  function handleLogout() {
    Alert.alert(
      t('profile.logout'),
      t('profile.logoutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('profile.logout'), style: 'destructive', onPress: signOut },
      ],
    );
  }

  function handleSupport() {
    const tel = `tel:${SUPPORT_PHONE}`;
    Linking.canOpenURL(tel)
      .then((ok) => {
        if (ok) return Linking.openURL(tel);
        showError(`Call us at ${SUPPORT_PHONE}`, { title: "Couldn't open dialer" });
      })
      .catch(() => showError(`Call us at ${SUPPORT_PHONE}`, { title: "Couldn't open dialer" }));
  }

  function handleAbout() {
    const version = Constants.expoConfig?.version ?? '1.0.0';
    const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '';
    Alert.alert('ZopMop', `${t('profile.version')}: ${version}${build ? ` (${build})` : ''}`);
  }

  const onlineH = progress ? Math.round((progress.online_minutes / 60) * 10) / 10 : 0;
  // Per-pro tunable target from the backend; legacy 80h fallback only if the
  // field is missing/zero on an older server.
  const targetH = progress && progress.target_minutes > 0 ? progress.target_minutes / 60 : 80;
  const earnings = progress ? paiseToRupeesShort(progress.projected_pay_paise) : '—';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />}
      >
        <View style={styles.headerWrap}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarInitial(user?.name)}</Text>
          </View>
          <Text style={styles.name}>{user?.name ?? ''}</Text>
          <Text style={styles.phone}>{formatPhone10(user?.phone)}</Text>
          <Text style={styles.empId}>{t('profile.employeeId')} · {shortEmployeeId(user?.id)}</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Feather name="map-pin" size={16} color={c.accent} />
            <Text style={styles.cardHeaderText}>{t('profile.assignedArea')}</Text>
          </View>
          {zone ? (
            <Text style={styles.zoneName}>{zone.name}</Text>
          ) : (
            <Text style={styles.zoneMuted}>{t('profile.noZone')}</Text>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Feather name="bar-chart-2" size={16} color={c.accent} />
            <Text style={styles.cardHeaderText}>{t('profile.thisFortnight')}</Text>
          </View>
          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <Text style={styles.statLabel}>{t('profile.onlineHours')}</Text>
              <Text style={styles.statValue}>{onlineH} / {targetH}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statLabel}>{t('profile.totalEarnings')}</Text>
              <Text style={styles.statValue}>{earnings}</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <SettingsRow
            colors={c}
            icon="calendar"
            label={t('profile.declareLeave')}
            onPress={() => navigation.navigate('ProDeclareLeave')}
          />
          <View style={styles.rowDivider} />
          <SettingsRow
            colors={c}
            icon="clock"
            label={t('profile.leaveHistory')}
            onPress={() => navigation.navigate('ProLeaveHistory')}
          />
          <View style={styles.rowDivider} />
          <SettingsRow
            colors={c}
            icon="globe"
            label={t('profile.changeLanguage')}
            onPress={() => navigation.navigate('LanguageToggle')}
          />
          <View style={styles.rowDivider} />
          <SettingsRow
            colors={c}
            icon="phone"
            label={t('profile.support')}
            onPress={handleSupport}
          />
          <View style={styles.rowDivider} />
          <SettingsRow
            colors={c}
            icon="info"
            label={t('profile.about')}
            onPress={handleAbout}
          />
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Feather name="log-out" size={16} color={c.accent} />
          <Text style={styles.logoutText}>{t('profile.logout')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsRow({
  colors,
  icon,
  label,
  onPress,
}: { colors: ReturnType<typeof useColors>; icon: React.ComponentProps<typeof Feather>['name']; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.base, gap: Spacing.base }}
      onPress={onPress}
    >
      <Feather name={icon} size={18} color={colors.text} />
      <Text style={{ flex: 1, color: colors.text, fontFamily: FontFamily.medium, fontSize: FontSize.base }}>{label}</Text>
      <Feather name="chevron-right" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    scroll: { padding: Spacing.lg, gap: Spacing.base, paddingBottom: Spacing['3xl'] },
    headerWrap: { alignItems: 'center', gap: 6, paddingVertical: Spacing.lg },
    avatar: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center',
      borderWidth: 2, borderColor: c.accent,
    },
    avatarText: { fontFamily: FontFamily.bold, fontSize: 36, color: c.accent },
    name: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text, marginTop: Spacing.sm },
    phone: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.textSecondary },
    empId: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, letterSpacing: 1 },
    card: {
      backgroundColor: c.surface, borderRadius: Radius.lg, padding: Spacing.lg,
      borderWidth: 1, borderColor: c.border, gap: Spacing.sm,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cardHeaderText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
    zoneName: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    zoneMuted: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textMuted },
    statsRow: { flexDirection: 'row', alignItems: 'center', paddingTop: Spacing.sm },
    statCell: { flex: 1, gap: 4 },
    statLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    statValue: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    statDivider: { width: 1, height: 32, backgroundColor: c.border },
    rowDivider: { height: 1, backgroundColor: c.border, marginLeft: Spacing.base + 18 + Spacing.base },
    logoutBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: Spacing.sm, marginTop: Spacing.lg,
      paddingVertical: Spacing.base, borderRadius: Radius.lg,
      borderWidth: 1, borderColor: c.accent,
    },
    logoutText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.accent },
  });
}
