import React, { useMemo } from 'react';
import { Alert, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useColors } from '../../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { lightColors } from '../../theme/colors';
type C = typeof lightColors;
type Props = NativeStackScreenProps<MainStackParamList, 'RoomiesCodeShare'>;

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 16,
      gap: 4,
    },
    backBtn: { padding: 4, marginLeft: -4 },
    headerTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.text,
      letterSpacing: -0.5,
    },
    body: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Spacing['2xl'],
      paddingBottom: 80,
    },
    iconWrap: {
      width: 88,
      height: 88,
      borderRadius: Radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.xl,
      ...Shadow.sm,
    },
    groupName: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.text,
      letterSpacing: -0.4,
      textAlign: 'center',
      marginBottom: Spacing.sm,
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: Spacing['3xl'],
    },
    codeCard: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      paddingVertical: Spacing.xl,
      paddingHorizontal: Spacing['2xl'],
      alignItems: 'center',
      width: '100%',
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
      marginBottom: Spacing.xl,
    },
    codeLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      marginBottom: Spacing.sm,
    },
    codeValue: {
      fontFamily: FontFamily.extrabold,
      fontSize: 40,
      color: c.primary,
      letterSpacing: 10,
      marginBottom: Spacing.md,
    },
    copyRow: { flexDirection: 'row', gap: Spacing.sm },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.base,
      borderRadius: Radius.lg,
      backgroundColor: c.primaryBg,
    },
    actionBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.primary,
    },
    caption: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textMuted,
      textAlign: 'center',
    },
    doneBtn: {
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.xl,
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      paddingVertical: Spacing.md,
      alignItems: 'center',
      ...Shadow.sm,
    },
    doneBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#FFF',
    },
  });
}

export default function RoomiesCodeShareScreen({ route }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { code, groupName } = route.params;
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const displayCode = `${code.slice(0, 3)} ${code.slice(3)}`;

  const handleCopy = () => {
    Alert.alert('Code copied', `Your invite code is: ${displayCode}`);
  };

  const handleShare = async () => {
    await Share.share({
      message: `Join my household on ZopMop! Use code: ${displayCode}`,
    });
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Invite Code</Text>
      </View>

      <View style={s.body}>
        <View style={s.iconWrap}>
          <Ionicons name="home" size={40} color={c.primary} />
        </View>

        <Text style={s.groupName}>{groupName}</Text>
        <Text style={s.subtitle}>
          Share this code with up to 3 housemates to let them join your household.
        </Text>

        <View style={s.codeCard}>
          <Text style={s.codeLabel}>Invite Code</Text>
          <Text style={s.codeValue}>{displayCode}</Text>
          <View style={s.copyRow}>
            <TouchableOpacity style={s.actionBtn} onPress={handleCopy} activeOpacity={0.7}>
              <Ionicons name="copy-outline" size={16} color={c.primary} />
              <Text style={s.actionBtnText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={handleShare} activeOpacity={0.7}>
              <Ionicons name="share-outline" size={16} color={c.primary} />
              <Text style={s.actionBtnText}>Share</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={s.caption}>Code does not expire</Text>
      </View>

      <TouchableOpacity style={s.doneBtn} onPress={() => navigation.navigate('Home')} activeOpacity={0.8}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
