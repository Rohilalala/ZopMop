// UsualsRow — "Book in 30 seconds" preset rail.
//
// Special behaviour: the "Book Instantly" entry is pinned to the left edge while
// the remaining presets scroll horizontally *behind* it. The pin starts wide
// (icon + label visible) and shrinks to an icon-only chip as the user scrolls
// right. Tapping the pin routes to the instant flow (AllServices?instant=true).
// Other taps route through the normal onPress handler.

import React, { useRef } from 'react';
import { Animated, Image, View, Text, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { PressFx } from '../ui/PressFx';
import { useTheme } from '../../context/ThemeContext';
import type { ApiService } from '../../api/services';
import type { MainStackParamList } from '../../types/navigation';
import { serviceIcon } from './serviceIcon';

const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

type Props = {
  services: ApiService[];
  onPress: (svc: ApiService) => void;
  onSeeAll?: () => void;
};

const PIN_WIDTH_EXPANDED = 130;
const PIN_WIDTH_COMPACT  = 76;
const PIN_HEIGHT         = 116;
const PIN_SHRINK_RANGE   = 90; // px scrolled before pin fully compact
const PIN_GAP   = 10;

// Bolt icon visually overflows the pin via transform:scale. Mask width is
// derived from the bolt's visual radius so cards fade out under the icon —
// not the (much smaller) pin frame.
const BOLT_BASE   = 60;
const BOLT_SCALE  = 3.0;
const BOLT_RADIUS = (BOLT_BASE * BOLT_SCALE) / 2;
const PAGE_PAD  = 20;

function isInstantPin(svc: ApiService): boolean {
  const n = svc.name.toLowerCase();
  return n.includes('book instantly') || n.includes('instant booking');
}

export function UsualsRow({ services, onPress, onSeeAll }: Props) {
  const { isDark } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  const scrollX = useRef(new Animated.Value(0)).current;

  if (services.length === 0) return null;

  // Detect the pin (first service with name "Instant booking"). Falls back to
  // index 0 when no explicit instant pin exists, so the user always sees a
  // pinned-leftmost card.
  const pinIndex = Math.max(0, services.findIndex(isInstantPin));
  const pin = services[pinIndex];
  const rest = services.filter((_, i) => i !== pinIndex);

  const handlePinPress = () => {
    navigation.navigate('AllServices', { instant: true });
  };

  // Pin shrinks from wide → icon-only as the rail scrolls right. Layout
  // animations (width / padding) cannot use the native driver, so this runs
  // on the JS thread — fine for short interactive ranges at 60fps.
  const pinWidth = scrollX.interpolate({
    inputRange:  [0, PIN_SHRINK_RANGE],
    outputRange: [PIN_WIDTH_EXPANDED, PIN_WIDTH_COMPACT],
    extrapolate: 'clamp',
  });
  const labelOpacity = scrollX.interpolate({
    inputRange:  [0, PIN_SHRINK_RANGE * 0.5],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  // Spacer = page-edge padding + pin width + gap, so the first card sits flush
  // to the pin's right edge as the pin shrinks. Rail itself is full-bleed so
  // cards can fade out under the pin instead of getting clipped at PAGE_PAD.
  const spacerWidth = scrollX.interpolate({
    inputRange:  [0, PIN_SHRINK_RANGE],
    outputRange: [PAGE_PAD + PIN_WIDTH_EXPANDED + PIN_GAP, PAGE_PAD + PIN_WIDTH_COMPACT + PIN_GAP],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ marginTop: 24 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingHorizontal: PAGE_PAD,
          paddingBottom: 10,
        }}
      >
        <Text style={[fontBold, { fontSize: 18, color: isDark ? '#FFFFFF' : '#0D0D0F', letterSpacing: -0.18 }]}>
          Book in 30 seconds
        </Text>
        <PressFx onPress={onSeeAll}>
          <Text style={[fontSemi, { fontSize: 12, color: '#F5A300' }]}>All →</Text>
        </PressFx>
      </View>

      {/* Wrapper: relative so the pinned card can absolute-overlay the scroll.
          Rail is full-bleed (no horizontal padding / clip) so cards can fade
          smoothly under the pin via the gradient mask below. */}
      <View style={{ position: 'relative' }}>
        <Animated.ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false },
          )}
          contentContainerStyle={{
            paddingRight: PAGE_PAD,
            gap: PIN_GAP,
            alignItems: 'center',
          }}
        >
          {/* Animated leading spacer reserves space under the pin and shrinks with it. */}
          <Animated.View style={{ width: spacerWidth, height: 1 }} />
          {rest.map((svc, idx) => (
            <PresetCard
              key={svc.id}
              service={svc}
              index={idx}
              isDark={isDark}
              scrollX={scrollX}
              onPress={() => onPress(svc)}
            />
          ))}
        </Animated.ScrollView>

        {/* Pinned card — opaque bg so cards sliding under are fully occluded
            within the card's rounded footprint. */}
        <Animated.View
          style={{
            position: 'absolute',
            left: PAGE_PAD,
            top: 0,
            width: pinWidth,
            height: PIN_HEIGHT,
            zIndex: 2,
          }}
        >
          <PressFx
            onPress={handlePinPress}
            style={{
              flex: 1,
              paddingHorizontal: 8,
              paddingVertical: 4,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
            }}
          >
            {/* Match the preset cards' icon-box height so the label sits at
                the same vertical level across the row. */}
            <View
              style={{
                width: '100%',
                height: 92,
                alignItems: 'center',
                justifyContent: 'flex-start',
                overflow: 'visible',
              }}
            >
              <Image
                source={require('../../../assets/instant-booking.png')}
                resizeMode="contain"
                style={{ width: BOLT_BASE, height: BOLT_BASE, marginTop: 5, transform: [{ scale: BOLT_SCALE }] }}
              />
            </View>
            <Animated.Text
              numberOfLines={1}
              style={[
                fontExtra,
                {
                  fontSize: 16,
                  color: '#F5A300',
                  letterSpacing: -0.16,
                  marginTop: 10,
                  textAlign: 'center',
                  opacity: labelOpacity,
                },
              ]}
            >
              {pin.name}
            </Animated.Text>
          </PressFx>
        </Animated.View>
      </View>
    </View>
  );
}

