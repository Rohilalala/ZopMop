import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { useTheme, useColors } from '../../context/ThemeContext';
import { getMe, updateMe, deleteMe } from '../../api/users';

type C = typeof lightColors;
type Nav = NativeStackNavigationProp<MainStackParamList>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 20;
const APP_VERSION = '1.0.0';

// ── Static data ───────────────────────────────────────────────────────────────

const ACTION_RAIL = [
  { id: 'bookings', label: 'Bookings', icon: 'calendar-outline' },
  { id: 'wallet',   label: 'Wallet',   icon: 'wallet-outline' },
  { id: 'offers',   label: 'Offers',   icon: 'pricetag-outline' },
  { id: 'support',  label: 'Help',     icon: 'help-buoy-outline' },
] as const;

const ACCOUNT_ITEMS = [
  { id: 'addresses', label: 'Saved Addresses', icon: 'location-outline' },
  { id: 'roomies',   label: 'Roomies',         icon: 'home-outline' },
  { id: 'experts',   label: 'Your Experts',    icon: 'people-outline' },
  { id: 'payments',  label: 'Payment Methods', icon: 'card-outline' },
  { id: 'notifs',    label: 'Notifications',   icon: 'notifications-outline' },
] as const;

const LEGAL_ITEMS = [
  { id: 'about',   label: 'About ZopMop',     icon: 'information-circle-outline' },
  { id: 'terms',   label: 'Terms of Service', icon: 'document-text-outline' },
  { id: 'privacy', label: 'Privacy Policy',   icon: 'shield-checkmark-outline' },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name?: string | null): string {
  if (!name) return 'ZM';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPhone(raw?: string): string {
  if (!raw) return '';
  const match = raw.match(/^(\+\d{2})(\d{5})(\d{5})$/);
  if (match) return `${match[1]} ${match[2]} ${match[3]}`;
  return raw;
}

function roleLabel(role?: string): string {
  if (!role) return 'Member';
  const r = role.toLowerCase();
  if (r === 'pro' || r === 'helper') return 'Pro Partner';
  if (r === 'admin') return 'Admin';
  return 'Member';
}

// ── Root Component ────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const { token, user, signOut, updateUser } = useAuth();
  const navigation = useNavigation<Nav>();
  const [editVisible, setEditVisible] = useState(false);
  const [fetchingProfile, setFetchingProfile] = useState(false);
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const scrollY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!token || token === '__guest__') return;
    setFetchingProfile(true);
    getMe(token)
      .then(updateUser)
      .catch(() => {})
      .finally(() => setFetchingProfile(false));
  }, []);

  const handleLogout = () => {
    Alert.alert('Log out of ZopMop?', 'You can sign back in anytime with your phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: signOut },
    ]);
  };

  const handleDeleteAccount = () => {
    if (!token || token === '__guest__') return;
    Alert.alert(
      'Delete account',
      'This permanently removes your profile, bookings, addresses and pro data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'Tap Delete to permanently remove your account.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deleteMe(token);
                      signOut();
                    } catch (err) {
                      Alert.alert(
                        'Delete failed',
                        err instanceof Error ? err.message : 'Please try again.',
                      );
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const headerOpacity = scrollY.interpolate({
    inputRange: [80, 140],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <Animated.View
        pointerEvents="none"
        style={[s.stickyBar, { opacity: headerOpacity }]}
      />
      <View style={s.topBar}>
        <TouchableOpacity
          style={s.iconBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Animated.Text
          style={[s.topBarTitle, { opacity: headerOpacity }]}
          numberOfLines={1}
        >
          {user?.name ?? 'Profile'}
        </Animated.Text>
        <View style={{ width: 36 }} />
      </View>

      <Animated.ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
      >
        <HeroCard
          name={user?.name}
          phone={user?.phone}
          role={user?.role}
          loading={fetchingProfile && !user?.phone}
          onEdit={() => setEditVisible(true)}
        />

        <ActionRail navigation={navigation} />

        <ReferralTicket
          onPress={() =>
            Alert.alert(
              'Refer & earn ₹100',
              'Share ZopMop with friends — you both earn ₹100 in wallet credit. Coming soon.',
            )
          }
        />

        <AppearanceRow />

        <SectionHeader>Account</SectionHeader>
        <GroupedList
          items={ACCOUNT_ITEMS}
          onPress={(id) => {
            switch (id) {
              case 'addresses': navigation.navigate('Addresses'); break;
              case 'roomies':   navigation.navigate('RoomiesSetup'); break;
              case 'experts':   Alert.alert('Your Experts', 'Expert history is coming soon.'); break;
              case 'payments':  navigation.navigate('Payment'); break;
              case 'notifs':    Alert.alert('Notifications', 'Notification settings are coming soon.'); break;
            }
          }}
        />

        <SectionHeader muted>Info & Legal</SectionHeader>
        <GroupedList items={LEGAL_ITEMS} muted />

        <DangerZone onLogout={handleLogout} onDelete={handleDeleteAccount} />

        <Footer />
      </Animated.ScrollView>

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

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard({
  name, phone, role, loading, onEdit,
}: {
  name?: string | null;
  phone?: string;
  role?: string;
  loading?: boolean;
  onEdit: () => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const initials = getInitials(name);
  const displayName = name ?? 'Add your name';
  const displayPhone = formatPhone(phone);

  return (
    <View style={s.heroWrap}>
      <View style={s.hero}>
        <View style={s.heroStripe} pointerEvents="none" />

        <View style={s.heroTopRow}>
          <Text style={s.heroEyebrow} numberOfLines={1}>
            ZOPMOP · {roleLabel(role).toUpperCase()}
          </Text>
          <TouchableOpacity
            onPress={onEdit}
            hitSlop={12}
            activeOpacity={0.75}
            style={s.heroEditBtn}
          >
            <Ionicons name="pencil" size={14} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        <View style={s.heroBody}>
          <View style={s.heroMonogram}>
            <Text style={s.heroMonogramText}>{initials}</Text>
          </View>
          <View style={s.heroTextWrap}>
            {loading ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Text style={[s.heroName, !name && { opacity: 0.6 }]} numberOfLines={1}>
                  {displayName}
                </Text>
                {!!displayPhone && (
                  <Text style={s.heroPhone} numberOfLines={1}>
                    {displayPhone}
                  </Text>
                )}
              </>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

// ── Action Rail (4-up circular) ──────────────────────────────────────────────

function ActionRail({ navigation }: { navigation: Nav }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  function go(id: string) {
    switch (id) {
      case 'bookings': navigation.navigate('Bookings'); break;
      case 'wallet':   navigation.navigate('Wallet'); break;
      case 'offers':   navigation.navigate('Offers'); break;
      case 'support':  navigation.navigate('HelpSupport'); break;
    }
  }

  return (
    <View style={s.rail}>
      {ACTION_RAIL.map((a) => (
        <TouchableOpacity
          key={a.id}
          onPress={() => go(a.id)}
          activeOpacity={0.75}
          style={s.railItem}
        >
          <View style={s.railBubble}>
            <Ionicons name={a.icon as any} size={22} color={c.primary} />
          </View>
          <Text style={s.railLabel} numberOfLines={1}>
            {a.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Referral Ticket ───────────────────────────────────────────────────────────

function ReferralTicket({ onPress }: { onPress: () => void }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={s.ticket}
    >
      <View style={s.ticketLeft}>
        <Text style={s.ticketEyebrow}>INVITE A FRIEND</Text>
        <Text style={s.ticketTitle}>Earn ₹100</Text>
        <Text style={s.ticketSub}>per friend who joins</Text>
      </View>

      <View style={s.ticketRight}>
        <View style={s.ticketCta}>
          <Ionicons name="gift-outline" size={20} color="#FFFFFF" />
        </View>
        <Text style={s.ticketCtaLabel}>SHARE</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Appearance Row (own card so layout is bullet-proof) ──────────────────────

function AppearanceRow() {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const { isDark, toggleTheme } = useTheme();

  return (
    <>
      <SectionHeader>Preferences</SectionHeader>
      <View style={s.card}>
        <View style={s.row}>
          <View style={s.rowIcon}>
            <Ionicons
              name={isDark ? 'moon' : 'sunny-outline'}
              size={18}
              color={c.primary}
            />
          </View>
          <View style={s.rowTextWrap}>
            <Text style={s.rowLabel} numberOfLines={1}>Appearance</Text>
            <Text style={s.rowMeta} numberOfLines={1}>{isDark ? 'Dark' : 'Light'}</Text>
          </View>
          <Switch
            value={isDark}
            onValueChange={toggleTheme}
            trackColor={{ false: c.border, true: c.primary }}
            thumbColor="#FFFFFF"
            ios_backgroundColor={c.border}
          />
        </View>
      </View>
    </>
  );
}

// ── Section Header ────────────────────────────────────────────────────────────

function SectionHeader({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <Text style={[s.sectionLabel, muted && { color: c.textMuted }]}>
      {children}
    </Text>
  );
}

// ── Grouped List ──────────────────────────────────────────────────────────────

type ListItem = { id: string; label: string; icon: string };

function GroupedList({
  items, onPress, muted = false,
}: {
  items: readonly ListItem[];
  onPress?: (id: string) => void;
  muted?: boolean;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.card}>
      {items.map((item, i) => (
        <React.Fragment key={item.id}>
          <TouchableOpacity
            style={s.row}
            activeOpacity={0.7}
            onPress={() => onPress?.(item.id)}
          >
            <View style={[s.rowIcon, muted && s.rowIconMuted]}>
              <Ionicons
                name={item.icon as any}
                size={18}
                color={muted ? c.textSecondary : c.primary}
              />
            </View>
            <View style={s.rowTextWrap}>
              <Text
                style={[s.rowLabel, muted && { color: c.textSecondary }]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
          </TouchableOpacity>
          {i < items.length - 1 && <View style={s.divider} />}
        </React.Fragment>
      ))}
    </View>
  );
}

// ── Danger Zone ───────────────────────────────────────────────────────────────

function DangerZone({
  onLogout, onDelete,
}: {
  onLogout: () => void;
  onDelete: () => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <>
      <Text style={[s.sectionLabel, { color: c.danger }]}>Danger Zone</Text>
      <View style={[s.card, s.cardDanger]}>
        <TouchableOpacity
          style={s.row}
          activeOpacity={0.7}
          onPress={onLogout}
        >
          <View style={[s.rowIcon, s.rowIconDanger]}>
            <Ionicons name="log-out-outline" size={18} color={c.danger} />
          </View>
          <View style={s.rowTextWrap}>
            <Text style={[s.rowLabel, { color: c.danger }]} numberOfLines={1}>
              Log Out
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={c.danger}
            style={{ opacity: 0.5 }}
          />
        </TouchableOpacity>
        <View style={[s.divider, { backgroundColor: c.dangerBg }]} />
        <TouchableOpacity
          style={s.row}
          activeOpacity={0.7}
          onPress={onDelete}
        >
          <View style={[s.rowIcon, s.rowIconDanger]}>
            <Ionicons name="trash-outline" size={18} color={c.danger} />
          </View>
          <View style={s.rowTextWrap}>
            <Text style={[s.rowLabel, { color: c.danger }]} numberOfLines={1}>
              Delete Account
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={c.danger}
            style={{ opacity: 0.5 }}
          />
        </TouchableOpacity>
      </View>
    </>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.footer}>
      <Text style={s.footerBrand}>ZOPMOP</Text>
      <Text style={s.footerMeta}>v{APP_VERSION}  ·  Made in India</Text>
    </View>
  );
}

// ── Edit Profile Modal ────────────────────────────────────────────────────────

function EditProfileModal({
  visible, currentName, phone, token, onClose, onSaved,
}: {
  visible: boolean;
  currentName?: string | null;
  phone?: string;
  token: string | null;
  onClose: () => void;
  onSaved: (user: any) => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const slideAnim = useRef(new Animated.Value(400)).current;
  const nameRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(currentName ?? '');
      setError('');
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 22,
        stiffness: 220,
      }).start(() => nameRef.current?.focus());
    } else {
      Animated.timing(slideAnim, {
        toValue: 400,
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
      setError('Could not save. Try again.');
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
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />

        <Animated.View style={[s.sheet, { transform: [{ translateY: slideAnim }] }]}>
          <View style={s.sheetHandle} />

          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Edit profile</Text>
            <TouchableOpacity
              style={s.sheetClose}
              onPress={onClose}
              hitSlop={10}
              activeOpacity={0.7}
            >
              <Ionicons name="close" size={18} color={c.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={s.formFields}>
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Full name</Text>
              <TouchableOpacity
                style={[s.fieldCard, error ? s.fieldCardError : null]}
                activeOpacity={1}
                onPress={() => nameRef.current?.focus()}
              >
                <Ionicons name="person-outline" size={18} color={c.textMuted} />
                <TextInput
                  ref={nameRef}
                  style={s.fieldInput}
                  value={name}
                  onChangeText={(t) => { setName(t); if (error) setError(''); }}
                  placeholder="Your full name"
                  placeholderTextColor={c.textMuted}
                  autoCapitalize="words"
                  maxLength={60}
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
                {name.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setName('')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={18} color={c.textMuted} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
              {error ? <Text style={s.fieldError}>{error}</Text> : null}
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Mobile</Text>
              <View style={[s.fieldCard, s.fieldCardLocked]}>
                <Ionicons name="call-outline" size={18} color={c.textMuted} />
                <Text style={s.fieldInputLocked}>{formatPhone(phone)}</Text>
                <Ionicons name="lock-closed-outline" size={14} color={c.textMuted} />
              </View>
              <Text style={s.fieldHint}>Phone number can't be changed.</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[s.saveBtn, (!hasChanges || saving) && s.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!hasChanges || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color="#FFFFFF" size="small" />
              : <Text style={s.saveBtnText}>Save changes</Text>}
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flex: 1 },
    content: { paddingBottom: 48 },

    // Top bar
    stickyBar: {
      position: 'absolute',
      top: 0, left: 0, right: 0,
      height: 92,
      backgroundColor: c.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      zIndex: 1,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: H_PAD,
      paddingTop: 8,
      paddingBottom: 12,
      zIndex: 2,
    },
    iconBtn: {
      width: 36, height: 36,
      borderRadius: 18,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    topBarTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.md,
      color: c.text,
      letterSpacing: -0.2,
      maxWidth: SCREEN_WIDTH - 160,
    },

    // Hero
    heroWrap: {
      paddingHorizontal: H_PAD,
      marginTop: 8,
      marginBottom: 24,
    },
    hero: {
      backgroundColor: c.primary,
      borderRadius: 28,
      paddingHorizontal: 22,
      paddingTop: 22,
      paddingBottom: 26,
      overflow: 'hidden',
      ...Shadow.lg,
    },
    heroStripe: {
      position: 'absolute',
      bottom: 0, left: 0, right: 0,
      height: 4,
      backgroundColor: c.accentLight,
    },
    heroTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 24,
    },
    heroEyebrow: {
      flex: 1,
      fontFamily: FontFamily.bold,
      fontSize: 10,
      letterSpacing: 1.6,
      color: 'rgba(255,255,255,0.7)',
    },
    heroEditBtn: {
      width: 32, height: 32,
      borderRadius: 16,
      backgroundColor: 'rgba(255,255,255,0.16)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.25)',
    },
    heroBody: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    heroMonogram: {
      width: 64, height: 64,
      borderRadius: 32,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.4)',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 16,
    },
    heroMonogramText: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize.xl,
      color: '#FFFFFF',
      letterSpacing: 0.5,
    },
    heroTextWrap: { flex: 1 },
    heroName: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['3xl'],
      color: '#FFFFFF',
      letterSpacing: -0.6,
      lineHeight: FontSize['3xl'] + 4,
    },
    heroPhone: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: 'rgba(255,255,255,0.78)',
      marginTop: 4,
      letterSpacing: 0.2,
    },

    // Action rail (4-up)
    rail: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: H_PAD,
      marginBottom: 28,
    },
    railItem: {
      flex: 1,
      alignItems: 'center',
    },
    railBubble: {
      width: 56, height: 56,
      borderRadius: 28,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: 8,
    },
    railLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.text,
      letterSpacing: -0.1,
      textAlign: 'center',
    },

    // Referral ticket
    ticket: {
      marginHorizontal: H_PAD,
      marginBottom: 28,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.accent,
      borderRadius: 22,
      paddingVertical: 20,
      paddingHorizontal: 22,
      ...Shadow.md,
    },
    ticketLeft: {
      flex: 1,
    },
    ticketEyebrow: {
      fontFamily: FontFamily.bold,
      fontSize: 10,
      letterSpacing: 1.4,
      color: 'rgba(255,255,255,0.78)',
      marginBottom: 6,
    },
    ticketTitle: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['2xl'],
      color: '#FFFFFF',
      letterSpacing: -0.5,
    },
    ticketSub: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: 'rgba(255,255,255,0.85)',
      marginTop: 2,
    },
    ticketRight: {
      alignItems: 'center',
      marginLeft: 16,
    },
    ticketCta: {
      width: 44, height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.3)',
      marginBottom: 6,
    },
    ticketCtaLabel: {
      fontFamily: FontFamily.bold,
      fontSize: 10,
      color: '#FFFFFF',
      letterSpacing: 1.4,
    },

    // Section header
    sectionLabel: {
      fontFamily: FontFamily.bold,
      fontSize: 11,
      letterSpacing: 1.4,
      color: c.textSecondary,
      textTransform: 'uppercase',
      marginHorizontal: H_PAD,
      marginBottom: 10,
      marginTop: 4,
    },

    // Card / list
    card: {
      backgroundColor: c.white,
      marginHorizontal: H_PAD,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      marginBottom: 24,
    },
    cardDanger: {
      borderColor: c.dangerBg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    rowIcon: {
      width: 36, height: 36,
      borderRadius: 12,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 14,
    },
    rowIconMuted: { backgroundColor: c.surface },
    rowIconDanger: { backgroundColor: c.dangerBg },
    rowTextWrap: { flex: 1 },
    rowLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      letterSpacing: -0.1,
    },
    rowMeta: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      marginTop: 2,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginLeft: 16 + 36 + 14,
    },

    // Footer
    footer: {
      alignItems: 'center',
      paddingTop: 16,
      paddingBottom: 8,
    },
    footerBrand: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize.sm,
      letterSpacing: 4,
      color: c.textMuted,
    },
    footerMeta: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      marginTop: 6,
      letterSpacing: 0.4,
    },

    // Edit modal
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheet: {
      position: 'absolute',
      bottom: 0, left: 0, right: 0,
      backgroundColor: c.white,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      paddingBottom: Platform.OS === 'ios' ? 36 : 24,
      paddingHorizontal: 20,
      paddingTop: 12,
      ...Shadow.lg,
    },
    sheetHandle: {
      width: 36, height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
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
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize.xl,
      color: c.text,
      letterSpacing: -0.4,
    },
    sheetClose: {
      width: 32, height: 32,
      borderRadius: Radius.full,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    formFields: { marginBottom: 24 },
    fieldGroup: { marginBottom: 16 },
    fieldLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      marginLeft: 2,
      marginBottom: 6,
    },
    fieldCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.white,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: c.border,
      height: 56,
      paddingHorizontal: 16,
    },
    fieldCardError: { borderColor: c.danger },
    fieldCardLocked: { backgroundColor: c.surface, borderColor: c.border },
    fieldInput: {
      flex: 1,
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: c.text,
      paddingVertical: 0,
      marginLeft: 10,
    },
    fieldInputLocked: {
      flex: 1,
      fontFamily: FontFamily.medium,
      fontSize: FontSize.md,
      color: c.textMuted,
      marginLeft: 10,
    },
    fieldError: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.danger,
      marginLeft: 2,
      marginTop: 4,
    },
    fieldHint: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      marginLeft: 2,
      marginTop: 4,
    },
    saveBtn: {
      height: 54,
      backgroundColor: c.primary,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      ...Shadow.md,
    },
    saveBtnDisabled: { opacity: 0.4 },
    saveBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.md,
      color: '#FFFFFF',
      letterSpacing: 0.2,
    },
  });
}
