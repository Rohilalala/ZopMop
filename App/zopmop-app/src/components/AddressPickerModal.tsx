import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  PanResponder,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, Radius, Shadow, Spacing } from '../theme';
import { deleteAddress, type ApiAddress } from '../api/addresses';
import { showError } from '../utils/toast';
import { haptics } from '../utils/haptics';
import EditAddressModal from './EditAddressModal';
import LocationSelectorModal from './LocationSelectorModal';

const SWIPE_WIDTH = 80;
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const TAG_ICONS: Record<ApiAddress['tag'], string> = {
  Home: 'home-outline',
  Work: 'briefcase-outline',
  Other: 'location-outline',
};

interface Props {
  visible: boolean;
  token: string | null;
  addresses: ApiAddress[];
  selectedId: string | null;
  onSelect: (address: ApiAddress) => void;
  onClose: () => void;
  onAddressEdited: (address: ApiAddress) => void;
  onAddressDeleted: (id: string) => void;
  onRefreshAddresses: (newLat?: number, newLon?: number) => void;
}

export default function AddressPickerModal({
  visible,
  token,
  addresses,
  selectedId,
  onSelect,
  onClose,
  onAddressEdited,
  onAddressDeleted,
  onRefreshAddresses,
}: Props) {
  const [editTarget, setEditTarget] = useState<ApiAddress | null>(null);
  const [locationModalVisible, setLocationModalVisible] = useState(false);

  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 22,
        stiffness: 200,
      }).start();
    } else {
      Animated.timing(slideAnim, { toValue: SCREEN_HEIGHT, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);

  function handleDelete(addr: ApiAddress) {
    Alert.alert('Delete Address', 'Are you sure you want to delete this address?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!token) return;
          try {
            await deleteAddress(token, addr.id);
            onAddressDeleted(addr.id);
          } catch {
            showError('Could not delete. Please try again.');
          }
        },
      },
    ]);
  }

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
      >
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />

          <Animated.View
            style={[s.sheet, { transform: [{ translateY: slideAnim }] }]}
          >
            <View style={s.handle} />

            {/* Header */}
            <View style={s.header}>
              <Text style={s.title}>Select Address</Text>
              <TouchableOpacity style={s.closeBtn} onPress={onClose} activeOpacity={0.7}>
                <Ionicons name="close" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Add new address */}
            <TouchableOpacity
              style={s.addNewRow}
              activeOpacity={0.8}
              onPress={() => setLocationModalVisible(true)}
            >
              <View style={s.addNewIconBox}>
                <Ionicons name="add" size={20} color={Colors.primary} />
              </View>
              <Text style={s.addNewText}>Add new address</Text>
              <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
            </TouchableOpacity>

            <View style={s.sectionDivider} />

            {addresses.length === 0 ? (
              <View style={s.emptyWrap}>
                <Ionicons name="location-outline" size={36} color={Colors.textMuted} />
                <Text style={s.emptyText}>No saved addresses</Text>
                <Text style={s.emptySub}>Tap above to add your first address</Text>
              </View>
            ) : (
              <ScrollView
                style={s.scroll}
                contentContainerStyle={s.scrollContent}
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                <Text style={s.swipeHint}>Swipe left to edit  ·  Swipe right to delete</Text>
                {addresses.map(addr => (
                  <SwipeableAddressRow
                    key={addr.id}
                    address={addr}
                    selected={addr.id === selectedId}
                    onSelect={() => { haptics.light(); onSelect(addr); onClose(); }}
                    onEdit={() => setEditTarget(addr)}
                    onDelete={() => handleDelete(addr)}
                  />
                ))}
                <View style={{ height: 16 }} />
              </ScrollView>
            )}
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>

      <EditAddressModal
        address={editTarget}
        token={token}
        onClose={() => setEditTarget(null)}
        onSaved={addr => { onAddressEdited(addr); setEditTarget(null); }}
        onDeleted={id => { onAddressDeleted(id); setEditTarget(null); }}
      />

      <LocationSelectorModal
        visible={locationModalVisible}
        onClose={() => setLocationModalVisible(false)}
        onLocationSelect={(_name, lat, lon) => {
          setLocationModalVisible(false);
          onRefreshAddresses(lat, lon);
        }}
      />
    </>
  );
}

// ── Swipeable Row ─────────────────────────────────────────────────────────────

