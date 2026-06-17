// RoomiesCodeShareScreen — dark home pattern.
// Big invite-code display (3+3 split), copy + share actions, done CTA.

import React, { useMemo } from 'react';
import {
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { showInfo } from '../../utils/toast';

import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Props = NativeStackScreenProps<MainStackParamList, 'RoomiesCodeShare'>;

export default function RoomiesCodeShareScreen({ route }: Props) {
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { code, groupName } = route.params;

  const displayCode = `${code.slice(0, 3)} ${code.slice(3)}`;

  const handleCopy = () => {
    showInfo(`Your invite code is: ${displayCode}`, { title: 'Code copied' });
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Join my household on ZopMop! Use code: ${displayCode}`,
      });
    } catch {
      // Share sheet failed to open (not user dismissal) — surface the code so
      // they can copy it manually instead of the button doing nothing.
      showInfo(`Your invite code is: ${displayCode}`, { title: "Couldn't open share" });
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <View style={[styles.head, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={styles.iconBtn}>
            <Feather name="chevron-left" size={18} color={c.text} />
          </PressFx>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Invite code</Text>
          </View>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <View style={styles.iconRing} />
          <View style={styles.iconCircle}>
            <Feather name="users" size={32} color={c.amber} />
          </View>
        </View>

        <Text style={styles.groupName}>{groupName}</Text>
        <Text style={styles.subtitle}>
          Share this code with up to 3 housemates to let them join.
        </Text>

        <GlassCard radius={22} style={styles.codeCard}>
          <Text style={styles.codeLabel}>Invite code</Text>
          <Text style={styles.codeValue}>{displayCode}</Text>
          <View style={styles.copyRow}>
            <PressFx style={styles.actionBtn} onPress={handleCopy}>
              <Feather name="copy" size={14} color={c.amber} />
              <Text style={styles.actionBtnText}>Copy</Text>
            </PressFx>
            <PressFx style={styles.actionBtn} onPress={handleShare}>
              <Feather name="share-2" size={14} color={c.amber} />
              <Text style={styles.actionBtnText}>Share</Text>
            </PressFx>
          </View>
        </GlassCard>

        <Text style={styles.caption}>Code does not expire.</Text>
      </View>

      <PressFx
        style={[styles.doneBtn, { marginBottom: 12 + insets.bottom }]}
        onPress={() => navigation.navigate('Home')}
      >
        <Text style={styles.doneBtnText}>Done</Text>
      </PressFx>
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors).
// useColors()'s dark palette is Slate, which would change this screen's dark
// look and fork the amber — breaking "dark pixel-identical" + "amber #F5A300 in
// both". useC() keeps dark at #0A0A0A / #F5A300 (identical) and carries the
// cream + amber-radial light bg, matching the other migrated screens.
function makeStyles(c: ScreenColors, _isDark: boolean) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },

    head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    iconBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glassHi,
      borderWidth: 0.5, borderColor: c.glassBorderHi,
    },
    title: {
      ...fontExtra,
      fontSize: 24, color: c.text,
      letterSpacing: -0.6, lineHeight: 28,
    },

    body: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      paddingBottom: 40,
    },

    iconWrap: {
      width: 110, height: 110,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 18,
    },
    iconRing: {
      position: 'absolute',
      width: 110, height: 110, borderRadius: 55,
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.18)',
    },
    iconCircle: {
      width: 76, height: 76, borderRadius: 38,
      backgroundColor: c.amberSoft,
      borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
      alignItems: 'center', justifyContent: 'center',
    },

    groupName: {
      ...fontExtra,
      fontSize: 22,
      color: c.text,
      letterSpacing: -0.5,
      textAlign: 'center',
      marginBottom: 6,
    },
    subtitle: {
      ...fontMed,
      fontSize: 13.5,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 28,
      paddingHorizontal: 8,
    },

    codeCard: {
      width: '100%',
      paddingVertical: 22,
      paddingHorizontal: 22,
      alignItems: 'center',
      marginBottom: 18,
    },
    codeLabel: {
      ...fontBold,
      fontSize: 10,
      color: c.textMuted,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginBottom: 12,
    },
    codeValue: {
      ...fontExtra,
      fontSize: 40,
      color: c.amber,
      letterSpacing: 8,
      marginBottom: 16,
    },
    copyRow: { flexDirection: 'row', gap: 10 },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: c.amberSoft,
      borderWidth: 0.5,
      borderColor: 'rgba(245,163,0,0.28)',
    },
    actionBtnText: {
      ...fontSemi,
      fontSize: 12.5,
      color: c.amber,
    },
    caption: {
      ...fontMed,
      fontSize: 12,
      color: c.textMuted,
      textAlign: 'center',
    },

    doneBtn: {
      marginHorizontal: 20,
      backgroundColor: c.amber,
      borderRadius: 18,
      paddingVertical: 16,
      alignItems: 'center',
    },
    doneBtnText: {
      ...fontBold,
      fontSize: 14.5,
      color: '#0A0A0A', // Ink on amber — same in both themes.
      letterSpacing: 0.2,
    },
  });
}
