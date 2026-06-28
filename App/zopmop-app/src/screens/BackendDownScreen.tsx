import React from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
  useWindowDimensions,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import LottieView from 'lottie-react-native';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import ZopFull from '../../assets/zop/zop-full.svg';
import ZopLookingUp from '../../assets/zop/zop-looking-up.svg';
import ZopLookingAway from '../../assets/zop/zop-looking-away.svg';
import ZopSleeping from '../../assets/zop/zop-sleeping.svg';
import ZopHappy from '../../assets/zop/zop-happy.svg';
import ZopSad from '../../assets/zop/zop-sad.svg';
import ZopSurprised from '../../assets/zop/zop-surprised.svg';
import ZopWink from '../../assets/zop/zop-wink.svg';
import ZopLove from '../../assets/zop/zop-love.svg';
import ZopConfused from '../../assets/zop/zop-confused.svg';
import ZopCool from '../../assets/zop/zop-cool.svg';
import ZopCry from '../../assets/zop/zop-cry.svg';
import ZopShocked from '../../assets/zop/zop-shocked.svg';
import ZopBlush from '../../assets/zop/zop-blush.svg';
import ZopThinking from '../../assets/zop/zop-thinking.svg';
import ZopTongue from '../../assets/zop/zop-tongue.svg';
import ZopDizzy from '../../assets/zop/zop-dizzy.svg';
import ZopSmug from '../../assets/zop/zop-smug.svg';

const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

// Pre-baked scatter of background Zops. Positions are in % of screen so the
// pattern adapts to any device. Each entry: x%, y%, size px, rotation deg,
// variant. Hand-tuned to feel random. Pool excludes Angry.
type BgZop = {
  x: number; // 0..1
  y: number; // 0..1
  size: number;
  rot: number;
  V: React.ComponentType<{ width: number; height: number }>;
};

const BG_ZOPS: BgZop[] = [
  { x: 0.05, y: 0.04, size: 70, rot: -14, V: ZopHappy },
  { x: 0.42, y: 0.02, size: 56, rot: 22,  V: ZopLookingUp },
  { x: 0.78, y: 0.05, size: 64, rot: -8,  V: ZopSleeping },
  { x: 0.18, y: 0.14, size: 48, rot: 12,  V: ZopLove },
  { x: 0.62, y: 0.16, size: 80, rot: -20, V: ZopShocked },
  { x: 0.02, y: 0.26, size: 60, rot: 30,  V: ZopWink },
  { x: 0.36, y: 0.28, size: 44, rot: -6,  V: ZopCool },
  { x: 0.85, y: 0.30, size: 72, rot: 16,  V: ZopConfused },
  { x: 0.10, y: 0.42, size: 50, rot: -22, V: ZopBlush },
  { x: 0.92, y: 0.46, size: 54, rot: 8,   V: ZopSurprised },
  { x: 0.05, y: 0.58, size: 68, rot: 18,  V: ZopThinking },
  { x: 0.88, y: 0.62, size: 60, rot: -14, V: ZopTongue },
  { x: 0.20, y: 0.72, size: 76, rot: 24,  V: ZopSad },
  { x: 0.58, y: 0.74, size: 50, rot: -10, V: ZopDizzy },
  { x: 0.82, y: 0.78, size: 64, rot: 28,  V: ZopSmug },
  { x: 0.04, y: 0.86, size: 56, rot: -18, V: ZopFull },
  { x: 0.40, y: 0.90, size: 60, rot: 14,  V: ZopCry },
  { x: 0.72, y: 0.92, size: 48, rot: -24, V: ZopLookingAway },
  { x: 0.30, y: 0.50, size: 42, rot: 36,  V: ZopHappy },
  { x: 0.66, y: 0.50, size: 46, rot: -30, V: ZopLove },
  { x: 0.50, y: 0.10, size: 40, rot: 8,   V: ZopBlush },
  { x: 0.96, y: 0.18, size: 38, rot: -12, V: ZopTongue },
  { x: 0.14, y: 0.34, size: 38, rot: 18,  V: ZopThinking },
  { x: 0.74, y: 0.40, size: 42, rot: -8,  V: ZopSmug },
  { x: 0.48, y: 0.62, size: 38, rot: 26,  V: ZopWink },
  { x: 0.30, y: 0.82, size: 40, rot: -16, V: ZopSurprised },
];

