import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import LocationSelectorModal from '../../components/LocationSelectorModal';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 16;
const GRID_GAP = 10;
const SERVICE_CARD_WIDTH = (SCREEN_WIDTH - H_PAD * 2 - GRID_GAP * 2) / 3;

// ── Static data (replace with API later) ─────────────────────────────────────

const SERVICES = [
  { id: '1', emoji: '🧹', name: 'Sweeping &\nMopping',   price: 25,  mrp: 125, rating: 4.9, reviews: '15.3k', bg: '#EEF2FF' },
  { id: '2', emoji: '🚿', name: 'Bathroom\nCleaning',    price: 25,  mrp: 150, rating: 4.9, reviews: '17.8k', bg: '#F0FDFA' },
  { id: '3', emoji: '🍽️', name: 'Utensils',             price: 25,  mrp: 125, rating: 4.9, reviews: '13.5k', bg: '#FFF7ED' },
  { id: '4', emoji: '🧽', name: 'Dusting &\nWiping',     price: 25,  mrp: 125, rating: 4.9, reviews: '6.5k',  bg: '#F0FDF4' },
  { id: '5', emoji: '🔪', name: 'Kitchen\nPrep',         price: 25,  mrp: 125, rating: 4.9, reviews: '3.7k',  bg: '#EFF6FF' },
  { id: '6', emoji: '👕', name: 'Laundry',               price: 25,  mrp: 125, rating: 4.9, reviews: '4.5k',  bg: '#FDF4FF' },
  { id: '7', emoji: '🪟', name: 'Window\nCleaning',      price: 25,  mrp: 125, rating: 4.9, reviews: '4.2k',  bg: '#F8FAFC' },
  { id: '8', emoji: '❄️', name: 'Fridge\nCleaning',      price: 149, mrp: 250, rating: 4.9, reviews: '3.3k',  bg: '#F0F9FF' },
  { id: '9', emoji: '🧺', name: 'Ironing &\nFolding',    price: 25,  mrp: 125, rating: 4.8, reviews: '4.3k',  bg: '#FEF9C3' },
];

