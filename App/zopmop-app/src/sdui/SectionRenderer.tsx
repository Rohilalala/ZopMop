// SectionRenderer — the per-section host inside an SDUI page.
//
// Responsibilities:
//   - Skip when section.visible === false.
//   - Look up the type in SECTION_REGISTRY; log + drop unknown types.
//   - Wrap the chosen component in a per-section ErrorBoundary so one bad
//     section doesn't blank the whole page.
//   - Fire a single impression event per (section.id) per session.
//   - Apply the sanitised layout + style tokens as the outer wrapper style.

import React, { useEffect, useMemo } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { logEvent, trackImpression } from '../analytics/impressionTracker';
import { resolveColor, resolveRadius } from './tokens';
import { SECTION_REGISTRY } from './registry';
import type {
  SduiAction,
  SduiLayout,
  SduiSection,
  SduiSectionType,
  SduiStyle,
} from './types';

interface Props {
  section:  SduiSection;
  position: number;
  onAction: (action: SduiAction) => void;
}

function buildWrapperStyle(
  layout: SduiLayout | undefined,
  style:  SduiStyle  | undefined,
): StyleProp<ViewStyle> {
  if (!layout && !style) return undefined;
  const out: ViewStyle = {};

  if (layout) {
    // SduiLayout has been sanitised already; copy keys directly.
    Object.assign(out, layout as ViewStyle);
  }
  if (style) {
    const bg = resolveColor(style.bg);
    const fg = resolveColor(style.fg);
    const radius = resolveRadius(style.radius);
    if (bg) out.backgroundColor = bg;
    // fg is typically passed down to children; we expose it via borderColor
    // here as a sensible default since SduiStyle has no explicit text channel.
    if (fg) out.borderColor = fg;
    if (typeof radius === 'number') out.borderRadius = radius;
  }
  return out;
}

// ── Per-section error boundary ──────────────────────────────────────────────
// We can't reuse src/components/ErrorBoundary.tsx because it doesn't expose a
// hook for our analytics call. This boundary logs sdui_render_error and then
// renders nothing, so a single broken section doesn't blank the whole page.

interface BoundaryProps {
  sectionId:   string;
  sectionType: string;
  children:    React.ReactNode;
}
interface BoundaryState { hasError: boolean }

class SectionErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    logEvent('sdui_render_error', {
      section_id:   this.props.sectionId,
      section_type: this.props.sectionType,
      message:      error?.message,
    });
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ── Renderer ────────────────────────────────────────────────────────────────

function SectionRendererInner({ section, position, onAction }: Props) {
  // Fire impression once per session per section id.
  useEffect(() => {
    if (section.visible === false) return;
    trackImpression(section.id, section.type, position);
  }, [section.id, section.type, section.visible, position]);

  const wrapperStyle = useMemo(
    () => buildWrapperStyle(section.layout, section.style),
    [section.layout, section.style],
  );

  if (section.visible === false) return null;

  const Entry = SECTION_REGISTRY[section.type as SduiSectionType];
  if (!Entry) {
    logEvent('sdui_unknown_component', {
      type:    section.type,
      page_id: 'home',
    });
    if (__DEV__) {
      return (
        <View style={{ padding: 12, backgroundColor: '#FEF2F2', margin: 8, borderRadius: 8 }}>
          <Text style={{ color: '#991B1B', fontSize: 12 }}>
            [SDUI] Unknown section type: {String(section.type)}
          </Text>
        </View>
      );
    }
    return null;
  }

  const inner = (
    <SectionErrorBoundary sectionId={section.id} sectionType={section.type}>
      <Entry section={section} onAction={onAction} position={position} />
    </SectionErrorBoundary>
  );

  if (!wrapperStyle) return inner;
  return <View style={wrapperStyle}>{inner}</View>;
}

export const SectionRenderer = React.memo(SectionRendererInner);
