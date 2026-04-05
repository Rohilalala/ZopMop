import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useCart } from '../../context/CartContext';
import { listServices, type ApiService } from '../../api/services';
import type { MainStackParamList } from '../../types/navigation';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 16;
const CARD_GAP = 12;
const CARD_WIDTH = (SCREEN_WIDTH - H_PAD * 2 - CARD_GAP) / 2;

// ── Category grouping ─────────────────────────────────────────────────────────
// Services come from the real API; only the structural grouping is defined here.

const CATEGORY_DEFS: { id: string; title: string; match: (name: string) => boolean }[] = [
  { id: 'home_cleaning', title: 'Home Cleaning',        match: n => /sweep|mop|dust|wipe|window|balcony|bathroom/i.test(n) },
  { id: 'kitchen',       title: 'Kitchen Services',      match: n => /kitchen|dish|utensil|fridge|cabinet/i.test(n) },
  { id: 'laundry',       title: 'Laundry & Fabric Care', match: n => /laundry|iron|fold|wardrobe/i.test(n) },
  { id: 'outdoor',       title: 'Outdoor & Garden',      match: n => /garden|plant|outdoor/i.test(n) },
  { id: 'vehicle',       title: 'Vehicle Care',          match: n => /\bcar\b|vehicle|bike/i.test(n) },
  { id: 'pet',           title: 'Pet Care',              match: n => /pet|dog|cat|walk/i.test(n) },
  { id: 'other',         title: 'Other Services',        match: () => true },
];

interface Group { id: string; title: string; services: ApiService[] }

