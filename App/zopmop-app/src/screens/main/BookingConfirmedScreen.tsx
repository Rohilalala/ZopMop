// BookingConfirmedScreen — design-system port of `preview/booking-confirmation.html`.
//
// Two variants determined from route.params.instant (or fallback: presence of
// `slot` ⇒ scheduled, absence ⇒ instant):
//   • Instant — green check + "You're all set!" + helper "On the way" mini-card
//   • Scheduled — same hero pattern with blue scheduled flag + "Matching tomorrow
//     morning" pro placeholder + "What's next" action list
//
// Animations (60fps via Reanimated shared values):
//   • Check orb spring-pop (scale 0.4 → 1.08 → 1, ~700ms)
//   • Pulsing ring expanding outward (.6→1.5 / opacity 0→1→0)
//   • Continuous slow rotation on the dashed outer ring
//   • Confetti — 9 colored dots falling from top with stagger
//   • Loading dots (scheduled "matching" state)

import React, { useEffect, useMemo, useState } from 'react';
import {
  BackHandler,
  Dimensions,
  Image,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { SuccessBackdrop } from '../../components/SuccessBackdrop';

import type { MainStackParamList } from '../../types/navigation';
import { GlassCard } from '../../components/home/GlassCard';
import { ServiceThumb } from '../../components/home/ServiceThumb';
import { serviceIcon } from '../../components/home/serviceIcon';
import { SuccessTick, Confetti } from '../../components/SuccessTick';
import { PressFx } from '../../components/ui/PressFx';
import ZopLookingUp from '../../../assets/zop/zop-looking-up.svg';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useC } from '../../theme/screen';
import { getMatchStatus } from '../../api/matching';
import { haptics } from '../../utils/haptics';
import { showInfo } from '../../utils/toast';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMono:  TextStyle = { fontFamily: 'PlusJakartaSans_500Medium', letterSpacing: 0.4 };

const H_PAD = 20;

// ── Screen ──────────────────────────────────────────────────────────────────

