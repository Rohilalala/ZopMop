// AddressesScreen — dark home pattern.
// Swipeable rows: drag right reveals delete (red), drag left reveals edit
// (amber). Row foreground is opaque #0A0A0A so the actions slide behind.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  
  Alert,
  Animated,
  PanResponder,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useC, type ScreenColors } from '../../theme/screen';
import { listAddresses, deleteAddress, type ApiAddress } from '../../api/addresses';
import { LocationSelector } from '../../components/LocationSelector';

import { Bloom } from '../../components/home/Bloom';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;
const ACTION_WIDTH = 80;

type Props = { navigation: NativeStackNavigationProp<MainStackParamList, 'Addresses'> };

const TAG_ICONS: Record<ApiAddress['tag'], keyof typeof Feather.glyphMap> = {
  Home: 'home',
  Work: 'briefcase',
  Other: 'map-pin',
};

// In-memory cache of the last-fetched address list. Re-entering Addresses
// renders synchronously from this snapshot; refetch runs silently underneath.
const addressesMemCache: { list: ApiAddress[] | null } = { list: null };

export default function AddressesScreen({ navigation }: Props) {
  const { isDark } = useTheme();
  const c = useC();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const { token } = useAuth();
  const insets = useSafeAreaInsets();
  const [addresses, setAddresses] = useState<ApiAddress[]>(addressesMemCache.list ?? []);
  const [loading, setLoading] = useState(addressesMemCache.list == null);
  const [editTarget, setEditTarget] = useState<ApiAddress | null>(null);

  useEffect(() => {
    if (!token || token === '__guest__') return;
    listAddresses(token)
      .then((list) => {
        setAddresses(list);
        addressesMemCache.list = list;
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  function handleEdited(updated: ApiAddress) {
    setAddresses((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    setEditTarget(null);
  }

  function handleDeleted(id: string) {
    setAddresses((prev) => prev.filter((a) => a.id !== id));
    setEditTarget(null);
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
            <Text style={s.title}>Saved addresses</Text>
            <Text style={s.sub}>
              {addresses.length > 0
                ? `${addresses.length} saved · swipe to manage`
                : 'Add a place from the home screen.'}
            </Text>
          </View>
        </View>
      </View>

      {loading ? (
        <LoadingSkeleton variant="list" rows={4} />
      ) : addresses.length === 0 ? (
        <View style={s.empty}>
          <View style={s.emptyIconWrap}>
            <Feather name="map-pin" size={26} color={c.amber} />
          </View>
          <Text style={s.emptyTitle}>No saved addresses</Text>
          <Text style={s.emptySub}>Add a place from the home screen and it'll appear here.</Text>
          <PressFx style={s.emptyCta} onPress={() => navigation.navigate('Home')}>
            <Text style={s.emptyCtaText}>Go home</Text>
          </PressFx>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.list}>
            {addresses.map((addr) => (
              <SwipeableRow
                key={addr.id}
                address={addr}
                token={token}
                onEdit={() => setEditTarget(addr)}
                onDeleted={handleDeleted}
              />
            ))}
          </View>
        </ScrollView>
      )}

      <LocationSelector
        visible={editTarget !== null}
        onClose={() => setEditTarget(null)}
        mode={{ kind: 'manage', editAddress: editTarget ?? undefined }}
        theme={isDark ? 'dark' : 'light'}
        onLocationSelect={() => {
          setEditTarget(null);
          if (!token || token === '__guest__') return;
          listAddresses(token)
            .then((list) => { setAddresses(list); addressesMemCache.list = list; })
            .catch(() => {});
        }}
        onAddressesChanged={() => {
          if (!token || token === '__guest__') return;
          listAddresses(token)
            .then((list) => { setAddresses(list); addressesMemCache.list = list; })
            .catch(() => {});
        }}
      />
    </View>
  );
}

function SwipeableRow({
  address, token, onEdit, onDeleted,
}: {
  address: ApiAddress;
  token: string | null;
  onEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const { isDark } = useTheme();
  const c = useC();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeState = useRef<'closed' | 'left' | 'right'>('closed');

  const close = () => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    swipeState.current = 'closed';
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        const base =
          swipeState.current === 'left' ? -ACTION_WIDTH
          : swipeState.current === 'right' ? ACTION_WIDTH
          : 0;
        translateX.setValue(Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        if (swipeState.current === 'closed') {
          if (g.dx < -30) {
            Animated.spring(translateX, { toValue: -ACTION_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
            swipeState.current = 'left';
          } else if (g.dx > 30) {
            Animated.spring(translateX, { toValue: ACTION_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
            swipeState.current = 'right';
          } else {
            close();
          }
        } else {
          if (
            (swipeState.current === 'left' && g.dx > 20) ||
            (swipeState.current === 'right' && g.dx < -20)
          ) {
            close();
          } else {
            Animated.spring(translateX, {
              toValue: swipeState.current === 'left' ? -ACTION_WIDTH : ACTION_WIDTH,
              useNativeDriver: true,
              bounciness: 4,
            }).start();
          }
        }
      },
    }),
  ).current;

  function confirmDelete() {
    Alert.alert(
      'Delete address?',
      'This address will be removed from your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            close();
            if (!token) return;
            try {
              await deleteAddress(token, address.id);
              onDeleted(address.id);
            } catch (err: any) {
              Alert.alert('Cannot delete', err?.message ?? 'Try again.');
            }
          },
        },
      ],
    );
  }

  return (
    <View style={s.rowWrap}>
      {/* Right swipe → reveals delete on the left side. */}
      <View style={[s.actionSlot, s.actionLeft]}>
        <PressFx style={s.deleteAction} onPress={confirmDelete}>
          {/* Icon on the danger action fill — white in dark, kept white on the
              danger swatch in light too (reads on c.danger). */}
          <Feather name="trash-2" size={17} color="#FFFFFF" />
          <Text style={s.actionText}>Delete</Text>
        </PressFx>
      </View>

      {/* Left swipe → reveals edit on the right side. */}
      <View style={[s.actionSlot, s.actionRight]}>
        <PressFx
          style={s.editAction}
          onPress={() => { close(); onEdit(); }}
        >
          {/* Ink on amber — same in both themes. */}
          <Feather name="edit-2" size={17} color="#0A0A0A" />
          {/* Ink on amber — same in both themes. */}
          <Text style={[s.actionText, { color: '#0A0A0A' }]}>Edit</Text>
        </PressFx>
      </View>

      <Animated.View
        style={[s.row, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={s.tagIcon}>
          <Feather name={TAG_ICONS[address.tag]} size={16} color={c.amber} />
        </View>
        <View style={s.rowInfo}>
          <View style={s.rowTopLine}>
            <Text style={s.rowTag}>{address.tag}</Text>
            {!!address.receiver_name && (
              <Text style={s.rowReceiver} numberOfLines={1}>
                For {address.receiver_name}
              </Text>
            )}
          </View>
          <Text style={s.rowAddress} numberOfLines={2}>
            {address.full_address}
          </Text>
          {(address.flat_no || address.floor || address.building_name) ? (
            <Text style={s.rowDetail} numberOfLines={1}>
              {[address.flat_no, address.floor, address.building_name].filter(Boolean).join(', ')}
            </Text>
          ) : null}
        </View>
        {/* Faint trailing chevron — no useC token at 0.18; keep exact dark
            literal, use c.textMuted in light. */}
        <Feather name="chevron-right" size={14} color={isDark ? 'rgba(255,255,255,0.18)' : c.textMuted} />
      </Animated.View>
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// Slate). useColors()'s dark palette would change this screen's dark look and
// fork the amber. useC() keeps dark identical (#0A0A0A bg + #F5A300 amber) and
// adds the cream + amber light surface, matching the other migrated screens.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Raised opaque row foreground that slides over rowWrap: #0A0A0A in dark
  // (= bg, kept exact); white surface in light so it fully covers the row
  // behind it. rowWrap supplies the border; the row is clipped (overflow
  // hidden) so no shadow is added here.
  const rowSurface = isDark ? '#0A0A0A' : c.white;
  // Danger action fill — exact red in dark, deep danger token in light.
  const danger = isDark ? '#EF4444' : c.danger;

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    // Sticky head
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
      paddingHorizontal: 32, gap: 12,
    },
    emptyIconWrap: {
      width: 76, height: 76, borderRadius: 38,
      alignItems: 'center', justifyContent: 'center',
      // Amber-tint fill/border — same in both themes (amber is shared).
      backgroundColor: 'rgba(245,163,0,0.14)',
      borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
      marginBottom: 8,
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
      marginBottom: 6,
    },
    emptyCta: {
      backgroundColor: c.amber,
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 22,
    },
    emptyCtaText: {
      ...fontBold,
      // Ink on amber — same in both themes.
      fontSize: 13.5, color: '#0A0A0A', letterSpacing: 0.1,
    },

    // List
    list: { paddingHorizontal: H_PAD, gap: 10, paddingTop: 4 },

    rowWrap: {
      borderRadius: 18,
      overflow: 'hidden',
      height: 84,
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
    },
    actionSlot: { position: 'absolute', top: 0, bottom: 0, width: ACTION_WIDTH },
    actionLeft: { left: 0 },
    actionRight: { right: 0 },
    deleteAction: {
      flex: 1, backgroundColor: danger,
      alignItems: 'center', justifyContent: 'center', gap: 4,
    },
    editAction: {
      flex: 1, backgroundColor: c.amber,
      alignItems: 'center', justifyContent: 'center', gap: 4,
    },
    actionText: {
      ...fontBold,
      // Label on the colored action fill — white in both themes (edit overrides
      // to ink inline since its fill is amber).
      fontSize: 11, color: '#FFFFFF', letterSpacing: 0.2,
    },

    row: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      backgroundColor: rowSurface,
    },
    tagIcon: {
      width: 38, height: 38, borderRadius: 12,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.amberSoft,
    },
    rowInfo: { flex: 1, minWidth: 0 },
    rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
    rowTag: {
      ...fontBold,
      fontSize: 13.5, color: c.text, letterSpacing: -0.1,
    },
    rowReceiver: {
      flex: 1,
      ...fontMed,
      fontSize: 11, color: c.textMuted,
    },
    rowAddress: {
      ...fontMed,
      fontSize: 12, color: c.textSecondary,
      lineHeight: 16,
    },
    rowDetail: {
      ...fontMed,
      fontSize: 11, color: c.textMuted,
      marginTop: 1,
    },
  });
}
