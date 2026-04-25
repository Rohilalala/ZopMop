import React, { useEffect } from 'react';
import { View, Text, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useCart } from '../../context/CartContext';
import { PressFx } from '../ui/PressFx';
import { Motion } from '../../constants/tokens';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

type Props = {
  selectedAddressId?: string;
};

export function HomeCartBar({ selectedAddressId }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { itemCount, subtotalCents } = useCart();
  const visible = itemCount > 0;
  const ty = useSharedValue(visible ? 0 : 120);

  useEffect(() => {
    if (visible) {
      ty.value = withSpring(0, Motion.spring.snappy);
    } else {
      ty.value = withTiming(120, {
        duration: Motion.duration.base,
        easing: Motion.easing.exit,
      });
    }
  }, [visible]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ty.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        animStyle,
        {
          position: 'absolute',
          bottom: 24,
          left: 16,
          right: 16,
        },
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#0F172A',
          borderRadius: 999,
          paddingLeft: 8,
          paddingRight: 8,
          paddingVertical: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.18,
          shadowRadius: 18,
          elevation: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: '#4F46E5',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={[fontBold, { color: '#FFFFFF', fontSize: 15 }]}>{itemCount}</Text>
          </View>
          <View>
            <Text style={[fontBold, { color: '#FFFFFF', fontSize: 14 }]}>
              {itemCount} service{itemCount > 1 ? 's' : ''} added
            </Text>
            <Text style={[fontReg, { color: '#94A3B8', fontSize: 12, marginTop: 1 }]}>
              ₹{(subtotalCents / 100).toFixed(0)} subtotal
            </Text>
          </View>
        </View>
        <PressFx
          onPress={() => navigation.navigate('Cart', { selectedAddressId })}
          style={{
            backgroundColor: '#4F46E5',
            paddingHorizontal: 18,
            paddingVertical: 12,
            borderRadius: 999,
          }}
        >
          <Text style={[fontSemi, { color: '#FFFFFF', fontSize: 14 }]}>View cart  →</Text>
        </PressFx>
      </View>
    </Animated.View>
  );
}