function SwipeableAddressRow({
  address,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  address: ApiAddress;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  // 'closed' | 'left' (edit revealed) | 'right' (delete revealed)
  const swipeState = useRef<'closed' | 'left' | 'right'>('closed');

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        const base =
          swipeState.current === 'left' ? -SWIPE_WIDTH
          : swipeState.current === 'right' ? SWIPE_WIDTH
          : 0;
        translateX.setValue(Math.max(-SWIPE_WIDTH, Math.min(SWIPE_WIDTH, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        if (swipeState.current === 'closed') {
          if (g.dx < -30) {
            // Swipe left → reveal Edit on right
            Animated.spring(translateX, { toValue: -SWIPE_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
            swipeState.current = 'left';
          } else if (g.dx > 30) {
            // Swipe right → reveal Delete on left
            Animated.spring(translateX, { toValue: SWIPE_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
            swipeState.current = 'right';
          } else {
            close();
          }
        } else {
          // Any swipe in opposite direction closes it
          if (
            (swipeState.current === 'left' && g.dx > 20) ||
            (swipeState.current === 'right' && g.dx < -20)
          ) {
            close();
          } else {
            Animated.spring(translateX, {
              toValue: swipeState.current === 'left' ? -SWIPE_WIDTH : SWIPE_WIDTH,
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

  return (
    <View style={s.rowWrap}>
      {/* Delete action on left */}
      <View style={[s.actionSlot, s.actionLeft]}>
        <TouchableOpacity
          style={s.deleteAction}
          activeOpacity={0.85}
          onPress={() => { close(); onDelete(); }}
        >
          <Ionicons name="trash-outline" size={20} color={Colors.white} />
          <Text style={s.actionText}>Delete</Text>
        </TouchableOpacity>
      </View>

      {/* Edit action on right */}
      <View style={[s.actionSlot, s.actionRight]}>
        <TouchableOpacity
          style={s.editAction}
          activeOpacity={0.85}
          onPress={() => { close(); onEdit(); }}
        >
          <Ionicons name="create-outline" size={20} color={Colors.white} />
          <Text style={s.actionText}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Sliding row */}
      <Animated.View
        style={[s.row, selected && s.rowSelected, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        <TouchableOpacity
          style={s.rowInner}
          activeOpacity={0.7}
          onPress={onSelect}
        >
          <View style={[s.tagIconBox, selected && s.tagIconBoxSelected]}>
            <Ionicons
              name={TAG_ICONS[address.tag] as any}
              size={20}
              color={selected ? Colors.white : Colors.primary}
            />
          </View>

          <View style={s.rowInfo}>
            <View style={s.rowTopLine}>
              <Text style={[s.rowTag, selected && s.rowTagSelected]}>{address.tag}</Text>
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

          {selected && (
            <Ionicons name="checkmark-circle" size={22} color={Colors.primary} />
          )}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.78,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    ...Shadow.lg,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 0,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    flex: 1,
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  addNewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: `${Colors.primary}33`,
  },
  addNewIconBox: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: `${Colors.primary}33`,
  },
  addNewText: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.primary,
  },

  sectionDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 16,
    marginVertical: 12,
  },

  swipeHint: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: 10,
  },

  emptyWrap: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  emptyText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  emptySub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // Swipeable row
  rowWrap: {
    marginBottom: 10,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    height: 76,
    ...Shadow.sm,
  },

  actionSlot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: SWIPE_WIDTH,
  },
  actionLeft: { left: 0 },
  actionRight: { right: 0 },

  deleteAction: {
    flex: 1,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderTopLeftRadius: Radius.xl,
    borderBottomLeftRadius: Radius.xl,
  },
  editAction: {
    flex: 1,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderTopRightRadius: Radius.xl,
    borderBottomRightRadius: Radius.xl,
  },
  actionText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.white,
  },

  row: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    height: 76,
  },
  rowSelected: {
    borderColor: `${Colors.primary}55`,
    backgroundColor: Colors.primaryBg,
  },
  rowInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    gap: 12,
  },
  tagIconBox: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagIconBoxSelected: {
    backgroundColor: Colors.primary,
  },
  rowInfo: { flex: 1 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  rowTag: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text },
  rowTagSelected: { color: Colors.primary },
  rowReceiver: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, flex: 1 },
  rowAddress: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
  rowDetail: { fontFamily: FontFamily.regular, fontSize: 10, color: Colors.textMuted, marginTop: 1 },
});
