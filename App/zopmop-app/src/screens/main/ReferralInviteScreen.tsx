import React, { useEffect, useState } from 'react';
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
import { applyReferralCode } from '../../api/referral';
import {
  checkServiceability,
  SERVICEABLE_CITIES,
  type ServiceableCity,
} from '../../utils/serviceability';

const BG = '#0A0A0A';
const SURFACE = '#141416';
const TEXT_HI = '#FFFFFF';
const TEXT_MID = 'rgba(255,255,255,0.62)';
const TEXT_DIM = 'rgba(255,255,255,0.38)';
const AMBER = '#F5A300';
const HAIRLINE = 'rgba(255,255,255,0.08)';
const DANGER = '#F87171';

type Step = 'location' | 'not_serviceable' | 'confirm' | 'success' | 'error';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'ReferralInvite'>;
  route: RouteProp<MainStackParamList, 'ReferralInvite'>;
};

export default function ReferralInviteScreen({ navigation, route }: Props) {
  const { code } = route.params;
  const { token } = useAuth();
  const [step, setStep] = useState<Step>('location');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    runGpsCheck();
  }, []);

  const runGpsCheck = async () => {
    setBusy(true);
    try {
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
        setErrorMsg('You have already used a referral code.');
      } else if (errCode === 'referral_cap_reached') {
        setErrorMsg('This referral link is no longer active.');
      } else {
        setErrorMsg('Something went wrong. Please try again.');
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
        {busy && !showManual ? (
          <View style={styles.centered}>
            <ActivityIndicator color={AMBER} size="large" />
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
                  <Feather name="map-pin" size={16} color={AMBER} />
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
        <View style={styles.centered}>
          <Feather name="map-pin" size={48} color={TEXT_DIM} />
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
        <View style={styles.centered}>
          <View style={styles.inviteCard}>
            <Feather name="gift" size={40} color={AMBER} />
            <Text style={[styles.heading, { marginTop: 16 }]}>You are invited!</Text>
            <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>
              Accept this invite and get{' '}
              <Text style={{ color: AMBER, fontWeight: '700' }}>Rs 100</Text> in your wallet
              after your first booking.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
            onPress={handleAccept}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#0A0A0A" />
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
        <View style={styles.centered}>
          <Feather name="check-circle" size={56} color={AMBER} />
          <Text style={[styles.heading, { marginTop: 20 }]}>Invite accepted!</Text>
          <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>
            Complete your first booking to get{' '}
            <Text style={{ color: AMBER, fontWeight: '700' }}>Rs 100</Text> in your wallet.
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
        <Feather name="alert-circle" size={48} color={DANGER} />
        <Text style={[styles.heading, { marginTop: 20 }]}>Oops</Text>
        <Text style={[styles.body, { marginTop: 8, textAlign: 'center' }]}>{errorMsg}</Text>
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 40 }]} onPress={handleExplore}>
          <Text style={styles.primaryBtnText}>Explore Services</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  heading: { color: TEXT_HI, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { color: TEXT_MID, fontSize: 15, lineHeight: 22 },
  inviteCard: {
    alignItems: 'center',
    backgroundColor: SURFACE,
    borderRadius: 20,
    padding: 28,
    width: '100%',
    marginBottom: 32,
  },
  primaryBtn: {
    backgroundColor: AMBER,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
    alignItems: 'center',
    width: '100%',
  },
  primaryBtnText: { color: '#0A0A0A', fontSize: 16, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 12 },
  secondaryBtnText: { color: TEXT_DIM, fontSize: 15 },
  sheet: { flex: 1, padding: 24 },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
  },
  cityText: { color: TEXT_HI, fontSize: 16, marginLeft: 12 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: HAIRLINE },
});
