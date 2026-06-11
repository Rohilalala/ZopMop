// LiquidGlass — central gate for Apple's native Liquid Glass (iOS 26+).
//
// `expo-glass-effect` wraps UIVisualEffectView+UIGlassEffect. The flag is
// resolved ONCE at module load: true only on iOS 26+ devices where the native
// effect exists. Every consumer branches on it and keeps its previous styled
// fallback (the hand-built glass recipe) for Android / older iOS, so nothing
// regresses off-platform.
//
// NOTE: the native module must be present in the dev-client binary — using
// GlassView against an older binary SIGABRTs (Fabric). Rebuild after adding
// the package (see project memory: xcodebuild sim workaround).

import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

export const liquidGlass = isLiquidGlassAvailable();
export { GlassView };
