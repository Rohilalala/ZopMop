// ServiceAboutScreen — service detail BOTTOM SHEET (Step 4 of catalog rework).
// Rises over the dimmed catalog (route presentation: transparentModal). Two
// snaps via the shared BottomSheet primitive: PEEK (hero + hook + rating +
// duration + price + add bar) and EXPANDED (includes / excludes / how-it's-done
// with numeral icons / FAQs). All copy/content comes from live data seeded in
// Steps 1-3; the HTML reference supplied layout + tokens only. No add-on block.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Image,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { getServiceDetails, type ServiceDetails } from '../../api/services';
import { useCart } from '../../context/CartContext';
import { useTheme } from '../../context/ThemeContext';
import { useC, type ScreenColors } from '../../theme/screen';
import { usePostHog } from 'posthog-react-native';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { PressFx } from '../../components/ui/PressFx';
import { serviceIcon } from '../../components/home/serviceIcon';

const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;
const { height: SCREEN_H } = Dimensions.get('window');
const PEEK_H = Math.round(SCREEN_H * 0.62) - 75;
const EXPANDED_H = Math.round(SCREEN_H * 0.92);

type Nav = NativeStackNavigationProp<MainStackParamList>;
type Route = RouteProp<MainStackParamList, 'ServiceAbout'>;

// Step numeral assets (Step 3). icon = 'step-1'..'step-4' → 1.png..4.png.
const NUMERAL_PNG: Record<string, number> = {
  'step-1': require('../../../assets/icons/1.png'),
  'step-2': require('../../../assets/icons/2.png'),
  'step-3': require('../../../assets/icons/3.png'),
  'step-4': require('../../../assets/icons/4.png'),
};

// Duration-logic guidance (deferred from Step 2; not in DB — client copy keyed
// by the fixed service UUID). Shown as a subtitle under the duration selector.
const DURATION_GUIDANCE: Record<string, string> = {
  'a1000000-0000-0000-0000-000000000001': '30 min for a compact 1BHK or a few rooms. 60 min for a standard 2 or 3BHK. 90 min for a larger home or floors that need a second pass.',
  'a1000000-0000-0000-0000-000000000002': '30 min covers 1 bathroom, 60 min covers 1 to 2, 90 min covers 2 to 3.',
  'a1000000-0000-0000-0000-000000000003': "30 min for a single meal's load for two or three people. 60 min for a full day's pile for a family. 90 min for a larger buildup, big cookware, or after-party cleanup.",
  'a1000000-0000-0000-0000-000000000004': '30 min for a few rooms or the main living areas. 60 min for a standard 2 or 3BHK. 90 min for a larger home or surfaces that have sat untouched for a while.',
  'a1000000-0000-0000-0000-000000000005': "30 min for a single meal's prep. 60 min for a few dishes or a day's cooking. 90 min for a larger spread or batch prep.",
  'a1000000-0000-0000-0000-000000000006': "30 min for a single load. 60 min for a couple of loads or a week's clothes. 90 min for a family's load or a larger backlog.",
  'a1000000-0000-0000-0000-000000000007': '30 min for a few windows or a room. 60 min for a standard 2 or 3BHK. 90 min for a larger home or windows that need more work.',
  'a1000000-0000-0000-0000-000000000008': '30 min for a single-door fridge. 60 min for a double-door. 90 min for a larger fridge or more buildup.',
  'a1000000-0000-0000-0000-000000000009': "30 min for a small load or a day's clothes. 60 min for a week's pile for one or two people. 90 min for a family's load or a larger backlog.",
  'a1000000-0000-0000-0000-000000000010': '30 min for a small balcony. 60 min for a larger balcony or a couple of them. 90 min for multiple balconies or more buildup.',
  'a1000000-0000-0000-0000-000000000012': '30 min for counters and stove in a compact kitchen. 60 min for a standard kitchen done properly. 90 min for a larger kitchen or more buildup.',
  'a1000000-0000-0000-0000-000000000014': '30 min for a single wardrobe or section. 60 min for a full wardrobe. 90 min for a larger wardrobe or more to sort.',
  'a1000000-0000-0000-0000-000000000018': '30 min for a few plants or a balcony set. 60 min for a larger set across the home. 90 min for many plants or more upkeep.',
  'a1000000-0000-0000-0000-000000000019': "30 min for a single bag. 60 min for a couple of bags or a longer pack. 90 min for a family's luggage or a larger load.",
  'a1000000-0000-0000-0000-000000000020': "30 min for a single bag. 60 min for a couple of bags. 90 min for a family's luggage or a larger load.",
  'a1000000-0000-0000-0000-000000000021': '30 min for a couple of fans. 60 min for a standard 2 or 3BHK. 90 min for a larger home or more fans.',
  'a1000000-0000-0000-0000-000000000022': 'Fixed 90-minute slot. A party setup or cleanup needs the full block.',
};

