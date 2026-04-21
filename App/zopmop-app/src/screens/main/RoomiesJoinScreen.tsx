import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { useColors } from '../../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { lightColors } from '../../theme/colors';
import { joinGroup } from '../../api/roomies';

type C = typeof lightColors;

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
      paddingHorizontal: Spacing.base,
      paddingTop: Spacing.xl,
    },
    instruction: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      lineHeight: 22,
      marginBottom: Spacing['3xl'],
    },
    digitRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: Spacing.sm,
      marginBottom: Spacing['3xl'],
    },
    digitBox: {
      width: 48,
      height: 56,
      borderRadius: Radius.lg,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.white,
    },
    digitBoxFilled: { borderColor: c.primary, backgroundColor: c.primaryBg },
    digitText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.text,
    },
    hiddenInput: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    joinBtn: {
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.xl,
      borderRadius: Radius.xl,
      paddingVertical: Spacing.md,
      alignItems: 'center',
      ...Shadow.sm,
    },
    joinBtnEnabled: { backgroundColor: c.primary },
    joinBtnDisabled: { backgroundColor: c.border },
    joinBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#FFF',
    },
  });
}

export default function RoomiesJoinScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const { refresh } = useRoomies();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleChangeText = useCallback((val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
  }, []);

  const handleJoin = useCallback(async () => {
    if (!token || code.length !== 6) return;
    setLoading(true);
    try {
      const resp = await joinGroup(token, code);
      await refresh();
      navigation.replace('RoomiesWelcome', {
        groupName: resp.group.name,
        addressLabel: resp.address_label,
        addressAdded: resp.address_added,
      });
    } catch (err: any) {
      Alert.alert('Could not join', err.message ?? 'Please check the code and try again.');
    } finally {
      setLoading(false);
    }
  }, [token, code, refresh, navigation]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Join a Household</Text>
      </View>

      <View style={s.body}>
        <Text style={s.instruction}>
          Ask your housemate for their 6-digit invite code and enter it below.
        </Text>

        {/* Digit display — tapping focuses the hidden input */}
        <TouchableOpacity style={s.digitRow} onPress={() => inputRef.current?.focus()} activeOpacity={1}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={[s.digitBox, code[i] ? s.digitBoxFilled : undefined]}>
              <Text style={s.digitText}>{code[i] ?? ''}</Text>
            </View>
          ))}
        </TouchableOpacity>

        {/* Hidden native input that drives the digit display */}
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

      <TouchableOpacity
        style={[s.joinBtn, code.length === 6 && !loading ? s.joinBtnEnabled : s.joinBtnDisabled]}
        onPress={handleJoin}
        activeOpacity={0.8}
        disabled={code.length !== 6 || loading}
      >
        {loading ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <Text style={s.joinBtnText}>Join Household</Text>
        )}
      </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
