import React from 'react';
import { Dimensions, View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function DarkBg() {
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${SCREEN_W} ${SCREEN_H + 60}`}
    >
      <Defs>
        <RadialGradient
          id="amberMain"
          cx={SCREEN_W * 0.95}
          cy={-SCREEN_H * 0.08}
          rx={SCREEN_W * 1.10}
          ry={SCREEN_H * 0.65}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.22" />
          <Stop offset="40%" stopColor="#F5A300" stopOpacity="0.08" />
          <Stop offset="70%" stopColor="#F5A300" stopOpacity="0" />
        </RadialGradient>

        <RadialGradient
          id="whiteFill"
          cx={-SCREEN_W * 0.10}
          cy={SCREEN_H * 0.12}
          rx={SCREEN_W * 0.80}
          ry={SCREEN_H * 0.55}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%"  stopColor="#FFFFFF" stopOpacity="0.05" />
          <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
        </RadialGradient>

        <RadialGradient
          id="amberTail"
          cx={SCREEN_W * 0.85}
          cy={SCREEN_H * 0.40}
          rx={SCREEN_W * 0.95}
          ry={SCREEN_H * 0.55}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.06" />
          <Stop offset="60%" stopColor="#F5A300" stopOpacity="0" />
        </RadialGradient>
      </Defs>

      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#amberMain)" />
      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#amberTail)" />
      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#whiteFill)" />
    </Svg>
  );
}

function LightBg() {
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${SCREEN_W} ${SCREEN_H + 60}`}
    >
      <Defs>
        <LinearGradient id="lightBase" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%"  stopColor="#FAF7F2" />
          <Stop offset="55%" stopColor="#F4EFE7" />
          <Stop offset="100%" stopColor="#EFE9DE" />
        </LinearGradient>

        <RadialGradient
          id="lightAmber1"
          cx={SCREEN_W * 1.10}
          cy={-SCREEN_H * 0.10}
          rx={SCREEN_W * 1.10}
          ry={SCREEN_H * 0.70}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.35" />
          <Stop offset="50%" stopColor="#F5A300" stopOpacity="0" />
        </RadialGradient>

        <RadialGradient
          id="lightAmber2"
          cx={-SCREEN_W * 0.10}
          cy={SCREEN_H * 0.10}
          rx={SCREEN_W * 1.00}
          ry={SCREEN_H * 0.80}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%"  stopColor="#FFBA03" stopOpacity="0.20" />
          <Stop offset="55%" stopColor="#FFBA03" stopOpacity="0" />
        </RadialGradient>
      </Defs>

      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#lightBase)" />
      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#lightAmber2)" />
      <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#lightAmber1)" />
    </Svg>
  );
}

export function ScreenBg() {
  const { isDark } = useTheme();

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: -60,
        left: 0,
        right: 0,
        height: SCREEN_H + 60,
      }}
    >
      {isDark ? <DarkBg /> : <LightBg />}
    </View>
  );
}
