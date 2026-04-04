import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';

type Props = {
  route: RouteProp<AuthStackParamList, 'RoleSelection'>;
};

type Role = 'user' | 'professional';

export default function RoleSelectionScreen({ route }: Props) {
  const { phone } = route.params;
  const { signIn } = useAuth();
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
    setError('');
    setLoading(true);
    try {
      // TODO: POST /select-role when backend is running
      signIn(phone, selected);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
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
              ? <ActivityIndicator color={Colors.white} size="small" />
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
  const color = active ? Colors.white : Colors.primary;
  return (
    <View style={styles.personIcon}>
      <View style={[styles.personHead, { backgroundColor: color }]} />
      <View style={[styles.personBody, { backgroundColor: color }]} />
    </View>
  );
}

function BriefcaseIcon({ active }: { active: boolean }) {
  const color = active ? Colors.white : Colors.primary;
  return (
    <View style={styles.briefcaseIcon}>
      <View style={[styles.briefcaseHandle, { borderColor: color }]} />
      <View style={[styles.briefcaseBody, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  container: {
    flex: 1,
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing['3xl'],
  },

  header: { marginBottom: Spacing['3xl'], gap: Spacing.md },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  logoMarkText: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize.xl,
    color: Colors.white,
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },

  cards: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  card: {
    flex: 1,
    aspectRatio: 0.82,
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    ...Shadow.sm,
  },
  cardSelected: {
    borderColor: Colors.primary,
    borderWidth: 2,
    ...Shadow.md,
  },

  // Check badge top-right
  checkBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0,
  },
  checkBadgeVisible: {
    backgroundColor: Colors.primary,
    opacity: 1,
  },
  checkmark: {
    position: 'absolute',
    width: 4,
    height: 7,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: Colors.white,
    transform: [{ rotate: '45deg' }, { translateY: -1 }],
  },
  checkmarkArm: { display: 'none' }, // using border trick above

  // Icon box
  iconBox: {
    width: 56,
    height: 56,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  iconBoxSelected: {
    backgroundColor: Colors.primary,
  },

  cardTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.text,
    textAlign: 'center',
  },
  cardTitleSelected: {
    color: Colors.primary,
  },
  cardDesc: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.sm,
  },

  // Person icon
  personIcon: { alignItems: 'center' },
  personHead: {
    width: 13,
    height: 13,
    borderRadius: Radius.full,
    marginBottom: 3,
  },
  personBody: {
    width: 20,
    height: 10,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },

  // Briefcase icon
  briefcaseIcon: { alignItems: 'center' },
  briefcaseHandle: {
    width: 13,
    height: 5,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderWidth: 2,
    borderBottomWidth: 0,
    backgroundColor: 'transparent',
    marginBottom: -1,
  },
  briefcaseBody: {
    width: 24,
    height: 15,
    borderRadius: 3,
  },

  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    marginTop: Spacing.md,
  },

  bottom: {
    paddingHorizontal: Spacing['2xl'],
    paddingBottom: Spacing['2xl'],
  },
  continueButton: {
    height: 54,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
  continueButtonDisabled: { opacity: 0.45 },
  continueButtonText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
