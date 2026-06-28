// OffersScreen — dark home pattern.
// Layout: Bloom backdrop → header → coupon-code input row (input + amber
// gradient Apply) → list of ticket-style offer cards with discount badge,
// dashed divider, terms, and apply CTA.

import React, { useEffect, useMemo, useState } from 'react';
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

import { useC, type ScreenColors } from '../../theme/screen';
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
  const c = useC();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
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
              <Feather name="chevron-left" size={18} color={c.text} />
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
              <Feather name="tag" size={15} color={c.amber} />
            </View>
            <TextInput
              style={s.input}
              placeholder="ENTER COUPON CODE"
              placeholderTextColor={c.textMuted}
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
              style={[s.applyBtn, !inputCode.trim() && s.applyBtnDisabled]}
            >
              {/* Vibrant amber gradient only when actionable. When disabled,
                  a flat muted-amber chip + muted text reads clearly instead of
                  dimming the whole button (which made the dark ink illegible). */}
              {!!inputCode.trim() && (
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
              )}
              <Text style={[s.applyBtnText, !inputCode.trim() && s.applyBtnTextDisabled]}>Apply</Text>
            </PressFx>
          </View>
          {!!errorMessage && <Text style={s.errorText}>{errorMessage}</Text>}
        </View>

        <Text style={s.secH}>Available coupons</Text>
        {loading ? (
          <View style={s.body}>
            <ActivityIndicator color={c.amber} style={{ marginTop: 20 }} />
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
                s={s}
                c={c}
                isDark={isDark}
              />
            ))}
          </View>
        )}

        <View style={s.disclaim}>
          <Feather name="info" size={12} color={c.textMuted} />
          <Text style={s.disclaimText}>
            One coupon per booking. Discounts apply after taxes & service fee.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function OfferCard({
  offer, terms, onApply, s, c, isDark,
}: {
  offer: Offer;
  terms: string[];
  onApply: () => void;
  s: ReturnType<typeof makeStyles>;
  c: ScreenColors;
  isDark: boolean;
}) {
  // Raised ticket surface: dark keeps the #1A1A1C→#0F0F11 gradient identical;
  // light becomes a white card on cream (border + shadow live in s.ticket).
  const surfaceTop = isDark ? '#1A1A1C' : c.white;
  const surfaceBot = isDark ? '#0F0F11' : c.white;
  return (
    <View style={s.ticket}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <SvgLinearGradient id={`tBg-${offer.id}`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={surfaceTop} />
              <Stop offset="100%" stopColor={surfaceBot} />
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
        <Feather name="check-circle" size={14} color={c.amber} />
        <Text style={s.ticketApplyText}>Apply this offer</Text>
      </PressFx>
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). Dark stays #0A0A0A + amber #F5A300 (pixel-identical); light adds the
// cream bg + amber, matching the other migrated screens.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Raised ticket surface: dark keeps the #0F0F11 base under the SVG gradient;
  // light becomes a white card on cream, so it gets a subtle border + soft
  // shadow to read on the cream bg (dark stays the documented dark literal).
  const ticketSurface = isDark ? '#0F0F11' : c.white;
  const lightCard = isDark
    ? null
    : {
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };
  // Danger: dark keeps the exact red literals; light uses readable deep red.
  const dangerText = isDark ? '#EF4444' : c.danger;
  const inputErrorBorder = isDark ? 'rgba(239,68,68,0.55)' : c.dangerBorder;

  return StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },

  // Sticky head
  head: {
    backgroundColor: c.bg,
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.glassHi,
    borderWidth: 0.5, borderColor: c.glassBorderHi,
  },
  title: {
    ...fontExtra,
    fontSize: 24, color: c.text,
    letterSpacing: -0.6, lineHeight: 28,
  },
  sub: {
    ...fontMed,
    fontSize: 12, color: c.textMuted,
    marginTop: 2,
  },

  secH: {
    ...fontBold,
    fontSize: 11,
    color: c.textMuted,
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
    backgroundColor: c.glass,
    borderWidth: 0.5,
    borderColor: c.glassBorder,
  },
  inputCardError: { borderColor: inputErrorBorder },
  inputIcon: {
    width: 30, height: 30, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.amberSoft,
  },
  input: {
    flex: 1,
    ...fontSemi,
    fontSize: 14, color: c.text, letterSpacing: 1,
    paddingVertical: 10,
  },
  applyBtn: {
    height: 38, paddingHorizontal: 18, borderRadius: 10,
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    minWidth: 76,
  },
  applyBtnText: {
    ...fontExtra,
    // Ink on the amber gradient button — same in both themes.
    fontSize: 13, color: '#0A0A0A', letterSpacing: 0.2,
  },
  // Disabled (no code entered): a clean neutral chip instead of dimming the
  // amber gradient (which let the dark card bleed through + killed the ink
  // contrast). Reads clearly as "disabled" and stays legible in both themes.
  applyBtnDisabled: { backgroundColor: c.glassHi, borderWidth: 1, borderColor: c.glassBorder },
  applyBtnTextDisabled: { color: c.textSecondary },

  errorText: {
    ...fontMed,
    fontSize: 12, color: dangerText,
    marginTop: 8, marginLeft: 4,
  },

  // Ticket
  ticket: {
    borderRadius: 18,
    overflow: 'hidden',
    padding: 14,
    backgroundColor: ticketSurface,
    borderWidth: 0.5,
    borderColor: c.glassBorder,
    ...(lightCard || {}),
  },
  ticketAmberLine: {
    position: 'absolute', bottom: 0, left: '15%', right: '15%', height: 1,
    backgroundColor: c.amberLine,
  },
  ticketTop: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    marginBottom: 10,
  },
  discountBadge: {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 0.5,
    borderColor: c.amberLine,
  },
  discountBadgeText: {
    ...fontExtra,
    fontSize: 11, color: c.amberHi, letterSpacing: 0.4,
  },
  ticketTitle: {
    ...fontBold,
    fontSize: 14, color: c.text, letterSpacing: -0.1,
    lineHeight: 18,
  },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  codeLabel: {
    ...fontMed,
    fontSize: 11, color: c.textMuted,
  },
  codeChip: {
    paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4,
    backgroundColor: c.glassHi,
    borderWidth: 0.5,
    borderColor: c.glassBorderHi,
    borderStyle: 'dashed',
  },
  codeChipText: {
    ...fontExtra,
    fontSize: 10, color: c.amberHi, letterSpacing: 1,
  },

  dashedDivider: {
    height: 1, marginVertical: 8,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderTopColor: c.glassBorder,
  },

  terms: { gap: 5, marginBottom: 10 },
  termRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  termDot: {
    width: 4, height: 4, borderRadius: 2, marginTop: 7,
    backgroundColor: c.textMuted,
  },
  termText: {
    flex: 1,
    ...fontMed,
    fontSize: 11.5, color: c.textSecondary, lineHeight: 16,
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
    fontSize: 12.5, color: c.amber, letterSpacing: 0.2,
  },

  emptyText: {
    ...fontMed,
    fontSize: 13, color: c.textMuted,
    textAlign: 'center', paddingVertical: 24,
  },

  disclaim: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: H_PAD + 4, paddingTop: 22,
  },
  disclaimText: {
    flex: 1,
    ...fontMed,
    fontSize: 11, color: c.textMuted, lineHeight: 16,
  },
  });
}