export default function BookingConfirmedScreen() {
  const { isDark } = useTheme();
  const c = useC();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'BookingConfirmed'>>();
  const insets = useSafeAreaInsets();

  const params = route.params || ({} as MainStackParamList['BookingConfirmed']);
  const {
    bookingId, totalCents, slot, addressLine,
    serviceId, serviceName, durationMinutes,
    helperName, helperPhone, helperRating,
    paymentLabel, discountCents, promoCode, etaMinutes,
  } = params;

  const isInstant = params.bookingType === 'instant';
  const isScheduled = !isInstant;

  const shortId = `ZM-${(bookingId ?? '').replace(/-/g, '').slice(0, 4).toUpperCase()}`;
  const totalRupees = `₹${(totalCents / 100).toFixed(0)}`;

  useEffect(() => {
    haptics.medium();
  }, []);

  // Live booking lifecycle for instant bookings — drives the dynamic hero title.
  // Stages: 'on_the_way' (default) → 'at_door' (pro tapped "I've Arrived")
  // → 'in_progress' (job started) → 'completed' (job done).
  const { token } = useAuth();
  type LiveStage = 'on_the_way' | 'at_door' | 'in_progress' | 'completed' | 'cancelled';
  const [liveStage, setLiveStage] = useState<LiveStage>('on_the_way');
  const [livePhone, setLivePhone] = useState<string | undefined>(helperPhone);
  const [liveHelperName, setLiveHelperName] = useState<string | undefined>(helperName);
  const [livePhotoUrl, setLivePhotoUrl] = useState<string | undefined>(undefined);
  const [liveRating, setLiveRating] = useState<number | undefined>(helperRating);
  const [liveTotalJobs, setLiveTotalJobs] = useState<number | undefined>(undefined);

  // Fire success haptic exactly once when the booking transitions to completed.
  useEffect(() => {
    if (liveStage === 'completed') haptics.success();
  }, [liveStage]);

  // Android hardware back: exit to home root, not back into the booking flow.
  // Prevents stack restore from re-mounting this screen and re-firing confetti.
  useFocusEffect(
    React.useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        navigation.popToTop();
        return true;
      });
      return () => sub.remove();
    }, [navigation])
  );

  useFocusEffect(
    React.useCallback(() => {
      if (!isInstant || !bookingId || !token || token === '__guest__') return;
      let alive = true;

      const tick = async () => {
        try {
          const ms = await getMatchStatus(token, bookingId);
          if (!alive) return;
          if (ms.helper?.phone) setLivePhone(ms.helper.phone);
          if (ms.helper?.name) setLiveHelperName(ms.helper.name);
          if (ms.helper?.photo_url) setLivePhotoUrl(ms.helper.photo_url);
          if (typeof ms.helper?.rating === 'number') setLiveRating(ms.helper.rating);
          if (typeof ms.helper?.total_jobs === 'number') setLiveTotalJobs(ms.helper.total_jobs);

          const bs = ms.booking_status;
          if (bs === 'completed') { setLiveStage('completed'); return; }
          if (bs === 'cancelled') { setLiveStage('cancelled'); return; }
          if (bs === 'in_progress') { setLiveStage('in_progress'); return; }

          // Helper assigned but job not started — at-door iff pro tapped Arrived.
          setLiveStage(ms.arrived ? 'at_door' : 'on_the_way');
        } catch { /* keep last known */ }
      };

      tick();
      // 1.5 s cadence so the hero title flips to "Pro's at your door" almost
      // immediately after the pro taps "I've Arrived".
      const id = setInterval(tick, 1500);
      return () => { alive = false; clearInterval(id); };
    }, [isInstant, bookingId, token])
  );

  const heroTitle = useMemo(() => {
    if (!isInstant) return 'Scheduled.';
    switch (liveStage) {
      case 'at_door':     return "Pro's at your door";
      case 'in_progress': return 'Service underway';
      case 'completed':   return 'All done — sparkling!';
      case 'cancelled':   return 'Booking cancelled';
      default:            return "You're all set!";
    }
  }, [isInstant, liveStage]);

  // ASAP arrival promise — "arriving by <HH:MM>" where HH:MM = now + the
  // backend's promise_eta_minutes (winning pro's walking ETA + pad, spec §6),
  // rendered as an IST clock time. Computed once on mount: etaMinutes is the
  // promise captured at booking time, not a live-decrementing countdown.
  const arrivalBy = useMemo(() => {
    if (!isInstant || typeof etaMinutes !== 'number' || etaMinutes <= 0) return undefined;
    const at = new Date(Date.now() + etaMinutes * 60_000);
    return at.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [isInstant, etaMinutes]);

  const heroSub = useMemo(() => {
    if (!isInstant) return "We'll match you with a top pro the morning of your booking.";
    switch (liveStage) {
      case 'at_door':     return `${(liveHelperName ?? 'Your pro').split(' ')[0]} is right outside. Share the OTP to begin.`;
      case 'in_progress': return 'Sit back — your pro is hard at work.';
      case 'completed':   return 'Cleaning wrapped up. Rate your pro to let us know how it went.';
      case 'cancelled':   return 'This booking was cancelled.';
      default:
        if (arrivalBy) {
          return `${(liveHelperName ?? 'Your pro').split(' ')[0]} is on the way — arriving by ${arrivalBy}.`;
        }
        return "Pro is on the way. We'll keep you posted at every step.";
    }
  }, [isInstant, liveStage, liveHelperName, arrivalBy]);

  const onDone     = () => navigation.popToTop();
  const onTrack    = () =>
    navigation.replace('TrackLive', {
      bookingId: bookingId ?? '',
      serviceName,
      helperName: liveHelperName,
      helperPhone: livePhone,
      helperRating,
    });
  const onAddSvc   = () => navigation.navigate('Tabs', { screen: 'AllServices' });

  const onCallPro = () => {
    if (!livePhone) return;
    Linking.openURL(`tel:${livePhone.replace(/\s+/g, '')}`).catch(() => {});
  };
  const onMessage = () => {
    if (!bookingId) return;
    navigation.navigate('Chat', { bookingId, helperName: liveHelperName });
  };
  const onReschedule = () => { /* scheduled flow only — no-op for instant */ };

  return (
    <View style={[styles.safe, { backgroundColor: c.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <SuccessBackdrop isDark={isDark} />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingBottom: 140 + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Confetti />

        <Hero
          title={heroTitle}
          sub={heroSub}
          shortId={shortId}
          isDark={isDark}
        />

        {isInstant && liveHelperName && (
          <ProProfileCard
            name={liveHelperName}
            photoUrl={livePhotoUrl}
            rating={liveRating}
            totalJobs={liveTotalJobs}
            isDark={isDark}
          />
        )}

        <Ticket
          serviceName={serviceName ?? 'Service'}
          serviceId={serviceId}
          durationMinutes={durationMinutes ?? 30}
          totalRupees={totalRupees}
          isScheduled={isScheduled}
          slot={slot}
          addressLine={addressLine}
          paymentLabel={paymentLabel}
          discountCents={discountCents}
          promoCode={promoCode}
          helperName={liveHelperName ?? helperName}
          helperRating={liveRating ?? helperRating}
          etaMinutes={etaMinutes}
          isDark={isDark}
        />

        {isInstant ? (
          <InstantActions
            canCall={!!livePhone}
            onCall={onCallPro}
            onMessage={onMessage}
            onReschedule={onReschedule}
            isDark={isDark}
          />
        ) : (
          <ScheduledActions isDark={isDark} />
        )}

        {/* ReferNudge (Refer & earn ₹100) hidden until referral program ships
            end-to-end (P12 / S14, S15). Re-enable when /me/referrals exists. */}
        {!isInstant && <WhatsNext isDark={isDark} />}
      </ScrollView>

      <BottomDock
        primaryLabel={
          isInstant
            ? (liveStage === 'completed' || liveStage === 'cancelled' ? 'Done' : 'Track live')
            : 'Done'
        }
        secondaryLabel={isInstant ? 'Home' : 'Add another service'}
        onPrimary={
          isInstant
            ? (liveStage === 'completed' || liveStage === 'cancelled' ? onDone : onTrack)
            : onDone
        }
        onSecondary={isInstant ? onDone : onAddSvc}
        isDark={isDark}
      />
    </View>
  );
}

// Backdrop (green + amber radials) extracted to components/SuccessBackdrop —
// shared with TrackLive's service-complete state so both success surfaces match.

// ── Hero — check orb + title + sub + booking id pill ────────────────────────

function Hero({
  title,
  sub,
  shortId,
  isDark,
}: { title: string; sub: string; shortId: string; isDark: boolean }) {
  const idBg = isDark ? 'rgba(245,163,0,0.14)' : 'rgba(245,163,0,0.18)';
  const idColor = isDark ? '#F5A300' : '#B96E00';
  const idBorder = isDark ? 'rgba(245,163,0,0.3)' : 'rgba(245,163,0,0.35)';
  return (
    <View style={styles.hero}>
      <SuccessTick style={{ marginBottom: 12 }} />
      <Text style={[fontExtra, styles.heroTitle, { color: isDark ? '#FFFFFF' : '#0D0D0F' }]}>{title}</Text>
      <Text style={[fontMed, styles.heroSub, { color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(13,13,15,0.55)' }]}>{sub}</Text>
      <View style={[styles.idPill, { backgroundColor: idBg, borderColor: idBorder }]}>
        <Feather name="hash" size={11} color={idColor} />
        <Text style={[fontMono, { color: idColor, fontSize: 12, fontWeight: '700' }]}>
          Booking #{shortId}
        </Text>
      </View>
    </View>
  );
}

// ── Pro profile card — assigned pro photo, rating, jobs ────────────────────

function ProProfileCard({
  name,
  photoUrl,
  rating,
  totalJobs,
  isDark,
}: {
  name: string;
  photoUrl?: string;
  rating?: number;
  totalJobs?: number;
  isDark: boolean;
}) {
  const initial = (name || 'P')[0].toUpperCase();
  const ratingValue = typeof rating === 'number' ? rating : undefined;
  const cardBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(13,13,15,0.03)';
  const cardBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.06)';
  const textPrimary = isDark ? '#FFFFFF' : '#0D0D0F';
  const textMuted = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(13,13,15,0.55)';
  const starEmpty = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.20)';
  return (
    <View style={[styles.proCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
      <View style={styles.proCardAvWrap}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.proCardAv} />
        ) : (
          <View style={[styles.proCardAv, styles.proCardAvFallback]}>
            <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 22 }]}>{initial}</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[fontBold, styles.proCardName, { color: textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.proCardStars}>
          <StarRow rating={ratingValue ?? 0} starEmpty={starEmpty} />
          {ratingValue !== undefined && (
            <Text style={[fontSemi, styles.proCardRatingText]}>
              {ratingValue.toFixed(1)}
            </Text>
          )}
        </View>
        <Text style={[fontMed, styles.proCardJobs, { color: textMuted }]}>
          {typeof totalJobs === 'number' ? `${totalJobs} jobs completed` : 'New pro'}
        </Text>
      </View>
    </View>
  );
}

function StarRow({ rating, starEmpty }: { rating: number; starEmpty: string }) {
  const stars = [0, 1, 2, 3, 4];
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {stars.map((i) => {
        const filled = rating >= i + 1;
        const half = !filled && rating > i + 0.25 && rating < i + 1;
        return (
          <Feather
            key={i}
            name="star"
            size={12}
            color={filled || half ? '#F5A300' : starEmpty}
          />
        );
      })}
    </View>
  );
}

// ── Ticket — service + meta + perforation + detail rows + pro mini ──────────

type TicketProps = {
  serviceName: string;
  serviceId?: string;
  durationMinutes: number;
  totalRupees: string;
  isScheduled: boolean;
  slot?: string;
  addressLine?: string;
  paymentLabel?: string;
  discountCents?: number;
  promoCode?: string;
  helperName?: string;
  helperRating?: number;
  etaMinutes?: number;
  isDark: boolean;
};

function Ticket(props: TicketProps) {
  const {
    serviceName, serviceId, durationMinutes, totalRupees, isScheduled,
    slot, addressLine, paymentLabel, discountCents, promoCode,
    helperName, helperRating, etaMinutes, isDark,
  } = props;
  const iconSrc = serviceIcon({ id: serviceId, name: serviceName });
  const textPrimary = isDark ? '#FFFFFF' : '#0D0D0F';
  const textMuted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.55)';

  return (
    <GlassCard
      radius={22}
      hero
      style={{ marginHorizontal: H_PAD, marginTop: 24, overflow: 'hidden' }}
    >
      {/* TOP — service header */}
      <View style={styles.tkTop}>
        <View style={styles.tkSvcIcon}>
          <ServiceThumb height={56} radius={14} />
          {iconSrc && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Image
                source={iconSrc}
                resizeMode="contain"
                style={{ width: 44, height: 44 }}
              />
            </View>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {isScheduled && <ScheduledFlag isDark={isDark} />}
          <Text style={[fontBold, styles.tkSvcName, { color: textPrimary }]} numberOfLines={2}>
            {serviceName}
          </Text>
          <Text style={[fontMed, styles.tkSvcMeta, { color: textMuted }]}>
            {durationMinutes} min{slot ? '' : ' · 1 service'}
          </Text>
        </View>
        <View style={styles.pricePill}>
          <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 13 }]}>{totalRupees}</Text>
        </View>
      </View>

      {/* Perforation */}
      <Perforation isDark={isDark} />

      {/* Detail grid */}
      <View style={styles.tkBody}>
        {isScheduled ? (
          <ScheduledDetails
            slot={slot}
            addressLine={addressLine}
            paymentLabel={paymentLabel}
            discountCents={discountCents}
            promoCode={promoCode}
            isDark={isDark}
          />
        ) : (
          <InstantDetails
            slot={slot}
            addressLine={addressLine}
            paymentLabel={paymentLabel}
            discountCents={discountCents}
            promoCode={promoCode}
            etaMinutes={etaMinutes}
            isDark={isDark}
          />
        )}
      </View>

      {/* Pro mini-card */}
      <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
        <ProMini
          isScheduled={isScheduled}
          helperName={helperName}
          helperRating={helperRating}
          isDark={isDark}
        />
      </View>
    </GlassCard>
  );
}

