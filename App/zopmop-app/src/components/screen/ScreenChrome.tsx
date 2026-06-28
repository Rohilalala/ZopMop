import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../theme';
import { useC } from '../../theme/screen';
import { Bloom } from '../home/Bloom';
import { PressFx } from '../ui/PressFx';
import { useTheme } from '../../context/ThemeContext';

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
  const c = useC();
  const { isDark } = useTheme();
  return (
    <PressFx
      style={[
        chrome.iconBtn,
        {
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.05)',
          borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(13,13,15,0.06)',
        },
      ]}
      onPress={onPress}
    >
      <Feather name={icon} size={size} color={c.text} />
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
  const c = useC();
  return (
    <View style={chrome.head}>
      {onBack ? <IconBtn icon="chevron-left" onPress={onBack} /> : <View style={{ width: 36 }} />}
      <View style={{ flex: 1 }}>
        <Text style={[chrome.hTitle, { color: c.text }]} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={[chrome.hSub, { color: c.textMuted }]} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right ?? <View style={{ width: 36 }} />}
    </View>
  );
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  const c = useC();
  return <Text style={[chrome.sectionHeader, { color: c.textMuted }]}>{children}</Text>;
}

export function Card({
  children, style,
}: {
  children: React.ReactNode;
  style?: any;
}) {
  const { isDark } = useTheme();
  return (
    <View
      style={[
        chrome.card,
        isDark
          ? { backgroundColor: 'rgba(255,255,255,0.045)', borderColor: 'rgba(255,255,255,0.07)' }
          : {
              backgroundColor: '#FFFFFF',
              borderWidth: 1,
              borderColor: 'rgba(13,13,15,0.06)',
              shadowColor: 'rgba(100,60,0,1)',
              shadowOpacity: 0.10,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 8 },
            },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export const chrome = StyleSheet.create({
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14,
  },
  hTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: 24,
    letterSpacing: -0.6, lineHeight: 28,
  },
  hSub: {
    fontFamily: FontFamily.medium,
    fontSize: 12,
    marginTop: 2,
  },
  sectionHeader: {
    fontFamily: FontFamily.bold,
    fontSize: 11, letterSpacing: 1.3,
    paddingHorizontal: 24, paddingTop: 22, paddingBottom: 10,
    textTransform: 'uppercase',
  },
  card: {
    marginHorizontal: 20,
    borderRadius: 18,
    padding: 14,
    borderWidth: 0.5,
  },
});
