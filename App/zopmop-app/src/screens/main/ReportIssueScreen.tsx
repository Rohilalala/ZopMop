import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { fileDispute, DISPUTE_REASON_LABELS, type DisputeReason } from '../../api/disputes';
import { PressFx } from '../../components/ui/PressFx';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { friendlyError } from '../../utils/errors';
import { showError, showSuccess } from '../../utils/toast';
import { haptics } from '../../utils/haptics';

const fontMed:  TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };

const REASONS = Object.entries(DISPUTE_REASON_LABELS) as [DisputeReason, string][];

type Nav = NativeStackNavigationProp<MainStackParamList, 'ReportIssue'>;
type Route = RouteProp<MainStackParamList, 'ReportIssue'>;

export default function ReportIssueScreen() {
  const { isDark } = useTheme();
  const c = useC();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { token } = useAuth();

  const { bookingId, serviceName } = route.params;

  const [selectedReason, setSelectedReason] = useState<DisputeReason | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = selectedReason !== null && description.trim().length >= 10 && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !token || !selectedReason) return;
    haptics.medium();
    setSubmitting(true);
    try {
      await fileDispute(token, bookingId, selectedReason, description.trim());
      showSuccess('Dispute filed. We will review within 48 hours.');
      navigation.goBack();
    } catch (err) {
      showError(friendlyError(err, 'Couldn’t file your dispute. Please try again.'), { title: 'Could not file dispute' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={12}>
          <Feather name="x" size={22} color={c.textSecondary} />
        </TouchableOpacity>
        <Text style={[fontBold, styles.title]}>Report an issue</Text>
        {serviceName ? (
          <Text style={[fontMed, styles.subtitle]} numberOfLines={1}>{serviceName}</Text>
        ) : null}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Reason picker */}
          <Text style={[fontSemi, styles.sectionLabel]}>What went wrong?</Text>
          <View style={styles.reasonGrid}>
            {REASONS.map(([value, label]) => {
              const active = selectedReason === value;
              return (
                <PressFx
                  key={value}
                  onPress={() => { haptics.light(); setSelectedReason(value); }}
                  style={[styles.reasonChip, active && styles.reasonChipActive]}
                >
                  <Text style={[fontMed, styles.reasonLabel, active && styles.reasonLabelActive]}>
                    {label}
                  </Text>
                </PressFx>
              );
            })}
          </View>

          {/* Description */}
          <Text style={[fontSemi, styles.sectionLabel]}>Tell us more</Text>
          <TextInput
            style={styles.input}
            value={description}
            onChangeText={setDescription}
            placeholder="Describe what happened (min 10 characters)..."
            placeholderTextColor={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.35)'}
            multiline
            numberOfLines={5}
            maxLength={2000}
            textAlignVertical="top"
          />
          <Text style={[fontMed, styles.charCount]}>{description.length}/2000</Text>

          {/* Submit */}
          <PressFx
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          >
            {submitting ? (
              <Text style={[fontBold, styles.submitLabel]}>Submitting...</Text>
            ) : (
              <Text style={[fontBold, styles.submitLabel]}>Submit dispute</Text>
            )}
          </PressFx>

          <Text style={[fontMed, styles.footNote]}>
            Our team reviews disputes within 48 hours. You may be contacted for more information.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). Dark stays #0A0A0A + amber #F5A300 identical; light adds the cream bg
// + amber. Ink on the amber submit button stays #0D0D0F in both themes.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Input / chip fill (rgba(255,255,255,0.06) in dark) → glassHi token.
  // The two dim caption greys (0.25 / 0.30) sit below textMuted (0.45), so they
  // fork to keep dark pixel-identical rather than brightening to the token.
  const dimCaption = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.35)';
  const footCaption = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(13,13,15,0.40)';

  return StyleSheet.create({
    root:              { flex: 1, backgroundColor: c.bg },
    header:            { paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassBorder },
    backBtn:           { alignSelf: 'flex-start', marginBottom: 12 },
    title:             { fontSize: 22, color: c.text, marginBottom: 2 },
    subtitle:          { fontSize: 13, color: c.textMuted },
    scroll:            { flex: 1 },
    content:           { padding: 20, gap: 12 },
    sectionLabel:      { fontSize: 14, color: c.textSecondary, marginTop: 8, marginBottom: 4 },
    reasonGrid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    reasonChip:        { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: c.glassHi, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassBorderHi },
    reasonChipActive:  { backgroundColor: 'rgba(245,163,0,0.15)', borderColor: c.amber },
    reasonLabel:       { fontSize: 13, color: c.textSecondary },
    reasonLabelActive: { color: c.amber },
    input:             { backgroundColor: c.glassHi, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassBorderHi, padding: 14, color: c.text, fontSize: 14, minHeight: 120, marginTop: 4 },
    charCount:         { fontSize: 11, color: dimCaption, textAlign: 'right' },
    submitBtn:         { backgroundColor: c.amber, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
    submitBtnDisabled: { opacity: 0.35 },
    // Ink on amber — same in both themes.
    submitLabel:       { fontSize: 16, color: '#0D0D0F' },
    footNote:          { fontSize: 12, color: footCaption, textAlign: 'center', lineHeight: 18, marginTop: 4 },
  });
}