function ScheduledFlag({ isDark }: { isDark: boolean }) {
  const flagBg = isDark ? 'rgba(96,165,250,0.18)' : 'rgba(59,130,246,0.18)';
  const flagColor = isDark ? '#60A5FA' : '#1D4ED8';
  return (
    <View style={[styles.scheduledFlag, { backgroundColor: flagBg }]}>
      <View
        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: flagColor }}
      />
      <Text
        style={[
          fontExtra,
          {
            fontSize: 10,
            color: flagColor,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
          },
        ]}
      >
        Scheduled
      </Text>
    </View>
  );
}

function Perforation({ isDark }: { isDark: boolean }) {
  const notchBg = isDark ? '#0A0A0A' : '#F4EFE7';
  const notchBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.05)';
  const dashColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(13,13,15,0.12)';
  return (
    <View style={styles.perfWrap}>
      <View style={[styles.perfNotch, { left: -12, backgroundColor: notchBg, borderColor: notchBorder }]} />
      <View style={[styles.perfDashes, { borderTopColor: dashColor }]} />
      <View style={[styles.perfNotch, { right: -12, backgroundColor: notchBg, borderColor: notchBorder }]} />
    </View>
  );
}

// ── Detail rows ─────────────────────────────────────────────────────────────

type DetailsProps = {
  slot?: string;
  addressLine?: string;
  paymentLabel?: string;
  discountCents?: number;
  promoCode?: string;
  isDark: boolean;
};

