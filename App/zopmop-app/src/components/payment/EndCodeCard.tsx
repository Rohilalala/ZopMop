// EndCodeCard — Phase 1 Step 5d shared "BIG 6-digit code" display.
// Same vocabulary the Start OTP card uses on TrackLive Step 5c
// (mockup spec .endcode-card / .endcode-digits / .endcode-helper),
// extracted into one component so Start + End OTP renders are
// visually identical and changing the treatment touches one place.
//
// Pure display — no input, no consume. Customer reads the digits
// aloud to the pro who types them into the pro app.

import React from 'react';
import { Platform, StyleSheet, Text, TextStyle, View } from 'react-native';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontMono: TextStyle = {
  fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
};

export interface EndCodeCardProps {
  /** The OTP digits. Empty string renders nothing — caller should
   *  gate on this. */
  code: string;
  /** Small uppercase label above the digits. Typical: "START CODE"
   *  or "END CODE". */
  label: string;
  /** Helper line below the digits. Typical: "Show this code to your
   *  pro to start." or "Read this code to {pro}". */
  helper?: string;
}

export default function EndCodeCard({ code, label, helper }: EndCodeCardProps) {
  if (!code || code.length === 0) return null;
  return (
    <View style={s.card}>
      <Text style={[fontBold, s.label]}>{label}</Text>
      <View style={s.digits}>
        {code.split('').map((d, i) => (
          <View key={i} style={s.digit}>
            <Text style={[fontMono, s.digitText]}>{d}</Text>
          </View>
        ))}
      </View>
      {helper ? (
        <Text style={[fontMed, s.helper]}>{helper}</Text>
      ) : null}
    </View>
  );
}

// Hardcoded dark tokens match the existing TrackLive / customer-side
// surfaces (the screen pre-dates the useColors() convention; whole-
// screen migration happens when the appearance-toast branch lands —
// see docs/phase-1-payment-gated-flow.md theme-hook section).
const s = StyleSheet.create({
  card: {
    marginTop: 18,
    marginHorizontal: 20,
    paddingVertical: 26,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.22)',
    alignItems: 'center',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: 'rgba(255,255,255,0.60)',
    marginBottom: 14,
    textTransform: 'uppercase',
  },
  digits: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  digit: {
    width: 42,
    height: 60,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  digitText: { fontSize: 34, fontWeight: '700', letterSpacing: -0.5, color: '#FFFFFF' },
  helper: {
    marginTop: 18,
    marginHorizontal: 28,
    textAlign: 'center',
    fontSize: 12.5,
    lineHeight: 17,
    color: 'rgba(255,255,255,0.5)',
  },
});
