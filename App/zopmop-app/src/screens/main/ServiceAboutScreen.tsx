// ServiceAboutScreen — dark home pattern.
// Layout: sticky header (back + title + share) → overview hero (service icon
// or emoji + name + rating) → duration selector (− amount +) → what's
// included / excluded (glass list cards) → how it works (numbered timeline)
// → add-on services (horizontal glass tiles) → sticky bottom bar (price +
// add to cart / view cart).

import React, { useCallback, useEffect, useState } from 'react';
import {
  
  Image,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import {
  getServiceDetails,
  getServiceAddons,
  type ServiceDetails,
  type ServiceAddon,
} from '../../api/services';
import { useCart } from '../../context/CartContext';
import { usePostHog } from 'posthog-react-native';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';
import { serviceIcon } from '../../components/home/serviceIcon';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;
type Route = RouteProp<MainStackParamList, 'ServiceAbout'>;

function computeNextDuration(
  current: number | null,
  service: { min_duration_minutes: number; max_duration_minutes: number; duration_step_minutes: number },
): number {
  if (current === null) return service.min_duration_minutes;
  const next = current + service.duration_step_minutes;
  return next > service.max_duration_minutes ? current : next;
}

function computePrevDuration(
  current: number | null,
  service: { min_duration_minutes: number; duration_step_minutes: number },
): number | null {
  if (current === null) return null;
  const prev = current - service.duration_step_minutes;
  return prev < service.min_duration_minutes ? null : prev;
}

function formatReviews(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Module-level in-memory cache so re-opening a service we've already seen
// renders the body instantly. Background revalidation still runs.
type DetailsCacheEntry = { details: ServiceDetails | null; addons: ServiceAddon[] };
const detailsCache: Map<string, DetailsCacheEntry> = new Map();

export default function ServiceAboutScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { params } = useRoute<Route>();
  const { service } = params;

  const cached = detailsCache.get(service.id);
  const [details, setDetails] = useState<ServiceDetails | null>(cached?.details ?? null);
  const [addons, setAddons] = useState<ServiceAddon[]>(cached?.addons ?? []);
  const [loading, setLoading] = useState(cached == null);
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());
  const [duration, setDuration] = useState<number | null>(service.min_duration_minutes);
  const [addedToCart, setAddedToCart] = useState(false);

  const { addItem } = useCart();
  const posthog = usePostHog();

  useEffect(() => {
    posthog?.capture('service_viewed', {
      service_id:        service.id,
      service_name:      service.name,
      base_price_cents:  service.base_price_cents,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [det, add] = await Promise.all([
          getServiceDetails(service.id),
          getServiceAddons(service.id),
        ]);
        if (!cancelled) {
          setDetails(det);
          setAddons(add);
          detailsCache.set(service.id, { details: det, addons: add });
        }
      } catch {
        // non-fatal — render with whatever we have
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [service.id]);

  const priceCents = duration != null
    ? Math.round((service.base_price_cents * duration) / service.min_duration_minutes)
    : service.base_price_cents;

  const canAddMore = duration === null || duration < service.max_duration_minutes;
  const canReduce = duration !== null && duration > service.min_duration_minutes;

  const handleAddToCart = useCallback(async () => {
    const d = duration ?? service.min_duration_minutes;
    const priceCents = Math.round((service.base_price_cents * d) / service.min_duration_minutes);
    await addItem(service.id, d, service.name, priceCents);
    setDuration(d);
    setAddedToCart(true);
    posthog?.capture('service_added_to_cart', {
      service_id:       service.id,
      service_name:     service.name,
      duration_minutes: d,
      price_cents:      priceCents,
      selected_addons:  selectedAddons.size,
    });
  }, [addItem, service.id, service.name, service.min_duration_minutes, service.base_price_cents, duration, selectedAddons.size, posthog]);

  const handleShare = useCallback(() => {
    Share.share({ message: `Check out ${service.name} on ZopMop!` });
  }, [service.name]);

  const icon = serviceIcon({ id: service.id, name: service.name });

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <View style={s.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
            <Feather name="chevron-left" size={18} color="#FFFFFF" />
          </PressFx>
          <Text style={s.headTitle} numberOfLines={1}>
            {service.name}
          </Text>
          <PressFx onPress={handleShare} style={s.iconBtn}>
            <Feather name="share-2" size={16} color="#FFFFFF" />
          </PressFx>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 130 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Overview hero */}
        <View style={s.body}>
          <GlassCard radius={22} hero style={s.overviewCard}>
            <View style={s.overviewIconWrap}>
              {icon ? (
                <Image source={icon} style={s.overviewIconImg} resizeMode="contain" />
              ) : (
                <Text style={s.overviewEmoji}>{service.emoji ?? '🧹'}</Text>
              )}
            </View>
            <View style={s.overviewInfo}>
              <Text style={s.overviewName}>{service.name}</Text>
              {(details?.service.short_description ?? service.short_description) ? (
                <Text style={s.overviewDesc} numberOfLines={2}>
                  {details?.service.short_description ?? service.short_description}
                </Text>
              ) : null}
              <View style={s.ratingPill}>
                <Text style={s.ratingStar}>★</Text>
                <Text style={s.ratingText}>{service.rating}</Text>
                <Text style={s.reviewText}>· {formatReviews(service.review_count)} reviews</Text>
              </View>
            </View>
          </GlassCard>
        </View>

        {/* Duration */}
        <Text style={s.secH}>Duration</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.durationCard}>
            <View>
              <Text style={s.durationLabel}>{`${duration ?? service.min_duration_minutes} min`}</Text>
              <Text style={s.durationSub}>{`₹${(priceCents / 100).toFixed(0)}`}</Text>
            </View>
            <View style={s.durationControls}>
              <PressFx
                style={[s.durationBtn, !canReduce && s.durationBtnDisabled]}
                disabled={!canReduce}
                onPress={() => {
                  const prev = computePrevDuration(duration, service);
                  setDuration(prev);
                  setAddedToCart(false);
                }}
              >
                <Feather
                  name="minus"
                  size={16}
                  color={canReduce ? '#F5A300' : 'rgba(255,255,255,0.25)'}
                />
              </PressFx>
              <Text style={s.durationValue}>{duration ?? service.min_duration_minutes}</Text>
              <PressFx
                style={[s.durationBtn, !canAddMore && s.durationBtnDisabled]}
                disabled={!canAddMore}
                onPress={() => {
                  const next = computeNextDuration(duration, service);
                  setDuration(next);
                  setAddedToCart(false);
                }}
              >
                <Feather
                  name="plus"
                  size={16}
                  color={canAddMore ? '#F5A300' : 'rgba(255,255,255,0.25)'}
                />
              </PressFx>
            </View>
          </GlassCard>
        </View>

        {loading ? (
          <LoadingSkeleton variant="block" />
        ) : (
          <>
            {details && details.includes.length > 0 && (
              <>
                <Text style={s.secH}>What's included</Text>
                <View style={s.body}>
                  <GlassCard radius={20} style={s.listCard}>
                    {details.includes.map((inc, i) => (
                      <View key={inc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                        <View style={s.includeIcon}>
                          <Feather name="check" size={12} color="#22C55E" />
                        </View>
                        <Text style={s.listText}>{inc.item}</Text>
                      </View>
                    ))}
                  </GlassCard>
                </View>
              </>
            )}

            {details && details.excludes.length > 0 && (
              <>
                <Text style={s.secH}>What's not included</Text>
                <View style={s.body}>
                  <GlassCard radius={20} style={s.listCard}>
                    {details.excludes.map((exc, i) => (
                      <View key={exc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                        <View style={[s.includeIcon, s.excludeIcon]}>
                          <Feather name="x" size={12} color="#EF4444" />
                        </View>
                        <Text style={s.listText}>{exc.item}</Text>
                      </View>
                    ))}
                  </GlassCard>
                </View>
              </>
            )}

            {details && details.steps.length > 0 && (
              <>
                <Text style={s.secH}>How it works</Text>
                <View style={s.body}>
                  <View style={s.stepsCol}>
                    {details.steps.map((step, i) => (
                      <View key={step.id} style={s.stepRow}>
                        <View style={s.stepLeft}>
                          <View style={s.stepNumCircle}>
                            <Text style={s.stepNum}>{step.step_number}</Text>
                          </View>
                          {i < details.steps.length - 1 && <View style={s.stepLine} />}
                        </View>
                        <View style={s.stepBody}>
                          <Text style={s.stepTitle}>{step.title}</Text>
                          {step.description ? (
                            <Text style={s.stepDesc}>{step.description}</Text>
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              </>
            )}

            {addons.length > 0 && (
              <>
                <Text style={s.secH}>Add-on services</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.addonsRow}
                >
                  {addons.map((addon) => {
                    const selected = selectedAddons.has(addon.id);
                    const aIcon = serviceIcon({ id: addon.id, name: addon.name });
                    return (
                      <PressFx
                        key={addon.id}
                        style={[s.addonCard, selected && s.addonCardSelected]}
                        onPress={() => {
                          setSelectedAddons((prev) => {
                            const next = new Set(prev);
                            if (selected) next.delete(addon.id);
                            else next.add(addon.id);
                            return next;
                          });
                        }}
                      >
                        <View style={s.addonIconBox}>
                          {aIcon ? (
                            <Image source={aIcon} style={s.addonIconImg} resizeMode="contain" />
                          ) : (
                            <Text style={s.addonEmoji}>{addon.emoji ?? '✨'}</Text>
                          )}
                        </View>
                        <Text style={s.addonName} numberOfLines={2}>{addon.name}</Text>
                        <Text style={s.addonPrice}>
                          ₹{(addon.base_price_cents / 100).toFixed(0)}
                        </Text>
                        <View style={[s.addonToggle, selected && s.addonToggleSelected]}>
                          <Feather
                            name={selected ? 'check' : 'plus'}
                            size={11}
                            color={selected ? '#0A0A0A' : '#F5A300'}
                          />
                          <Text
                            style={[
                              s.addonToggleText,
                              selected && s.addonToggleTextSelected,
                            ]}
                          >
                            {selected ? 'Added' : 'Add'}
                          </Text>
                        </View>
                      </PressFx>
                    );
                  })}
                </ScrollView>
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Sticky bottom CTA */}
      <View style={[s.bottomBar, { paddingBottom: 12 + insets.bottom }]}>
        <View style={s.bottomPriceCol}>
          <Text style={s.bottomPriceLabel}>Total</Text>
          <View style={s.bottomPriceRow}>
            <Text style={s.bottomPrice}>₹{(priceCents / 100).toFixed(0)}</Text>
            {service.mrp_cents != null && (
              <Text style={s.bottomMrp}>₹{(service.mrp_cents / 100).toFixed(0)}</Text>
            )}
          </View>
        </View>
        <PressFx
          style={[s.addCartBtn, addedToCart && s.addCartBtnDone]}
          onPress={addedToCart ? () => navigation.navigate('Cart') : handleAddToCart}
        >
          <Text style={s.addCartText}>
            {addedToCart ? 'View cart' : 'Add to cart'}
          </Text>
          <Feather
            name={addedToCart ? 'arrow-right' : 'plus'}
            size={15}
            color="#0A0A0A"
          />
        </PressFx>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  // Sticky head
  head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  headTitle: {
    flex: 1,
    ...fontExtra,
    fontSize: 18, color: '#FFFFFF',
    letterSpacing: -0.4,
    textAlign: 'center',
  },

  body: { paddingHorizontal: H_PAD },

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

  // Overview
  overviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 18,
    marginTop: 6,
  },
  overviewIconWrap: {
    width: 72, height: 72, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.1)',
    borderWidth: 0.5, borderColor: 'rgba(245,163,0,0.2)',
  },
  overviewIconImg: { width: 52, height: 52 },
  overviewEmoji: { fontSize: 36 },
  overviewInfo: { flex: 1, gap: 4 },
  overviewName: {
    ...fontExtra,
    fontSize: 18, color: '#FFFFFF',
    letterSpacing: -0.3,
  },
  overviewDesc: {
    ...fontMed,
    fontSize: 12.5, color: 'rgba(255,255,255,0.6)',
    lineHeight: 18,
  },
  ratingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 4,
  },
  ratingStar: { ...fontBold, color: '#F5A300', fontSize: 11.5 },
  ratingText: {
    ...fontBold,
    fontSize: 11.5, color: '#FFFFFF',
  },
  reviewText: {
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.45)',
    marginLeft: 2,
  },

  // Duration
  durationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  durationLabel: {
    ...fontBold,
    fontSize: 16, color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  durationSub: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  durationControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  durationBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(245,163,0,0.12)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  durationBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.08)',
  },
  durationValue: {
    ...fontExtra,
    fontSize: 18, color: '#FFFFFF',
    minWidth: 32, textAlign: 'center',
    letterSpacing: -0.3,
  },

  // Includes / Excludes list card
  listCard: { padding: 6 },
  listRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 10, gap: 12,
  },
  listRowBorder: {
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  listText: {
    ...fontMed,
    fontSize: 13, color: 'rgba(255,255,255,0.78)',
    flex: 1, lineHeight: 18,
  },
  includeIcon: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(34,197,94,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  excludeIcon: { backgroundColor: 'rgba(239,68,68,0.14)' },

  // Steps
  stepsCol: { gap: 0 },
  stepRow: { flexDirection: 'row', gap: 14 },
  stepLeft: { alignItems: 'center', width: 28 },
  stepNumCircle: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(245,163,0,0.18)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepNum: {
    ...fontExtra,
    fontSize: 12, color: '#F5A300',
  },
  stepLine: {
    width: 2, flex: 1, minHeight: 18,
    backgroundColor: 'rgba(245,163,0,0.18)',
    marginVertical: 4,
  },
  stepBody: { flex: 1, paddingBottom: 20 },
  stepTitle: {
    ...fontSemi,
    fontSize: 13.5, color: '#FFFFFF',
    marginBottom: 2, letterSpacing: -0.1,
  },
  stepDesc: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.55)',
    lineHeight: 17,
  },

  // Addons
  addonsRow: { paddingLeft: H_PAD, paddingRight: H_PAD - 10, gap: 10 },
  addonCard: {
    width: 130,
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    backgroundColor: 'rgba(255,255,255,0.045)',
    alignItems: 'center',
    gap: 6,
  },
  addonCardSelected: {
    borderColor: 'rgba(245,163,0,0.5)',
    backgroundColor: 'rgba(245,163,0,0.08)',
  },
  addonIconBox: {
    width: 52, height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.1)',
    borderWidth: 0.5, borderColor: 'rgba(245,163,0,0.18)',
  },
  addonIconImg: { width: 38, height: 38 },
  addonEmoji: { fontSize: 24 },
  addonName: {
    ...fontSemi,
    fontSize: 11.5, color: '#FFFFFF',
    textAlign: 'center', lineHeight: 15,
  },
  addonPrice: {
    ...fontExtra,
    fontSize: 12, color: '#F5A300',
  },
  addonToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 0.5, borderColor: 'rgba(245,163,0,0.32)',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  addonToggleSelected: {
    backgroundColor: '#F5A300',
    borderColor: '#F5A300',
  },
  addonToggleText: {
    ...fontBold,
    fontSize: 10, color: '#F5A300', letterSpacing: 0.3,
  },
  addonToggleTextSelected: { color: '#0A0A0A' },

  // Bottom bar
  bottomBar: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: H_PAD,
    paddingTop: 12,
    backgroundColor: 'rgba(10,10,10,0.92)',
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  bottomPriceCol: { flex: 1 },
  bottomPriceLabel: {
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.45)',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  bottomPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  bottomPrice: {
    ...fontExtra,
    fontSize: 22, color: '#FFFFFF', letterSpacing: -0.5,
  },
  bottomMrp: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.4)',
    textDecorationLine: 'line-through',
  },
  addCartBtn: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F5A300',
    borderRadius: 16,
    paddingVertical: 14,
  },
  addCartBtnDone: { backgroundColor: '#FFC042' },
  addCartText: {
    ...fontBold,
    fontSize: 14, color: '#0A0A0A', letterSpacing: 0.1,
  },
});