function InstantDetails({ slot, addressLine, paymentLabel, discountCents, promoCode, etaMinutes, isDark }: DetailsProps & { etaMinutes?: number }) {
  const savedLine =
    discountCents && discountCents > 0
      ? `₹${Math.round(discountCents / 100)} saved${promoCode ? ` with ${promoCode}` : ''}`
      : undefined;
  // ETA is supplied by the matching API on the BookingConfirmed nav params
  // (set by the booking/matching flow). Until it's there, surface a neutral
  // tracking state instead of fabricating "In ~6 min".
  const whenValue =
    typeof etaMinutes === 'number' && etaMinutes > 0
      ? `In ~${etaMinutes} min`
      : 'Tracking ETA…';
  return (
    <>
      <DetRow icon="clock" label="When" value={whenValue} sub={slot ?? 'Today'} isDark={isDark} />
      <DetRow
        icon="map-pin"
        label="Where"
        value={addressLine ? addressLine.split(',')[0] || 'Home' : 'Home'}
        sub={addressLine?.split(',').slice(1).join(',').trim()}
        isDark={isDark}
      />
      <DetRow icon="credit-card" label="Payment" value={paymentLabel ?? 'Paid'} sub={savedLine} full isDark={isDark} />
    </>
  );
}

function ScheduledDetails({ slot, addressLine, paymentLabel, discountCents, promoCode, isDark }: DetailsProps) {
  const savedLine =
    discountCents && discountCents > 0
      ? `₹${Math.round(discountCents / 100)} saved${promoCode ? ` with ${promoCode}` : ''}`
      : undefined;

  let dateLine = 'Scheduled';
  let timeLine = '';
  if (slot) {
    const d = new Date(slot);
    if (!isNaN(d.getTime())) {
      dateLine = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
      timeLine = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else {
      dateLine = slot;
    }
  }

  const tomorrow = new Date(Date.now() + 86400000);
  const isTomorrow = slot && new Date(slot).toDateString() === tomorrow.toDateString();

  return (
    <>
      <DetRow icon="calendar" label="Date" value={dateLine} sub={isTomorrow ? 'Tomorrow' : undefined} isDark={isDark} />
      <DetRow icon="clock" label="Time" value={timeLine || '—'} sub="2-hr arrival window" isDark={isDark} />
      <DetRow
        icon="map-pin"
        label="Address"
        value={addressLine ? addressLine.split(',')[0] || 'Home' : 'Home'}
        sub={addressLine?.split(',').slice(1).join(',').trim()}
        full
        isDark={isDark}
      />
      <DetRow icon="credit-card" label="Payment" value={paymentLabel ?? 'Paid'} sub={savedLine} full isDark={isDark} />
    </>
  );
}

function DetRow({
  icon,
  label,
  value,
  sub,
  full,
  isDark,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
  sub?: string;
  full?: boolean;
  isDark: boolean;
}) {
  const lblColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(13,13,15,0.45)';
  const valColor = isDark ? '#FFFFFF' : '#0D0D0F';
  const subColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(13,13,15,0.5)';
  return (
    <View style={[styles.detRow, full && { width: '100%' }]}>
      <View style={styles.detLbl}>
        <Feather name={icon} size={11} color={lblColor} />
        <Text
          style={[
            fontBold,
            { fontSize: 10, color: lblColor, letterSpacing: 1, textTransform: 'uppercase' },
          ]}
        >
          {label}
        </Text>
      </View>
      <Text style={[fontBold, styles.detVal, { color: valColor }]} numberOfLines={2}>{value}</Text>
      {sub && (
        <Text style={[fontMed, styles.detSub, { color: subColor }]} numberOfLines={2}>
          {sub}
        </Text>
      )}
    </View>
  );
}

// ── Pro mini ────────────────────────────────────────────────────────────────

function ProMini({
  isScheduled,
  helperName,
  helperRating,
  isDark,
}: {
  isScheduled: boolean;
  helperName?: string;
  helperRating?: number;
  isDark: boolean;
}) {
  const miniBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(13,13,15,0.03)';
  const miniBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.05)';
  const textPrimary = isDark ? '#FFFFFF' : '#0D0D0F';
  const textMuted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.55)';

  if (isScheduled) {
    // TODO(backend): derive copy from booking.scheduled_at (e.g. "Matching
    // Sat morning"). For now we keep the static "tomorrow" line to match
    // the design preview; it will read incorrectly for far-out schedules.
    return (
      <View style={[styles.proMini, { backgroundColor: miniBg, borderColor: miniBorder }]}>
        <View style={[styles.proAv, { backgroundColor: '#64748B', borderColor: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.8)' }]}>
          <Feather name="user" size={16} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[fontBold, { color: textPrimary, fontSize: 13, letterSpacing: -0.13 }]}>
            Matching tomorrow morning
          </Text>
          <Text
            style={[fontMed, { color: textMuted, fontSize: 11, marginTop: 2 }]}
          >
            You'll meet your pro 30 min before
          </Text>
        </View>
        <LoadingDots />
      </View>
    );
  }

  const initial = (helperName ?? 'P')[0].toUpperCase();
  return (
    <View style={[styles.proMini, { backgroundColor: miniBg, borderColor: miniBorder }]}>
      <View style={styles.proAv}>
        <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 14 }]}>{initial}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[fontBold, { color: textPrimary, fontSize: 13, letterSpacing: -0.13 }]}>
          {helperName ?? 'Your pro'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 4 }}>
          {typeof helperRating === 'number' ? (
            <>
              <Feather name="star" size={11} color="#F5A300" />
              <Text style={[fontMed, { color: textMuted, fontSize: 11 }]}>
                {helperRating.toFixed(1)} · Verified
              </Text>
            </>
          ) : (
            <Text style={[fontMed, { color: textMuted, fontSize: 11 }]}>
              Verified
            </Text>
          )}
        </View>
      </View>
      <Text style={[fontSemi, { color: '#F5A300', fontSize: 11 }]}>On the way</Text>
    </View>
  );
}

