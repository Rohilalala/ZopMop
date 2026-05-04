// ScreenChrome — thin wrappers around the canonical home primitives so any
// screen still importing from here gets the same dark home pattern as
// HomeScreen. New screens should import directly from `components/home/`
// + `components/ui/PressFx` and inline the title block (matches the rest of
// the migrated screens). This file exists for backwards compat with
// pre-migration screens (Cart, Profile, skeletons).

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../theme';
import { C } from '../../theme/screen';
import { Bloom } from '../home/Bloom';
import { PressFx } from '../ui/PressFx';

export function BackgroundGlow() {
  return <Bloom />;
}

export function IconBtn({
  icon, onPress, size = 18,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress?: () => void;
  size?: number;
}) {
  return (
    <PressFx style={chrome.iconBtn} onPress={onPress}>
      <Feather name={icon} size={size} color={C.white} />
    </PressFx>
  );
}

export function ScreenHeader({
  title, subtitle, right, onBack,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <View style={chrome.head}>
      {onBack ? <IconBtn icon="chevron-left" onPress={onBack} /> : <View style={{ width: 36 }} />}
      <View style={{ flex: 1 }}>
        <Text style={chrome.hTitle} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={chrome.hSub} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right ?? <View style={{ width: 36 }} />}
    </View>
  );
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text style={chrome.sectionHeader}>{children}</Text>;
}

export function Card({
  children, style,
}: {
  children: React.ReactNode;
  style?: any;
}) {
  return <View style={[chrome.card, style]}>{children}</View>;
}

export const chrome = StyleSheet.create({
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14,
  },
  hTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: 24, color: C.white,
    letterSpacing: -0.6, lineHeight: 28,
  },
  hSub: {
    fontFamily: FontFamily.medium,
    fontSize: 12, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  sectionHeader: {
    fontFamily: FontFamily.bold,
    fontSize: 11, letterSpacing: 1.3,
    color: 'rgba(255,255,255,0.45)',
    paddingHorizontal: 24, paddingTop: 22, paddingBottom: 10,
    textTransform: 'uppercase',
  },
  card: {
    marginHorizontal: 20,
    borderRadius: 18,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
  },
});
