import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Animated, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../types/navigation';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../theme';
import { useCart } from '../context/CartContext';

type Nav = NativeStackNavigationProp<MainStackParamList>;

export default function FloatingCartButton() {
  const navigation = useNavigation<Nav>();
  const { itemCount, cartBadgeAnim } = useCart();

  if (itemCount === 0) return null;

  return (
    <TouchableOpacity
      style={s.fab}
      activeOpacity={0.85}
      onPress={() => navigation.navigate('Cart')}
    >
      <Text style={s.icon}>🛒</Text>
      <Animated.View style={[s.badge, { transform: [{ scale: cartBadgeAnim }] }]}>
        <Text style={s.badgeText}>{itemCount > 9 ? '9+' : itemCount}</Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  fab: {
    position: 'absolute',
    bottom: 88,        // above tab bar (65px) + gap
    right: 18,
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
    // subtle translucency
    opacity: 0.96,
  },
  icon: { fontSize: 24 },
  badge: {
    position: 'absolute',
    top: -4, right: -4,
    minWidth: 20, height: 20,
    borderRadius: Radius.full,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: Colors.white,
  },
  badgeText: {
    fontFamily: FontFamily.bold,
    fontSize: 10,
    color: Colors.white,
    lineHeight: 13,
  },
});
