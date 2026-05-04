// ProLeaveHistoryScreen — read-only list of past leave declarations.
// One row per leave: date, status, source (self vs admin grant). Backend
// doesn't currently surface "bookings affected per leave" as a single number,
// so we omit it rather than ship a misleading column. The CRM-side dashboard
// shows the per-row reassignment breakdown.

import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { FontFamily } from '../../theme';
import { getHistory, type LeaveRow } from '../../api/leave';

type Nav = NativeStackNavigationProp<MainStackParamList>;

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function ProLeaveHistoryScreen() {
  const nav = useNavigation<Nav>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await getHistory(token, 100);
        if (!cancelled) setRows(list);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.headerBar}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={{ padding: 4 }}>
          <Feather name="arrow-left" size={20} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Leave history</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <LoadingSkeleton variant="list" rows={4} />
        ) : rows.length === 0 ? (
          <Text style={s.empty}>No leave history yet.</Text>
        ) : (
          rows.map((r) => (
            <View key={r.id} style={s.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.rowDate}>{fmtDate(r.date)}</Text>
                <Text style={s.rowSub}>
                  {r.source === 'admin' ? 'Admin allocated' : 'Self declared'}
                  {r.note ? ` · ${r.note}` : ''}
                </Text>
              </View>
              <View
                style={[
                  s.statusPill,
                  r.status === 'approved' ? s.statusApproved : s.statusCancelled,
                ]}
              >
                <Text
                  style={[
                    s.statusText,
                    r.status === 'approved' ? { color: '#3DDC84' } : { color: '#FF6B6B' },
                  ]}
                >
                  {r.status}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
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
    content: { padding: 16, gap: 8 },
    empty: { color: c.textMuted, fontFamily: FontFamily.regular, fontSize: 13, textAlign: 'center', marginTop: 32 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 14,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.06)',
    },
    rowDate: { color: c.text, fontFamily: FontFamily.bold, fontSize: 14 },
    rowSub: { color: c.textMuted, fontFamily: FontFamily.regular, fontSize: 12, marginTop: 2 },
    statusPill: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
    },
    statusApproved: { borderColor: 'rgba(61,220,132,0.45)', backgroundColor: 'rgba(61,220,132,0.10)' },
    statusCancelled: { borderColor: 'rgba(255,107,107,0.45)', backgroundColor: 'rgba(255,107,107,0.10)' },
    statusText: { fontFamily: FontFamily.medium, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  });
}