function buildDurations(svc: {
  min_duration_minutes: number;
  max_duration_minutes: number;
  duration_step_minutes: number;
}): number[] {
  const { min_duration_minutes: min, max_duration_minutes: max, duration_step_minutes: step } = svc;
  if (step <= 0 || max <= min) return [min];
  const out: number[] = [];
  for (let d = min; d <= max; d += step) out.push(d);
  return out;
}

function priceFor(
  svc: { base_price_paise: number; min_duration_minutes: number },
  dur: number,
): number {
  return Math.round((svc.base_price_paise * dur) / svc.min_duration_minutes);
}

function formatReviews(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// In-memory cache so re-opening a service renders instantly.
const detailsCache: Map<string, ServiceDetails> = new Map();

export default function ServiceAboutScreen() {
  const { isDark } = useTheme();
  const c = useC();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const successGlyph = isDark ? '#22C55E' : c.green;
  const dangerGlyph = isDark ? '#EF4444' : c.danger;

  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { params } = useRoute<Route>();
  const { service } = params;

  const cached = detailsCache.get(service.id) ?? null;
  const [details, setDetails] = useState<ServiceDetails | null>(cached);
  const [loading, setLoading] = useState(cached == null);
  const [expanded, setExpanded] = useState(false);
  const [addedToCart, setAddedToCart] = useState(false);

  const activeSvc = details?.service ?? service;
  const durations = useMemo(() => buildDurations(activeSvc), [activeSvc]);
  const fixedDuration = durations.length === 1;
  const [duration, setDuration] = useState<number>(durations[0]);

  const { addItem } = useCart();
  const posthog = usePostHog();

  useEffect(() => {
    posthog?.capture('service_viewed', {
      service_id: service.id,
      service_name: service.name,
      base_price_paise: service.base_price_paise,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const det = await getServiceDetails(service.id);
        if (!cancelled) {
          setDetails(det);
          detailsCache.set(service.id, det);
        }
      } catch {
        // non-fatal — render with whatever we have
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service.id]);

  // Keep selected duration valid if the fetched service changes the options.
  useEffect(() => {
    if (!durations.includes(duration)) setDuration(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durations.join(',')]);

  const priceCents = priceFor(activeSvc, duration);

  const close = useCallback(() => navigation.goBack(), [navigation]);

  const handleAddToCart = useCallback(async () => {
    const pc = priceFor(activeSvc, duration);
    await addItem(service.id, duration, service.name, pc);
    setAddedToCart(true);
    posthog?.capture('service_added_to_cart', {
      service_id: service.id,
      service_name: service.name,
      duration_minutes: duration,
      price_paise: pc,
    });
  }, [addItem, activeSvc, duration, service.id, service.name, posthog]);

  const handleShare = useCallback(() => {
    Share.share({ message: `Check out ${service.name} on ZopMop!` });
  }, [service.name]);

  const icon = serviceIcon({ id: service.id, name: service.name });
  const hook = details?.service.short_description ?? service.short_description;
  const guidance = DURATION_GUIDANCE[service.id];

  // Floating controls + grab-area header (drag region for the sheet).
  const header = (
    <View style={s.headerRow}>
      <PressFx onPress={close} style={s.floatBtn}>
        <Feather name="x" size={18} color={c.text} />
      </PressFx>
      <PressFx onPress={handleShare} style={s.floatBtn}>
        <Feather name="share-2" size={15} color={c.text} />
      </PressFx>
    </View>
  );

  // Sticky add bar — stays pinned across peek/expanded.
  const footer = (
    <View style={[s.bottomBar, { paddingBottom: 12 + insets.bottom }]}>
      <View style={s.bottomPriceCol}>
        <Text style={s.bottomPriceLabel}>Total</Text>
        <View style={s.bottomPriceRow}>
          <Text style={s.bottomPrice}>₹{(priceCents / 100).toFixed(0)}</Text>
          {activeSvc.mrp_paise != null && (
            <Text style={s.bottomMrp}>₹{(activeSvc.mrp_paise / 100).toFixed(0)}</Text>
          )}
        </View>
      </View>
      <PressFx
        style={[s.addCartBtn, addedToCart && s.addCartBtnDone]}
        onPress={addedToCart ? () => navigation.navigate('Cart') : handleAddToCart}
      >
        <Text style={s.addCartText}>{addedToCart ? 'View cart' : 'Add to cart'}</Text>
        <Feather name={addedToCart ? 'arrow-right' : 'plus'} size={15} color="#0A0A0A" />
      </PressFx>
    </View>
  );

  return (
    <BottomSheet
      visible
      onClose={close}
      height={PEEK_H}
      expandedHeight={EXPANDED_H}
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={header}
      footer={footer}
      surfaceColor={c.bg}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 92 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={s.hero}>
          <View style={s.heroIconWrap}>
            {icon ? (
              <Image source={icon} style={s.heroIconImg} resizeMode="contain" />
            ) : (
              <Text style={s.heroEmoji}>{service.emoji ?? '🧹'}</Text>
            )}
          </View>
          <View style={s.heroInfo}>
            <Text style={s.heroName}>{service.name}</Text>
            {hook ? (
              <Text style={s.heroHook} numberOfLines={2}>
                {hook}
              </Text>
            ) : null}
            <View style={s.ratingPill}>
              <Text style={s.ratingStar}>★</Text>
              <Text style={s.ratingText}>{service.rating}</Text>
              <Text style={s.reviewText}>· {formatReviews(service.review_count)} reviews</Text>
            </View>
          </View>
        </View>

        {/* Duration */}
        <Text style={s.secH}>Duration</Text>
        <View style={s.body}>
          {fixedDuration ? (
            <View style={s.fixedChip}>
              <Text style={s.fixedChipText}>{duration} min</Text>
              <Text style={s.fixedChipNote}>Fixed slot</Text>
            </View>
          ) : (
            <View style={s.segRow}>
              {durations.map((d) => {
                const sel = d === duration;
                return (
                  <PressFx
                    key={d}
                    style={[s.segChip, sel && s.segChipSel]}
                    onPress={() => {
                      setDuration(d);
                      setAddedToCart(false);
                    }}
                  >
                    <Text style={[s.segChipText, sel && s.segChipTextSel]}>{d} min</Text>
                  </PressFx>
                );
              })}
            </View>
          )}
          {guidance ? <Text style={s.guidance}>{guidance}</Text> : null}
        </View>

        {!expanded ? (
          <View style={s.body}>
            <PressFx style={s.viewFull} onPress={() => setExpanded(true)}>
              <Text style={s.viewFullText}>View more details</Text>
              <Feather name="chevron-down" size={16} color={c.amber} />
            </PressFx>
          </View>
        ) : null}

        {/* Expanded sections — gate on non-empty data */}
        {expanded && details && details.includes.length > 0 && (
          <>
            <Text style={s.secH}>What's included</Text>
            <View style={s.body}>
              <View style={s.listCard}>
                {details.includes.map((inc, i) => (
                  <View key={inc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                    <View style={s.includeIcon}>
                      <Feather name="check" size={12} color={successGlyph} />
                    </View>
                    <Text style={s.listText}>{inc.item}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {expanded && details && details.excludes.length > 0 && (
          <>
            <Text style={s.secH}>What's not included</Text>
            <View style={s.body}>
              <View style={s.listCard}>
                {details.excludes.map((exc, i) => (
                  <View key={exc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                    <View style={[s.includeIcon, s.excludeIcon]}>
                      <Feather name="x" size={12} color={dangerGlyph} />
                    </View>
                    <Text style={s.listText}>{exc.item}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {expanded && details && details.steps.length > 0 && (
          <>
            <Text style={s.secH}>How it's done</Text>
            <View style={s.body}>
              <View style={s.stepsCol}>
                {details.steps.map((step, i) => {
                  const numeral = NUMERAL_PNG[step.icon ?? `step-${step.step_number}`];
                  return (
                    <View key={step.id} style={s.stepRow}>
                      <View style={s.stepLeft}>
                        {numeral ? (
                          <Image source={numeral} style={s.stepNumImg} resizeMode="contain" />
                        ) : (
                          <View style={s.stepNumCircle}>
                            <Text style={s.stepNum}>{step.step_number}</Text>
                          </View>
                        )}
                        {i < details.steps.length - 1 && <View style={s.stepLine} />}
                      </View>
                      <View style={s.stepBody}>
                        <Text style={s.stepTitle}>{step.title}</Text>
                        {step.description ? (
                          <Text style={s.stepDesc}>{step.description}</Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </>
        )}

        {expanded && details && (details.faqs?.length ?? 0) > 0 && (
          <>
            <Text style={s.secH}>Frequently asked</Text>
            <View style={s.body}>
              <View style={s.listCard}>
                {details.faqs.map((faq, i) => (
                  <View key={`${faq.question}-${i}`} style={[s.faqRow, i > 0 && s.listRowBorder]}>
                    <Text style={s.faqQ}>{faq.question}</Text>
                    <Text style={s.faqA}>{faq.answer}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {loading && !details ? (
          <Text style={s.loadingText}>Loading details…</Text>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

function makeStyles(c: ScreenColors, isDark: boolean) {
  const successFill = isDark ? 'rgba(34,197,94,0.14)' : c.successSoft;
  const dangerFill = isDark ? 'rgba(239,68,68,0.14)' : c.dangerSoft;
  const barBg = isDark ? 'rgba(10,10,10,0.96)' : 'rgba(250,247,242,0.96)';

  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: H_PAD,
      paddingTop: 2,
      paddingBottom: 8,
    },
    floatBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.glassHi,
      borderWidth: 0.5,
      borderColor: c.glassBorderHi,
    },

    body: { paddingHorizontal: H_PAD },
    secH: {
      ...fontBold,
      fontSize: 11,
      color: c.textMuted,
      letterSpacing: 1.3,
      textTransform: 'uppercase',
      paddingHorizontal: H_PAD + 4,
      paddingTop: 20,
      paddingBottom: 10,
    },

    // Hero
    hero: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: H_PAD,
      paddingTop: 4,
    },
    heroIconWrap: {
      width: 76,
      height: 76,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(245,163,0,0.1)',
      borderWidth: 0.5,
      borderColor: 'rgba(245,163,0,0.2)',
    },
    heroIconImg: { width: 56, height: 56 },
    heroEmoji: { fontSize: 38 },
    heroInfo: { flex: 1, gap: 4 },
    heroName: { ...fontExtra, fontSize: 19, color: c.text, letterSpacing: -0.3 },
    heroHook: { ...fontMed, fontSize: 12.5, color: c.textSecondary, lineHeight: 18 },
    ratingPill: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    ratingStar: { ...fontBold, color: c.amber, fontSize: 11.5 },
    ratingText: { ...fontBold, fontSize: 11.5, color: c.text },
    reviewText: { ...fontMed, fontSize: 11, color: c.textMuted, marginLeft: 2 },

    // Duration segmented
    segRow: { flexDirection: 'row', gap: 10 },
    segChip: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 14,
      alignItems: 'center',
      backgroundColor: c.glass,
      borderWidth: 1,
      borderColor: c.glassBorder,
    },
    segChipSel: {
      backgroundColor: c.amberSoft,
      borderColor: 'rgba(245,163,0,0.5)',
    },
    segChipText: { ...fontBold, fontSize: 14, color: c.textSecondary, letterSpacing: -0.2 },
    segChipTextSel: { color: c.amber },
    fixedChip: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 10,
      paddingVertical: 14,
      paddingHorizontal: 18,
      borderRadius: 14,
      backgroundColor: c.amberSoft,
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.5)',
    },
    fixedChipText: { ...fontExtra, fontSize: 16, color: c.amber, letterSpacing: -0.3 },
    fixedChipNote: { ...fontMed, fontSize: 11.5, color: c.textMuted },
    guidance: { ...fontMed, fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 10 },

    viewFull: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginTop: 18,
      paddingVertical: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.35)',
      backgroundColor: c.amberSoft,
    },
    viewFullText: { ...fontBold, fontSize: 13, color: c.amber, letterSpacing: 0.1 },

    // Lists
    listCard: {
      padding: 6,
      borderRadius: 18,
      backgroundColor: isDark ? 'rgba(255,255,255,0.045)' : c.white,
      borderWidth: isDark ? 0 : 1,
      borderColor: c.glassBorder,
    },
    listRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 10,
      gap: 12,
    },
    listRowBorder: { borderTopWidth: 0.5, borderTopColor: c.divider },
    listText: { ...fontMed, fontSize: 13, color: c.textSecondary, flex: 1, lineHeight: 18 },
    includeIcon: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: successFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    excludeIcon: { backgroundColor: dangerFill },

    // Steps
    stepsCol: { gap: 0 },
    stepRow: { flexDirection: 'row', gap: 14 },
    stepLeft: { alignItems: 'center', width: 32 },
    stepNumImg: { width: 32, height: 32 },
    stepNumCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: 'rgba(245,163,0,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNum: { ...fontExtra, fontSize: 12, color: c.amber },
    stepLine: {
      width: 2,
      flex: 1,
      minHeight: 16,
      backgroundColor: 'rgba(245,163,0,0.18)',
      marginVertical: 4,
    },
    stepBody: { flex: 1, paddingBottom: 18 },
    stepTitle: { ...fontSemi, fontSize: 13.5, color: c.text, marginBottom: 2, letterSpacing: -0.1 },
    stepDesc: { ...fontMed, fontSize: 12, color: c.textSecondary, lineHeight: 17 },

    // FAQ
    faqRow: { paddingHorizontal: 10, paddingVertical: 12, gap: 5 },
    faqQ: { ...fontSemi, fontSize: 13, color: c.text, letterSpacing: -0.1 },
    faqA: { ...fontMed, fontSize: 12, color: c.textSecondary, lineHeight: 17 },

    loadingText: {
      ...fontMed,
      fontSize: 12,
      color: c.textMuted,
      textAlign: 'center',
      paddingVertical: 24,
    },

    // Sticky add bar
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: H_PAD,
      paddingTop: 12,
      backgroundColor: barBg,
      borderTopWidth: 0.5,
      borderTopColor: c.glassBorder,
    },
    bottomPriceCol: { flex: 1 },
    bottomPriceLabel: {
      ...fontMed,
      fontSize: 11,
      color: c.textMuted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    bottomPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    bottomPrice: { ...fontExtra, fontSize: 22, color: c.text, letterSpacing: -0.5 },
    bottomMrp: {
      ...fontMed,
      fontSize: 12,
      color: c.textMuted,
      textDecorationLine: 'line-through',
    },
    addCartBtn: {
      flex: 1.4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: c.amber,
      borderRadius: 16,
      paddingVertical: 14,
    },
    addCartBtnDone: { backgroundColor: c.amberHi },
    addCartText: { ...fontBold, fontSize: 14, color: '#0A0A0A', letterSpacing: 0.1 },
  });
}
