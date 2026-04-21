import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 4 },
    backBtn: { padding: 4, marginLeft: -4 },
    headerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, letterSpacing: -0.5 },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingBottom: 80 },
    iconWrap: { width: 112, height: 112, borderRadius: Radius.full, backgroundColor: c.primaryBg, alignItems: 'center', justifyContent: 'center', marginBottom: 24, ...Shadow.sm },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, marginBottom: 12, letterSpacing: -0.4 },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, textAlign: 'center', lineHeight: 22 },
    testBtn: {
      marginTop: 22,
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderRadius: Radius.lg,
      backgroundColor: c.primary,
      ...Shadow.sm,
    },
    testBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: '#FFFFFF',
    },
  });
}

export default function WalletScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Wallet</Text>
      </View>

      <View style={s.body}>
        <View style={s.iconWrap}>
          <Ionicons name="wallet-outline" size={64} color={c.primary} />
        </View>
        <Text style={s.title}>Coming Soon</Text>
        <Text style={s.subtitle}>
          Your wallet is on its way. You'll be able to check your balance and transactions right here.
        </Text>
        <TouchableOpacity
          style={s.testBtn}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('Payment')}
        >
          <Text style={s.testBtnText}>Open Payment Test</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
