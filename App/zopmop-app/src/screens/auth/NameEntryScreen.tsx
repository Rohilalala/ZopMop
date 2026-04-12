import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { updateMe } from '../../api/users';
import { pendingAuthStore } from '../../utils/pendingAuthStore';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'NameEntry'>;
  route: RouteProp<AuthStackParamList, 'NameEntry'>;
};

/** Maximum name length accepted by the app — matches backend validation. */
const NAME_MAX_LENGTH = 50;

/**
 * Sanitizes a display name:
 * - Strips leading/trailing whitespace.
 * - Collapses multiple internal spaces to a single space.
 * - Removes characters outside printable Unicode letters, spaces, hyphens, and apostrophes.
 *   This provides defense-in-depth even if the backend validates independently.
 */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M}'\- ]/gu, '');
}

export default function NameEntryScreen({ navigation, route }: Props) {
  const { phone } = route.params;
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<TextInput>(null);

  const sanitized = sanitizeName(name);
  const isValid = sanitized.length >= 2 && sanitized.length <= NAME_MAX_LENGTH;

  async function handleContinue() {
    if (!isValid) return;
    setError('');
    setLoading(true);

    try {
      const pending = pendingAuthStore.get();
      if (pending?.token) {
        // Send the sanitized name — never the raw input.
        const updatedUser = await updateMe(pending.token, sanitized);
        pendingAuthStore.set(pending.token, updatedUser);
      }
      navigation.replace('RoleSelection', { phone });
    } catch {
      // Best-effort — continue to next screen even if name save fails.
      navigation.replace('RoleSelection', { phone });
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.logoMark}>
              <Text style={styles.logoMarkText}>Z</Text>
            </View>
            <Text style={styles.title}>What's your name?</Text>
            <Text style={styles.subtitle}>
              We'll use this to personalise your experience.
            </Text>
          </View>

          {/* Input card */}
          <TouchableOpacity
            style={[styles.inputCard, error ? styles.inputCardError : null]}
            onPress={() => inputRef.current?.focus()}
            activeOpacity={1}
          >
            <TextInput
              ref={inputRef}
              style={styles.nameInput}
              value={name}
              onChangeText={(t) => { setName(t); if (error) setError(''); }}
              keyboardType="default"
              placeholder="Your full name"
              placeholderTextColor={Colors.textMuted}
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={handleContinue}
              autoCapitalize="words"
              autoFocus
            />
          </TouchableOpacity>

          {/* Error */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        {/* CTA */}
        <View style={styles.bottom}>
          <TouchableOpacity
            style={[
              styles.continueButton,
              (!isValid || loading) && styles.continueButtonDisabled,
            ]}
            onPress={handleContinue}
            disabled={!isValid || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color={Colors.white} size="small" />
            ) : (
              <Text style={styles.continueButtonText}>Continue</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing['4xl'],
  },

  header: { marginBottom: Spacing['3xl'], gap: Spacing.md },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  logoMarkText: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize.xl,
    color: Colors.white,
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    lineHeight: FontSize['3xl'] * 1.2,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: FontSize.base * 1.6,
  },

  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    height: 60,
    paddingHorizontal: Spacing.base,
    ...Shadow.sm,
  },
  inputCardError: {
    borderColor: Colors.danger,
  },
  nameInput: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xl,
    color: Colors.text,
    paddingVertical: 0,
  },

  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.danger,
    marginTop: Spacing.sm,
    marginLeft: Spacing.xs,
  },

  bottom: {
    paddingHorizontal: Spacing['2xl'],
    paddingBottom: Spacing['2xl'],
  },
  continueButton: {
    height: 54,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
  continueButtonDisabled: { opacity: 0.45 },
  continueButtonText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
