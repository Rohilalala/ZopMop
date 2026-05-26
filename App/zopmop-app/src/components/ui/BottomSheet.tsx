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
  height?: number; // peak height in px (default 60% screen)
  children: React.ReactNode;
};

/**
 * Bottom sheet w/ swipe-to-dismiss + backdrop fade.
 * GSAP-equivalent: timeline opens → fade backdrop + spring sheet up; pan drives close.
 */
export function BottomSheet({ visible, onClose, height, children }: Props) {
  const c = useColors();
  const sheetH = height ?? Math.round(SCREEN_H * 0.6);
  const translateY = useSharedValue(sheetH);
  const backdrop = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, Motion.spring.gentle);
      backdrop.value = withTiming(1, { duration: Motion.duration.base });
    } else {
      translateY.value = withTiming(sheetH, {
        duration: Motion.duration.base,
        easing: Motion.easing.exit,
      });
      backdrop.value = withTiming(0, { duration: Motion.duration.quick });
    }
  }, [visible, sheetH]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));

  const dismiss = () => onClose();

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > sheetH * 0.3 || e.velocityY > 800) {
        translateY.value = withTiming(sheetH, {
          duration: Motion.duration.quick,
          easing: Motion.easing.exit,
        });
        runOnJS(dismiss)();
      } else {
        translateY.value = withSpring(0, Motion.spring.snappy);
      }
    });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[backdropStyle, { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              sheetStyle,
              {
                position: 'absolute',
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
              },
            ]}
          >
            <View style={{ alignItems: 'center', paddingVertical: 6 }}>
              <View
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: c.border,
                }}
              />
            </View>
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
