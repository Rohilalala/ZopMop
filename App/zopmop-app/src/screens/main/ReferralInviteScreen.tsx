import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import * as Location from 'expo-location';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { applyReferralCode, getReferralStats } from '../../api/referral';
import {
  checkServiceability,
  SERVICEABLE_CITIES,
  type ServiceableCity,
} from '../../utils/serviceability';

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors) —
// same as ReferralEarnScreen. useColors()'s dark palette is Slate, which would
// change this screen's dark look + fork the amber. useC() keeps dark identical
// (#0A0A0A / #F5A300) and carries the cream + amber light language.

type Step = 'location' | 'not_serviceable' | 'confirm' | 'success' | 'error';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'ReferralInvite'>;
  route: RouteProp<MainStackParamList, 'ReferralInvite'>;
};

export default function ReferralInviteScreen({ navigation, route }: Props) {
  const { code } = route.params;
  const { token } = useAuth();
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);

  // Danger red: keep the exact soft #F87171 in dark; light uses the danger
  // token (#DC2626) which is tuned to read on cream (raw #F87171 washes out).
  const danger = isDark ? '#F87171' : c.danger;
  // Ink on the amber CTA — theme-independent (button is amber in both).
  const onAmber = '#0A0A0A';

  const [step, setStep] = useState<Step>('location');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    runPreflightAndGps();
  }, []);

  // Pre-check the user's referral state BEFORE showing the Accept Invite UI.
  // Skips straight to the error step when the code can't possibly be applied:
  //   - user already has an incoming referral (used or pending)
  //   - the deep-link code is the user's own code (self-referral)
  // This prevents users tapping Accept just to see a backend rejection.
  const runPreflightAndGps = async () => {
    setBusy(true);
    try {
      if (token) {
        try {
          const stats = await getReferralStats(token);
          if (stats.incoming) {
            setErrorMsg(
              `Zop here — you’ve already redeemed code ${stats.incoming.referrer_code}. Only one referral code is allowed per account. Open Refer & Earn for details.`,
            );
            setStep('error');
            setBusy(false);
            return;
          }
          if (stats.code && stats.code.toUpperCase() === code.toUpperCase()) {
            setErrorMsg('Zop says: that’s your own code. Share it with friends instead — you can’t redeem it yourself.');
            setStep('error');
            setBusy(false);
            return;
          }
        } catch (e) {
          console.warn('[referral] preflight stats failed; proceeding to GPS step', e);
          // Non-fatal: fall through to normal GPS flow.
        }
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setShowManual(true);
        setBusy(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const city = checkServiceability(pos.coords.latitude, pos.coords.longitude);
      setStep(city ? 'confirm' : 'not_serviceable');
    } catch {
      setShowManual(true);
    } finally {
      setBusy(false);
    }
  };

  const selectCity = (_city: ServiceableCity) => {
    setShowManual(false);
    setStep('confirm');
  };

  const handleAccept = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await applyReferralCode(token, code);
      setStep('success');
    } catch (err: any) {
      const errCode = err?.code;
      if (errCode === 'already_referred') {
        setErrorMsg(
          'Zop here — you’ve already redeemed a referral code. Only one is allowed per account. Check Refer & Earn for details.',
        );
      } else if (errCode === 'referral_cap_reached') {
        setErrorMsg('Zop says: this code has already filled all 3 referral slots and isn’t active anymore.');
      } else if (errCode === 'self_referral') {
        setErrorMsg('Zop says: you can’t redeem your own code. Share it with friends instead.');
      } else {
        setErrorMsg('Zop hit a snag applying that code. Please try again.');
      }
      setStep('error');
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = () => {
    navigation.navigate('Tabs', { screen: 'Home' });
  };

  const handleExplore = () => {
    navigation.navigate('Tabs', { screen: 'AllServices' });
  };

  if (step === 'location') {
    return (
      <SafeAreaView style={styles.root}>
        <Bloom />
        {busy && !showManual ? (
          <View style={styles.centered}>
            <ActivityIndicator color={c.amber} size="large" />
            <Text style={[styles.body, { marginTop: 16 }]}>Checking your location...</Text>
          </View>
        ) : showManual ? (
          <View style={styles.sheet}>
            <Text style={styles.heading}>Select your city</Text>
            <FlatList
              data={SERVICEABLE_CITIES}
              keyExtractor={c => c.name}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.cityRow} onPress={() => selectCity(item)}>
                  <Feather name="map-pin" size={16} color={c.amber} />
                  <Text style={styles.cityText}>{item.displayName}</Text>
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
            />
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  if (step === 'not_serviceable') {
    return (
      <SafeAreaView style={styles.root}>
        <Bloom />
        <View style={styles.centered}>
          <Feather name="map-pin" size={48} color={c.textMuted} />
          <Text style={[styles.heading, { marginTop: 20 }]}>Not serviceable yet</Text>
          <Text style={[styles.body, { marginTop: 8 }]}>
            ZopMop is not available in your area yet. We are expanding soon!
          </Text>
          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 32 }]}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.secondaryBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'confirm') {
    return (
      <SafeAreaView style={styles.root}>
        <Bloom />
        <View style={styles.centered}>
          <View style={styles.inviteCard}>
            <Feather name="gift" size={40} color={c.amber} />
            <Text style={[styles.heading, { marginTop: 16 }]}>You are invited!</Text>
            <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>
              Accept this invite and get{' '}
              <Text style={{ color: c.amber, fontWeight: '700' }}>Rs 100</Text> in your wallet
              after your first booking.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
            onPress={handleAccept}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={onAmber} />
            ) : (
              <Text style={styles.primaryBtnText}>Accept Invite</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 16 }]} onPress={handleDecline}>
            <Text style={styles.secondaryBtnText}>Decline</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'success') {
    return (
      <SafeAreaView style={styles.root}>
        <Bloom />
        <View style={styles.centered}>
          <Feather name="check-circle" size={56} color={c.amber} />
          <Text style={[styles.heading, { marginTop: 20 }]}>Invite accepted!</Text>
          <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>
            Complete your first booking to get{' '}
            <Text style={{ color: c.amber, fontWeight: '700' }}>Rs 100</Text> in your wallet.
          </Text>
          <TouchableOpacity style={[styles.primaryBtn, { marginTop: 40 }]} onPress={handleExplore}>
            <Text style={styles.primaryBtnText}>Explore Services</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.centered}>
        <Feather name="alert-circle" size={48} color={danger} />
        <Text style={[styles.heading, { marginTop: 20 }]}>Oops</Text>
        <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>{errorMsg}</Text>
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 40 }]} onPress={handleExplore}>
          <Text style={styles.primaryBtnText}>Explore Services</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(c: ScreenColors, isDark: boolean) {
  // Raised surface (#141416) has no useC equivalent → documented dark literal;
  // white card + subtle border/shadow in light so it reads on cream.
  const surface = isDark ? '#141416' : c.white;
  const lightCard = isDark
    ? null
    : {
        borderWidth: 1,
        borderColor: c.glassBorder,
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    heading: { color: c.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
    body: { color: c.textSecondary, fontSize: 15, lineHeight: 22 },
    inviteCard: {
      alignItems: 'center',
      backgroundColor: surface,
      borderRadius: 20,
      padding: 28,
      width: '100%',
      marginBottom: 32,
      ...(lightCard || {}),
    },
    primaryBtn: {
      backgroundColor: c.amber,
      borderRadius: 14,
      paddingVertical: 16,
      paddingHorizontal: 40,
      alignItems: 'center',
      width: '100%',
    },
    // Ink on amber CTA — same in both themes.
    primaryBtnText: { color: '#0A0A0A', fontSize: 16, fontWeight: '700' },
    secondaryBtn: { paddingVertical: 12 },
    secondaryBtnText: { color: c.textMuted, fontSize: 15 },
    sheet: { flex: 1, padding: 24 },
    cityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 16,
    },
    cityText: { color: c.text, fontSize: 16, marginLeft: 12 },
    sep: { height: StyleSheet.hairlineWidth, backgroundColor: c.glassBorder },
  });
}
