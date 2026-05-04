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
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import type { MainStackParamList } from '../../types/navigation';
import { GlassCard } from '../../components/home/GlassCard';
import { ServiceThumb } from '../../components/home/ServiceThumb';
import { serviceIcon } from '../../components/home/serviceIcon';
import { PressFx } from '../../components/ui/PressFx';
import ZopLookingUp from '../../../assets/zop/zop-looking-up.svg';
import { useAuth } from '../../context/AuthContext';
import { getMatchStatus } from '../../api/matching';
import { haptics } from '../../utils/haptics';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMono:  TextStyle = { fontFamily: 'PlusJakartaSans_500Medium', letterSpacing: 0.4 };

const H_PAD = 20;

// ── Screen ──────────────────────────────────────────────────────────────────

export default function BookingConfirmedScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'BookingConfirmed'>>();
  const insets = useSafeAreaInsets();

  const params = route.params || ({} as MainStackParamList['BookingConfirmed']);
  const {
    bookingId, totalCents, slot, addressLine,
    serviceId, serviceName, durationMinutes,
    helperName, helperPhone, helperRating,
    paymentLabel, discountCents, promoCode,
  } = params;

  // Resolve variant: explicit `instant` overrides; else infer from `slot`.
  const isInstant = params.instant ?? !slot;
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

  const heroSub = useMemo(() => {
    if (!isInstant) return "We'll match you with a top pro the morning of your booking.";
    switch (liveStage) {
      case 'at_door':     return `${(liveHelperName ?? 'Your pro').split(' ')[0]} is right outside. Share the OTP to begin.`;
      case 'in_progress': return 'Sit back — your pro is hard at work.';
      case 'completed':   return 'Cleaning wrapped up. Rate your pro and add a tip if you loved it.';
      case 'cancelled':   return 'This booking was cancelled.';
      default:            return "Pro is on the way. We'll keep you posted at every step.";
    }
  }, [isInstant, liveStage, liveHelperName]);

  const onDone     = () => navigation.popToTop();
  const onTrack    = () =>
    navigation.replace('TrackLive', {
      bookingId: bookingId ?? '',
      serviceName,
      helperName: liveHelperName,
      helperPhone: livePhone,
      helperRating,
    });
  const onAddSvc   = () => navigation.navigate('AllServices', {});

  const onCallPro = () => {
    if (!livePhone) return;
    Linking.openURL(`tel:${livePhone.replace(/\s+/g, '')}`).catch(() => {});
  };
  const onMessage = () => {
    if (!bookingId) return;
    navigation.navigate('Chat', { bookingId, helperName: liveHelperName });
  };
  const onAddTip = () => {
    if (!bookingId) return;
    navigation.navigate('Tip', { bookingId, helperName: liveHelperName });
  };
  const onReschedule = () => { /* scheduled flow only — no-op for instant */ };

  return (
    <View style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <SuccessBackdrop />

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
        />

        {isInstant && liveHelperName && (
          <ProProfileCard
            name={liveHelperName}
            photoUrl={livePhotoUrl}
            rating={liveRating}
            totalJobs={liveTotalJobs}
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
          helperName={helperName}
          helperRating={helperRating}
        />

        {isInstant ? (
          <InstantActions
            canCall={!!livePhone}
            onCall={onCallPro}
            onMessage={onMessage}
            onTip={onAddTip}
            onReschedule={onReschedule}
          />
        ) : (
          <ScheduledActions />
        )}

        {isInstant ? (
          <ReferNudge />
        ) : (
          <WhatsNext />
        )}
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
      />
    </View>
  );
}

// ── Backdrop — green + amber radials matching design ────────────────────────

function SuccessBackdrop() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: SCREEN_H,
      }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${SCREEN_W} ${SCREEN_H}`}>
        <Defs>
          <RadialGradient
            id="green"
            cx={SCREEN_W / 2} cy={-SCREEN_H * 0.10}
            rx={SCREEN_W * 0.80} ry={SCREEN_H * 0.50}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#22C55E" stopOpacity="0.22" />
            <Stop offset="55%" stopColor="#22C55E" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient
            id="amber"
            cx={SCREEN_W * 1.0} cy={SCREEN_H * 0.30}
            rx={SCREEN_W * 0.70} ry={SCREEN_H * 0.50}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.18" />
            <Stop offset="55%" stopColor="#F5A300" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width={SCREEN_W} height={SCREEN_H} fill="#0A0A0A" />
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#green)" />
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#amber)" />
      </Svg>
    </View>
  );
}

// ── Confetti — 9 colored dots ───────────────────────────────────────────────

const CONFETTI: { x: number; y: number; w: number; h: number; bg: string; rot: number; round: boolean; delay: number }[] = [
  { x: 0.18, y: 0.14, w:  8, h:  8, bg: '#F5A300', rot:   0, round: false, delay: 200 },
  { x: 0.30, y: 0.08, w:  6, h:  6, bg: '#22C55E', rot:   0, round: true,  delay: 400 },
  { x: 0.62, y: 0.11, w:  7, h: 14, bg: '#60A5FA', rot:  20, round: false, delay: 500 },
  { x: 0.78, y: 0.18, w:  8, h:  8, bg: '#FFC042', rot:   0, round: true,  delay: 300 },
  { x: 0.48, y: 0.06, w:  6, h: 12, bg: '#F5A300', rot: -25, round: false, delay: 550 },
  { x: 0.84, y: 0.32, w:  6, h:  6, bg: '#22C55E', rot:   0, round: true,  delay: 700 },
  { x: 0.10, y: 0.34, w:  5, h:  5, bg: '#FFC042', rot:   0, round: true,  delay: 600 },
  { x: 0.90, y: 0.09, w:  6, h: 10, bg: '#F87171', rot:  15, round: false, delay: 450 },
  { x: 0.24, y: 0.30, w:  5, h:  9, bg: '#22C55E', rot: -15, round: false, delay: 800 },
];

function Confetti() {
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 400, zIndex: 3 }}
    >
      {CONFETTI.map((c, i) => (
        <ConfettiDot key={i} cfg={c} />
      ))}
    </View>
  );
}

function ConfettiDot({ cfg }: { cfg: typeof CONFETTI[number] }) {
  const fall = useSharedValue(0);
  useEffect(() => {
    fall.value = withDelay(
      cfg.delay,
      withTiming(1, { duration: 2400, easing: Easing.in(Easing.cubic) }),
    );
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: fall.value < 0.05 ? 0 : fall.value < 0.2 ? fall.value / 0.2 : 1 - fall.value,
    transform: [
      { translateY: -30 + fall.value * 250 },
      { rotate: `${cfg.rot + fall.value * 140}deg` },
    ],
  }));
  return (
    <Animated.View
      style={[
        style,
        {
          position: 'absolute',
          left: SCREEN_W * cfg.x,
          top: SCREEN_H * cfg.y,
          width: cfg.w,
          height: cfg.h,
          backgroundColor: cfg.bg,
          borderRadius: cfg.round ? cfg.w / 2 : 1.5,
        },
      ]}
    />
  );
}

// ── Hero — check orb + title + sub + booking id pill ────────────────────────

function Hero({
  title,
  sub,
  shortId,
}: { title: string; sub: string; shortId: string }) {
  return (
    <View style={styles.hero}>
      <CheckOrb />
      <Text style={[fontExtra, styles.heroTitle]}>{title}</Text>
      <Text style={[fontMed, styles.heroSub]}>{sub}</Text>
      <View style={styles.idPill}>
        <Feather name="hash" size={11} color="#F5A300" />
        <Text style={[fontMono, { color: '#F5A300', fontSize: 12, fontWeight: '700' }]}>
          Booking #{shortId}
        </Text>
      </View>
    </View>
  );
}

function CheckOrb() {
  // Layout matches design exactly:
  //   • Orb              108×108 (radius 54)
  //   • Solid pulse ring 132×132 (12px outside orb), 2px solid, animated
  //   • Dashed ring      152×152 (22px outside orb), 1.5px dashed, slow spin
  // Container: 152×152 with overflow visible so the pulse ring can expand
  // past it (scale 0.6 → 1.5).
  const ORB    = 108;
  const SOLID  = 132;
  const DASHED = 152;

  // Spring-pop: 0.4 → 1.08 → 1
  const scale   = useSharedValue(0.4);
  const opacity = useSharedValue(0);
  // Pulse ring: 0.6 → 1.5, opacity 0→1→0 over 1.4s
  const ringScale   = useSharedValue(0.6);
  const ringOpacity = useSharedValue(0);
  // Outer dashed ring: continuous slow spin 18s/360° linear
  const spin = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(
      150,
      withSequence(
        withTiming(1.08, { duration: 420, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 14, stiffness: 200 }),
      ),
    );
    opacity.value = withDelay(150, withTiming(1, { duration: 220 }));

    ringScale.value = withDelay(
      400,
      withTiming(1.5, { duration: 1400, easing: Easing.out(Easing.cubic) }),
    );
    ringOpacity.value = withDelay(
      400,
      withSequence(
        withTiming(1, { duration: 280 }),
        withTiming(0, { duration: 1120 }),
      ),
    );

    spin.value = withRepeat(
      withTiming(360, { duration: 18000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
    opacity: ringOpacity.value,
  }));
  const dashedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  return (
    <View
      style={{
        width: DASHED,
        height: DASHED,
        alignSelf: 'center',
        marginBottom: 12,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Outer dashed ring — 22px outside orb, 1.5px dashed, continuous spin.
          Uses SVG (not borderStyle:'dashed') so dashes tile evenly around the
          circumference — RN's CSS dashed border on circles produces an uneven
          seam where the ring closes. */}
      <Animated.View
        style={[
          dashedStyle,
          {
            position: 'absolute',
            width: DASHED,
            height: DASHED,
          },
        ]}
      >
        {(() => {
          const STROKE = 1.5;
          const r = (DASHED - STROKE) / 2;
          const C = 2 * Math.PI * r;
          // 50 dash+gap pairs tile exactly into circumference — matches design
          // density; tiles cleanly so there is no seam.
          const PAIRS = 50;
          const DASH = C / PAIRS / 2;
          return (
            <Svg width={DASHED} height={DASHED}>
              <Circle
                cx={DASHED / 2}
                cy={DASHED / 2}
                r={r}
                stroke="rgba(34,197,94,0.32)"
                strokeWidth={STROKE}
                strokeDasharray={[DASH, DASH]}
                strokeLinecap="butt"
                fill="none"
              />
            </Svg>
          );
        })()}
      </Animated.View>

      {/* Static solid ring — always visible inner halo (matches design). */}
      <View
        style={{
          position: 'absolute',
          width: SOLID,
          height: SOLID,
          borderRadius: SOLID / 2,
          borderWidth: 1.5,
          borderColor: 'rgba(34,197,94,0.45)',
        }}
      />

      {/* Solid pulse ring — one-shot expand+fade outward from the static ring. */}
      <Animated.View
        style={[
          ringStyle,
          {
            position: 'absolute',
            width: SOLID,
            height: SOLID,
            borderRadius: SOLID / 2,
            borderWidth: 2,
            borderColor: 'rgba(34,197,94,0.35)',
          },
        ]}
      />

      {/* Orb */}
      <Animated.View
        style={[
          orbStyle,
          {
            width: ORB,
            height: ORB,
            borderRadius: ORB / 2,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#22C55E',
            shadowOffset: { width: 0, height: 20 },
            shadowOpacity: 0.45,
            shadowRadius: 50,
            elevation: 14,
            overflow: 'hidden',
            borderWidth: 2,
            borderTopColor: 'rgba(255,255,255,0.45)',
            borderBottomColor: 'rgba(0,0,0,0.18)',
            borderLeftColor: 'rgba(255,255,255,0.18)',
            borderRightColor: 'rgba(255,255,255,0.18)',
          },
        ]}
      >
        {/* Orb fill — top→bottom green gradient for 3D ball look. */}
        <Svg
          width={ORB}
          height={ORB}
          style={{ position: 'absolute', top: 0, left: 0 }}
        >
          <Defs>
            <SvgLinearGradient id="orbGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#5BE08A" />
              <Stop offset="1" stopColor="#16A34A" />
            </SvgLinearGradient>
          </Defs>
          <Circle cx={ORB / 2} cy={ORB / 2} r={ORB / 2} fill="url(#orbGrad)" />
        </Svg>

        {/* Tick — custom SVG path with offset shadow path beneath for 3D feel. */}
        <Svg width={54} height={54} viewBox="0 0 24 24" fill="none">
          <Path
            d="M5 12.5l5 5 9-11"
            stroke="rgba(0,0,0,0.22)"
            strokeWidth={3.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            transform="translate(0,1.4)"
          />
          <Path
            d="M5 12.5l5 5 9-11"
            stroke="#FFFFFF"
            strokeWidth={3.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

// ── Pro profile card — assigned pro photo, rating, jobs ────────────────────

function ProProfileCard({
  name,
  photoUrl,
  rating,
  totalJobs,
}: {
  name: string;
  photoUrl?: string;
  rating?: number;
  totalJobs?: number;
}) {
  const initial = (name || 'P')[0].toUpperCase();
  const ratingValue = typeof rating === 'number' ? rating : undefined;
  return (
    <View style={styles.proCard}>
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
        <Text style={[fontBold, styles.proCardName]} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.proCardStars}>
          <StarRow rating={ratingValue ?? 0} />
          {ratingValue !== undefined && (
            <Text style={[fontSemi, styles.proCardRatingText]}>
              {ratingValue.toFixed(1)}
            </Text>
          )}
        </View>
        <Text style={[fontMed, styles.proCardJobs]}>
          {typeof totalJobs === 'number' ? `${totalJobs} jobs completed` : 'New pro'}
        </Text>
      </View>
    </View>
  );
}

function StarRow({ rating }: { rating: number }) {
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
            color={filled || half ? '#F5A300' : 'rgba(255,255,255,0.25)'}
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
};

function Ticket(props: TicketProps) {
  const {
    serviceName, serviceId, durationMinutes, totalRupees, isScheduled,
    slot, addressLine, paymentLabel, discountCents, promoCode,
    helperName, helperRating,
  } = props;
  const iconSrc = serviceIcon({ id: serviceId, name: serviceName });

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
          {isScheduled && <ScheduledFlag />}
          <Text style={[fontBold, styles.tkSvcName]} numberOfLines={2}>
            {serviceName}
          </Text>
          <Text style={[fontMed, styles.tkSvcMeta]}>
            {durationMinutes} min{slot ? '' : ' · 1 service'}
          </Text>
        </View>
        <View style={styles.pricePill}>
          <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 13 }]}>{totalRupees}</Text>
        </View>
      </View>

      {/* Perforation */}
      <Perforation />

      {/* Detail grid */}
      <View style={styles.tkBody}>
        {isScheduled ? (
          <ScheduledDetails
            slot={slot}
            addressLine={addressLine}
            paymentLabel={paymentLabel}
            discountCents={discountCents}
            promoCode={promoCode}
          />
        ) : (
          <InstantDetails
            slot={slot}
            addressLine={addressLine}
            paymentLabel={paymentLabel}
            discountCents={discountCents}
            promoCode={promoCode}
          />
        )}
      </View>

      {/* Pro mini-card */}
      <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
        <ProMini
          isScheduled={isScheduled}
          helperName={helperName}
          helperRating={helperRating}
        />
      </View>
    </GlassCard>
  );
}

function ScheduledFlag() {
  return (
    <View style={styles.scheduledFlag}>
      <View
        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#60A5FA' }}
      />
      <Text
        style={[
          fontExtra,
          {
            fontSize: 10,
            color: '#60A5FA',
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

function Perforation() {
  return (
    <View style={styles.perfWrap}>
      <View style={[styles.perfNotch, { left: -12 }]} />
      <View style={styles.perfDashes} />
      <View style={[styles.perfNotch, { right: -12 }]} />
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
};

function InstantDetails({ slot, addressLine, paymentLabel, discountCents, promoCode }: DetailsProps) {
  const savedLine =
    discountCents && discountCents > 0
      ? `₹${Math.round(discountCents / 100)} saved${promoCode ? ` with ${promoCode}` : ''}`
      : undefined;
  return (
    <>
      <DetRow
        icon="clock"
        label="When"
        value="In ~6 min"
        sub={slot ?? 'Today'}
      />
      <DetRow
        icon="map-pin"
        label="Where"
        value={addressLine ? addressLine.split(',')[0] || 'Home' : 'Home'}
        sub={addressLine?.split(',').slice(1).join(',').trim()}
      />
      <DetRow
        icon="credit-card"
        label="Payment"
        value={paymentLabel ?? 'Paid'}
        sub={savedLine}
        full
      />
    </>
  );
}

function ScheduledDetails({ slot, addressLine, paymentLabel, discountCents, promoCode }: DetailsProps) {
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
      <DetRow icon="calendar" label="Date" value={dateLine} sub={isTomorrow ? 'Tomorrow' : undefined} />
      <DetRow icon="clock"    label="Time" value={timeLine || '—'} sub="2-hr arrival window" />
      <DetRow
        icon="map-pin"
        label="Address"
        value={addressLine ? addressLine.split(',')[0] || 'Home' : 'Home'}
        sub={addressLine?.split(',').slice(1).join(',').trim()}
        full
      />
      <DetRow
        icon="credit-card"
        label="Payment"
        value={paymentLabel ?? 'Paid'}
        sub={savedLine}
        full
      />
    </>
  );
}

function DetRow({
  icon,
  label,
  value,
  sub,
  full,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
  sub?: string;
  full?: boolean;
}) {
  return (
    <View style={[styles.detRow, full && { width: '100%' }]}>
      <View style={styles.detLbl}>
        <Feather name={icon} size={11} color="rgba(255,255,255,0.45)" />
        <Text
          style={[
            fontBold,
            { fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: 1, textTransform: 'uppercase' },
          ]}
        >
          {label}
        </Text>
      </View>
      <Text style={[fontBold, styles.detVal]} numberOfLines={2}>{value}</Text>
      {sub && (
        <Text style={[fontMed, styles.detSub]} numberOfLines={2}>
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
}: {
  isScheduled: boolean;
  helperName?: string;
  helperRating?: number;
}) {
  if (isScheduled) {
    return (
      <View style={styles.proMini}>
        <View style={[styles.proAv, { backgroundColor: '#64748B' }]}>
          <Feather name="user" size={16} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[fontBold, { color: '#FFFFFF', fontSize: 13, letterSpacing: -0.13 }]}>
            Matching tomorrow morning
          </Text>
          <Text
            style={[fontMed, { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 }]}
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
    <View style={styles.proMini}>
      <View style={styles.proAv}>
        <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 14 }]}>{initial}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[fontBold, { color: '#FFFFFF', fontSize: 13, letterSpacing: -0.13 }]}>
          {helperName ?? 'Your pro'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 4 }}>
          <Feather name="star" size={11} color="#F5A300" />
          <Text style={[fontMed, { color: 'rgba(255,255,255,0.55)', fontSize: 11 }]}>
            {(helperRating ?? 4.9).toFixed(1)} · Verified
          </Text>
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
  onTip,
  onReschedule,
}: {
  canCall: boolean;
  onCall: () => void;
  onMessage: () => void;
  onTip: () => void;
  onReschedule: () => void;
}) {
  return (
    <View style={styles.actGrid}>
      <ActChip icon="phone"          label="Call pro"    onPress={onCall} disabled={!canCall} />
      <ActChip icon="message-square" label="Message"     onPress={onMessage} />
      <ActChip icon="award"          label="Add tip"     onPress={onTip} />
      <ActChip icon="clock"          label="Reschedule"  onPress={onReschedule} disabled />
    </View>
  );
}

function ScheduledActions() {
  return (
    <View style={styles.actGrid}>
      <ActChip icon="calendar"  label="Calendar" />
      <ActChip icon="clock"     label="Reschedule" />
      <ActChip icon="map-pin"   label="Edit address" />
      <ActChip icon="x"         label="Cancel" danger />
    </View>
  );
}

function ActChip({
  icon,
  label,
  danger,
  onPress,
  disabled,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  danger?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <PressFx
      onPress={disabled ? undefined : onPress}
      style={[styles.actChip, disabled && { opacity: 0.45 }]}
    >
      <View
        style={[
          styles.actIcon,
          danger && { backgroundColor: 'rgba(248,113,113,0.14)' },
        ]}
      >
        <Feather name={icon} size={18} color={danger ? '#F87171' : '#F5A300'} />
      </View>
      <Text style={[fontBold, styles.actLbl]}>{label}</Text>
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

function WhatsNext() {
  const items: { icon: React.ComponentProps<typeof Feather>['name']; title: string; sub: string }[] = [
    { icon: 'calendar',       title: 'Add to calendar',       sub: 'Apple, Google, or Outlook' },
    { icon: 'bell',           title: 'Set reminder',           sub: '30 min before pro arrives' },
    { icon: 'message-square', title: 'Add a note for the pro', sub: 'Pet at home, parking, gate code…' },
  ];
  return (
    <View style={{ marginHorizontal: H_PAD, marginTop: 22 }}>
      <Text style={[fontBold, styles.nextH]}>What's next</Text>
      <GlassCard radius={16} style={{ overflow: 'hidden' }}>
        {items.map((it, i) => (
          <PressFx key={it.title} style={styles.nxItem}>
            <View style={styles.nxIcon}>
              <Feather name={it.icon} size={16} color="#F5A300" />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[fontBold, { color: '#FFFFFF', fontSize: 13, letterSpacing: -0.07 }]}>
                {it.title}
              </Text>
              <Text style={[fontMed, { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 }]}>
                {it.sub}
              </Text>
            </View>
            <Feather name="chevron-right" size={14} color="rgba(255,255,255,0.4)" />
            {i < items.length - 1 && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute', left: 54, right: 14, bottom: 0,
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: 'rgba(255,255,255,0.06)',
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
}: {
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.dock,
        { paddingBottom: insets.bottom + 16 },
      ]}
    >
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <PressFx onPress={onSecondary} style={[styles.dockBtn, styles.dockGhost]}>
          <Text
            style={[fontBold, { color: '#FFFFFF', fontSize: 14, letterSpacing: -0.14 }]}
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
  safe: { flex: 1, backgroundColor: '#0A0A0A' },

  // Hero
  hero: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: 30,
    color: '#FFFFFF',
    letterSpacing: -1.05,
    lineHeight: 32,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
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
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.3)',
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
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
    color: '#FFFFFF',
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
    color: 'rgba(255,255,255,0.6)',
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
    color: '#FFFFFF',
    letterSpacing: -0.34,
    lineHeight: 20,
  },
  tkSvcMeta: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
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
    backgroundColor: 'rgba(96,165,250,0.18)',
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
    backgroundColor: '#0A0A0A',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  perfDashes: {
    flex: 1,
    marginHorizontal: 14,
    borderTopWidth: 1.5,
    borderTopColor: 'rgba(255,255,255,0.12)',
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
    color: '#FFFFFF',
    letterSpacing: -0.13,
    lineHeight: 17,
  },
  detSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
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
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  actIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.16)',
  },
  actLbl: {
    fontSize: 10.5,
    color: '#FFFFFF',
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
    color: 'rgba(255,255,255,0.45)',
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
    backgroundColor: 'rgba(10,10,10,0.92)',
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.06)',
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
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
});
