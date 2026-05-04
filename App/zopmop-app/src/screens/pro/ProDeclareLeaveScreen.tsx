// ProDeclareLeaveScreen — confirms tomorrow's leave declaration. Reads balance
// and affected bookings, shows the post-declaration balance, then POSTs to
// /pro/leave/declare. Outcome screen reflects the reassignment / cancellation
// breakdown returned by the backend.

import React, { useEffect, useMemo, useState } from 'react';
import {
  
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { FontFamily } from '../../theme';
import {
  declare as declareLeave,
  getAffectedTomorrow,
  getBalance,
  type AffectedBooking,
  type DeclareError,
  type DeclareResult,
  type LeaveBalance,
} from '../../api/leave';

type Nav = NativeStackNavigationProp<MainStackParamList>;

function tomorrowDateISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // Convert to IST date string (YYYY-MM-DD).
  const istParts = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return istParts;
}

function fmtTomorrowHuman(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function fmtSlotIST(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

export default function ProDeclareLeaveScreen() {
  const nav = useNavigation<Nav>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [bookings, setBookings] = useState<AffectedBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DeclareResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [bal, aff] = await Promise.all([
          getBalance(token).catch(() => null),
          getAffectedTomorrow(token).catch(() => [] as AffectedBooking[]),
        ]);
        if (cancelled) return;
        setBalance(bal);
        setBookings(aff);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function onConfirm() {
    if (!token || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const r = await declareLeave(token, tomorrowDateISO());
      setResult(r);
    } catch (e) {
      const err = e as DeclareError;
      setErrorMsg(err?.message || 'Could not declare leave. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success view ─────────────────────────────────────────────────────────
  if (result) {
    const reassigned = result.reassigned_count;
    const cancelled = result.cancelled_count;
    let summary = 'Leave declared. Affected bookings will be reassigned.';
    if (cancelled > 0) {
      summary = `Leave declared. ${cancelled} booking${cancelled === 1 ? '' : 's'} could not be reassigned and ${cancelled === 1 ? 'has' : 'have'} been cancelled. Customers have been notified.`;
    } else if (reassigned === 0) {
      summary = 'Leave declared. No bookings were affected.';
    }
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <Header title="Leave declared" onBack={() => nav.goBack()} colors={c} />
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.card}>
            <Feather name="check-circle" size={32} color="#3DDC84" style={{ marginBottom: 12 }} />
            <Text style={s.cardTitle}>{summary}</Text>
            <Text style={s.cardSub}>
              Balance: {result.balance.balance} / {result.balance.quota}
            </Text>
          </View>
          <TouchableOpacity onPress={() => nav.goBack()} style={s.primaryBtn} activeOpacity={0.85}>
            <Text style={s.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Confirmation view ────────────────────────────────────────────────────
  const noBalance = balance != null && balance.balance <= 0;
  const balanceAfter = balance ? Math.max(0, balance.balance - 1) : 0;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Header title="Declare leave" onBack={() => nav.goBack()} colors={c} />
      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <LoadingSkeleton variant="block" />
        ) : (
          <>
            <View style={s.card}>
              <Text style={s.label}>Date</Text>
              <Text style={s.value}>{fmtTomorrowHuman()}</Text>
            </View>

            {noBalance ? (
              <View style={s.card}>
                <Feather name="alert-triangle" size={20} color={c.primary} style={{ marginBottom: 8 }} />
                <Text style={s.cardTitle}>No leave days remaining.</Text>
                <Text style={s.cardSub}>Contact your manager to allocate additional leave.</Text>
              </View>
            ) : (
              <>
                <View style={s.card}>
                  <Text style={s.label}>Affected bookings</Text>
                  {bookings.length === 0 ? (
                    <Text style={s.cardSub}>No bookings scheduled for tomorrow.</Text>
                  ) : (
                    bookings.map((b) => (
                      <View key={b.ID} style={s.bookingRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={s.bookingTitle} numberOfLines={1}>
                            {b.ServiceName || 'Scheduled service'}
                          </Text>
                          <Text style={s.bookingSub} numberOfLines={1}>
                            {b.CustomerName || 'Customer'} · {fmtSlotIST(b.ScheduledTime)}
                          </Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>

                {balance && (
                  <View style={s.card}>
                    <Text style={s.label}>Leave balance after declaration</Text>
                    <Text style={s.value}>
                      {balanceAfter} / {balance.quota}
                    </Text>
                  </View>
                )}

                {errorMsg && (
                  <Text style={[s.cardSub, { color: '#FF6B6B', textAlign: 'center' }]}>
                    {errorMsg}
                  </Text>
                )}

                <TouchableOpacity
                  onPress={onConfirm}
                  disabled={submitting}
                  activeOpacity={0.85}
                  style={[s.primaryBtn, submitting && { opacity: 0.6 }]}
                >
                  {submitting ? (
                    <LoadingBars size="small" color="#0D0D0F" />
                  ) : (
                    <Text style={s.primaryBtnText}>Confirm Leave</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({
  title,
  onBack,
  colors,
}: {
  title: string;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
      <TouchableOpacity onPress={onBack} hitSlop={10} style={{ padding: 4 }}>
        <Feather name="arrow-left" size={20} color={colors.text} />
      </TouchableOpacity>
      <Text
        style={{
          flex: 1,
          textAlign: 'center',
          marginRight: 28,
          color: colors.text,
          fontFamily: FontFamily.bold,
          fontSize: 16,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, gap: 12 },
    card: {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.06)',
    },
    cardTitle: { color: c.text, fontFamily: FontFamily.bold, fontSize: 15, marginBottom: 4 },
    cardSub: { color: c.textMuted, fontFamily: FontFamily.regular, fontSize: 13, lineHeight: 18 },
    label: {
      color: c.textMuted,
      fontFamily: FontFamily.medium,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 6,
    },
    value: { color: c.text, fontFamily: FontFamily.bold, fontSize: 16 },
    bookingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: 'rgba(255,255,255,0.06)',
    },
    bookingTitle: { color: c.text, fontFamily: FontFamily.medium, fontSize: 13 },
    bookingSub: { color: c.textMuted, fontFamily: FontFamily.regular, fontSize: 12, marginTop: 2 },
    primaryBtn: {
      marginTop: 4,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: c.primary,
      alignItems: 'center',
    },
    primaryBtnText: { color: '#0D0D0F', fontFamily: FontFamily.bold, fontSize: 14, letterSpacing: 0.2 },
  });
}