const CARD_W = 96;

function PresetCard({
  service,
  index,
  isDark,
  scrollX,
  onPress,
}: {
  service: ApiService;
  index: number;
  isDark: boolean;
  scrollX: Animated.Value;
  onPress: () => void;
}) {
  const src = serviceIcon({ id: service.id, name: service.name });

  // Fade card out as its center crosses the bolt icon's right edge moving left.
  // Uses static layout values (PIN_WIDTH_EXPANDED) — pin shrink slightly shifts
  // the bolt's center but the perceptual fade timing still feels right.
  const cardCenterAtZero =
    PAGE_PAD + PIN_WIDTH_EXPANDED + PIN_GAP + index * (CARD_W + PIN_GAP) + CARD_W / 2;
  const boltCenter = PAGE_PAD + PIN_WIDTH_EXPANDED / 2;
  const boltRight  = boltCenter + BOLT_RADIUS;
  const fadeStart  = Math.max(0, cardCenterAtZero - boltRight);
  const fadeEnd    = Math.max(fadeStart + 1, cardCenterAtZero - boltCenter);
  const opacity = scrollX.interpolate({
    inputRange:  [fadeStart, fadeEnd],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View style={{ opacity }}>
    <PressFx
      onPress={onPress}
      style={{
        width: CARD_W,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingVertical: 4,
      }}
    >
      <View
        style={{
          width: 96,
          height: 92,
          alignItems: 'center',
          justifyContent: 'flex-start',
          overflow: 'visible',
        }}
      >
        {src ? (
          <Image
            source={src}
            resizeMode="contain"
            style={{ width: 76, height: 76, marginTop: 5, transform: [{ scale: 1.8 }] }}
          />
        ) : (
          <Feather name="package" size={38} color={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(13,13,15,0.35)'} />
        )}
      </View>
      <Text
        style={[
          fontExtra,
          {
            fontSize: 13,
            lineHeight: 16,
            color: isDark ? '#FFFFFF' : '#0D0D0F',
            letterSpacing: -0.13,
            marginTop: 10,
            textAlign: 'center',
          },
        ]}
        numberOfLines={2}
      >
        {service.name}
      </Text>
    </PressFx>
    </Animated.View>
  );
}
