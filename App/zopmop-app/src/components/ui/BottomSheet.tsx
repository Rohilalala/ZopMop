import React, { useEffect } from 'react';
import { Modal, Pressable, View, Dimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Motion } from '../../constants/tokens';
import { useColors } from '../../context/ThemeContext';

const { height: SCREEN_H } = Dimensions.get('window');

type Props = {
  visible: boolean;
  onClose: () => void;
  height?: number; // peek height in px (default 60% screen)
  /**
   * When set (and > height), the sheet gains a second snap point: it opens at
   * `height` (peek) and can rise to `expandedHeight`. Drag down past peek closes.
   * Omit for the original single-height behaviour.
   */
  expandedHeight?: number;
  /** Controlled expanded state (only meaningful with expandedHeight). */
  expanded?: boolean;
  onExpandedChange?: (v: boolean) => void;
  /**
   * Optional fixed header (grab handle + controls). When provided alongside
   * expandedHeight, the drag gesture is attached to the header ONLY, so a
   * scrollable body in `children` scrolls without fighting the sheet pan.
   */
  header?: React.ReactNode;
  /**
   * Optional sticky footer pinned to the screen bottom (e.g. an add-to-cart
   * bar). Rendered outside the animated sheet so it stays in place across the
   * peek/expanded snaps. Give scrollable `children` matching bottom padding.
   */
  footer?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Bottom sheet w/ swipe-to-dismiss + backdrop fade. Single-height by default
 * (drag-to-close). Pass expandedHeight for a two-snap peek/expanded sheet.
 */
export function BottomSheet({
  visible,
  onClose,
  height,
  expandedHeight,
  expanded,
  onExpandedChange,
  header,
  footer,
  children,
}: Props) {
  const c = useColors();
  const peekH = height ?? Math.round(SCREEN_H * 0.6);
  const twoSnap = expandedHeight != null && expandedHeight > peekH;
  const sheetH = twoSnap ? (expandedHeight as number) : peekH;
  const PEEK_Y = twoSnap ? sheetH - peekH : 0; // translateY when peeking
  const CLOSED_Y = sheetH; // translateY when hidden

  const translateY = useSharedValue(CLOSED_Y);
  const backdrop = useSharedValue(0);
  const startY = useSharedValue(0);

  const openY = twoSnap && expanded ? 0 : PEEK_Y;

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(openY, Motion.spring.gentle);
      backdrop.value = withTiming(1, { duration: Motion.duration.base });
    } else {
      translateY.value = withTiming(CLOSED_Y, {
        duration: Motion.duration.base,
        easing: Motion.easing.exit,
      });
      backdrop.value = withTiming(0, { duration: Motion.duration.quick });
    }
  }, [visible, openY, CLOSED_Y]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));

  const dismiss = () => onClose();
  const setExpanded = (v: boolean) => onExpandedChange?.(v);

  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      const next = startY.value + e.translationY;
      translateY.value = Math.min(Math.max(next, 0), CLOSED_Y);
    })
    .onEnd((e) => {
      if (!twoSnap) {
        if (e.translationY > sheetH * 0.3 || e.velocityY > 800) {
          translateY.value = withTiming(CLOSED_Y, {
            duration: Motion.duration.quick,
            easing: Motion.easing.exit,
          });
          runOnJS(dismiss)();
        } else {
          translateY.value = withSpring(0, Motion.spring.snappy);
        }
        return;
      }
      // Two-snap: project final position, then snap to expanded / peek / close.
      const projected = translateY.value + e.velocityY * 0.08;
      const closedFromPeek = projected > PEEK_Y + peekH * 0.4;
      if (closedFromPeek) {
        translateY.value = withTiming(CLOSED_Y, {
          duration: Motion.duration.quick,
          easing: Motion.easing.exit,
        });
        runOnJS(dismiss)();
      } else if (Math.abs(projected - 0) <= Math.abs(projected - PEEK_Y)) {
        translateY.value = withSpring(0, Motion.spring.snappy);
        runOnJS(setExpanded)(true);
      } else {
        translateY.value = withSpring(PEEK_Y, Motion.spring.snappy);
        runOnJS(setExpanded)(false);
      }
    });

  const grabHandle = (
    <View style={{ alignItems: 'center', paddingVertical: 6 }}>
      <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: c.border }} />
    </View>
  );

  const sheetBox = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: sheetH,
    backgroundColor: c.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  };

  // Handle-only drag (two-snap with a header): body can scroll freely.
  if (twoSnap && header) {
    return (
      <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
        <View style={{ flex: 1 }}>
          <Animated.View style={[backdropStyle, { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }]}>
            <Pressable style={{ flex: 1 }} onPress={onClose} />
          </Animated.View>
          <Animated.View style={[sheetStyle, sheetBox]}>
            <GestureDetector gesture={pan}>
              <View>
                {grabHandle}
                {header}
              </View>
            </GestureDetector>
            {children}
          </Animated.View>
          {footer != null && (
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>{footer}</View>
          )}
        </View>
      </Modal>
    );
  }

  // Original behaviour: whole sheet is draggable.
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[backdropStyle, { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View style={[sheetStyle, sheetBox]}>
            {grabHandle}
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
