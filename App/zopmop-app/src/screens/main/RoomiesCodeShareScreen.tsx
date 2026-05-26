// RoomiesCodeShareScreen — dark home pattern.
// Big invite-code display (3+3 split), copy + share actions, done CTA.

import React from 'react';
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
  const { isDark } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { code, groupName } = route.params;

  const displayCode = `${code.slice(0, 3)} ${code.slice(3)}`;

  const handleCopy = () => {
    showInfo(`Your invite code is: ${displayCode}`, { title: 'Code copied' });
  };

  const handleShare = async () => {
    await Share.share({
      message: `Join my household on ZopMop! Use code: ${displayCode}`,
    });
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <View style={s.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
            <Feather name="chevron-left" size={18} color="#FFFFFF" />
          </PressFx>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Invite code</Text>
          </View>
        </View>
      </View>

      <View style={s.body}>
        <View style={s.iconWrap}>
          <View style={s.iconRing} />
          <View style={s.iconCircle}>
            <Feather name="users" size={32} color="#F5A300" />
          </View>
        </View>

        <Text style={s.groupName}>{groupName}</Text>
        <Text style={s.subtitle}>
          Share this code with up to 3 housemates to let them join.
        </Text>

        <GlassCard radius={22} style={s.codeCard}>
          <Text style={s.codeLabel}>Invite code</Text>
          <Text style={s.codeValue}>{displayCode}</Text>
          <View style={s.copyRow}>
            <PressFx style={s.actionBtn} onPress={handleCopy}>
              <Feather name="copy" size={14} color="#F5A300" />
              <Text style={s.actionBtnText}>Copy</Text>
            </PressFx>
            <PressFx style={s.actionBtn} onPress={handleShare}>
              <Feather name="share-2" size={14} color="#F5A300" />
              <Text style={s.actionBtnText}>Share</Text>
            </PressFx>
          </View>
        </GlassCard>

        <Text style={s.caption}>Code does not expire.</Text>
      </View>

      <PressFx
        style={[s.doneBtn, { marginBottom: 12 + insets.bottom }]}
        onPress={() => navigation.navigate('Home')}
      >
        <Text style={s.doneBtnText}>Done</Text>
      </PressFx>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  title: {
    ...fontExtra,
    fontSize: 24, color: '#FFFFFF',
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
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },

  groupName: {
    ...fontExtra,
    fontSize: 22,
    color: '#FFFFFF',
    letterSpacing: -0.5,
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    ...fontMed,
    fontSize: 13.5,
    color: 'rgba(255,255,255,0.55)',
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
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  codeValue: {
    ...fontExtra,
    fontSize: 40,
    color: '#F5A300',
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
    backgroundColor: 'rgba(245,163,0,0.12)',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.28)',
  },
  actionBtnText: {
    ...fontSemi,
    fontSize: 12.5,
    color: '#F5A300',
  },
  caption: {
    ...fontMed,
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
  },

  doneBtn: {
    marginHorizontal: 20,
    backgroundColor: '#F5A300',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
  },
  doneBtnText: {
    ...fontBold,
    fontSize: 14.5,
    color: '#0A0A0A',
    letterSpacing: 0.2,
  },
});