function LoadingDots() {
  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      <Dot delay={0} />
      <Dot delay={200} />
      <Dot delay={400} />
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const op = useSharedValue(0.3);
  useEffect(() => {
    op.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1,   { duration: 500, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.3, { duration: 500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      ),
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.View
      style={[
        style,
        { width: 6, height: 6, borderRadius: 3, backgroundColor: '#F5A300' },
      ]}
    />
  );
}

// ── Action grids ────────────────────────────────────────────────────────────

function InstantActions({
  canCall,
  onCall,
  onMessage,
  onReschedule,
  isDark,
}: {
  canCall: boolean;
  onCall: () => void;
  onMessage: () => void;
  onReschedule: () => void;
  isDark: boolean;
}) {
  return (
    <View style={styles.actGrid}>
      <ActChip icon="phone"          label="Call pro"    onPress={onCall} disabled={!canCall} isDark={isDark} />
      <ActChip icon="message-square" label="Message"     onPress={onMessage} isDark={isDark} />
      <ActChip icon="clock"          label="Reschedule"  onPress={onReschedule} disabled isDark={isDark} />
    </View>
  );
}

function ScheduledActions({ isDark }: { isDark: boolean }) {
  const onCalendar = () => showInfo('Coming soon', { title: 'Calendar' });
  const onReschedule = () => showInfo('Coming soon', { title: 'Reschedule' });
  const onEditAddress = () => showInfo('Coming soon', { title: 'Edit address' });
  const onCancel = () => showInfo('Coming soon', { title: 'Cancel booking' });
  return (
    <View style={styles.actGrid}>
      <ActChip icon="calendar"  label="Calendar"     onPress={onCalendar}    isDark={isDark} />
      <ActChip icon="clock"     label="Reschedule"   onPress={onReschedule}  isDark={isDark} />
      <ActChip icon="map-pin"   label="Edit address" onPress={onEditAddress} isDark={isDark} />
      <ActChip icon="x"         label="Cancel"       onPress={onCancel}      danger isDark={isDark} />
    </View>
  );
}

function ActChip({
  icon,
  label,
  danger,
  onPress,
  disabled,
  isDark,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  danger?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  isDark: boolean;
}) {
  const chipBg = isDark ? 'rgba(255,255,255,0.05)' : '#FFFFFF';
  const chipBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.05)';
  const chipText = isDark ? '#FFFFFF' : '#0D0D0F';
  const chipShadow = !isDark ? { shadowColor: 'rgba(13,13,15,1)', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 0, elevation: 1 } : {};
  return (
    <PressFx
      onPress={disabled ? undefined : onPress}
      style={[styles.actChip, { backgroundColor: chipBg, borderColor: chipBorder }, chipShadow, disabled && { opacity: 0.45 }]}
    >
      <View
        style={[
          styles.actIcon,
          danger && { backgroundColor: 'rgba(248,113,113,0.14)' },
        ]}
      >
        <Feather name={icon} size={18} color={danger ? '#F87171' : '#F5A300'} />
      </View>
      <Text style={[fontBold, styles.actLbl, { color: chipText }]}>{label}</Text>
    </PressFx>
  );
}


// ── Refer nudge (instant) ───────────────────────────────────────────────────

function ReferNudge() {
  return (
    <View style={styles.refer}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: -30, top: -30,
          width: 140, height: 140,
          borderRadius: 70,
          backgroundColor: 'rgba(255,255,255,0.16)',
        }}
      />
      <ZopLookingUp width={54} height={54} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 14, letterSpacing: -0.21 }]}>
          Refer & earn ₹100
        </Text>
        <Text style={[fontSemi, { color: 'rgba(13,13,15,0.7)', fontSize: 11.5, marginTop: 3 }]}>
          For every friend who books
        </Text>
      </View>
      <PressFx style={styles.referCta}>
        <Text style={[fontExtra, { color: '#FFC042', fontSize: 11 }]}>Invite</Text>
      </PressFx>
    </View>
  );
}

