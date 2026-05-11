import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Linking,

  Animated,
  Easing,
} from 'react-native';
import Constants from 'expo-constants';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SkeletonBox } from '../../components/SkeletonBox';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
} from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { FontFamily } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getMe, updateMe, deleteMe, UnpaidBookingsError } from '../../api/users';
import { listAddresses } from '../../api/addresses';
import { listExperts } from '../../api/experts';
import { useRoomies } from '../../context/RoomiesContext';
import { haptics } from '../../utils/haptics';
import { showError, showInfo } from '../../utils/toast';
import ZopFace from '../../../assets/zop/zop-face.svg';
import { Bloom } from '../../components/home/Bloom';

// Brand legal URLs — matched with auth/OTPVerificationScreen.tsx.
const PRIVACY_POLICY_URL = 'https://zopmop.com/privacy';
const TERMS_URL = 'https://zopmop.com/terms';

type Nav = NativeStackNavigationProp<MainStackParamList>;

// Pull from Expo manifest so the About modal + footer track the shipped version.
const APP_VERSION =
  (Constants?.expoConfig?.version as string | undefined) ?? '1.0.0';
const H_PAD = 20;

const C = {
  bg: '#0A0A0A',
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberLo: '#E88F00',
  ink: '#0D0D0F',
  white: '#FFFFFF',
  text: '#FFFFFF',
  muted: 'rgba(255,255,255,0.45)',
  meta: 'rgba(255,255,255,0.45)',
  rowLabel: '#FFFFFF',
  glassFill: 'rgba(255,255,255,0.06)',
  glassFill2: 'rgba(255,255,255,0.025)',
  glassBorder: 'rgba(255,255,255,0.07)',
  divider: 'rgba(255,255,255,0.04)',
  active: '#22C55E',
  danger: '#EF4444',
};

