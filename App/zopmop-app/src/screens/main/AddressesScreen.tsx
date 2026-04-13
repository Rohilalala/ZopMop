import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Animated,
  PanResponder,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import EditAddressModal from '../../components/EditAddressModal';

type Props = { navigation: NativeStackNavigationProp<MainStackParamList, 'Addresses'> };

const TAG_ICONS: Record<ApiAddress['tag'], string> = {
  Home: 'home-outline',
  Work: 'briefcase-outline',
  Other: 'location-outline',
};
const ACTION_WIDTH = 80;

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AddressesScreen({ navigation }: Props) {
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<ApiAddress | null>(null);

  useEffect(() => {
    if (!token || token === '__guest__') return;
    listAddresses(token)
      .then(setAddresses)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleEdited(updated: ApiAddress) {
    setAddresses(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    setEditTarget(null);
  }

  function handleDeleted(id: string) {
    setAddresses(prev => prev.filter(a => a.id !== id));
    setEditTarget(null);
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={20} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Saved Addresses</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : addresses.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="location-outline" size={48} color={c.textMuted} />
          <Text style={s.emptyTitle}>No saved addresses</Text>
          <Text style={s.emptySub}>Addresses you save will appear here</Text>
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.hint}>Swipe left to edit  ·  Swipe right to delete</Text>
          {addresses.map(addr => (
            <SwipeableRow
              key={addr.id}
              address={addr}
              onEdit={() => setEditTarget(addr)}
              onDeleted={handleDeleted}
            />
          ))}
          <View style={{ height: 32 }} />
        </ScrollView>
      )}

      <EditAddressModal
        address={editTarget}
        token={token}
        onClose={() => setEditTarget(null)}
        onSaved={handleEdited}
        onDeleted={handleDeleted}
      />
    </SafeAreaView>
  );
}

// ── Swipeable Row ─────────────────────────────────────────────────────────────

function SwipeableRow({
  address,
  onEdit,
  onDeleted,
}: {
  address: ApiAddress;
  onEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeState = useRef<'closed' | 'left' | 'right'>('closed');

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

  function close() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    swipeState.current = 'closed';
  }

  function confirmDelete() {
    Alert.alert('Delete Address', 'Are you sure you want to delete this address?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => { close(); onDeleted(address.id); },
      },
    ]);
  }

  return (
    <View style={s.rowWrap}>
      {/* Delete — revealed on swipe right */}
      <View style={[s.actionSlot, s.actionLeft]}>
        <TouchableOpacity style={s.deleteAction} activeOpacity={0.85} onPress={confirmDelete}>
          <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
          <Text style={s.actionText}>Delete</Text>
        </TouchableOpacity>
      </View>

      {/* Edit — revealed on swipe left */}
      <View style={[s.actionSlot, s.actionRight]}>
        <TouchableOpacity style={s.editAction} activeOpacity={0.85} onPress={() => { close(); onEdit(); }}>
          <Ionicons name="create-outline" size={20} color="#FFFFFF" />
          <Text style={s.actionText}>Edit</Text>
        </TouchableOpacity>
      </View>

      <Animated.View style={[s.row, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <View style={s.tagIconBox}>
          <Ionicons name={TAG_ICONS[address.tag] as any} size={20} color={c.primary} />
        </View>
        <View style={s.rowInfo}>
          <View style={s.rowTopLine}>
            <Text style={s.rowTag}>{address.tag}</Text>
            {address.receiver_name ? (
              <Text style={s.rowReceiver} numberOfLines={1}>For {address.receiver_name}</Text>
            ) : null}
          </View>
          <Text style={s.rowAddress} numberOfLines={2}>{address.full_address}</Text>
          {(address.flat_no || address.floor || address.building_name) ? (
            <Text style={s.rowDetail} numberOfLines={1}>
              {[address.flat_no, address.floor, address.building_name].filter(Boolean).join(', ')}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const H_PAD = 16;

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flex: 1 },
    content: { paddingTop: 4 },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: H_PAD,
      paddingTop: 8,
      paddingBottom: 14,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: Radius.full,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      flex: 1,
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: c.text,
      textAlign: 'center',
      letterSpacing: -0.3,
    },

    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
    emptyTitle: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.textSecondary,
      marginTop: 8,
    },
    emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted },

    hint: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      textAlign: 'center',
      paddingVertical: 10,
    },

    // Swipeable row
    rowWrap: {
      marginHorizontal: H_PAD,
      marginBottom: 10,
      borderRadius: Radius.xl,
      overflow: 'hidden',
      height: 76,
      ...Shadow.sm,
    },
    actionSlot: { position: 'absolute', top: 0, bottom: 0, width: ACTION_WIDTH },
    actionLeft: { left: 0 },
    actionRight: { right: 0 },
    deleteAction: {
      flex: 1,
      backgroundColor: c.danger,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      borderTopLeftRadius: Radius.xl,
      borderBottomLeftRadius: Radius.xl,
    },
    editAction: {
      flex: 1,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      borderTopRightRadius: Radius.xl,
      borderBottomRightRadius: Radius.xl,
    },
    actionText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: '#FFFFFF' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.white,
      paddingHorizontal: Spacing.base,
      paddingVertical: 14,
      gap: 14,
      borderRadius: Radius.xl,
      height: 76,
    },
    tagIconBox: {
      width: 44,
      height: 44,
      borderRadius: Radius.lg,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowInfo: { flex: 1 },
    rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    rowTag: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    rowReceiver: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      flex: 1,
    },
    rowAddress: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      lineHeight: 18,
    },
    rowDetail: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 2 },
  });
}
