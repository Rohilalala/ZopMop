import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Share,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { getServiceDetails, getServiceAddons, type ServiceDetails, type ServiceAddon } from '../../api/services';
import { useCart } from '../../context/CartContext';

type Nav = NativeStackNavigationProp<MainStackParamList>;
type Route = RouteProp<MainStackParamList, 'ServiceAbout'>;

// ── Duration selector logic ───────────────────────────────────────────────────

function computeNextDuration(current: number | null, service: { min_duration_minutes: number; max_duration_minutes: number; duration_step_minutes: number }): number {
  if (current === null) return service.min_duration_minutes;
  const next = current + service.duration_step_minutes;
  return next > service.max_duration_minutes ? current : next;
}

function computePrevDuration(current: number | null, service: { min_duration_minutes: number; duration_step_minutes: number }): number | null {
  if (current === null) return null;
  const prev = current - service.duration_step_minutes;
  return prev < service.min_duration_minutes ? null : prev;
}

// ── Root Component ────────────────────────────────────────────────────────────

export default function ServiceAboutScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const { service } = params;

  const [details, setDetails] = useState<ServiceDetails | null>(null);
  const [addons, setAddons] = useState<ServiceAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());
  const [duration, setDuration] = useState<number | null>(null);
  const [addedToCart, setAddedToCart] = useState(false);

  const { addItem } = useCart();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [det, add] = await Promise.all([
          getServiceDetails(service.id),
          getServiceAddons(service.id),
        ]);
        if (!cancelled) {
          setDetails(det);
          setAddons(add);
        }
      } catch {
        // keep loading=false so screen is still usable
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [service.id]);

  const priceCents = duration != null
    ? Math.round(service.base_price_cents * duration / service.min_duration_minutes)
    : service.base_price_cents;

  const canAddMore = duration === null || duration < service.max_duration_minutes;
  const canReduce = duration !== null && duration > service.min_duration_minutes;

  const handleAddToCart = useCallback(async () => {
    const d = duration ?? service.min_duration_minutes;
    await addItem(service.id, d);
    setDuration(d);
    setAddedToCart(true);
  }, [addItem, service.id, service.min_duration_minutes, duration]);

  const handleShare = useCallback(() => {
    Share.share({ message: `Check out ${service.name} on ZopMop!` });
  }, [service.name]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{service.name}</Text>
        <TouchableOpacity style={s.shareBtn} onPress={handleShare} activeOpacity={0.7}>
          <Text style={s.shareIcon}>⬆</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        {/* Service Overview */}
        <View style={[s.overviewCard, { backgroundColor: service.bg_color || '#EEF2FF' }]}>
          <Text style={s.overviewEmoji}>{service.emoji ?? '🧹'}</Text>
          <View style={s.overviewInfo}>
            <Text style={s.overviewName}>{service.name}</Text>
            {(details?.service.short_description ?? service.short_description) ? (
              <Text style={s.overviewDesc}>
                {details?.service.short_description ?? service.short_description}
              </Text>
            ) : null}
            <View style={s.overviewMeta}>
              <View style={s.ratingPill}>
                <Text style={s.ratingText}>⭐ {service.rating}</Text>
                <Text style={s.reviewText}> ({formatReviews(service.review_count)} reviews)</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Duration Selector */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Duration</Text>
          <View style={s.durationCard}>
            <View style={s.durationLeft}>
              <Text style={s.durationLabel}>
                {duration == null ? 'Select duration' : `${duration} min`}
              </Text>
              <Text style={s.durationSub}>
                {duration == null
                  ? `Starting from ${service.min_duration_minutes} min`
                  : `₹${(priceCents / 100).toFixed(0)}`}
              </Text>
            </View>
            <View style={s.durationControls}>
              <TouchableOpacity
                style={[s.durationBtn, !canReduce && s.durationBtnDisabled]}
                disabled={!canReduce}
                activeOpacity={0.7}
                onPress={() => {
                  const prev = computePrevDuration(duration, service);
                  setDuration(prev);
                  setAddedToCart(false);
                }}
              >
                <Text style={[s.durationBtnText, !canReduce && s.durationBtnTextDisabled]}>−</Text>
              </TouchableOpacity>
              <Text style={s.durationValue}>{duration ?? '—'}</Text>
              <TouchableOpacity
                style={[s.durationBtn, !canAddMore && s.durationBtnDisabled]}
                disabled={!canAddMore}
                activeOpacity={0.7}
                onPress={() => {
                  const next = computeNextDuration(duration, service);
                  setDuration(next);
                  setAddedToCart(false);
                }}
              >
                <Text style={[s.durationBtnText, !canAddMore && s.durationBtnTextDisabled]}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginVertical: 32 }} />
        ) : (
          <>
            {/* Included */}
            {details && details.includes.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>What's included</Text>
                <View style={s.listCard}>
                  {details.includes.map((inc, i) => (
                    <View key={inc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                      <View style={s.includeIcon}>
                        <Text style={s.includeIconText}>✓</Text>
                      </View>
                      <Text style={s.listText}>{inc.item}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Excluded */}
            {details && details.excludes.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>What's not included</Text>
                <View style={s.listCard}>
                  {details.excludes.map((exc, i) => (
                    <View key={exc.id} style={[s.listRow, i > 0 && s.listRowBorder]}>
                      <View style={[s.includeIcon, s.excludeIcon]}>
                        <Text style={s.excludeIconText}>✕</Text>
                      </View>
                      <Text style={s.listText}>{exc.item}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* How it works */}
            {details && details.steps.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>How it works</Text>
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
                        <Text style={s.stepIcon}>{step.icon ?? '📌'}</Text>
                        <View style={s.stepText}>
                          <Text style={s.stepTitle}>{step.title}</Text>
                          {step.description ? (
                            <Text style={s.stepDesc}>{step.description}</Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Add-ons */}
            {addons.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>Add-on services</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.addonsRow}
                >
                  {addons.map(addon => {
                    const selected = selectedAddons.has(addon.id);
                    return (
                      <TouchableOpacity
                        key={addon.id}
                        style={[s.addonCard, selected && s.addonCardSelected]}
                        activeOpacity={0.8}
                        onPress={() => {
                          setSelectedAddons(prev => {
                            const next = new Set(prev);
                            selected ? next.delete(addon.id) : next.add(addon.id);
                            return next;
                          });
                        }}
                      >
                        <View style={[s.addonEmojiBox, { backgroundColor: addon.bg_color || '#EEF2FF' }]}>
                          <Text style={s.addonEmoji}>{addon.emoji ?? '✨'}</Text>
                        </View>
                        <Text style={s.addonName} numberOfLines={2}>{addon.name}</Text>
                        <Text style={s.addonPrice}>₹{(addon.base_price_cents / 100).toFixed(0)}</Text>
                        <View style={[s.addonToggle, selected && s.addonToggleSelected]}>
                          <Text style={[s.addonToggleText, selected && s.addonToggleTextSelected]}>
                            {selected ? '✓ Added' : '+ Add'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Sticky bottom CTA */}
      <View style={s.bottomBar}>
        <View style={s.bottomPriceCol}>
          <Text style={s.bottomPriceLabel}>Total</Text>
          <View style={s.bottomPriceRow}>
            <Text style={s.bottomPrice}>₹{(priceCents / 100).toFixed(0)}</Text>
            {service.mrp_cents != null && (
              <Text style={s.bottomMrp}>₹{(service.mrp_cents / 100).toFixed(0)}</Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={[s.addCartBtn, addedToCart && s.addCartBtnDone]}
          activeOpacity={0.85}
          onPress={addedToCart ? () => navigation.navigate('Cart') : handleAddToCart}
        >
          <Text style={s.addCartText}>
            {addedToCart ? 'View Cart →' : 'Add to Cart'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatReviews(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { paddingBottom: 16 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    width: 36, height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  backIcon: { fontSize: 18, color: Colors.text, marginTop: -1 },
  headerTitle: {
    flex: 1,
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  shareBtn: {
    width: 36, height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  shareIcon: { fontSize: 16, color: Colors.textSecondary },

  // Overview
  overviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    borderRadius: Radius.xl,
    padding: 20,
    gap: 16,
    ...Shadow.sm,
  },
  overviewEmoji: { fontSize: 52 },
  overviewInfo: { flex: 1, gap: 4 },
  overviewName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xl,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  overviewDesc: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  overviewMeta: { flexDirection: 'row', marginTop: 4 },
  ratingPill: { flexDirection: 'row', alignItems: 'center' },
  ratingText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: Colors.text },
  reviewText: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted },

  // Section
  section: { paddingHorizontal: 16, marginBottom: 24 },
  sectionTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 12,
    letterSpacing: -0.2,
  },

  // Duration
  durationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  durationLeft: { gap: 2 },
  durationLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.text },
  durationSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },
  durationControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  durationBtn: {
    width: 36, height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.primaryBg,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  durationBtnDisabled: { backgroundColor: Colors.surface, borderColor: Colors.border },
  durationBtnText: { fontSize: 20, color: Colors.primary, lineHeight: 24, fontFamily: FontFamily.bold },
  durationBtnTextDisabled: { color: Colors.textMuted },
  durationValue: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    minWidth: 32,
    textAlign: 'center',
  },

  // List cards (includes/excludes)
  listCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  listRowBorder: { borderTopWidth: 1, borderTopColor: Colors.border },
  listText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  includeIcon: {
    width: 22, height: 22, borderRadius: Radius.full,
    backgroundColor: `${Colors.success}22`,
    alignItems: 'center', justifyContent: 'center',
  },
  includeIconText: { fontSize: 11, color: Colors.success, fontFamily: FontFamily.bold },
  excludeIcon: { backgroundColor: `${Colors.danger}18` },
  excludeIconText: { fontSize: 11, color: Colors.danger, fontFamily: FontFamily.bold },

  // Steps
  stepsCol: { gap: 0 },
  stepRow: { flexDirection: 'row', gap: 12 },
  stepLeft: { alignItems: 'center', width: 28 },
  stepNumCircle: {
    width: 28, height: 28, borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  stepNum: { fontFamily: FontFamily.bold, fontSize: FontSize.xs, color: Colors.white },
  stepLine: { width: 2, flex: 1, backgroundColor: Colors.border, marginVertical: 4, minHeight: 20 },
  stepBody: { flex: 1, flexDirection: 'row', gap: 12, paddingBottom: 20 },
  stepIcon: { fontSize: 22, marginTop: 2 },
  stepText: { flex: 1 },
  stepTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.text, marginBottom: 2 },
  stepDesc: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 18 },

  // Addons
  addonsRow: { paddingRight: 4, gap: 12 },
  addonCard: {
    width: 120,
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    gap: 6,
    ...Shadow.sm,
  },
  addonCardSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryBg },
  addonEmojiBox: {
    width: 48, height: 48, borderRadius: Radius.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  addonEmoji: { fontSize: 24 },
  addonName: {
    fontFamily: FontFamily.semibold, fontSize: 11,
    color: Colors.text, textAlign: 'center', lineHeight: 15,
  },
  addonPrice: { fontFamily: FontFamily.bold, fontSize: FontSize.xs, color: Colors.primary },
  addonToggle: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: Radius.full,
    borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  addonToggleSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  addonToggleText: { fontFamily: FontFamily.semibold, fontSize: 10, color: Colors.textSecondary },
  addonToggleTextSelected: { color: Colors.white },

  // Bottom bar
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 16,
    ...Shadow.md,
  },
  bottomPriceCol: { flex: 1 },
  bottomPriceLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted },
  bottomPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bottomPrice: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: Colors.text },
  bottomMrp: {
    fontFamily: FontFamily.regular, fontSize: FontSize.sm,
    color: Colors.textMuted, textDecorationLine: 'line-through',
  },
  addCartBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 14,
    alignItems: 'center',
    ...Shadow.sm,
  },
  addCartBtnDone: { backgroundColor: Colors.accent },
  addCartText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.white },
});
