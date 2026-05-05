// ProProfileScreen — read-only profile for pros plus a link to leave history.
// Kept intentionally minimal: name, phone, role/status. Pros edit profile from
// onboarding; this is the dashboard entry point, not a settings page.

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { FontFamily } from '../../theme';

type Nav = NativeStackNavigationProp<MainStackParamList>;

export default function ProProfileScreen() {
  useProRoleGate();
  const nav = useNavigation<Nav>();
  const { user } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const initial = (user?.name?.[0] ?? user?.phone?.[0] ?? '?').toUpperCase();

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.headerBar}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={{ padding: 4 }}>
          <Feather name="arrow-left" size={20} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Profile</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={s.content}>
        <View style={s.avatarWrap}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initial}</Text>
          </View>
          <Text style={s.name}>{user?.name || 'Pro'}</Text>
          <Text style={s.role}>{(user?.role || '').toUpperCase()}</Text>
        </View>

        <View style={s.card}>
          <Row icon="phone" label="Phone" value={user?.phone || '—'} />
          <Divider />
          <Row icon="user-check" label="Account status" value={user ? 'Active' : 'Unknown'} />
        </View>

        <TouchableOpacity
          style={s.linkRow}
          activeOpacity={0.7}
          onPress={() => nav.navigate('ProLeaveHistory')}
        >
          <Feather name="calendar" size={16} color={c.text} style={{ marginRight: 12 }} />
          <Text style={s.linkLabel}>Leave history</Text>
          <Feather name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ icon, label, value }: { icon: React.ComponentProps<typeof Feather>['name']; label: string; value: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.row}>
      <Feather name={icon} size={16} color={c.textMuted} style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

function Divider() {
  const c = useColors();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: c.border ?? 'rgba(255,255,255,0.06)',
        marginLeft: 28,
      }}
    />
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    headerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    headerTitle: { color: c.text, fontFamily: FontFamily.bold, fontSize: 16 },
    content: { padding: 16, gap: 16 },
    avatarWrap: { alignItems: 'center', marginTop: 8 },
    avatar: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: 'rgba(245,163,0,0.12)',
      borderWidth: 2,
      borderColor: 'rgba(245,163,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    avatarText: { color: c.primary, fontFamily: FontFamily.bold, fontSize: 32 },
    name: { color: c.text, fontFamily: FontFamily.bold, fontSize: 18 },
    role: {
      marginTop: 4,
      color: c.textMuted,
      fontFamily: FontFamily.medium,
      fontSize: 11,
      letterSpacing: 1.2,
    },
    card: {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 16,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.06)',
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
    rowLabel: { color: c.textMuted, fontFamily: FontFamily.regular, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
    rowValue: { color: c.text, fontFamily: FontFamily.medium, fontSize: 14, marginTop: 2 },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 14,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.06)',
    },
    linkLabel: { flex: 1, color: c.text, fontFamily: FontFamily.medium, fontSize: 14 },
  });
}
