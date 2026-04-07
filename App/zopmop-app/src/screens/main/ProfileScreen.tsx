import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Dimensions,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getMe, updateMe } from '../../api/users';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 16;
const QUICK_GAP = 10;
const QUICK_CARD_WIDTH = (SCREEN_WIDTH - H_PAD * 2 - QUICK_GAP) / 2;

// ── Static data ───────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { id: 'bookings', title: 'My Bookings',   subtitle: 'View and manage bookings',     icon: 'calendar-outline'      },
  { id: 'wallet',   title: 'Wallet',         subtitle: 'Check balance & transactions', icon: 'wallet-outline'        },
  { id: 'offers',   title: 'Offers',         subtitle: 'View available deals',         icon: 'pricetag-outline'      },
  { id: 'support',  title: 'Help & Support', subtitle: 'Get assistance quickly',       icon: 'help-circle-outline'   },
] as const;

const ACCOUNT_ITEMS = [
  { id: 'addresses', label: 'Saved Addresses',             icon: 'location-outline'      },
  { id: 'experts',   label: 'Your Experts',                icon: 'people-outline'        },
  { id: 'payments',  label: 'Payment Methods',             icon: 'card-outline'          },
  { id: 'notifs',    label: 'Notifications & Preferences', icon: 'notifications-outline' },
] as const;

const LEGAL_ITEMS = [
  { id: 'about',   label: 'About',              icon: 'information-circle-outline' },
  { id: 'terms',   label: 'Terms & Conditions', icon: 'document-text-outline'      },
  { id: 'privacy', label: 'Privacy Policy',     icon: 'shield-checkmark-outline'   },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPhone(raw?: string): string {
  if (!raw) return '';
  // +919876543210 → +91 98765 43210
  const match = raw.match(/^(\+\d{2})(\d{5})(\d{5})$/);
  if (match) return `${match[1]} ${match[2]} ${match[3]}`;
  return raw;
}

// ── Root Component ────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const { token, user, signOut, updateUser } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const [editVisible, setEditVisible] = useState(false);
  const [fetchingProfile, setFetchingProfile] = useState(false);

  // Refresh user data from backend on mount.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    setFetchingProfile(true);
    getMe(token)
      .then(updateUser)
      .catch(() => {})
      .finally(() => setFetchingProfile(false));
  }, []);

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Profile</Text>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <UserInfoCard
          name={user?.name}
          phone={user?.phone}
          loading={fetchingProfile && !user?.phone}
          onEditPress={() => setEditVisible(true)}
        />
        <QuickActionsGrid />
        <ReferralBanner />
        <ListSection
          title="Account"
          items={ACCOUNT_ITEMS}
          onItemPress={{
            addresses: () => navigation.navigate('Addresses'),
            experts:   () => Alert.alert('Your Experts', 'Expert history is coming soon.'),
            payments:  () => Alert.alert('Payment Methods', 'Payment methods are coming soon.'),
            notifs:    () => Alert.alert('Notifications', 'Notification settings are coming soon.'),
          }}
        />
        <ListSection title="Info & Legal" items={LEGAL_ITEMS} muted />
        <AccountActions onLogout={handleLogout} />
        <View style={{ height: 32 }} />
      </ScrollView>

      <EditProfileModal
        visible={editVisible}
        currentName={user?.name}
        phone={user?.phone}
        token={token}
        onClose={() => setEditVisible(false)}
        onSaved={(updated) => { updateUser(updated); setEditVisible(false); }}
      />
    </SafeAreaView>
  );
}

// ── User Info Card ────────────────────────────────────────────────────────────

