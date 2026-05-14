// ProLeaveHistoryScreen — read-only list of past leave declarations.
// One row per leave: date, status, source (self vs admin grant). Backend
// doesn't currently surface "bookings affected per leave" as a single number,
// so we omit it rather than ship a misleading column. The CRM-side dashboard
// shows the per-row reassignment breakdown.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { FontFamily } from '../../theme';
import { getHistory, type LeaveRow } from '../../api/leave';
import OfflineBanner from '../../components/OfflineBanner';

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
  useProRoleGate();
  const nav = useNavigation<Nav>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!token) return;
    try {
      const list = await getHistory(token, 100);
      setRows(list);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    loadHistory().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [loadHistory]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadHistory();
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <OfflineBanner />
      <View style={s.headerBar}>
        <TouchableOpacity onPress={() => nav.goBack()} accessibilityLabel="Go back" accessibilityRole="button" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Feather name="arrow-left" size={20} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Leave history</Text>
        <View style={{ width: 28 }} />
      </View>

      {loading ? (
        <View style={s.content}>
          <LoadingSkeleton variant="list" rows={4} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListEmptyComponent={<Text style={s.empty}>No leave history yet.</Text>}
          renderItem={({ item: r }) => (
            <View style={s.row}>
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
          )}
        />
      )}
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
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
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
