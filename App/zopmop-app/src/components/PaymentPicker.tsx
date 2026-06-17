// PaymentPicker — wallet applicator + when→method chooser. When the wallet is
// applied the remainder is online-only (Pay-after is not offered, D13); when
// it isn't, the customer picks Pay-now (Cashfree) vs Pay-after (cash/online
// later). `planFor` collapses the two flags into the funding rail the cart maps
// onto `payment_source`.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../theme';
import { useC } from '../theme/screen';
import { useTheme } from '../context/ThemeContext';

export type PayPlan =
  | { kind: 'wallet_full' }                 // wallet covers total
  | { kind: 'wallet_split' }                // wallet partial + online remainder
  | { kind: 'online' }                      // pay now, online, no wallet
  | { kind: 'pay_after' };                  // cod

export function PaymentPicker({
  totalPaise, walletBalancePaise, value, onChange,
}: {
  totalPaise: number;
  walletBalancePaise: number | null;        // null = not yet fetched
  value: { useWallet: boolean; payWhen: 'now' | 'after' };
  onChange: (next: { useWallet: boolean; payWhen: 'now' | 'after' }) => void;
}) {
  const c = useC();
  const { isDark } = useTheme();
  const bal = walletBalancePaise ?? 0;
  const applied = Math.min(bal, totalPaise);
  const covers = bal >= totalPaise && bal > 0;
  // Theme-aware hairlines: the static rgba(13,13,15,…) borders vanish on a dark
  // background, so the wallet row + checkbox were invisible in dark mode.
  const rowBorder = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(13,13,15,0.10)';
  const checkBorder = isDark ? 'rgba(255,255,255,0.30)' : 'rgba(13,13,15,0.20)';
  // When wallet is applied, the remainder is online-only → force payWhen='now'
  // and the Pay-after option is not offered (D13). `PayCard` below is modeled
  // verbatim on the existing `PaymentSourceCard` (lightweight selectable card,
  // NOT a filled CTA). `pp` styles via StyleSheet.create following the file's
  // existing style patterns.
  return (
    <View style={pp.wrap}>
      {bal > 0 && (
        <Pressable
          style={[pp.walletRow, { borderColor: rowBorder }, value.useWallet && pp.walletRowOn]}
          onPress={() => onChange({ useWallet: !value.useWallet, payWhen: 'now' })}
        >
          <Feather name="zap" size={16} color={c.amber} />
          <Text style={pp.walletText}>Use wallet (₹{(bal / 100).toFixed(0)} available)</Text>
          <View style={[pp.check, { borderColor: checkBorder }, value.useWallet && pp.checkOn]}>
            {value.useWallet && <Feather name="check" size={12} color={c.ink} />}
          </View>
        </Pressable>
      )}
      {value.useWallet && !covers && (
        <Text style={pp.hint}>
          ₹{(applied / 100).toFixed(0)} from wallet + ₹{((totalPaise - applied) / 100).toFixed(0)} online
        </Text>
      )}
      {value.useWallet && covers && <Text style={pp.hint}>Paid fully from wallet</Text>}
      {!value.useWallet && (
        <View style={pp.whenRow}>
          <PayCard label="Pay now" sub="UPI, card, netbanking" active={value.payWhen === 'now'}
            onPress={() => onChange({ useWallet: false, payWhen: 'now' })} />
          <PayCard label="Pay after service" sub="Cash, or pay online anytime" active={value.payWhen === 'after'}
            onPress={() => onChange({ useWallet: false, payWhen: 'after' })} />
        </View>
      )}
    </View>
  );
}

// PayCard — copy the existing PaymentSourceCard component (selectable card,
// title + subtitle + selected ring). Kept private to this file.
function PayCard({ label, sub, active, onPress }: { label: string; sub: string; active: boolean; onPress: () => void }) {
  const c = useC();
  const { isDark } = useTheme();
  const tint = '#F5A300';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}. ${sub}.`}
      style={[
        pp.card,
        {
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#FFFFFF',
          borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.06)',
        },
        active && [
          pp.cardSelected,
          !isDark && {
            backgroundColor: 'rgba(245,163,0,0.08)',
            borderColor: 'rgba(245,163,0,0.40)',
          },
        ],
      ]}
    >
      <View style={pp.iconRow}>
        <Feather name={label === 'Pay now' ? 'credit-card' : 'clock'} size={14} color={tint} />
        {active ? (
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Feather name="check-circle" size={16} color={tint} />
          </View>
        ) : null}
      </View>
      <Text style={[pp.cardTitle, { color: c.text }]}>{label}</Text>
      <Text style={[pp.cardSub, { color: c.textSecondary }]} numberOfLines={2}>{sub}</Text>
    </Pressable>
  );
}

export function planFor(useWallet: boolean, payWhen: 'now' | 'after', totalPaise: number, walletBalancePaise: number | null): PayPlan {
  const bal = walletBalancePaise ?? 0;
  if (useWallet && bal > 0) return bal >= totalPaise ? { kind: 'wallet_full' } : { kind: 'wallet_split' };
  return payWhen === 'after' ? { kind: 'pay_after' } : { kind: 'online' };
}

const pp = StyleSheet.create({
  wrap: { gap: 10 },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(13,13,15,0.06)',
  },
  walletRowOn: {
    borderColor: 'rgba(245,163,0,0.55)',
    backgroundColor: 'rgba(245,163,0,0.10)',
  },
  walletText: { flex: 1, fontFamily: FontFamily.bold, fontSize: 13.5, color: '#F5A300', letterSpacing: -0.1 },
  check: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5, borderColor: 'rgba(13,13,15,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: '#F5A300', borderColor: '#F5A300' },
  hint: { fontFamily: FontFamily.medium, fontSize: 11.5, color: '#E88F00', marginLeft: 4 },
  whenRow: { flexDirection: 'row', gap: 10 },
  card: {
    flex: 1,
    minHeight: 92,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    gap: 6,
  },
  cardSelected: {
    borderColor: 'rgba(245,163,0,0.55)',
    backgroundColor: 'rgba(245,163,0,0.10)',
    shadowColor: '#F5A300',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontFamily: FontFamily.bold, fontSize: 14, letterSpacing: -0.1 },
  cardSub: { fontFamily: FontFamily.medium, fontSize: 11.5, lineHeight: 15 },
});
