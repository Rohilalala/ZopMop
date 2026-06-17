import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';

const OTP_LEN = 4;

interface Props {
  visible: boolean;
  title: string;
  cta: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (otp: string) => void;
  onClose: () => void;
}

export function OtpSheet({ visible, title, cta, busy, error, onSubmit, onClose }: Props) {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const refs = useRef<(TextInput | null)[]>([]);

  // Clear any previously-typed digits each time the sheet opens — otherwise the
  // component stays mounted and the START code pre-fills the END-OTP sheet
  // (guaranteed-wrong submission that also burns an attempt counter).
  useEffect(() => {
    if (visible) setDigits(Array(OTP_LEN).fill(''));
  }, [visible]);

  function reset() {
    setDigits(Array(OTP_LEN).fill(''));
    onClose();
  }
  function change(i: number, text: string) {
    const cleaned = text.replace(/\D/g, '');
    if (cleaned.length === OTP_LEN) {
      setDigits(cleaned.split(''));
      refs.current[OTP_LEN - 1]?.focus();
      return;
    }
    const d = cleaned.slice(-1);
    if (!d) return;
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (i < OTP_LEN - 1) refs.current[i + 1]?.focus();
  }
  function keyPress(i: number, key: string) {
    if (key === 'Backspace' && !digits[i] && i > 0) {
      const next = [...digits];
      next[i - 1] = '';
      setDigits(next);
      refs.current[i - 1]?.focus();
    }
  }

  const code = digits.join('');
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={reset}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={{ flex: 1 }} onPress={reset} />
        <View style={s.sheet} onStartShouldSetResponder={() => true}>
          <View style={s.handle} />
          <Text style={s.title}>{title}</Text>
          <View style={s.row}>
            {digits.map((d, i) => (
              <TextInput
                key={i}
                ref={(r) => {
                  refs.current[i] = r;
                }}
                style={[s.box, d ? s.boxFilled : null, error ? s.boxError : null]}
                value={d}
                onChangeText={(t) => change(i, t)}
                onKeyPress={({ nativeEvent }) => keyPress(i, nativeEvent.key)}
                keyboardType="number-pad"
                maxLength={OTP_LEN}
                selectTextOnFocus
                autoFocus={i === 0}
              />
            ))}
          </View>
          {!!error && <Text style={s.error}>{error}</Text>}
          <Pressable
            style={[s.cta, code.length < OTP_LEN || busy ? s.ctaDisabled : null]}
            disabled={code.length < OTP_LEN || busy}
            onPress={() => onSubmit(code)}
          >
            <Text style={s.ctaText}>{cta}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const BOX = 52;
const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#E2E2E2',
    borderRadius: 999,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  box: {
    width: BOX,
    height: BOX + 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#E2E2E2',
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  boxFilled: { borderColor: '#F5A300', backgroundColor: 'rgba(245,163,0,0.12)' },
  boxError: { borderColor: '#E5484D', backgroundColor: '#FFF0F0' },
  error: { color: '#E5484D', fontSize: 13, marginTop: 10, textAlign: 'center' },
  cta: { backgroundColor: '#F5A300', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
