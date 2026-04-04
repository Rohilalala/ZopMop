import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 16;
const QUICK_GAP = 10;
const QUICK_CARD_WIDTH = (SCREEN_WIDTH - H_PAD * 2 - QUICK_GAP) / 2;

// ── Static data (replace with context/API later) ──────────────────────────────

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

// ── Root Component ────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const { signOut } = useAuth();

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: signOut },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This action is permanent and cannot be undone. All your data will be deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => {} },
      ],
    );
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Profile</Text>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <UserInfoCard />
        <QuickActionsGrid />
        <ReferralBanner />
        <ListSection title="Account" items={ACCOUNT_ITEMS} />
        <ListSection title="Info & Legal" items={LEGAL_ITEMS} muted />
        <AccountActions onLogout={handleLogout} onDelete={handleDeleteAccount} />
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── User Info Card ────────────────────────────────────────────────────────────

function UserInfoCard() {
  return (
    <View style={s.userCard}>
      <View style={s.avatarWrap}>
        <View style={s.avatar}>
          <Text style={s.avatarInitials}>AR</Text>
        </View>
        <TouchableOpacity style={s.avatarEditBtn} activeOpacity={0.8}>
          <Ionicons name="pencil" size={11} color={Colors.white} />
        </TouchableOpacity>
      </View>

      <View style={s.userInfo}>
        <Text style={s.userName} numberOfLines={1}>Aditya Rohilla</Text>
        <Text style={s.userPhone}>+91 98765 43210</Text>
      </View>

      <TouchableOpacity style={s.editBtn} activeOpacity={0.8}>
        <Text style={s.editBtnText}>Edit</Text>
        <Ionicons name="chevron-forward" size={12} color={Colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

// ── Quick Actions Grid ────────────────────────────────────────────────────────

function QuickActionsGrid() {
  return (
    <View style={s.section}>
      <View style={s.quickGrid}>
        {QUICK_ACTIONS.map(item => (
          <TouchableOpacity
            key={item.id}
            style={[s.quickCard, { width: QUICK_CARD_WIDTH }]}
            activeOpacity={0.82}
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
      <TouchableOpacity style={s.referralCard} activeOpacity={0.85}>
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
  title,
  items,
  muted = false,
}: {
  title: string;
  items: readonly ListItem[];
  muted?: boolean;
}) {
  return (
    <View style={s.section}>
      <Text style={[s.sectionLabel, muted && s.sectionLabelMuted]}>{title}</Text>
      <View style={s.listCard}>
        {items.map((item, idx) => (
          <React.Fragment key={item.id}>
            <TouchableOpacity style={s.listRow} activeOpacity={0.7}>
              <View style={[s.listIconBox, muted && s.listIconBoxMuted]}>
                <Ionicons
                  name={item.icon as any}
                  size={18}
                  color={muted ? Colors.textMuted : Colors.primary}
                />
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

function AccountActions({ onLogout, onDelete }: { onLogout: () => void; onDelete: () => void }) {
  return (
    <View style={s.section}>
      <View style={s.listCard}>
        <TouchableOpacity style={s.listRow} onPress={onLogout} activeOpacity={0.7}>
          <View style={[s.listIconBox, s.listIconBoxWarn]}>
            <Ionicons name="log-out-outline" size={18} color={Colors.warning} />
          </View>
          <Text style={[s.listLabel, s.listLabelWarn]}>Log Out</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
        </TouchableOpacity>

        <View style={s.divider} />

        <TouchableOpacity style={s.listRow} onPress={onDelete} activeOpacity={0.7}>
          <View style={[s.listIconBox, s.listIconBoxDanger]}>
            <Ionicons name="trash-outline" size={18} color={Colors.danger} />
          </View>
          <Text style={[s.listLabel, s.listLabelDanger]}>Delete Account</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const DIVIDER_INDENT = H_PAD + 36 + 12; // left-aligns with row text

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { paddingBottom: Spacing.base },

  // ── Header
  header: {
    paddingHorizontal: H_PAD,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },

  // ── Section wrapper
  section: {
    paddingHorizontal: H_PAD,
    marginBottom: 20,
  },
  sectionLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sectionLabelMuted: {
    color: Colors.textMuted,
  },

  // ── User Card
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

  // ── Quick Actions Grid
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: QUICK_GAP,
  },
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
  quickTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  quickSubtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 16,
  },

  // ── Referral Banner
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
  referralContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
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
  referralTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.white,
    marginBottom: 2,
  },
  referralSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: 'rgba(255,255,255,0.76)',
  },

  // ── List Card
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
  listIconBoxMuted: {
    backgroundColor: Colors.surface,
  },
  listIconBoxWarn: {
    backgroundColor: Colors.warningBg,
  },
  listIconBoxDanger: {
    backgroundColor: Colors.dangerBg,
  },
  listLabel: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  listLabelMuted: {
    color: Colors.textSecondary,
  },
  listLabelWarn: {
    color: Colors.warning,
  },
  listLabelDanger: {
    color: Colors.danger,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: DIVIDER_INDENT,
  },
});