// ── Root Component ────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [locationName, setLocationName] = useState('Sector 51, Gurugram');

  function handleLocationSelect(name: string) {
    const shortName = name.split(',').slice(0, 2).join(',').trim();
    setLocationName(shortName);
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <Header locationName={locationName} onLocationPress={() => setLocationModalVisible(true)} />
        <HeroCard />
        <BookingCards />
        <ServicesGrid />
        <TrustStrip />
        <View style={{ height: 32 }} />
      </ScrollView>

      <LocationSelectorModal
        visible={locationModalVisible}
        onClose={() => setLocationModalVisible(false)}
        onLocationSelect={(name) => handleLocationSelect(name)}
      />
    </SafeAreaView>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ locationName, onLocationPress }: { locationName: string; onLocationPress: () => void }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  return (
    <View style={s.header}>
      <TouchableOpacity style={s.locationBtn} activeOpacity={0.7} onPress={onLocationPress}>
        <Text style={s.locationLabel}>Your location</Text>
        <View style={s.locationRow}>
          <Text style={s.locationName} numberOfLines={1}>{locationName}</Text>
          <Text style={s.chevron}>⌄</Text>
        </View>
      </TouchableOpacity>

      <View style={s.headerRight}>
        <TouchableOpacity style={s.earnBtn} activeOpacity={0.8}>
          <Text style={s.earnIcon}>🪙</Text>
          <Text style={s.earnText}>Earn ₹100</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.avatarBtn} activeOpacity={0.8} onPress={() => navigation.navigate('Profile')}>
          <Text style={s.avatarIcon}>👤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard() {
  return (
    <View style={s.heroCard}>
      {/* Decorative circles */}
      <View style={[s.heroCircle, s.heroCircle1]} />
      <View style={[s.heroCircle, s.heroCircle2]} />

      {/* Available pill */}
      <View style={s.heroPill}>
        <View style={s.heroPillDot} />
        <Text style={s.heroPillText}>Available Now</Text>
      </View>

      <Text style={s.heroTitle}>Expert help,{'\n'}at your doorstep</Text>
      <Text style={s.heroSub}>Trusted professionals, on demand</Text>

      <TouchableOpacity style={s.heroCTA} activeOpacity={0.85}>
        <Text style={s.heroCTAText}>Book a Service  →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Booking Cards ─────────────────────────────────────────────────────────────

function BookingCards() {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>How would you like to book?</Text>
      <View style={s.bookingRow}>

        {/* Schedule */}
        <TouchableOpacity style={s.bookingCard} activeOpacity={0.85}>
          <View style={[s.bookingIconBox, { backgroundColor: Colors.primaryBg }]}>
            <Text style={s.bookingEmoji}>📅</Text>
          </View>
          <Text style={s.bookingCardTitle}>Schedule</Text>
          <Text style={s.bookingCardSub}>Pick your time</Text>
        </TouchableOpacity>

        {/* Instant */}
        <TouchableOpacity style={[s.bookingCard, s.bookingCardInstant]} activeOpacity={0.85}>
          <View style={s.timePill}>
            <Text style={s.timePillText}>~30 min</Text>
          </View>
          <View style={[s.bookingIconBox, { backgroundColor: '#F0FDFA' }]}>
            <Text style={s.bookingEmoji}>⚡</Text>
          </View>
          <Text style={s.bookingCardTitle}>Instant</Text>
          <Text style={s.bookingCardSub}>Get help now</Text>
        </TouchableOpacity>

      </View>
    </View>
  );
}

// ── Services Grid ─────────────────────────────────────────────────────────────

function ServicesGrid() {
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Popular Services</Text>
        <TouchableOpacity activeOpacity={0.7}>
          <Text style={s.seeAll}>See all</Text>
        </TouchableOpacity>
      </View>

      <View style={s.grid}>
        {SERVICES.map(service => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </View>
    </View>
  );
}

function ServiceCard({ service }: { service: typeof SERVICES[0] }) {
  return (
    <TouchableOpacity
      style={[s.serviceCard, { width: SERVICE_CARD_WIDTH }]}
      activeOpacity={0.85}
    >
      <View style={[s.serviceImgBox, { backgroundColor: service.bg }]}>
        <View style={s.ratingBadge}>
          <Text style={s.ratingText}>⭐ {service.rating}</Text>
        </View>
        <Text style={s.serviceEmoji}>{service.emoji}</Text>
        <TouchableOpacity style={s.addBtn} activeOpacity={0.8}>
          <Text style={s.addBtnText}>+</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.serviceName} numberOfLines={2}>{service.name}</Text>
      <View style={s.priceRow}>
        <Text style={s.servicePrice}>₹{service.price}</Text>
        <Text style={s.serviceMrp}>₹{service.mrp}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Trust Strip ───────────────────────────────────────────────────────────────

function TrustStrip() {
  const items = [
    { icon: '✅', label: 'Verified\nPros' },
    { icon: '🛡️', label: 'Background\nChecked' },
    { icon: '⭐', label: '4.9 Rated\nService' },
  ];

  return (
    <View style={s.section}>
      <View style={s.trustCard}>
        <Text style={s.trustTitle}>Reliable & Trustworthy</Text>
        <View style={s.trustRow}>
          {items.map((item, idx) => (
            <React.Fragment key={item.label}>
              <View style={s.trustItem}>
                <Text style={s.trustIcon}>{item.icon}</Text>
                <Text style={s.trustLabel}>{item.label}</Text>
              </View>
              {idx < items.length - 1 && <View style={s.trustDivider} />}
            </React.Fragment>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { paddingBottom: Spacing.base },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: H_PAD,
    paddingTop: 12,
    paddingBottom: 16,
  },
  locationBtn: { flex: 1 },
  locationLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  locationName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    maxWidth: SCREEN_WIDTH * 0.42,
  },
  chevron: {
    fontSize: 16,
    color: Colors.textSecondary,
    marginTop: -2,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  earnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryBg,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.primary}22`,
  },
  earnIcon: { fontSize: 12 },
  earnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  avatarBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarIcon: { fontSize: 18 },

  // Hero Card
  heroCard: {
    marginHorizontal: H_PAD,
    backgroundColor: Colors.primary,
    borderRadius: Radius['2xl'],
    padding: 24,
    paddingBottom: 28,
    overflow: 'hidden',
    marginBottom: 28,
  },
  heroCircle: {
    position: 'absolute',
    borderRadius: Radius.full,
    backgroundColor: Colors.white,
  },
  heroCircle1: {
    width: 150,
    height: 150,
    opacity: 0.07,
    top: -55,
    right: -35,
  },
  heroCircle2: {
    width: 90,
    height: 90,
    opacity: 0.05,
    bottom: -25,
    right: 90,
  },
  heroPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.full,
    marginBottom: 16,
  },
  heroPillDot: {
    width: 6,
    height: 6,
    borderRadius: Radius.full,
    backgroundColor: '#4ADE80',
  },
  heroPillText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.xs,
    color: Colors.white,
  },
  heroTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['3xl'],
    color: Colors.white,
    lineHeight: FontSize['3xl'] * 1.2,
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  heroSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.72)',
    marginBottom: 22,
  },
  heroCTA: {
    backgroundColor: Colors.white,
    alignSelf: 'flex-start',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: Radius.xl,
  },
  heroCTAText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Section wrapper
  section: {
    paddingHorizontal: H_PAD,
    marginBottom: 28,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sectionTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    letterSpacing: -0.2,
    marginBottom: 14,
  },
  seeAll: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.primary,
    marginBottom: 14,
  },

  // Booking Cards
  bookingRow: {
    flexDirection: 'row',
    gap: 12,
  },
  bookingCard: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 16,
    borderWidth: 1.5,
    borderColor: Colors.border,
    ...Shadow.sm,
    overflow: 'hidden',
  },
  bookingCardInstant: {
    borderColor: `${Colors.accent}44`,
    backgroundColor: '#F7FFFE',
  },
  bookingIconBox: {
    width: 48,
    height: 48,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  bookingEmoji: { fontSize: 22 },
  bookingCardTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 3,
  },
  bookingCardSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  timePill: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: Colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  timePillText: {
    fontFamily: FontFamily.semibold,
    fontSize: 10,
    color: Colors.white,
  },

  // Services Grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  serviceCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  serviceImgBox: {
    width: '100%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ratingBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(255,255,255,0.88)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  ratingText: {
    fontFamily: FontFamily.semibold,
    fontSize: 9,
    color: Colors.text,
  },
  serviceEmoji: { fontSize: 32 },
  addBtn: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: Radius.md,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  addBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: 16,
    color: Colors.primary,
    lineHeight: 20,
    marginTop: -1,
  },
  serviceName: {
    fontFamily: FontFamily.semibold,
    fontSize: 11,
    color: Colors.text,
    paddingHorizontal: 8,
    paddingTop: 8,
    lineHeight: 16,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingBottom: 10,
    paddingTop: 3,
  },
  servicePrice: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  serviceMrp: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textDecorationLine: 'line-through',
  },

  // Trust Strip
  trustCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  trustTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 18,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  trustItem: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  trustIcon: { fontSize: 24 },
  trustLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 16,
  },
  trustDivider: {
    width: 1,
    height: 40,
    backgroundColor: Colors.border,
  },
});
