import React, { useCallback, useEffect } from 'react';
import { Alert, View, Text, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useCart } from '../../context/CartContext';
import { PressFx } from '../ui/PressFx';
import { Motion } from '../../constants/tokens';

const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };

type Props = {
  selectedAddressId?: string;
};

export function HomeCartBar({ selectedAddressId }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { items, itemCount, subtotalCents, removeItem } = useCart();
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

  const firstName = items[0]?.service_name ?? `${itemCount} service${itemCount > 1 ? 's' : ''}`;
  const totalRupees = `₹${(subtotalCents / 100).toFixed(0)}`;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        animStyle,
        {
          position: 'absolute',
          // Clear the BottomTabBar pill (94 from screen bottom) AND the
          // Zop mascot that overhangs ~32px above the pill. 134 = 22 (pill
          // bottom inset) + 72 (pill height) + 32 (Zop overhang) + 8 (gap).
          bottom: 134,
          left: 16,
          right: 16,
          zIndex: 45,
        },
      ]}
    >
      <PressFx
        onPress={() => navigation.navigate('Cart', { selectedAddressId })}
        onLongPress={() => {
          Alert.alert(
            'Clear cart?',
            `Remove all ${itemCount} item${itemCount > 1 ? 's' : ''} from cart.`,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Clear',
                style: 'destructive',
                onPress: async () => {
                  for (const it of items) {
                    try { await removeItem(it.id); } catch {}
                  }
                },
              },
            ],
          );
        }}
        style={{
          height: 62,
          borderRadius: 18,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          // Solid brand amber — primary CTA stays opaque (tinted glass read
          // muddy over dark content; Apple keeps prominent CTAs solid too).
          backgroundColor: '#F5A300',
          shadowColor: '#F5A300',
          shadowOffset: { width: 0, height: 14 },
          shadowOpacity: 0.4,
          shadowRadius: 30,
          elevation: 12,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            backgroundColor: '#0D0D0F',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={[fontExtra, { color: '#F5A300', fontSize: 14 }]}>{itemCount}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[fontExtra, { color: '#0D0D0F', fontSize: 14, letterSpacing: -0.14 }]}
            numberOfLines={1}
          >
            {totalRupees} · {items.length} item{items.length > 1 ? 's' : ''}
          </Text>
          <Text
            style={[fontMed, { color: 'rgba(13,13,15,0.7)', fontSize: 11 }]}
            numberOfLines={1}
          >
            {firstName}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 13 }]}>Review</Text>
          <Feather name="chevron-right" size={16} color="#0D0D0F" />
        </View>
      </PressFx>
    </Animated.View>
  );
}