function UserInfoCard({
  name,
  phone,
  loading,
  onEditPress,
}: {
  name?: string | null;
  phone?: string;
  loading?: boolean;
  onEditPress: () => void;
}) {
  const initials = getInitials(name);
  const displayName = name ?? 'Add your name';
  const displayPhone = formatPhone(phone);

  return (
    <View style={s.userCard}>
      <View style={s.avatarWrap}>
        <View style={s.avatar}>
          <Text style={s.avatarInitials}>{initials}</Text>
        </View>
        <TouchableOpacity style={s.avatarEditBtn} activeOpacity={0.8} onPress={onEditPress}>
          <Ionicons name="pencil" size={11} color={Colors.white} />
        </TouchableOpacity>
      </View>

      <View style={s.userInfo}>
        {loading ? (
          <ActivityIndicator size="small" color={Colors.primary} />
        ) : (
          <>
            <Text style={[s.userName, !name && s.userNamePlaceholder]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={s.userPhone}>{displayPhone}</Text>
          </>
        )}
      </View>

      <TouchableOpacity style={s.editBtn} activeOpacity={0.8} onPress={onEditPress}>
        <Text style={s.editBtnText}>Edit</Text>
        <Ionicons name="chevron-forward" size={12} color={Colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

// ── Edit Profile Modal ────────────────────────────────────────────────────────

function EditProfileModal({
  visible,
  currentName,
  phone,
  token,
  onClose,
  onSaved,
}: {
  visible: boolean;
  currentName?: string | null;
  phone?: string;
  token: string | null;
  onClose: () => void;
  onSaved: (user: any) => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const slideAnim = useRef(new Animated.Value(300)).current;
  const nameRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(currentName ?? '');
      setError('');
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start(() => nameRef.current?.focus());
    } else {
      Animated.timing(slideAnim, {
        toValue: 300,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  async function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Name must be at least 2 characters.');
      return;
    }
    if (!token || token === '__guest__') {
      setError('Not authenticated.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const updated = await updateMe(token, trimmed);
      onSaved(updated);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = name.trim() !== (currentName ?? '').trim();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Backdrop */}
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />

        {/* Sheet */}
        <Animated.View style={[s.sheet, { transform: [{ translateY: slideAnim }] }]}>
          {/* Handle */}
          <View style={s.sheetHandle} />

          {/* Sheet header */}
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Edit Profile</Text>
            <TouchableOpacity style={s.sheetClose} onPress={onClose} activeOpacity={0.7}>
              <Ionicons name="close" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Fields */}
          <View style={s.formFields}>
            {/* Name field */}
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Full Name</Text>
              <TouchableOpacity
                style={[s.fieldCard, error ? s.fieldCardError : null]}
                activeOpacity={1}
                onPress={() => nameRef.current?.focus()}
              >
                <Ionicons name="person-outline" size={18} color={Colors.textMuted} />
                <TextInput
                  ref={nameRef}
                  style={s.fieldInput}
                  value={name}
                  onChangeText={(t) => { setName(t); if (error) setError(''); }}
                  placeholder="Your full name"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="words"
                  maxLength={60}
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
                {name.length > 0 && (
                  <TouchableOpacity onPress={() => setName('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
              {error ? <Text style={s.fieldError}>{error}</Text> : null}
            </View>

            {/* Phone — read-only */}
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Mobile Number</Text>
              <View style={[s.fieldCard, s.fieldCardLocked]}>
                <Ionicons name="call-outline" size={18} color={Colors.textMuted} />
                <Text style={s.fieldInputLocked}>{formatPhone(phone)}</Text>
                <Ionicons name="lock-closed-outline" size={14} color={Colors.textMuted} />
              </View>
              <Text style={s.fieldHint}>Phone number cannot be changed.</Text>
            </View>
          </View>

          {/* Save button */}
          <TouchableOpacity
            style={[s.saveBtn, (!hasChanges || saving) && s.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!hasChanges || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.saveBtnText}>Save Changes</Text>}
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Quick Actions Grid ────────────────────────────────────────────────────────

function QuickActionsGrid() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  function handleQuickAction(id: string) {
    switch (id) {
      case 'bookings': navigation.navigate('Bookings'); break;
      case 'wallet':   navigation.navigate('Wallet'); break;
      case 'offers':   navigation.navigate('Offers'); break;
      case 'support':  navigation.navigate('HelpSupport'); break;
    }
  }

  return (
    <View style={s.section}>
      <View style={s.quickGrid}>
        {QUICK_ACTIONS.map(item => (
          <TouchableOpacity
            key={item.id}
            style={[s.quickCard, { width: QUICK_CARD_WIDTH }]}
            activeOpacity={0.82}
            onPress={() => handleQuickAction(item.id)}
          >
            <View style={s.quickIconBox}>
              <Ionicons name={item.icon as any} size={22} color={Colors.primary} />
            </View>
            <Text style={s.quickTitle}>{item.title}</Text>
            <Text style={s.quickSubtitle} numberOfLines={2}>{item.subtitle}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ── Referral Banner ───────────────────────────────────────────────────────────

function ReferralBanner() {
  return (
    <View style={s.section}>
      <TouchableOpacity style={s.referralCard} activeOpacity={0.85} onPress={() => Alert.alert('Refer & Earn', 'Share ZopMop with friends and earn ₹100 per referral. Referral feature coming soon!')}>
        <View style={s.referralCircle} />
        <View style={s.referralContent}>
          <View style={s.referralIconBox}>
            <Text style={s.referralEmoji}>🎁</Text>
          </View>
          <View style={s.referralText}>
            <Text style={s.referralTitle}>Refer & Earn</Text>
            <Text style={s.referralSub}>Invite friends and get rewards</Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={Colors.white} style={{ opacity: 0.7 }} />
      </TouchableOpacity>
    </View>
  );
}

// ── List Section ──────────────────────────────────────────────────────────────

type ListItem = { id: string; label: string; icon: string };

function ListSection({
  title, items, muted = false, onItemPress = {},
}: {
  title: string;
  items: readonly ListItem[];
  muted?: boolean;
  onItemPress?: Record<string, () => void>;
}) {
  return (
    <View style={s.section}>
      <Text style={[s.sectionLabel, muted && s.sectionLabelMuted]}>{title}</Text>
      <View style={s.listCard}>
        {items.map((item, idx) => (
          <React.Fragment key={item.id}>
            <TouchableOpacity style={s.listRow} activeOpacity={0.7} onPress={onItemPress[item.id]}>
              <View style={[s.listIconBox, muted && s.listIconBoxMuted]}>
                <Ionicons name={item.icon as any} size={18} color={muted ? Colors.textMuted : Colors.primary} />
              </View>
              <Text style={[s.listLabel, muted && s.listLabelMuted]}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
            {idx < items.length - 1 && <View style={s.divider} />}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

// ── Account Actions ───────────────────────────────────────────────────────────

function AccountActions({ onLogout }: { onLogout: () => void }) {
  return (
    <View style={s.section}>
      <View style={s.listCard}>
        <TouchableOpacity style={s.listRow} onPress={onLogout} activeOpacity={0.7}>
          <View style={[s.listIconBox, s.listIconBoxDanger]}>
            <Ionicons name="log-out-outline" size={18} color={Colors.danger} />
          </View>
          <Text style={[s.listLabel, s.listLabelDanger]}>Log Out</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const DIVIDER_INDENT = H_PAD + 36 + 12;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { paddingBottom: Spacing.base },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: H_PAD, paddingTop: 12, paddingBottom: 16, gap: 4 },
  backBtn: { padding: 4, marginLeft: -4 },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },

  section: { paddingHorizontal: H_PAD, marginBottom: 20 },
  sectionLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sectionLabelMuted: { color: Colors.textMuted },

  // User Card
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    marginHorizontal: H_PAD,
    marginBottom: 20,
    borderRadius: Radius.xl,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 14,
    ...Shadow.sm,
  },
  avatarWrap: { position: 'relative' },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: Radius.full,
    backgroundColor: Colors.primaryBg,
    borderWidth: 2,
    borderColor: `${Colors.primary}33`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.primary,
  },
  avatarEditBtn: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 22,
    height: 22,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.white,
  },
  userInfo: { flex: 1 },
  userName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 3,
  },
  userNamePlaceholder: {
    color: Colors.textMuted,
    fontFamily: FontFamily.regular,
  },
  userPhone: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.primary}33`,
    backgroundColor: Colors.primaryBg,
  },
  editBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.primary,
  },

  // Quick Actions
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: QUICK_GAP },
  quickCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
    ...Shadow.sm,
  },
  quickIconBox: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  quickTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text },
  quickSubtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, lineHeight: 16 },

  // Referral
  referralCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.accent,
    borderRadius: Radius.xl,
    padding: Spacing.base,
    gap: 12,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  referralCircle: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: Radius.full,
    backgroundColor: Colors.white,
    opacity: 0.07,
    top: -45,
    right: -30,
  },
  referralContent: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  referralIconBox: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  referralEmoji: { fontSize: 22 },
  referralText: { flex: 1 },
  referralTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.white, marginBottom: 2 },
  referralSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: 'rgba(255,255,255,0.76)' },

  // List
  listCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: 12,
  },
  listIconBox: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listIconBoxMuted: { backgroundColor: Colors.surface },
  listIconBoxWarn: { backgroundColor: Colors.warningBg },
  listIconBoxDanger: { backgroundColor: Colors.dangerBg },
  listLabel: { flex: 1, fontFamily: FontFamily.medium, fontSize: FontSize.base, color: Colors.text },
  listLabelMuted: { color: Colors.textSecondary },
  listLabelWarn: { color: Colors.warning },
  listLabelDanger: { color: Colors.danger },
  divider: { height: 1, backgroundColor: Colors.border, marginLeft: DIVIDER_INDENT },

  // Edit Modal
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    paddingHorizontal: H_PAD + 4,
    paddingTop: 12,
    ...Shadow.md,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  sheetTitle: {
    flex: 1,
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  sheetClose: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  formFields: { gap: 16, marginBottom: 24 },
  fieldGroup: { gap: 6 },
  fieldLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginLeft: 2,
  },
  fieldCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    height: 56,
    paddingHorizontal: Spacing.base,
    gap: 10,
    ...Shadow.sm,
  },
  fieldCardError: { borderColor: Colors.danger },
  fieldCardLocked: { backgroundColor: Colors.surface, borderColor: Colors.border },
  fieldInput: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.text,
    paddingVertical: 0,
  },
  fieldInputLocked: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.textMuted,
  },
  fieldError: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginLeft: 2,
  },
  fieldHint: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginLeft: 2,
  },

  saveBtn: {
    height: 54,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