// ── What's next (scheduled) ─────────────────────────────────────────────────

function WhatsNext({ isDark }: { isDark: boolean }) {
  const textPrimary = isDark ? '#FFFFFF' : '#0D0D0F';
  const textMuted = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(13,13,15,0.5)';
  const headColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(13,13,15,0.45)';
  const dividerColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.06)';
  const chevronColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(13,13,15,0.4)';

  const items: { icon: React.ComponentProps<typeof Feather>['name']; title: string; sub: string }[] = [
    { icon: 'calendar',  title: 'Add to calendar',       sub: 'Apple, Google, or Outlook' },
    { icon: 'bell',      title: 'Set reminder',           sub: '30 min before pro arrives' },
    { icon: 'edit-3',    title: 'Add a note for the pro', sub: 'Pet at home, parking, gate code…' },
  ];

  const onItemPress = (title: string) => showInfo('Coming soon', { title });

  return (
    <View style={{ marginHorizontal: H_PAD, marginTop: 22 }}>
      <Text style={[fontBold, styles.nextH, { color: headColor }]}>What's next</Text>
      <GlassCard radius={16} style={{ overflow: 'hidden' }}>
        {items.map((it, i) => (
          <PressFx key={it.title} onPress={() => onItemPress(it.title)} style={styles.nxItem}>
            <View style={styles.nxIcon}>
              <Feather name={it.icon} size={16} color="#F5A300" />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[fontBold, { color: textPrimary, fontSize: 13, letterSpacing: -0.07 }]}>
                {it.title}
              </Text>
              <Text style={[fontMed, { color: textMuted, fontSize: 11, marginTop: 2 }]}>
                {it.sub}
              </Text>
            </View>
            <Feather name="chevron-right" size={14} color={chevronColor} />
            {i < items.length - 1 && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute', left: 54, right: 14, bottom: 0,
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: dividerColor,
                }}
              />
            )}
          </PressFx>
        ))}
      </GlassCard>
    </View>
  );
}