// Dimmed Zop scatter backdrop. Exported so other full-screen states (e.g. the
// force-update screen) render the exact same background.
export function ScatterBg() {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {BG_ZOPS.map((z, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: z.x * SCREEN_W - z.size / 2,
            top: z.y * SCREEN_H - z.size / 2,
            width: z.size,
            height: z.size,
            opacity: 0.13,
            transform: [{ rotate: `${z.rot}deg` }],
          }}
        >
          <z.V width={z.size} height={z.size} />
        </View>
      ))}
    </View>
  );
}

const ZOP_SIZE = 220;

// Two-state Zop driven by lottie files that share the same X-eyes pose at
// their boundaries, so swapping is seamless:
//   dead — X-eyes idle with baked glitch twitches, loops (3s)
//   peek — eyes open, glance left, sweep right, settle back to X (1.4s)
// Imperative play(start, end) is broken on lottie-react-native 7.3.6 under
// the New Architecture (finishes instantly), so segment playback is done by
// swapping autoPlay sources instead.
function ZopDownLottie({ state }: { state: 'dead' | 'peek' }) {
  return state === 'peek' ? (
    <LottieView
      key="peek"
      source={require('../../assets/animation/zop-down-peek.json')}
      style={{ width: ZOP_SIZE, height: ZOP_SIZE }}
      autoPlay
      loop={false}
    />
  ) : (
    <LottieView
      key="dead"
      source={require('../../assets/animation/zop-down-dead.json')}
      style={{ width: ZOP_SIZE, height: ZOP_SIZE }}
      autoPlay
      loop
    />
  );
}

type Props = { onRetry: () => void };

export default function BackendDownScreen({ onRetry }: Props) {
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = React.useState(false);

  // Tap → run the same probe the button runs, but show the sneaky peek
  // animation for at least PEEK_MIN_MS so the user sees feedback even when
  // the probe resolves instantly. If the backend is back, this screen
  // unmounts naturally; otherwise we revert to the dead glitch.
  const PEEK_MIN_MS = 1400;
  const triggerRetry = React.useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    onRetry();
    setTimeout(() => setRefreshing(false), PEEK_MIN_MS);
  }, [onRetry, refreshing]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Background scatter — dimmed Zops with mixed expressions. */}
      <ScatterBg />

      {/* Foreground — bright dead Zop + copy + retry. */}
      <View
        style={[
          styles.center,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <Pressable
          onPress={triggerRetry}
          disabled={refreshing}
          style={({ pressed }) => [
            styles.deadWrap,
            pressed && !refreshing && { transform: [{ scale: 0.97 }] },
          ]}
        >
          <ZopDownLottie state={refreshing ? 'peek' : 'dead'} />
        </Pressable>
        <View style={styles.tapHint}>
          <Feather name="refresh-cw" size={12} color="rgba(255,255,255,0.55)" />
          <Text style={[fontSemi, styles.tapHintText]}>
            {refreshing ? 'Looking for the server…' : 'Tap Zop to retry'}
          </Text>
        </View>
        <Text style={[fontExtra, styles.title]}>Zop's down.</Text>
        <Text style={[fontSemi, styles.body]}>
          Can't reach our servers right now.{'\n'}Check your connection or try again in a minute.
        </Text>
        <Pressable
          onPress={triggerRetry}
          disabled={refreshing}
          style={({ pressed }) => [
            styles.btn,
            pressed && !refreshing && { opacity: 0.7 },
            refreshing && { opacity: 0.55 },
          ]}
        >
          <Text style={[fontBold, styles.btnLabel]}>
            {refreshing ? 'Trying…' : 'Try again'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0B0B0C',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  deadWrap: {
    // Subtle dark vignette behind the bright dead Zop so it pops above the
    // dimmer scatter even where a background Zop sits directly behind it.
    padding: 24,
    borderRadius: 999,
    backgroundColor: 'rgba(11,11,12,0.78)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
    elevation: 16,
  },
  tapHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  tapHintText: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.65)',
    letterSpacing: 0.4,
  },
  title: {
    fontSize: 28,
    color: '#FFFFFF',
    marginTop: 18,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 12,
    textAlign: 'center',
  },
  btn: {
    marginTop: 32,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: '#22C55E',
  },
  btnLabel: {
    color: '#0B0B0C',
    fontSize: 15,
  },
});
