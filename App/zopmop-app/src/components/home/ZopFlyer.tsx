// ZopFlyer — inline SVG Zop with animatable eyes + wink. Designed for the
// Home pull-to-refresh easter egg: the parent controls translation + rotation;
// this component just renders the SVG and exposes hooks for fading eyes out
// during the flight and morphing the right eye into a wink line on landing.

import React from 'react';
import Animated, {
  useAnimatedProps,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const STAR_PATH =
  'M178.1,26.44c1.39-5.53,10.07-5.53,11.46,0,24.18,96.14,68.9,141.13,165.61,165.5,5.53,1.39,5.53,10.05,0,11.44-96.73,24.37-141.45,69.36-165.61,165.5-1.39,5.53-10.07,5.53-11.46,0-24.18-96.14-68.9-141.15-165.59-165.5-5.53-1.39-5.53-10.05,0-11.44,96.72-24.37,141.44-69.36,165.6-165.5h-.01Z';

const EYE_R_OPEN = 'M137.45 99.4 C 133.33 109.56 125.54 136.07 127.41 160.74';
const EYE_L_OPEN = 'M183.12 99.4 C 179.00 109.56 171.21 136.07 173.08 160.74';
const EYE_R_WINK = 'M 121 132 L 145 132';
const MOUTH      = 'M133.73 217.5 C 183.43 215.74 212.56 199.59 233.95 182.43';

const STROKE       = '#1F1F1F';
const STROKE_WIDTH = 13.03;

type Props = {
  size?: number;
  /** 1 = both eyes fully visible, 0 = invisible. */
  eyeOpacity: SharedValue<number>;
  /** 0 = right eye open, 1 = wink (flat line). */
  winkProgress: SharedValue<number>;
  /** When false, only the amber body renders (loading state). */
  showFace?: boolean;
};

export function ZopFlyer({
  size = 130,
  eyeOpacity,
  winkProgress,
  showFace = true,
}: Props) {
  const leftEyeProps   = useAnimatedProps(() => ({
    strokeOpacity: eyeOpacity.value,
    opacity: eyeOpacity.value,
  }));
  const rightOpenProps = useAnimatedProps(() => ({
    strokeOpacity: eyeOpacity.value * (1 - winkProgress.value),
    opacity:       eyeOpacity.value * (1 - winkProgress.value),
  }));
  const rightWinkProps = useAnimatedProps(() => ({
    strokeOpacity: eyeOpacity.value * winkProgress.value,
    opacity:       eyeOpacity.value * winkProgress.value,
  }));

  return (
    <Svg width={size} height={size} viewBox="0 0 395.32 395.32" fill="none">
      <Path d={STAR_PATH} fill="#FFBA03" />

      {showFace && (
        <>
          <AnimatedPath
            d={EYE_L_OPEN}
            stroke={STROKE}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            fill="none"
            animatedProps={leftEyeProps}
          />
          <AnimatedPath
            d={EYE_R_OPEN}
            stroke={STROKE}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            fill="none"
            animatedProps={rightOpenProps}
          />
          <AnimatedPath
            d={EYE_R_WINK}
            stroke={STROKE}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            fill="none"
            animatedProps={rightWinkProps}
          />
          <AnimatedPath
            d={MOUTH}
            stroke={STROKE}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            fill="none"
            animatedProps={leftEyeProps}
          />
        </>
      )}
    </Svg>
  );
}