// ── Bottom dock ─────────────────────────────────────────────────────────────

function BottomDock({
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  isDark,
}: {
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
  isDark: boolean;
}) {
  const insets = useSafeAreaInsets();
  const dockBg = isDark ? 'rgba(10,10,10,0.92)' : 'rgba(255,255,255,0.85)';
  const dockBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.06)';
  const ghostBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.04)';
  const ghostBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.06)';
  const ghostText = isDark ? '#FFFFFF' : '#0D0D0F';
  return (
    <View
      style={[
        styles.dock,
        { paddingBottom: insets.bottom + 16, backgroundColor: dockBg, borderTopColor: dockBorder },
      ]}
    >
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <PressFx onPress={onSecondary} style={[styles.dockBtn, styles.dockGhost, { backgroundColor: ghostBg, borderColor: ghostBorder }]}>
          <Text
            style={[fontBold, { color: ghostText, fontSize: 14, letterSpacing: -0.14 }]}
            numberOfLines={1}
          >
            {secondaryLabel}
          </Text>
        </PressFx>
        <PressFx onPress={onPrimary} style={[styles.dockBtn, styles.dockPrimary]}>
          <Text
            style={[fontExtra, { color: '#0D0D0F', fontSize: 14, letterSpacing: -0.14 }]}
            numberOfLines={1}
          >
            {primaryLabel}
          </Text>
          <Feather name="chevron-right" size={14} color="#0D0D0F" />
        </PressFx>
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // Hero
  hero: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: 30,
    letterSpacing: -1.05,
    lineHeight: 32,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 20,
    maxWidth: 320,
  },
  idPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    marginTop: 14,
    borderWidth: 0.5,
  },

  // Pro profile card (between hero and ticket)
  proCard: {
    marginHorizontal: H_PAD,
    marginTop: 18,
    padding: 14,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 0.5,
  },
  proCardAvWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(245,163,0,0.6)',
  },
  proCardAv: {
    width: '100%',
    height: '100%',
    borderRadius: 28,
  },
  proCardAvFallback: {
    backgroundColor: '#F5A300',
    alignItems: 'center',
    justifyContent: 'center',
  },
  proCardName: {
    fontSize: 15,
    letterSpacing: -0.2,
  },
  proCardStars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  proCardRatingText: {
    color: '#F5A300',
    fontSize: 12,
  },
  proCardJobs: {
    fontSize: 11.5,
    marginTop: 3,
  },

  // Ticket
  tkTop: {
    padding: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  tkSvcIcon: {
    width: 56, height: 56, borderRadius: 14,
    overflow: 'hidden', position: 'relative',
  },
  tkSvcName: {
    fontSize: 17,
    letterSpacing: -0.34,
    lineHeight: 20,
  },
  tkSvcMeta: {
    fontSize: 12,
    marginTop: 4,
  },
  pricePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 99,
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  scheduledFlag: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 99,
    marginBottom: 6,
  },

  // Perforation
  perfWrap: {
    height: 24,
    marginHorizontal: -1,
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  perfNotch: {
    position: 'absolute',
    top: 0,
    width: 24, height: 24,
    borderRadius: 12,
    borderWidth: 0.5,
  },
  perfDashes: {
    flex: 1,
    marginHorizontal: 14,
    borderTopWidth: 1.5,
    borderStyle: 'dashed',
  },

  // Body details grid
  tkBody: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  detRow: {
    width: '46%',
    flexDirection: 'column',
    gap: 3,
  },
  detLbl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  detVal: {
    fontSize: 13.5,
    letterSpacing: -0.13,
    lineHeight: 17,
  },
  detSub: {
    fontSize: 11,
    marginTop: 1,
  },

  // Pro mini
  proMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 0.5,
  },
  proAv: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },

  // Action grid
  actGrid: {
    marginHorizontal: H_PAD,
    marginTop: 18,
    flexDirection: 'row',
    gap: 8,
  },
  actChip: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderRadius: 14,
    alignItems: 'center',
    gap: 8,
    borderWidth: 0.5,
  },
  actIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.16)',
  },
  actLbl: {
    fontSize: 10.5,
    textAlign: 'center',
    lineHeight: 13,
  },

  // Refer
  refer: {
    marginHorizontal: H_PAD,
    marginTop: 22,
    padding: 16,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5A300',
    overflow: 'hidden',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.3,
    shadowRadius: 32,
    elevation: 8,
  },
  referCta: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 99,
    backgroundColor: '#0D0D0F',
  },

  // What's next
  nextH: {
    fontSize: 11,
    letterSpacing: 1.32,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  nxItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    paddingHorizontal: 14,
    position: 'relative',
  },
  nxIcon: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.14)',
  },

  // Dock
  dock: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    borderTopWidth: 0.5,
    zIndex: 50,
  },
  dockBtn: {
    flex: 1,
    height: 54,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dockPrimary: {
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 8,
  },
  dockGhost: {
    borderWidth: 0.5,
  },
});
