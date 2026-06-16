// ServiceThumb — icon "stage" backdrop for service cards. Faithful port of
// `.dark .svc .thumb::before` from the design system CSS, with two
// adaptations for native RN:
//
//   • CSS uses `backdrop-filter: blur()` which RN can't do; instead the
//     gradient layers themselves run through an SVG Gaussian blur filter so
//     edges read as soft glows rather than hard ellipses.
//   • Top-highlight + amber-underglow use multi-stop gradients (3 stops each)
//     so the falloff is gradual — single 0% → transparent stops produce a
//     visible "ring" where the radial ends.
//
// Featured variant: warmer base (#1C1A14 → #100E0B), wider amber spread.

import React from 'react';
import { View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
  Ellipse,
  Filter,
  FeGaussianBlur,
} from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';

type Props = {
  height: number;
  radius?: number;
  featured?: boolean;
};

export function ServiceThumb({ height, radius = 12, featured = false }: Props) {
  const { isDark } = useTheme();

  /* ── Dark mode values (unchanged) ─────────────────────────── */
  const darkBaseTop      = featured ? '#1C1A14' : '#1A1A1C';
  const darkBaseBottom   = featured ? '#100E0B' : '#0F0F11';
  const darkAmberOpacity = featured ? 0.30 : 0.20;
  const darkTopHiOpacity = featured ? 0.13 : 0.11;

  /* ── Light mode values ────────────────────────────────────── */
  const lightBaseTop    = featured ? '#FFFCF5' : '#FFFFFF';
  const lightBaseBottom = featured ? '#FFF6E5' : '#FAF7F2';
  // Amber underglow: #FFD89A for featured, #FFE9C7 for standard — full
  // opacity in the SVG stop, faded via the radial spread.
  const lightAmberColor = featured ? '#FFD89A' : '#FFE9C7';
  // Wider / more intense spread on featured
  const lightAmberRy    = featured ? 80 : 70;
  const lightAmberCy    = featured ? 118 : 112;
  const lightAmberRx    = featured ? 110 : 110;

  /* ── Resolved per-theme tokens ────────────────────────────── */
  const baseTop      = isDark ? darkBaseTop      : lightBaseTop;
  const baseBottom   = isDark ? darkBaseBottom    : lightBaseBottom;
  const amberColor   = isDark ? '#F5A300'         : lightAmberColor;
  const amberOpacity = isDark ? (featured ? 0.30 : 0.20) : 0.45;
  const topHiOpacity = isDark ? darkTopHiOpacity  : 0.50;
  const amberCy      = isDark ? (featured ? 118 : 112) : lightAmberCy;
  const amberRx      = isDark ? 110               : lightAmberRx;
  const amberRy      = isDark ? (featured ? 80 : 70) : lightAmberRy;

  return (
    <View
      style={{
        height,
        borderRadius: radius,
        overflow: 'hidden',
        backgroundColor: baseBottom,
        position: 'relative',
      }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Defs>
          <LinearGradient id="thumbBase" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%"   stopColor={baseTop} />
            <Stop offset="100%" stopColor={baseBottom} />
          </LinearGradient>

          {/* Soft-falloff radials: three stops each so the gradient hits zero
              gradually instead of forming a visible ring. */}
          <RadialGradient
            id="thumbTopHi"
            cx="50" cy="10" rx="160" ry="120"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#FFFFFF" stopOpacity={topHiOpacity} />
            <Stop offset="35%" stopColor="#FFFFFF" stopOpacity={topHiOpacity * 0.5} />
            <Stop offset="80%" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>

          <RadialGradient
            id="thumbAmber"
            cx="50" cy={amberCy} rx={amberRx} ry={amberRy}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor={amberColor} stopOpacity={amberOpacity} />
            <Stop offset="35%" stopColor={amberColor} stopOpacity={amberOpacity * 0.55} />
            <Stop offset="80%" stopColor={amberColor} stopOpacity="0" />
          </RadialGradient>

          <RadialGradient
            id="thumbGround"
            cx="50" cy="68" rx="34" ry="7"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#0D0D0F" stopOpacity={isDark ? '0.32' : '0'} />
            <Stop offset="70%" stopColor="#0D0D0F" stopOpacity="0" />
          </RadialGradient>

          {/* Gaussian blur filter — softens any residual edge from the
              radial gradients. Applied to the highlight + amber layers
              (NOT the ground shadow, which needs to stay tight). */}
          <Filter id="softBlur" x="-20%" y="-20%" width="140%" height="140%">
            <FeGaussianBlur stdDeviation="2.5" />
          </Filter>
        </Defs>

        <Rect width="100" height="100" fill="url(#thumbBase)" />
        <Rect width="100" height="100" fill="url(#thumbTopHi)" filter="url(#softBlur)" />
        <Rect width="100" height="100" fill="url(#thumbAmber)" filter="url(#softBlur)" />
        <Ellipse cx="50" cy="68" rx="34" ry="7" fill="url(#thumbGround)" />
      </Svg>

      {/* inner top highlight (1px) — sub-pixel specular edge */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: 1,
          backgroundColor: isDark
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(255,255,255,0.9)',
        }}
      />
      {/* hairline inner border */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          borderRadius: radius,
          borderWidth: 0.5,
          borderColor: isDark
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(13,13,15,0.05)',
        }}
      />
    </View>
  );
}
