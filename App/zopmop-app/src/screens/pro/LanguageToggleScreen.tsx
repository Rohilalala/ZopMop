import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';

import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { getLocale, setLocale, type Locale, t } from '../../i18n';
import { showSuccess } from '../../utils/toast';
import { useProRoleGate } from '../../hooks/useRoleGate';

const POP_DELAY_MS = 500;

export default function LanguageToggleScreen() {
  useProRoleGate();
  const navigation = useNavigation();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [selected, setSelected] = useState<Locale>(getLocale());

  function pick(loc: Locale) {
    if (loc === selected) return;
    setSelected(loc);
    setLocale(loc);
    showSuccess(t('language.changed'));
    setTimeout(() => {
      if (navigation.canGoBack()) navigation.goBack();
    }, POP_DELAY_MS);
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>{t('language.title')}</Text>
          <Text style={styles.subtitle}>{t('language.titleEn')}</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.body}>
        <LanguageCard
          colors={c}
          label={t('language.hindi')}
          subtitle={t('language.hindiSubtitle')}
          selected={selected === 'hi'}
          onPress={() => pick('hi')}
        />
        <LanguageCard
          colors={c}
          label={t('language.english')}
          subtitle={t('language.englishSubtitle')}
          selected={selected === 'en'}
          onPress={() => pick('en')}
        />
      </View>
    </SafeAreaView>
  );
}

function LanguageCard({
  colors,
  label,
  subtitle,
  selected,
  onPress,
}: { colors: ReturnType<typeof useColors>; label: string; subtitle: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={{
        backgroundColor: colors.surface,
        borderRadius: Radius.lg,
        padding: Spacing.lg,
        borderWidth: 2,
        borderColor: selected ? colors.accent : colors.border,
        flexDirection: 'row',
        alignItems: 'center',
      }}
      onPress={onPress}
    >
      <View style={{ flex: 1 }}>
        <Text style={{
          fontFamily: FontFamily.bold,
          fontSize: FontSize.xl,
          color: colors.text,
        }}>{label}</Text>
        <Text style={{
          fontFamily: FontFamily.regular,
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          marginTop: 4,
        }}>{subtitle}</Text>
      </View>
      {selected && <Feather name="check-circle" size={24} color={colors.accent} />}
    </TouchableOpacity>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: Spacing.base, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    backBtn: { padding: 4 },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text, textAlign: 'center' },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary, textAlign: 'center' },
    body: { padding: Spacing.lg, gap: Spacing.base },
  });
}