function groupServices(services: ApiService[]): Group[] {
  const map = new Map<string, Group>();
  for (const svc of services) {
    const cat = CATEGORY_DEFS.find(c => c.match(svc.name)) ?? CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
    if (!map.has(cat.id)) map.set(cat.id, { id: cat.id, title: cat.title, services: [] });
    map.get(cat.id)!.services.push(svc);
  }
  return Array.from(map.values()).filter(g => g.services.length > 0);
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AllServicesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'AllServices'>>();
  const instant = route.params?.instant ?? false;
  
  const [services, setServices] = useState<ApiService[]>([]);
  const [loading, setLoading] = useState(true);
  const { itemCount, subtotalCents } = useCart();

  useEffect(() => {
    listServices()
      .then(data => { if (data.length > 0) setServices(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const groups = groupServices(services);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Explore Services</Text>
      </View>

      {loading ? (
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={[s.scrollContent, itemCount > 0 && { paddingBottom: 84 }]}
          showsVerticalScrollIndicator={false}
        >
          {groups.map(group => (
            <View key={group.id} style={s.section}>
              <Text style={s.sectionTitle}>{group.title}</Text>
              <View style={s.grid}>
                {group.services.map(svc => (
                  <ServiceCard key={svc.id} service={svc} instant={instant} />
                ))}
              </View>
            </View>
          ))}

          {groups.length === 0 && (
            <View style={s.emptyWrap}>
              <Text style={s.emptyEmoji}>🔍</Text>
              <Text style={s.emptyText}>No services available right now</Text>
              <Text style={s.emptySubtext}>Check back soon</Text>
            </View>
          )}
        </ScrollView>
      )}

      {/* Cart bar */}
      {!instant && itemCount > 0 && (
        <View style={s.cartBar}>
          <View style={s.cartBarLeft}>
            <Text style={s.cartBarEmoji}>🛒</Text>
            <View>
              <Text style={s.cartBarCount}>{itemCount} service{itemCount > 1 ? 's' : ''}</Text>
              <Text style={s.cartBarSubtotal}>₹{(subtotalCents / 100).toFixed(0)} total</Text>
            </View>
          </View>
          <TouchableOpacity
            style={s.cartBarBtn}
            activeOpacity={0.85}
            onPress={() => navigation.navigate('Cart')}
          >
            <Text style={s.cartBarBtnText}>Go to cart  →</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

// ── Service Card ──────────────────────────────────────────────────────────────

function ServiceCard({ service, instant }: { service: ApiService, instant: boolean }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { addItem, removeItem, items } = useCart();
  const [busy, setBusy] = useState(false);

  const cartItem = items.find(i => i.service_id === service.id);
  const inCart = !!cartItem;

  // Render for instant mode
  if (instant) {
    return (
      <TouchableOpacity
        style={[s.card, { width: CARD_WIDTH }]}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('InstantMatching', { serviceId: service.id, serviceName: service.name })}
      >
        <View style={[s.cardImgBox, { backgroundColor: service.bg_color || '#EEF2FF' }]}>
          <View style={s.ratingBadge}>
            <Text style={s.ratingText}>⭐ {service.rating}</Text>
          </View>
          <Text style={s.cardEmoji}>{service.emoji ?? '🧹'}</Text>
        </View>

        <Text style={s.cardName} numberOfLines={2}>{service.name.replace(/\n/g, ' ')}</Text>
        <View style={s.priceRow}>
          <Text style={s.cardPrice}>₹{(service.base_price_cents / 100).toFixed(0)}</Text>
          {service.mrp_cents != null && (
            <Text style={s.cardMrp}>₹{(service.mrp_cents / 100).toFixed(0)}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    try {
      await addItem(service.id, service.min_duration_minutes);
    } catch (err: any) {
      Alert.alert('Could not add to cart', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleIncrement() {
    if (busy || !cartItem) return;
    const next = cartItem.duration_minutes + service.duration_step_minutes;
    if (next > service.max_duration_minutes) return;
    setBusy(true);
    try {
      await addItem(service.id, next);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDecrement() {
    if (busy || !cartItem) return;
    setBusy(true);
    try {
      if (cartItem.duration_minutes <= service.min_duration_minutes) {
        await removeItem(cartItem.id);
      } else {
        await addItem(service.id, cartItem.duration_minutes - service.duration_step_minutes);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      style={[s.card, { width: CARD_WIDTH }]}
      activeOpacity={inCart ? 1 : 0.85}
      onPress={() => { if (!inCart) navigation.navigate('ServiceAbout', { service }); }}
    >
      {/* Emoji area */}
      <View style={[s.cardImgBox, { backgroundColor: service.bg_color || '#EEF2FF' }]}>
        <View style={s.ratingBadge}>
          <Text style={s.ratingText}>⭐ {service.rating}</Text>
        </View>
        <Text style={s.cardEmoji}>{service.emoji ?? '🧹'}</Text>

        {inCart ? (
          <View style={s.stepper}>
            <TouchableOpacity
              style={s.stepBtn}
              activeOpacity={0.7}
              onPress={handleDecrement}
              disabled={busy}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
            >
              {busy
                ? <ActivityIndicator size="small" color={Colors.primary} style={{ transform: [{ scale: 0.55 }] }} />
                : <Text style={s.stepBtnText}>−</Text>
              }
            </TouchableOpacity>
            <View style={s.stepCenter}>
              <Text style={s.stepCount}>{cartItem.duration_minutes}</Text>
              <Text style={s.stepLabel}>Min</Text>
            </View>
            <TouchableOpacity
              style={s.stepBtn}
              activeOpacity={0.7}
              onPress={handleIncrement}
              disabled={busy || cartItem.duration_minutes >= service.max_duration_minutes}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            >
              <Text style={[
                s.stepBtnText,
                cartItem.duration_minutes >= service.max_duration_minutes && s.stepBtnDisabled,
              ]}>+</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={s.addBtn}
            activeOpacity={0.8}
            onPress={handleAdd}
            disabled={busy}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {busy
              ? <ActivityIndicator size="small" color={Colors.primary} style={{ transform: [{ scale: 0.7 }] }} />
              : <Text style={s.addBtnText}>+</Text>
            }
          </TouchableOpacity>
        )}
      </View>

      {/* Info */}
      <Text style={s.cardName} numberOfLines={2}>{service.name.replace(/\n/g, ' ')}</Text>
      <View style={s.priceRow}>
        <Text style={s.cardPrice}>₹{(service.base_price_cents / 100).toFixed(0)}</Text>
        {service.mrp_cents != null && (
          <Text style={s.cardMrp}>₹{(service.mrp_cents / 100).toFixed(0)}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: Spacing.xl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: H_PAD,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 4,
  },
  backBtn: { padding: 4, marginLeft: -4 },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },

  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  section: { paddingHorizontal: H_PAD, marginBottom: 32 },
  sectionTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    letterSpacing: -0.2,
    marginBottom: 14,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: CARD_GAP },

  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  cardImgBox: {
    width: '100%',
    aspectRatio: 1.2,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ratingBadge: {
    position: 'absolute', top: 6, left: 6,
    backgroundColor: 'rgba(255,255,255,0.88)',
    paddingHorizontal: 5, paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  ratingText: { fontFamily: FontFamily.semibold, fontSize: 9, color: Colors.text },
  cardEmoji: { fontSize: 36 },

  addBtn: {
    position: 'absolute', bottom: 6, right: 6,
    width: 26, height: 26, borderRadius: Radius.md,
    backgroundColor: Colors.white,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
    ...Shadow.sm,
  },
  addBtnText: { fontFamily: FontFamily.bold, fontSize: 16, color: Colors.primary, lineHeight: 20, marginTop: -1 },

  stepper: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.96)',
    paddingHorizontal: 8, paddingVertical: 5,
    borderTopWidth: 1, borderTopColor: `${Colors.primary}22`,
  },
  stepBtn: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontFamily: FontFamily.bold, fontSize: 18, color: Colors.primary, lineHeight: 22 },
  stepBtnDisabled: { color: Colors.border },
  stepCenter: { alignItems: 'center', flex: 1 },
  stepCount: { fontFamily: FontFamily.bold, fontSize: 13, color: Colors.text, lineHeight: 16 },
  stepLabel: { fontFamily: FontFamily.regular, fontSize: 8, color: Colors.textMuted, lineHeight: 10 },

  cardName: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.text,
    paddingHorizontal: 10,
    paddingTop: 8,
    lineHeight: 18,
  },
  priceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingBottom: 10, paddingTop: 3,
  },
  cardPrice: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text },
  cardMrp: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textDecorationLine: 'line-through',
  },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyEmoji: { fontSize: 40 },
  emptyText: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.text },
  emptySubtext: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },

  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.white,
    paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.border,
    ...Shadow.md,
  },
  cartBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cartBarEmoji: { fontSize: 22 },
  cartBarCount: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text },
  cartBarSubtotal: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 1 },
  cartBarBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: Radius.xl,
    ...Shadow.sm,
  },
  cartBarBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.white },
});