function getInitials(name?: string | null): string {
  if (!name) return 'ZM';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPhone(raw?: string): string {
  if (!raw) return '';
  const m = raw.match(/^(\+\d{2})(\d{5})(\d{5})$/);
  if (m) return `${m[1]} ${m[2]} ${m[3]}`;
  return raw;
}

function roleLabel(role?: string): string {
  if (!role) return 'MEMBER';
  const r = role.toLowerCase();
  if (r === 'pro' || r === 'helper') return 'PRO PARTNER';
  if (r === 'admin') return 'ADMIN';
  return 'MEMBER';
}

export default function ProfileScreen() {
  const { token, user, signOut, updateUser } = useAuth();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { myGroup } = useRoomies();
  const [editVisible, setEditVisible] = useState(false);
  const [fetchingProfile, setFetchingProfile] = useState(false);
  const [darkOn, setDarkOn] = useState(true);
  const [remindersOn, setRemindersOn] = useState(true);

  // Real meta wired to the existing per-user endpoints. We only render meta
  // strings once a value resolves — undefined collapses the row's subtitle.
  const [addressMeta, setAddressMeta] = useState<string | undefined>();
  const [expertsMeta, setExpertsMeta] = useState<string | undefined>();

  useEffect(() => {
    if (!token || token === '__guest__') return;
    setFetchingProfile(true);
    getMe(token)
      .then(updateUser)
      .catch(() => {})
      .finally(() => setFetchingProfile(false));
  }, []);

  useEffect(() => {
    if (!token || token === '__guest__') return;
    let alive = true;
    listAddresses(token)
      .then((rows) => {
        if (!alive) return;
        if (!rows || rows.length === 0) { setAddressMeta(undefined); return; }
        const tags = rows.map((r) => r.tag).filter(Boolean) as string[];
        const uniqueTags = Array.from(new Set(tags));
        if (uniqueTags.length === 0) {
          setAddressMeta(`${rows.length} saved`);
          return;
        }
        const shown = uniqueTags.slice(0, 2).join(' · ');
        const extra = rows.length - Math.min(uniqueTags.length, 2);
        setAddressMeta(extra > 0 ? `${shown} · +${extra} more` : shown);
      })
      .catch(() => {});
    listExperts(token)
      .then((res) => {
        if (!alive) return;
        const n = res?.experts?.length ?? 0;
        setExpertsMeta(n > 0 ? `${n} favorite${n === 1 ? '' : 's'}` : undefined);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [token]);

  const roomiesMeta = useMemo(() => {
    const n = myGroup?.members?.length ?? 0;
    if (!myGroup) return 'Not joined yet';
    if (n === 0) return 'Not joined yet';
    return `${n} member${n === 1 ? '' : 's'} · split bills automatically`;
  }, [myGroup]);

  const handleLogout = () => {
    haptics.warning();
    Alert.alert('Log out of ZopMop?', 'You can sign back in anytime with your phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => { haptics.heavy(); signOut(); } },
    ]);
  };

  const handleDelete = () => {
    if (!token || token === '__guest__') return;
    haptics.warning();
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
                      if (err instanceof UnpaidBookingsError) {
                        const totalRupees = (err.totalPaise / 100).toFixed(2);
                        Alert.alert(
                          'Settle pending payments',
                          `You have ${err.count} unpaid booking(s) totaling ₹${totalRupees}. Please settle them before deleting your account.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'View Bookings', onPress: () => navigation.navigate('Bookings') },
                          ],
                        );
                        return;
                      }
                      showError(err instanceof Error ? err.message : 'Please try again.', { title: 'Delete failed' });
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

  return (
    <View style={s.root}>
      <Bloom />

      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.topbar}>
          <TouchableOpacity style={s.iconBtn} onPress={() => navigation.goBack()} activeOpacity={0.75} hitSlop={10}>
            <Feather name="chevron-left" size={18} color={C.white} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.iconBtn}
            onPress={() => navigation.navigate('HelpSupport')}
            activeOpacity={0.75}
            hitSlop={10}
          >
            <Feather name="help-circle" size={16} color={C.white} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 110 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          <HeroCard
            name={user?.name}
            phone={user?.phone}
            role={user?.role}
            loading={fetchingProfile && !user?.phone}
            onEdit={() => setEditVisible(true)}
          />

          <ActionRail navigation={navigation} />

          <SectionHeader>Referral</SectionHeader>
          <Card>
            <Row
              icon={<Feather name="gift" size={17} color={C.amber} />}
              label="Refer & Earn"
              meta="Get Rs 200 per referral"
              chev
              onPress={() => navigation.navigate('ReferralEarn')}
              last
            />
          </Card>

          <SectionHeader>Preferences</SectionHeader>
          <Card>
            <Row
              icon={<Feather name="moon" size={17} color={C.amber} />}
              label="Appearance"
              meta={darkOn ? 'Dark mode' : 'Light mode'}
              right={<Toggle on={darkOn} onChange={setDarkOn} />}
            />
            {/* Reminder timing is locally toggled today; meta hidden until
                backend exposes a reminder-prefs endpoint (S8). */}
            <Row
              icon={<Feather name="bell" size={17} color={C.amber} />}
              label="Reminders"
              right={<Toggle on={remindersOn} onChange={setRemindersOn} />}
              last
            />
          </Card>

          <SectionHeader>Account</SectionHeader>
          <Card>
            <Row
              icon={<Feather name="map-pin" size={17} color={C.amber} />}
              label="Saved Addresses"
              meta={addressMeta}
              chev
              onPress={() => navigation.navigate('Addresses')}
            />
            <Row
              icon={<Feather name="home" size={17} color={C.amber} />}
              label="Roomies"
              meta={roomiesMeta}
              chev
              onPress={() => navigation.navigate('RoomiesSetup')}
            />
            <Row
              icon={<Feather name="users" size={17} color={C.amber} />}
              label="Your Experts"
              meta={expertsMeta}
              chev
              onPress={() => navigation.navigate('YourExperts')}
            />
            {/* Notifications meta hidden until /me/notification-prefs ships (S7). */}
            <Row
              icon={<Feather name="bell" size={17} color={C.amber} />}
              label="Notifications"
              chev
              onPress={() => showInfo("We'll let you know when channel preferences are configurable.", { title: 'Notifications' })}
              last
            />
          </Card>

          <SectionHeader>Info & Legal</SectionHeader>
          <Card>
            <Row
              muted
              icon={<Feather name="info" size={17} color="rgba(255,255,255,0.6)" />}
              label="About ZopMop"
              chev
              onPress={() => showInfo(`ZopMop · v${APP_VERSION}\nHome, handled.`, { title: 'About ZopMop' })}
            />
            <Row
              muted
              icon={<Feather name="file-text" size={17} color="rgba(255,255,255,0.6)" />}
              label="Terms of Service"
              chev
              onPress={() => Linking.openURL(TERMS_URL).catch(() => showError('Could not open Terms of Service.', { title: 'Terms' }))}
            />
            <Row
              muted
              icon={<Feather name="shield" size={17} color="rgba(255,255,255,0.6)" />}
              label="Privacy Policy"
              chev
              onPress={() => Linking.openURL(PRIVACY_POLICY_URL).catch(() => showError('Could not open Privacy Policy.', { title: 'Privacy' }))}
              last
            />
          </Card>

          <View style={s.danger}>
            <TouchableOpacity style={s.logoutBtn} activeOpacity={0.85} onPress={handleLogout}>
              <Feather name="log-out" size={16} color={C.danger} />
              <Text style={s.logoutText}>Log out</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.deleteBtn} activeOpacity={0.7} onPress={handleDelete}>
              <Text style={s.deleteText}>Delete account</Text>
            </TouchableOpacity>
          </View>

          <View style={s.footer}>
            <Text style={s.footerVersion}>ZopMop · v{APP_VERSION}</Text>
            <Text style={s.footerTagline}>Home, handled.</Text>
            <View style={s.footerZop}>
              <ZopFace width={32} height={32} opacity={0.4} />
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>

      <EditProfileModal
        visible={editVisible}
        currentName={user?.name}
        phone={user?.phone}
        token={token}
        onClose={() => setEditVisible(false)}
        onSaved={(u) => { updateUser(u); setEditVisible(false); }}
      />
    </View>
  );
}

// Background glow now sourced from the canonical home primitive (Bloom).

function HeroCard({
  name, phone, role, loading, onEdit,
}: {
  name?: string | null; phone?: string; role?: string; loading?: boolean; onEdit: () => void;
}) {
  const initials = getInitials(name);
  const displayName = name ?? 'Add your name';
  const displayPhone = formatPhone(phone);
  // S1, S2: Active-member chip + bookings count are hidden until the backend
  // exposes membership tier + completed_bookings_count on the user record.
  // Falling back to fabricated values would mislead fresh accounts.

  return (
    <View style={s.heroWrap}>
      <View style={s.hero}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%">
            <Defs>
              <SvgLinearGradient id="heroBg" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor="#1A1A1C" />
                <Stop offset="100%" stopColor="#0D0D0F" />
              </SvgLinearGradient>
              <SvgRadialGradient id="heroGlow" cx="80%" cy="30%" rx="100%" ry="80%">
                <Stop offset="0%" stopColor="#F5A300" stopOpacity="0.4" />
                <Stop offset="50%" stopColor="#F5A300" stopOpacity="0" />
              </SvgRadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#heroBg)" />
            <Rect width="100%" height="100%" fill="url(#heroGlow)" />
          </Svg>
        </View>

        <View style={s.heroAmberLine} pointerEvents="none" />

        <View style={s.heroTop}>
          <Text style={s.heroEyebrow} numberOfLines={1}>
            ZOPMOP · {roleLabel(role)}
          </Text>
          <TouchableOpacity onPress={onEdit} activeOpacity={0.75} hitSlop={12} style={s.heroEdit}>
            <Feather name="edit-2" size={13} color={C.white} />
          </TouchableOpacity>
        </View>

        <View style={s.heroBody}>
          <View style={s.monogramWrap}>
            <Svg width={64} height={64} style={StyleSheet.absoluteFill}>
              <Defs>
                <SvgLinearGradient id="monoGrad" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0%" stopColor="#FFC042" />
                  <Stop offset="100%" stopColor="#F5A300" />
                </SvgLinearGradient>
              </Defs>
              <Rect width="64" height="64" rx="32" fill="url(#monoGrad)" />
            </Svg>
            <Text style={s.monogramText}>{initials}</Text>
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            {loading ? (
              <View style={{ gap: 8 }}>
                <SkeletonBox width="60%" height={18} borderRadius={6} />
                <SkeletonBox width="40%" height={11} borderRadius={5} />
              </View>
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

function ActionRail({ navigation }: { navigation: Nav }) {
  // Pip badges (Bookings/Offers) are hidden until the backend provides counts:
  //   • Bookings — needs an upcoming-count on /bookings or a /me summary (S9).
  //   • Offers — needs GET /offers (S10/S23).
  // Showing fabricated 2/3 values misled fresh accounts.
  const items: Array<{
    id: string;
    label: string;
    icon: React.ReactNode;
    pip?: number;
    go: () => void;
  }> = [
    {
      id: 'bookings',
      label: 'Bookings',
      icon: <Feather name="calendar" size={22} color={C.amber} />,
      go: () => navigation.navigate('Bookings'),
    },
    {
      id: 'wallet',
      label: 'Wallet',
      icon: <Feather name="credit-card" size={22} color={C.amber} />,
      go: () => navigation.navigate('Wallet'),
    },
    {
      id: 'offers',
      label: 'Offers',
      icon: <Feather name="tag" size={22} color={C.amber} />,
      go: () => navigation.navigate('Offers'),
    },
    {
      id: 'help',
      label: 'Help',
      icon: <Feather name="help-circle" size={22} color={C.amber} />,
      go: () => navigation.navigate('HelpSupport'),
    },
  ];

  return (
    <View style={s.rail}>
      {items.map((it) => (
        <TouchableOpacity key={it.id} onPress={it.go} activeOpacity={0.75} style={s.railItem}>
          <View style={s.railBubble}>
            {it.icon}
            {it.pip != null && (
              <View style={s.pip}>
                <Text style={s.pipText}>{it.pip}</Text>
              </View>
            )}
          </View>
          <Text style={s.railLabel} numberOfLines={1}>{it.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ReferralTicket({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={s.ticket}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <SvgLinearGradient id="ticketGrad" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor="#FFC042" />
              <Stop offset="60%" stopColor="#F5A300" />
              <Stop offset="100%" stopColor="#E88F00" />
            </SvgLinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx="20" ry="20" fill="url(#ticketGrad)" />
        </Svg>
      </View>

      <View style={s.ticketLeft}>
        <Text style={s.ticketEyebrow}>INVITE A FRIEND</Text>
        <Text style={s.ticketTitle}>Earn ₹100</Text>
        <Text style={s.ticketSub}>per friend who joins ZopMop</Text>
      </View>

      <View style={s.ticketRight}>
        <View style={s.ticketCta}>
          <Feather name="share-2" size={20} color={C.amberHi} />
        </View>
        <Text style={s.ticketCtaLabel}>SHARE</Text>
      </View>
    </TouchableOpacity>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionHeader}>{children}</Text>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

function Row({
  icon, label, meta, right, chev, onPress, muted, last,
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  right?: React.ReactNode;
  chev?: boolean;
  onPress?: () => void;
  muted?: boolean;
  last?: boolean;
}) {
  const Comp: any = onPress ? TouchableOpacity : View;
  return (
    <Comp
      style={[s.row, !last && s.rowDivider]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <View style={[s.rowIcon, muted && s.rowIconMuted]}>{icon}</View>
      <View style={s.rowText}>
        <Text style={[s.rowLabel, muted && s.rowLabelMuted]} numberOfLines={1}>{label}</Text>
        {!!meta && <Text style={s.rowMeta} numberOfLines={1}>{meta}</Text>}
      </View>
      {right}
      {chev && <Feather name="chevron-right" size={14} color="rgba(255,255,255,0.4)" />}
    </Comp>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const anim = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: on ? 1 : 0,
      duration: 220,
      easing: Easing.bezier(0.37, 1.95, 0.66, 0.56),
      useNativeDriver: false,
    }).start();
  }, [on]);

  const left = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 20] });

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={() => onChange(!on)} style={s.toggleHit}>
      <View style={[s.toggleTrack, on ? s.toggleOn : s.toggleOff]}>
        {on && (
          <View style={StyleSheet.absoluteFill}>
            <Svg width="46" height="28">
              <Defs>
                <SvgLinearGradient id="togGrad" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor="#FFC042" />
                  <Stop offset="100%" stopColor="#F5A300" />
                </SvgLinearGradient>
              </Defs>
              <Rect width="46" height="28" rx="14" fill="url(#togGrad)" />
            </Svg>
          </View>
        )}
        <Animated.View style={[s.toggleThumb, { left }]} />
      </View>
    </TouchableOpacity>
  );
}

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
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const slideAnim = useRef(new Animated.Value(400)).current;
  const nameRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(currentName ?? '');
      setError('');
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220 })
        .start(() => nameRef.current?.focus());
    } else {
      Animated.timing(slideAnim, { toValue: 400, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);

  async function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length < 2) { setError('Name must be at least 2 characters.'); return; }
    if (!token || token === '__guest__') { setError('Not authenticated.'); return; }
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />
        <Animated.View style={[s.sheet, { transform: [{ translateY: slideAnim }] }]}>
          <View style={s.sheetHandle} />
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Edit profile</Text>
            <TouchableOpacity style={s.sheetClose} onPress={onClose} hitSlop={10} activeOpacity={0.7}>
              <Feather name="x" size={18} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>

          <View style={{ marginBottom: 24 }}>
            <View style={{ marginBottom: 16 }}>
              <Text style={s.fieldLabel}>Full name</Text>
              <TouchableOpacity
                style={[s.fieldCard, error ? s.fieldCardError : null]}
                activeOpacity={1}
                onPress={() => nameRef.current?.focus()}
              >
                <Feather name="user" size={18} color="rgba(255,255,255,0.5)" />
                <TextInput
                  ref={nameRef}
                  style={s.fieldInput}
                  value={name}
                  onChangeText={(t) => { setName(t); if (error) setError(''); }}
                  placeholder="Your full name"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  autoCapitalize="words"
                  maxLength={60}
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
                {name.length > 0 && (
                  <TouchableOpacity onPress={() => setName('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="x-circle" size={18} color="rgba(255,255,255,0.5)" />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
              {error ? <Text style={s.fieldError}>{error}</Text> : null}
            </View>

            <View style={{ marginBottom: 16 }}>
              <Text style={s.fieldLabel}>Mobile</Text>
              <View style={[s.fieldCard, s.fieldCardLocked]}>
                <Feather name="phone" size={18} color="rgba(255,255,255,0.4)" />
                <Text style={s.fieldInputLocked}>{formatPhone(phone)}</Text>
                <Feather name="lock" size={14} color="rgba(255,255,255,0.4)" />
              </View>
              <Text style={s.fieldHint}>Phone number can't be changed.</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[s.saveBtn, (!hasChanges || saving) && { opacity: 0.4 }]}
            onPress={handleSave}
            disabled={!hasChanges || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <LoadingBars color={C.ink} size="small" />
              : <Text style={s.saveBtnText}>Save changes</Text>}
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },

  // Hero
  heroWrap: { paddingHorizontal: H_PAD, paddingTop: 14 },
  hero: {
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  heroAmberLine: {
    position: 'absolute', bottom: 0, left: '20%', right: '20%', height: 1,
    backgroundColor: 'rgba(245,163,0,0.4)',
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  heroEyebrow: {
    fontFamily: FontFamily.bold,
    fontSize: 10,
    letterSpacing: 1.8,
    color: 'rgba(245,163,0,0.95)',
  },
  heroEdit: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  heroBody: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  monogramWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#F5A300',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  monogramText: {
    fontFamily: FontFamily.extrabold,
    fontSize: 22,
    color: C.ink,
    letterSpacing: -0.4,
  },
  heroName: {
    fontFamily: FontFamily.bold,
    fontSize: 22,
    color: C.white,
    letterSpacing: -0.4,
    lineHeight: 24,
  },
  heroPhone: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    color: 'rgba(255,255,255,0.55)',
    marginTop: 4,
  },
  heroChips: { flexDirection: 'row', gap: 8, marginTop: 10 },
  chip: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 99,
    backgroundColor: 'rgba(245,163,0,0.18)',
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  chipDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: C.active,
    shadowColor: C.active, shadowOpacity: 0.8, shadowRadius: 4,
  },
  chipText: {
    fontFamily: FontFamily.semibold,
    fontSize: 10,
    color: C.amberHi,
    letterSpacing: 0.2,
  },

  // Action rail
  rail: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 4,
    gap: 6,
  },
  railItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 14,
    gap: 6,
  },
  railBubble: {
    width: 54, height: 54, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.07)',
    position: 'relative',
  },
  pip: {
    position: 'absolute', top: -2, right: -2,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.bg,
  },
  pipText: {
    fontFamily: FontFamily.extrabold,
    fontSize: 9,
    color: C.ink,
    lineHeight: 10,
  },
  railLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: 11,
    color: 'rgba(255,255,255,0.85)',
  },

  // Ticket
  ticket: {
    marginHorizontal: H_PAD,
    marginTop: 18,
    padding: 18,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
    shadowColor: '#F5A300',
    shadowOpacity: 0.4,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  ticketLeft: { flex: 1 },
  ticketEyebrow: {
    fontFamily: FontFamily.bold,
    fontSize: 10,
    letterSpacing: 1.8,
    color: 'rgba(13,13,15,0.6)',
  },
  ticketTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: 24,
    color: C.ink,
    letterSpacing: -0.4,
    marginTop: 4,
    lineHeight: 26,
  },
  ticketSub: {
    fontFamily: FontFamily.medium,
    fontSize: 12,
    color: 'rgba(13,13,15,0.7)',
    marginTop: 4,
  },
  ticketRight: { alignItems: 'center', gap: 6 },
  ticketCta: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: C.ink,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  ticketCtaLabel: {
    fontFamily: FontFamily.extrabold,
    fontSize: 10,
    color: C.ink,
    letterSpacing: 1.2,
  },

  // Section header
  sectionHeader: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    letterSpacing: 1.3,
    color: 'rgba(255,255,255,0.45)',
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 8,
    textTransform: 'uppercase',
  },

  // Card
  card: {
    marginHorizontal: H_PAD,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  rowIconMuted: { backgroundColor: 'rgba(255,255,255,0.06)' },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: 14,
    color: C.white,
    letterSpacing: -0.1,
    lineHeight: 17,
  },
  rowLabelMuted: {
    fontFamily: FontFamily.medium,
    fontSize: 13,
    color: 'rgba(255,255,255,0.78)',
  },
  rowMeta: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 2,
  },

  // Toggle
  toggleHit: { padding: 2 },
  toggleTrack: {
    width: 46, height: 28, borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  toggleOff: { backgroundColor: 'rgba(255,255,255,0.08)' },
  toggleOn: {},
  toggleThumb: {
    position: 'absolute',
    top: 2,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    zIndex: 1,
  },

  // Danger
  danger: { marginHorizontal: H_PAD, marginTop: 24, gap: 8 },
  logoutBtn: {
    height: 46, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
  },
  logoutText: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    color: C.danger,
    letterSpacing: -0.1,
  },
  deleteBtn: {
    height: 46, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  deleteText: {
    fontFamily: FontFamily.semibold,
    fontSize: 12,
    color: 'rgba(239,68,68,0.75)',
  },

  // Footer
  footer: { paddingTop: 24, paddingBottom: 16, alignItems: 'center' },
  footerVersion: {
    fontFamily: FontFamily.semibold,
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 0.4,
  },
  footerTagline: {
    fontFamily: FontFamily.medium,
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  footerZop: { marginTop: 14, alignItems: 'center' },

  // Edit modal
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#101012',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  sheetTitle: {
    flex: 1,
    fontFamily: FontFamily.extrabold,
    fontSize: 20, color: C.white,
    letterSpacing: -0.4,
  },
  sheetClose: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  fieldLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: 13, color: 'rgba(255,255,255,0.65)',
    marginLeft: 2, marginBottom: 6,
  },
  fieldCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    height: 56, paddingHorizontal: 16,
  },
  fieldCardError: { borderColor: C.danger },
  fieldCardLocked: { backgroundColor: 'rgba(255,255,255,0.03)' },
  fieldInput: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: 16, color: C.white, paddingVertical: 0,
  },
  fieldInputLocked: {
    flex: 1, fontFamily: FontFamily.medium, fontSize: 16,
    color: 'rgba(255,255,255,0.5)',
  },
  fieldError: {
    fontFamily: FontFamily.regular, fontSize: 11,
    color: C.danger, marginLeft: 2, marginTop: 4,
  },
  fieldHint: {
    fontFamily: FontFamily.regular, fontSize: 11,
    color: 'rgba(255,255,255,0.4)', marginLeft: 2, marginTop: 4,
  },
  saveBtn: {
    height: 54, borderRadius: 18,
    backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#F5A300', shadowOpacity: 0.4,
    shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  saveBtnText: {
    fontFamily: FontFamily.extrabold, fontSize: 16,
    color: C.ink, letterSpacing: 0.2,
  },
});
