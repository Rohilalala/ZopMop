import React, { useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  
  Animated,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors, authColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { setNeedsRoleSelection } from '../../utils/pendingAuthStore';

type Props = {
  route: RouteProp<AuthStackParamList, 'RoleSelection'>;
};

type Role = 'user' | 'professional';

export default function RoleSelectionScreen({ route }: Props) {
  const { phone } = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { user } = useAuth();
  const c = authColors; // Auth flow locked to light — no dark variant.
  const styles = useMemo(() => createStyles(c), [c]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const buttonScale = useRef(new Animated.Value(1)).current;

  function animateButtonIn() {
    Animated.spring(buttonScale, {
      toValue: 0.95,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  }

  function animateButtonOut() {
    Animated.spring(buttonScale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 20,
      bounciness: 10,
    }).start();
  }

  async function handleContinue() {
    if (!selected) return;
    if (selected === 'professional') {
      navigation.navigate('ProOnboarding', { phone });
      return;
    }
    // Customer choice: user is already signed in from the verify-otp
    // step, so we just confirm we have a session and the root
    // navigator will swap to MainNavigator on the next render.
    setError('');
    setLoading(true);
    if (!user) {
      setError('Unable to complete sign-in. Please go back and try again.');
      setLoading(false);
      return;
    }
    // Customer chosen. Clear the role-selection flag so the root
    // navigator stops pinning AuthNavigator for this reason. A nameless
    // customer still needs NameEntry (App.tsx's needsName keeps Auth
    // mounted), so route there explicitly; a named one falls through to
    // MainNavigator on the next render.
    setNeedsRoleSelection(false);
    const hasName = !!user.name?.trim();
    if (!hasName) {
      navigation.replace('NameEntry', { phone });
    }
    setLoading(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.container}>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>Z</Text>
          </View>
          <Text style={styles.title}>Welcome to ZopMop</Text>
          <Text style={styles.subtitle}>How would you like to use the app?</Text>
        </View>

        {/* Cards — Pro left, User right */}
        <View style={styles.cards}>
          <RoleCard
            selected={selected === 'professional'}
            onPress={() => setSelected('professional')}
            icon={<BriefcaseIcon active={selected === 'professional'} />}
            title="I'm a Pro"
            desc="Offer services & earn"
          />
          <RoleCard
            selected={selected === 'user'}
            onPress={() => setSelected('user')}
            icon={<PersonIcon active={selected === 'user'} />}
            title="I'm a User"
            desc="Book home services instantly"
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      <View style={styles.bottom}>
        <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
          <TouchableOpacity
            style={[styles.continueButton, (!selected || loading) && styles.continueButtonDisabled]}
            onPress={handleContinue}
            onPressIn={animateButtonIn}
            onPressOut={animateButtonOut}
            disabled={!selected || loading}
            activeOpacity={1}
          >
            {loading
              ? <LoadingBars color="#0D0D0F" size="small" />
              : <Text style={styles.continueButtonText}>Continue</Text>}
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

function RoleCard({ selected, onPress, icon, title, desc }: {
  selected: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  const c = authColors; // Auth flow locked to light — no dark variant.
  const styles = useMemo(() => createStyles(c), [c]);
  return (
    <TouchableOpacity
      style={[styles.card, selected && styles.cardSelected]}
      onPress={onPress}
      activeOpacity={0.9}
    >
      {/* Check badge */}
      <View style={[styles.checkBadge, selected && styles.checkBadgeVisible]}>
        <View style={styles.checkmark} />
        <View style={styles.checkmarkArm} />
      </View>

      <View style={[styles.iconBox, selected && styles.iconBoxSelected]}>
        {icon}
      </View>

      <Text style={[styles.cardTitle, selected && styles.cardTitleSelected]}>{title}</Text>
      <Text style={styles.cardDesc}>{desc}</Text>
    </TouchableOpacity>
  );
}

function PersonIcon({ active }: { active: boolean }) {
  const c = authColors; // Auth flow locked to light — no dark variant.
  const styles = useMemo(() => createStyles(c), [c]);
  const color = active ? '#0D0D0F' : c.accent;
  return (
    <View style={styles.personIcon}>
      <View style={[styles.personHead, { backgroundColor: color }]} />
      <View style={[styles.personBody, { backgroundColor: color }]} />
    </View>
  );
}

function BriefcaseIcon({ active }: { active: boolean }) {
  const c = authColors; // Auth flow locked to light — no dark variant.
  const styles = useMemo(() => createStyles(c), [c]);
  const color = active ? '#0D0D0F' : c.accent;
  return (
    <View style={styles.briefcaseIcon}>
      <View style={[styles.briefcaseHandle, { borderColor: color }]} />
      <View style={[styles.briefcaseBody, { backgroundColor: color }]} />
    </View>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    container: { flex: 1, paddingHorizontal: Spacing['2xl'], paddingTop: Spacing['3xl'] },
    header: { marginBottom: Spacing['3xl'], gap: Spacing.md },
    logoMark: { width: 44, height: 44, borderRadius: Radius.lg, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm },
    logoMarkText: { fontFamily: FontFamily.extrabold, fontSize: FontSize.xl, color: '#0D0D0F' },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize['3xl'], color: c.text, letterSpacing: -0.5 },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary },
    cards: { flexDirection: 'row', gap: Spacing.md },
    card: {
      flex: 1, aspectRatio: 0.82, backgroundColor: c.white,
      borderRadius: Radius.xl, borderWidth: 1.5, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, ...Shadow.sm,
    },
    cardSelected: { borderColor: c.accent, borderWidth: 2, ...Shadow.md },
    checkBadge: {
      position: 'absolute', top: 12, right: 12, width: 20, height: 20,
      borderRadius: Radius.full, backgroundColor: c.border, alignItems: 'center', justifyContent: 'center', opacity: 0,
    },
    checkBadgeVisible: { backgroundColor: c.accent, opacity: 1 },
    checkmark: {
      position: 'absolute', width: 4, height: 7, borderRightWidth: 2, borderBottomWidth: 2,
      borderColor: '#0D0D0F', transform: [{ rotate: '45deg' }, { translateY: -1 }],
    },
    checkmarkArm: { display: 'none' },
    iconBox: { width: 56, height: 56, borderRadius: Radius.lg, backgroundColor: 'rgba(245,163,0,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xs },
    iconBoxSelected: { backgroundColor: c.accent },
    cardTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.md, color: c.text, textAlign: 'center' },
    cardTitleSelected: { color: c.accentOnSurface },
    cardDesc: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, textAlign: 'center', paddingHorizontal: Spacing.sm },
    personIcon: { alignItems: 'center' },
    personHead: { width: 13, height: 13, borderRadius: Radius.full, marginBottom: 3 },
    personBody: { width: 20, height: 10, borderTopLeftRadius: 10, borderTopRightRadius: 10 },
    briefcaseIcon: { alignItems: 'center' },
    briefcaseHandle: { width: 13, height: 5, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderWidth: 2, borderBottomWidth: 0, backgroundColor: 'transparent', marginBottom: -1 },
    briefcaseBody: { width: 24, height: 15, borderRadius: 3 },
    errorText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.danger, textAlign: 'center', marginTop: Spacing.md },
    bottom: { paddingHorizontal: Spacing['2xl'], paddingBottom: Spacing['2xl'] },
    continueButton: { height: 54, backgroundColor: c.accent, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', ...Shadow.md },
    continueButtonDisabled: { opacity: 0.45 },
    continueButtonText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: '#0D0D0F', letterSpacing: 0.2 },
  });
}
