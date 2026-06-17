// YourExpertsScreen — dark home pattern.
// Customer-facing list of preferred helpers (max 5). Backed by /me/experts;
// helpers are added from the post-job rating screen, not from this list.
// Long-press a row to remove.

import React, { useCallback, useMemo, useState } from 'react';
import {
  
  Alert,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { listExperts, removeExpert, type Expert } from '../../api/experts';
import { haptics } from '../../utils/haptics';
import { friendlyError } from '../../utils/errors';
import { showError, showSuccess } from '../../utils/toast';

import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;

// Module-level cache: re-entering keeps last expert list visible while we
// silently revalidate on focus.
const expertsMemCache: { list: Expert[] | null } = { list: null };

export default function YourExpertsScreen() {
  const c = useC();
  const { isDark } = useTheme();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [experts, setExperts] = useState<Expert[]>(expertsMemCache.list ?? []);
  const [loading, setLoading] = useState(expertsMemCache.list == null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || token === '__guest__') {
      setLoading(false);
      return;
    }
    try {
      const res = await listExperts(token);
      setExperts(res.experts);
      expertsMemCache.list = res.experts;
    } catch (err) {
      console.warn('[YourExperts] load failed', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      // Only show skeleton on the very first load. Subsequent focuses
      // refetch silently in the background.
      if (expertsMemCache.list == null) setLoading(true);
      load();
    }, [load]),
  );

  function confirmRemove(e: Expert) {
    haptics.warning();
    Alert.alert(
      'Remove expert?',
      `${e.name} will no longer get first pick of your bookings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (!token) return;
            setRemovingId(e.helper_id);
            try {
              await removeExpert(token, e.helper_id);
              setExperts((prev) => prev.filter((x) => x.helper_id !== e.helper_id));
              showSuccess(`${e.name} removed from Your Experts.`);
            } catch (err: any) {
              showError(friendlyError(err, 'Couldn’t remove this expert. Please try again.'));
            } finally {
              setRemovingId(null);
            }
          },
        },
      ],
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <View style={s.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
            <Feather name="chevron-left" size={18} color={c.text} />
          </PressFx>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Your experts</Text>
            <Text style={s.sub}>
              {experts.length > 0
                ? `${experts.length}/5 · first pick of your bookings`
                : 'Up to 5 pros get first pick of your bookings.'}
            </Text>
          </View>
        </View>
      </View>

      {loading ? (
        <LoadingSkeleton variant="list" rows={4} />
      ) : experts.length === 0 ? (
        <View style={s.empty}>
          <View style={s.emptyIconWrap}>
            <Feather name="users" size={26} color={c.amber} />
          </View>
          <Text style={s.emptyTitle}>No experts yet</Text>
          <Text style={s.emptySub}>
            After a service, add the pro as your expert from the rating screen. They'll get first pick of future bookings.
          </Text>
        </View>
      ) : (
        <View style={s.list}>
          {experts.map((e) => (
            <PressFx
              key={e.helper_id}
              onLongPress={() => confirmRemove(e)}
              style={s.card}
            >
              <View style={s.avatar}>
                <Text style={s.avatarText}>
                  {(e.name || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{e.name}</Text>
                <View style={s.metaRow}>
                  {typeof e.average_rating === 'number' ? (
                    <View style={s.metaPill}>
                      <Text style={s.starGlyph}>★</Text>
                      <Text style={s.metaText}>{e.average_rating.toFixed(1)}</Text>
                    </View>
                  ) : null}
                  <Text style={s.metaSub}>
                    {e.completed_jobs_with_user}{' '}
                    {e.completed_jobs_with_user === 1 ? 'job' : 'jobs'} with you
                  </Text>
                </View>
              </View>
              {removingId === e.helper_id ? (
                <LoadingBars color={c.amber} />
              ) : (
                <PressFx onPress={() => confirmRemove(e)} style={s.removeBtn}>
                  <Feather name="x" size={16} color={c.textSecondary} />
                </PressFx>
              )}
            </PressFx>
          ))}
          <Text style={s.hint}>Long-press a card to remove.</Text>
        </View>
      )}
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). useColors()'s dark palette is Slate (#0F172A bg / slate surface),
// which would change this screen's dark look and fork the amber — breaking
// "dark pixel-identical" + "amber #F5A300 in both". useC() keeps dark at
// #0A0A0A + amber identical and adds the cream + amber light bg, matching the
// other migrated screens (Wallet, ReferralEarn).
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Ink that sits on the amber avatar — theme-independent (avatar is amber in
  // both themes, so its text stays dark ink in both). Ink on amber — same in
  // both themes.
  const onAmber = '#0A0A0A';

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    iconBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glassHi,
      borderWidth: 0.5, borderColor: c.glassBorderHi,
    },
    title: {
      ...fontExtra,
      fontSize: 24, color: c.text,
      letterSpacing: -0.6, lineHeight: 28,
    },
    sub: {
      ...fontMed,
      fontSize: 12, color: c.textMuted,
      marginTop: 2,
    },

    // Empty
    empty: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 32, gap: 10,
    },
    emptyIconWrap: {
      width: 76, height: 76, borderRadius: 38,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.amberSoft,
      borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
      marginBottom: 6,
    },
    emptyTitle: {
      ...fontExtra,
      fontSize: 20, color: c.text,
      letterSpacing: -0.4,
    },
    emptySub: {
      ...fontMed,
      fontSize: 13, color: c.textSecondary,
      textAlign: 'center', lineHeight: 19,
    },

    list: { paddingHorizontal: H_PAD, paddingTop: 8, gap: 10 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderRadius: 18,
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
    },
    avatar: {
      width: 50, height: 50, borderRadius: 25,
      backgroundColor: c.amber,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarText: {
      ...fontExtra,
      // Ink on amber — same in both themes.
      fontSize: 19, color: onAmber,
    },
    name: {
      ...fontBold,
      fontSize: 15, color: c.text,
      letterSpacing: -0.2,
      marginBottom: 4,
    },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    metaPill: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      backgroundColor: c.amberSoft,
      paddingHorizontal: 8, paddingVertical: 3,
      borderRadius: 99,
    },
    starGlyph: {
      ...fontBold,
      fontSize: 10.5, color: c.amber,
    },
    metaText: {
      ...fontSemi,
      fontSize: 11, color: c.amber,
    },
    metaSub: {
      ...fontMed,
      fontSize: 12, color: c.textMuted,
    },
    removeBtn: {
      width: 32, height: 32, borderRadius: 11,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glass,
    },
    hint: {
      ...fontMed,
      textAlign: 'center',
      fontSize: 12, color: c.textMuted,
      marginTop: 6,
    },
  });
}
