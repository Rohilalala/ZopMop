import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Animated,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../theme';
import {
  updateAddress,
  deleteAddress,
  type ApiAddress,
  type CreateAddressPayload,
} from '../api/addresses';

const TAG_OPTIONS: ApiAddress['tag'][] = ['Home', 'Work', 'Other'];
const TAG_ICONS: Record<ApiAddress['tag'], string> = {
  Home: 'home-outline',
  Work: 'briefcase-outline',
  Other: 'location-outline',
};

interface Props {
  address: ApiAddress | null;
  token: string | null;
  onClose: () => void;
  onSaved: (a: ApiAddress) => void;
  onDeleted: (id: string) => void;
}

export default function EditAddressModal({ address, token, onClose, onSaved, onDeleted }: Props) {
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
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 180,
      }).start();
    } else {
      Animated.timing(slideAnim, { toValue: 500, duration: 220, useNativeDriver: true }).start();
    }
  }, [address]);

  async function handleSave() {
    if (!token || !address) return;
    setError('');
    setSaving(true);
    try {
      const originalUserPart = [address.flat_no, address.floor, address.building_name, address.landmark]
        .filter(Boolean)
        .join(', ');
      const geocodedSuffix =
        originalUserPart && address.full_address.startsWith(originalUserPart + ', ')
          ? address.full_address.slice(originalUserPart.length + 2)
          : address.full_address;

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
    Alert.alert('Delete Address', 'Are you sure you want to delete this address?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: handleDelete },
    ]);
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
          style={[s.sheet, { transform: [{ translateY: slideAnim }], maxHeight: SCREEN_HEIGHT * 0.88 }]}
        >
          <View style={s.handle} />

          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Edit Address</Text>
            <TouchableOpacity style={s.closeBtn} onPress={onClose} activeOpacity={0.7}>
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
            <Text style={s.fieldLabel}>Label</Text>
            <View style={s.tagRow}>
              {TAG_OPTIONS.map(t => (
                <TouchableOpacity
                  key={t}
                  style={[s.tagChip, tag === t && s.tagChipActive]}
                  onPress={() => setTag(t)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={TAG_ICONS[t] as any}
                    size={14}
                    color={tag === t ? Colors.white : Colors.textSecondary}
                  />
                  <Text style={[s.tagChipText, tag === t && s.tagChipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

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

            <Text style={s.fieldLabel}>Receiver Details</Text>
            <View style={s.fieldGroup}>
              <FieldRow icon="person-outline" placeholder="Receiver's name" value={receiverName} onChangeText={setReceiverName} autoCapitalize="words" />
              <View style={s.divider} />
              <FieldRow icon="call-outline" placeholder="Receiver's phone" value={receiverPhone} onChangeText={setReceiverPhone} keyboardType="phone-pad" />
            </View>

            {error ? <Text style={s.errorText}>{error}</Text> : null}

            <TouchableOpacity
              style={[s.saveBtn, saving && s.btnDisabled]}
              onPress={handleSave}
              disabled={saving || deleting}
              activeOpacity={0.85}
            >
              {saving
                ? <ActivityIndicator color={Colors.white} size="small" />
                : <Text style={s.saveBtnText}>Save Changes</Text>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.deleteBtn, deleting && s.btnDisabled]}
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
                )
              }
            </TouchableOpacity>

            <View style={{ height: 8 }} />
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

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

const H_PAD = 20;

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
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    ...Shadow.md,
  },
  handle: {
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
    paddingHorizontal: H_PAD,
    marginBottom: 20,
  },
  sheetTitle: {
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

  formScroll: { paddingHorizontal: H_PAD },

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
  btnDisabled: { opacity: 0.45 },
  saveBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.white, letterSpacing: 0.2 },

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
  deleteBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.danger },
});
