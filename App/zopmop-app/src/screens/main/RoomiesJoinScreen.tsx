// RoomiesJoinScreen — dark home pattern.
// 6-digit invite code entry. Hidden TextInput drives a row of glass digit boxes.

import React, { useCallback, useRef, useState } from 'react';
import {
  
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { joinGroup } from '../../api/roomies';
import { showError } from '../../utils/toast';

import { Bloom } from '../../components/home/Bloom';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

export default function RoomiesJoinScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { refresh } = useRoomies();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleChangeText = useCallback((val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (errorMessage) setErrorMessage('');
  }, [errorMessage]);

  const handleJoin = useCallback(async () => {
    if (!token || code.length !== 6) return;
    setLoading(true);
    setErrorMessage('');
    try {
      const resp = await joinGroup(token, code);
      await refresh();
      navigation.replace('RoomiesWelcome', {
        groupName: resp.group.name,
        addressLabel: resp.address_label,
        addressAdded: resp.address_added,
      });
    } catch (err: any) {
      const msg = err?.message ?? 'Please check the code and try again.';
      setErrorMessage(msg);
      showError(msg, { title: 'Could not join' });
    } finally {
      setLoading(false);
    }
  }, [token, code, refresh, navigation]);

  const ready = code.length === 6 && !loading;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headRow}>
            <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Join a household</Text>
              <Text style={s.sub}>Enter the 6-digit invite code.</Text>
            </View>
          </View>
        </View>

        <View style={s.body}>
          <Text style={s.instruction}>
            Ask your housemate for their invite code.
          </Text>

          <TouchableOpacity
            style={s.digitRow}
            onPress={() => inputRef.current?.focus()}
            activeOpacity={1}
          >
            {Array.from({ length: 6 }).map((_, i) => {
              const filled = !!code[i];
              return (
                <View
                  key={i}
                  style={[
                    s.digitBox,
                    filled && s.digitBoxFilled,
                    !!errorMessage && s.digitBoxError,
                  ]}
                >
                  <Text style={s.digitText}>{code[i] ?? ''}</Text>
                </View>
              );
            })}
          </TouchableOpacity>

          {!!errorMessage && <Text style={s.errorText}>{errorMessage}</Text>}

          <TextInput
            ref={inputRef}
            style={s.hiddenInput}
            value={code}
            onChangeText={handleChangeText}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            caretHidden
          />
        </View>

        <PressFx
          style={[s.joinBtn, !ready && s.joinBtnDisabled]}
          onPress={handleJoin}
          disabled={!ready}
        >
          {loading ? (
            <LoadingBars color="#0A0A0A" />
          ) : (
            <Text style={s.joinBtnText}>Join household</Text>
          )}
        </PressFx>
        <View style={{ height: insets.bottom || 16 }} />
      </KeyboardAvoidingView>
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
  sub: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  body: {
    flex: 1,
    paddingHorizontal: H_PAD,
    paddingTop: 24,
  },
  instruction: {
    ...fontMed,
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 28,
  },

  digitRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  digitBox: {
    width: 46, height: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center', justifyContent: 'center',
  },
  digitBoxFilled: {
    borderColor: 'rgba(245,163,0,0.55)',
    backgroundColor: 'rgba(245,163,0,0.08)',
  },
  digitBoxError: {
    borderColor: 'rgba(239,68,68,0.55)',
  },
  digitText: {
    ...fontBold,
    fontSize: 22, color: '#FFFFFF',
    letterSpacing: -0.4,
  },
  hiddenInput: {
    position: 'absolute',
    width: 1, height: 1,
    opacity: 0,
  },

  errorText: {
    ...fontMed,
    fontSize: 12.5,
    color: '#EF4444',
    textAlign: 'center',
    marginTop: 14,
  },

  joinBtn: {
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: '#F5A300',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
  },
  joinBtnDisabled: { opacity: 0.45 },
  joinBtnText: {
    ...fontBold,
    fontSize: 14.5,
    color: '#0A0A0A',
    letterSpacing: 0.2,
  },
});
