import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { lightColors } from '../../theme/colors';

type C = typeof lightColors;
type Props = NativeStackScreenProps<MainStackParamList, 'RoomiesWelcome'>;

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.primary },
    body: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Spacing['2xl'],
    },
    iconWrap: {
      width: 120,
      height: 120,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing['3xl'],
    },
    welcome: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['3xl'],
      color: '#FFF',
      letterSpacing: -0.6,
      textAlign: 'center',
      marginBottom: Spacing.sm,
    },
    groupName: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: 'rgba(255,255,255,0.85)',
      textAlign: 'center',
      marginBottom: Spacing.xl,
    },
    addressChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(255,255,255,0.2)',
      borderRadius: Radius.full,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.base,
      marginBottom: Spacing.sm,
    },
    addressText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: '#FFF',
    },
    addressAddedNote: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: 'rgba(255,255,255,0.7)',
      textAlign: 'center',
      marginTop: Spacing.sm,
    },
    letsGoBtn: {
      marginHorizontal: Spacing.base,
      marginBottom: Spacing['3xl'],
      backgroundColor: '#FFF',
      borderRadius: Radius.xl,
      paddingVertical: Spacing.md,
      alignItems: 'center',
      ...Shadow.sm,
    },
    letsGoBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.primary,
    },
  });
}

export default function RoomiesWelcomeScreen({ route }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { groupName, addressLabel, addressAdded } = route.params;
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Animated.View style={[s.body, { opacity, transform: [{ scale }] }]}>
        <View style={s.iconWrap}>
          <Ionicons name="home" size={60} color="#FFF" />
        </View>

        <Text style={s.welcome}>Welcome home!</Text>
        <Text style={s.groupName}>{groupName}</Text>

        <View style={s.addressChip}>
          <Ionicons name="location-outline" size={14} color="#FFF" />
          <Text style={s.addressText}>{addressLabel}</Text>
        </View>

        {addressAdded && (
          <Text style={s.addressAddedNote}>
            This address has been added to your saved addresses.
          </Text>
        )}
      </Animated.View>

      <TouchableOpacity
        style={s.letsGoBtn}
        onPress={() => navigation.navigate('Home')}
        activeOpacity={0.85}
      >
        <Text style={s.letsGoBtnText}>Let's go</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
