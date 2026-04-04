import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Animated,
  PanResponder,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import {
  listAddresses,
  updateAddress,
  deleteAddress,
  type ApiAddress,
  type CreateAddressPayload,
} from '../../api/addresses';

type Props = { navigation: NativeStackNavigationProp<MainStackParamList, 'Addresses'> };

const TAG_OPTIONS: ApiAddress['tag'][] = ['Home', 'Work', 'Other'];
const TAG_ICONS: Record<ApiAddress['tag'], string> = { Home: 'home-outline', Work: 'briefcase-outline', Other: 'location-outline' };
const ACTION_WIDTH = 80;

// ── Root ─────────────────────────────────────────────────────────────────────

export default function AddressesScreen({ navigation }: Props) {
  const { token } = useAuth();
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
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Saved Addresses</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : addresses.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="location-outline" size={48} color={Colors.textMuted} />
          <Text style={s.emptyTitle}>No saved addresses</Text>
          <Text style={s.emptySub}>Addresses you save will appear here</Text>
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.hint}>Swipe left on an address to edit</Text>
          {addresses.map(addr => (
            <SwipeableRow
              key={addr.id}
              address={addr}
              onEdit={() => setEditTarget(addr)}
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

function SwipeableRow({ address, onEdit }: { address: ApiAddress; onEdit: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const isOpen = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        const base = isOpen.current ? -ACTION_WIDTH : 0;
        translateX.setValue(Math.max(-ACTION_WIDTH, Math.min(0, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        if (!isOpen.current && g.dx < -30) {
          Animated.spring(translateX, { toValue: -ACTION_WIDTH, useNativeDriver: true, bounciness: 4 }).start();
          isOpen.current = true;
        } else if (isOpen.current && g.dx > 30) {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
          isOpen.current = false;
        } else {
          Animated.spring(translateX, {
            toValue: isOpen.current ? -ACTION_WIDTH : 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        }
      },
    }),
  ).current;

  function close() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    isOpen.current = false;
  }

  const tagIcon = TAG_ICONS[address.tag];

  return (
    <View style={s.rowWrap}>
      {/* Edit action revealed behind row */}
      <View style={s.actionArea}>
        <TouchableOpacity
          style={s.editAction}
          activeOpacity={0.85}
          onPress={() => { close(); onEdit(); }}
        >
          <Ionicons name="create-outline" size={22} color={Colors.white} />
          <Text style={s.editActionText}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Sliding row */}
      <Animated.View style={[s.row, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <View style={s.tagIconBox}>
          <Ionicons name={tagIcon as any} size={20} color={Colors.primary} />
        </View>

        <View style={s.rowInfo}>
          <View style={s.rowTopLine}>
            <Text style={s.rowTag}>{address.tag}</Text>
            {address.receiver_name ? (
              <Text style={s.rowReceiver} numberOfLines={1}>
                For {address.receiver_name}
              </Text>
            ) : null}
          </View>
          <Text style={s.rowAddress} numberOfLines={2}>{address.full_address}</Text>
          {address.flat_no || address.floor || address.building_name ? (
            <Text style={s.rowDetail} numberOfLines={1}>
              {[address.flat_no, address.floor, address.building_name].filter(Boolean).join(', ')}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// ── Edit Address Modal ────────────────────────────────────────────────────────

function EditAddressModal({
  address,
  token,
  onClose,
  onSaved,
  onDeleted,
}: {
  address: ApiAddress | null;
  token: string | null;
  onClose: () => void;
  onSaved: (a: ApiAddress) => void;
  onDeleted: (id: string) => void;
}) {
  const [tag, setTag] = useState<ApiAddress['tag']>('Home');
  const [flatNo, setFlatNo] = useState('');
  const [floor, setFloor] = useState('');
  const [building, setBuilding] = useState('');
  const [landmark, setLandmark] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const slideAnim = useRef(new Animated.Value(500)).current;
  const visible = address !== null;

  useEffect(() => {
    if (address) {
      setTag(address.tag);
      setFlatNo(address.flat_no ?? '');
      setFloor(address.floor ?? '');
      setBuilding(address.building_name ?? '');
      setLandmark(address.landmark ?? '');
      setReceiverName(address.receiver_name ?? '');
      setReceiverPhone(address.receiver_phone ?? '');
      setError('');
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 180 }).start();
    } else {
      Animated.timing(slideAnim, { toValue: 500, duration: 220, useNativeDriver: true }).start();
    }
  }, [address]);

  async function handleSave() {
    if (!token || !address) return;
    setError('');
    setSaving(true);
    try {
      // Extract the geocoded suffix from the original full_address by stripping
      // the original user-entered prefix (flat_no, floor, building_name, landmark).
      const originalUserPart = [address.flat_no, address.floor, address.building_name, address.landmark]
        .filter(Boolean).join(', ');
      const geocodedSuffix =
        originalUserPart && address.full_address.startsWith(originalUserPart + ', ')
          ? address.full_address.slice(originalUserPart.length + 2)
          : address.full_address;

      // Rebuild full_address: new user parts + the unchanged geocoded suffix.
      const newUserPart = [flatNo, floor, building, landmark].filter(Boolean).join(', ');
      const full_address = [newUserPart, geocodedSuffix].filter(Boolean).join(', ');

      const payload: Partial<CreateAddressPayload> = {
        tag,
        title: tag === 'Other' ? building || tag : tag,
        flat_no: flatNo,
        floor,
        building_name: building,
        landmark,
        full_address,
        receiver_name: receiverName,
        receiver_phone: receiverPhone,
      };
      const updated = await updateAddress(token, address.id, payload);
      onSaved(updated);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    Alert.alert(
      'Delete Address',
      'Are you sure you want to delete this address?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: handleDelete },
      ],
    );
  }

  async function handleDelete() {
    if (!token || !address) return;
    setDeleting(true);
    try {
      await deleteAddress(token, address.id);
      onDeleted(address.id);
    } catch {
      setError('Failed to delete. Please try again.');
    } finally {
      setDeleting(false);
    }
  }

  const { height: SCREEN_HEIGHT } = Dimensions.get('window');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />

        <Animated.View style={[s.sheet, { transform: [{ translateY: slideAnim }], maxHeight: SCREEN_HEIGHT * 0.88 }]}>
          <View style={s.sheetHandle} />

          {/* Sheet header */}
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Edit Address</Text>
            <TouchableOpacity style={s.sheetClose} onPress={onClose} activeOpacity={0.7}>
              <Ionicons name="close" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.formScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {/* Tag */}
            <Text style={s.fieldLabel}>Label</Text>
            <View style={s.tagRow}>
              {TAG_OPTIONS.map(t => (
                <TouchableOpacity
                  key={t}
                  style={[s.tagChip, tag === t && s.tagChipActive]}
                  onPress={() => setTag(t)}
                  activeOpacity={0.8}
                >
                  <Ionicons name={TAG_ICONS[t] as any} size={14} color={tag === t ? Colors.white : Colors.textSecondary} />
                  <Text style={[s.tagChipText, tag === t && s.tagChipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Address details */}
            <Text style={s.fieldLabel}>Address Details</Text>
            <View style={s.fieldGroup}>
              <FieldRow icon="business-outline" placeholder="Flat / Door no." value={flatNo} onChangeText={setFlatNo} />
              <View style={s.divider} />
              <FieldRow icon="layers-outline" placeholder="Floor" value={floor} onChangeText={setFloor} keyboardType="number-pad" />
              <View style={s.divider} />
              <FieldRow icon="home-outline" placeholder="Building / Society name" value={building} onChangeText={setBuilding} />
              <View style={s.divider} />
              <FieldRow icon="flag-outline" placeholder="Landmark" value={landmark} onChangeText={setLandmark} />
            </View>

            {/* Receiver */}
            <Text style={s.fieldLabel}>Receiver Details</Text>
            <View style={s.fieldGroup}>
              <FieldRow icon="person-outline" placeholder="Receiver's name" value={receiverName} onChangeText={setReceiverName} autoCapitalize="words" />
              <View style={s.divider} />
              <FieldRow icon="call-outline" placeholder="Receiver's phone" value={receiverPhone} onChangeText={setReceiverPhone} keyboardType="phone-pad" />
            </View>

            {error ? <Text style={s.errorText}>{error}</Text> : null}

            {/* Save */}
            <TouchableOpacity
              style={[s.saveBtn, saving && s.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving || deleting}
              activeOpacity={0.85}
            >
              {saving
                ? <ActivityIndicator color={Colors.white} size="small" />
                : <Text style={s.saveBtnText}>Save Changes</Text>}
            </TouchableOpacity>

            {/* Delete */}
            <TouchableOpacity
              style={[s.deleteBtn, deleting && s.saveBtnDisabled]}
              onPress={confirmDelete}
              disabled={saving || deleting}
              activeOpacity={0.85}
            >
              {deleting
                ? <ActivityIndicator color={Colors.danger} size="small" />
                : (
                  <>
                    <Ionicons name="trash-outline" size={16} color={Colors.danger} />
                    <Text style={s.deleteBtnText}>Delete Address</Text>
                  </>
                )}
            </TouchableOpacity>

            <View style={{ height: 8 }} />
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Field Row ─────────────────────────────────────────────────────────────────

function FieldRow({
  icon, placeholder, value, onChangeText, keyboardType = 'default', autoCapitalize = 'sentences',
}: {
  icon: string;
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
}) {
  return (
    <View style={s.fieldRow}>
      <Ionicons name={icon as any} size={18} color={Colors.textMuted} style={{ width: 24 }} />
      <TextInput
        style={s.fieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textMuted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        returnKeyType="done"
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const H_PAD = 16;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
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
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    textAlign: 'center',
    letterSpacing: -0.3,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.textSecondary, marginTop: 8 },
  emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },

  hint: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 10,
  },

  // Swipeable row
  rowWrap: {
    marginHorizontal: H_PAD,
    marginBottom: 10,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  actionArea: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  editAction: {
    width: ACTION_WIDTH,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  editActionText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.white,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: 14,
    borderRadius: Radius.xl,
  },
  tagIconBox: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  rowTag: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text },
  rowReceiver: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, flex: 1 },
  rowAddress: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  rowDetail: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },

  // Modal
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    ...Shadow.md,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: H_PAD + 4,
    marginBottom: 20,
  },
  sheetTitle: { flex: 1, fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.text, letterSpacing: -0.3 },
  sheetClose: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  formScroll: { paddingHorizontal: H_PAD + 4 },

  fieldLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4,
  },

  tagRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  tagChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  tagChipText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.textSecondary },
  tagChipTextActive: { color: Colors.white },

  fieldGroup: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    marginBottom: 20,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 2,
    gap: 10,
    height: 52,
  },
  fieldInput: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.text,
    paddingVertical: 0,
  },
  divider: { height: 1, backgroundColor: Colors.border, marginLeft: 52 },

  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    marginBottom: 12,
  },

  saveBtn: {
    height: 52,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    ...Shadow.md,
  },
  saveBtnDisabled: { opacity: 0.45 },
  saveBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: Colors.white, letterSpacing: 0.2 },

  deleteBtn: {
    height: 52,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerBg,
  },
  deleteBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: Colors.danger },
});
