// OffersScreen — dark home pattern.
// Layout: Bloom backdrop → header → coupon-code input row (input + amber
// gradient Apply) → list of ticket-style offer cards with discount badge,
// dashed divider, terms, and apply CTA.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { promoStore } from '../../utils/promoStore';
import { showSuccess, showError } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { useAuth } from '../../context/AuthContext';
import { listOffers, type Offer } from '../../api/promotions';
import { logEvent } from '../../analytics/impressionTracker';

import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;

function offerTerms(offer: Offer): string[] {
  const terms: string[] = [];
  if (offer.min_order_paise > 0) {
    terms.push(`Min order ₹${Math.floor(offer.min_order_paise / 100)}.`);
  }
  if (offer.max_per_user > 0) {
    terms.push(`Max ${offer.max_per_user} use${offer.max_per_user === 1 ? '' : 's'} per user.`);
  }
  if (offer.expires_at) {
    const d = new Date(offer.expires_at);
    terms.push(`Valid until ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`);
  }
  if (offer.categories.length > 0) {
    terms.push(`Applicable on: ${offer.categories.join(', ')}.`);
  }
  if (!offer.stackable) {
    terms.push('Cannot be combined with other offers.');
  }
  return terms;
}

export default function OffersScreen() {
  const { isDark } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputCode, setInputCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!token) return;
    listOffers(token)
      .then((data) => {
        setOffers(data);
        data.forEach((o) => logEvent('offer_impression', { offer_id: o.id, code: o.code }));
      })
      .catch(() => {/* non-fatal — empty list is fine */})
      .finally(() => setLoading(false));
  }, [token]);

  function handleApplyInput() {
    const code = inputCode.trim().toUpperCase();
    if (!code) return;
    const match = offers.find((o) => o.code === code);
    if (match) {
      haptics.success();
      promoStore.set(match.code);
      setErrorMessage('');
      showSuccess(`"${match.title}" applied to your cart.`, { title: 'Offer applied' });
    } else {
      haptics.error();
      setErrorMessage('Coupon code is not valid or has expired.');
      showError('Coupon code is not valid or has expired.', { title: 'Invalid code' });
    }
  }

  function handleApplyOffer(offer: Offer) {
    haptics.medium();
    logEvent('offer_tap', { offer_id: offer.id, code: offer.code });
    promoStore.set(offer.code);
    showSuccess(`"${offer.title}" applied to your cart.`, { title: 'Offer applied' });
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[0]}
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headRow}>
            <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Offers</Text>
              <Text style={s.sub}>Stack savings on your next booking.</Text>
            </View>
          </View>
        </View>

        <Text style={s.secH}>Have a code?</Text>
        <View style={s.body}>
          <View style={[s.inputCard, !!errorMessage && s.inputCardError]}>
            <View style={s.inputIcon}>
              <Feather name="tag" size={15} color="#F5A300" />
            </View>
            <TextInput
              style={s.input}
              placeholder="ENTER COUPON CODE"
              placeholderTextColor="rgba(255,255,255,0.32)"
              value={inputCode}
              onChangeText={(t) => {
                setInputCode(t);
                if (errorMessage) setErrorMessage('');
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleApplyInput}
            />
            <PressFx
              onPress={handleApplyInput}
              disabled={!inputCode.trim()}
              style={[s.applyBtn, !inputCode.trim() && { opacity: 0.4 }]}
            >
              <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
                <Defs>
                  <SvgLinearGradient id="applyGrad" x1="0" y1="0" x2="1" y2="1">
                    <Stop offset="0%" stopColor="#FFC042" />
                    <Stop offset="60%" stopColor="#F5A300" />
                    <Stop offset="100%" stopColor="#E88F00" />
                  </SvgLinearGradient>
                </Defs>
                <Rect width="100%" height="100%" rx="10" fill="url(#applyGrad)" />
              </Svg>
              <Text style={s.applyBtnText}>Apply</Text>
            </PressFx>
          </View>
          {!!errorMessage && <Text style={s.errorText}>{errorMessage}</Text>}
        </View>

        <Text style={s.secH}>Available coupons</Text>
        {loading ? (
          <View style={s.body}>
            <ActivityIndicator color="#F5A300" style={{ marginTop: 20 }} />
          </View>
        ) : offers.length === 0 ? (
          <View style={s.body}>
            <Text style={s.emptyText}>No offers available right now.</Text>
          </View>
        ) : (
          <View style={[s.body, { gap: 12 }]}>
            {offers.map((offer) => (
              <OfferCard
                key={offer.id}
                offer={offer}
                terms={offerTerms(offer)}
                onApply={() => handleApplyOffer(offer)}
              />
            ))}
          </View>
        )}

        <View style={s.disclaim}>
          <Feather name="info" size={12} color="rgba(255,255,255,0.4)" />
          <Text style={s.disclaimText}>
            One coupon per booking. Discounts apply after taxes & service fee.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function OfferCard({ offer, terms, onApply }: { offer: Offer; terms: string[]; onApply: () => void }) {
  return (
    <View style={s.ticket}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <SvgLinearGradient id={`tBg-${offer.id}`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor="#1A1A1C" />
              <Stop offset="100%" stopColor="#0F0F11" />
            </SvgLinearGradient>
            <SvgRadialGradient id={`tGlow-${offer.id}`} cx="0%" cy="50%" rx="50%" ry="120%">
              <Stop offset="0%" stopColor="#F5A300" stopOpacity="0.18" />
              <Stop offset="60%" stopColor="#F5A300" stopOpacity="0" />
            </SvgRadialGradient>
          </Defs>
          <Rect width="100%" height="100%" rx="18" fill={`url(#tBg-${offer.id})`} />
          <Rect width="100%" height="100%" rx="18" fill={`url(#tGlow-${offer.id})`} />
        </Svg>
      </View>

      <View style={s.ticketAmberLine} pointerEvents="none" />

      <View style={s.ticketTop}>
        <View style={s.discountBadge}>
          <Text style={s.discountBadgeText}>{offer.discount_label}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.ticketTitle} numberOfLines={2}>{offer.title}</Text>
          <View style={s.codeRow}>
            <Text style={s.codeLabel}>Code</Text>
            <View style={s.codeChip}>
              <Text style={s.codeChipText}>{offer.code}</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={s.dashedDivider} />

      <View style={s.terms}>
        {terms.map((t, i) => (
          <View key={i} style={s.termRow}>
            <View style={s.termDot} />
            <Text style={s.termText}>{t}</Text>
          </View>
        ))}
      </View>

      <PressFx onPress={onApply} style={s.ticketApplyBtn}>
        <Feather name="check-circle" size={14} color="#F5A300" />
        <Text style={s.ticketApplyText}>Apply this offer</Text>
      </PressFx>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  // Sticky head
  head: {
    backgroundColor: '#0A0A0A',
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  title: {
    ...fontExtra,
    fontSize: 24, color: '#FFFFFF',
    letterSpacing: -0.6, lineHeight: 28,
  },
  sub: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  secH: {
    ...fontBold,
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingHorizontal: H_PAD + 4,
    paddingTop: 22,
    paddingBottom: 10,
  },

  body: { paddingHorizontal: H_PAD },

  // Input row
  inputCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 6, paddingLeft: 14, paddingRight: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  inputCardError: { borderColor: 'rgba(239,68,68,0.55)' },
  inputIcon: {
    width: 30, height: 30, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  input: {
    flex: 1,
    ...fontSemi,
    fontSize: 14, color: '#FFFFFF', letterSpacing: 1,
    paddingVertical: 10,
  },
  applyBtn: {
    height: 38, paddingHorizontal: 18, borderRadius: 10,
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    minWidth: 76,
  },
  applyBtnText: {
    ...fontExtra,
    fontSize: 13, color: '#0A0A0A', letterSpacing: 0.2,
  },

  errorText: {
    ...fontMed,
    fontSize: 12, color: '#EF4444',
    marginTop: 8, marginLeft: 4,
  },

  // Ticket
  ticket: {
    borderRadius: 18,
    overflow: 'hidden',
    padding: 14,
    backgroundColor: '#0F0F11',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  ticketAmberLine: {
    position: 'absolute', bottom: 0, left: '15%', right: '15%', height: 1,
    backgroundColor: 'rgba(245,163,0,0.4)',
  },
  ticketTop: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    marginBottom: 10,
  },
  discountBadge: {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.4)',
  },
  discountBadgeText: {
    ...fontExtra,
    fontSize: 11, color: '#FFC042', letterSpacing: 0.4,
  },
  ticketTitle: {
    ...fontBold,
    fontSize: 14, color: '#FFFFFF', letterSpacing: -0.1,
    lineHeight: 18,
  },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  codeLabel: {
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.45)',
  },
  codeChip: {
    paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.12)',
    borderStyle: 'dashed',
  },
  codeChipText: {
    ...fontExtra,
    fontSize: 10, color: '#FFC042', letterSpacing: 1,
  },

  dashedDivider: {
    height: 1, marginVertical: 8,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderTopColor: 'rgba(255,255,255,0.08)',
  },

  terms: { gap: 5, marginBottom: 10 },
  termRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  termDot: {
    width: 4, height: 4, borderRadius: 2, marginTop: 7,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  termText: {
    flex: 1,
    ...fontMed,
    fontSize: 11.5, color: 'rgba(255,255,255,0.55)', lineHeight: 16,
  },

  ticketApplyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    height: 40, borderRadius: 11,
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.3)',
  },
  ticketApplyText: {
    ...fontExtra,
    fontSize: 12.5, color: '#F5A300', letterSpacing: 0.2,
  },

  emptyText: {
    ...fontMed,
    fontSize: 13, color: 'rgba(255,255,255,0.4)',
    textAlign: 'center', paddingVertical: 24,
  },

  disclaim: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: H_PAD + 4, paddingTop: 22,
  },
  disclaimText: {
    flex: 1,
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 16,
  },
});
