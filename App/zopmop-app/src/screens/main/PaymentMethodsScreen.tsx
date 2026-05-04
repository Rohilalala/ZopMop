import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Animated,
  
  StatusBar,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
  Rect,
  Circle,
  Text as SvgText,
  Path,
} from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { FontFamily } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { validateVpa } from '../../api/payments';

import { Bloom } from '../../components/home/Bloom';
import { PressFx } from '../../components/ui/PressFx';

type Nav = NativeStackNavigationProp<MainStackParamList>;

const C = {
  bg: '#0A0A0A',
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberLo: '#E88F00',
  ink: '#0D0D0F',
  white: '#FFFFFF',
  green: '#22C55E',
  upiPurple: '#5F259F',
  danger: '#EF4444',
};

type CardBrand = 'visa' | 'mastercard' | 'rupay' | 'amex' | 'diners' | 'discover' | 'jcb' | 'unknown';
type SavedCard = {
  id: string;
  brand: CardBrand;
  bank: string;
  last4: string;
  expiry: string;
  holder: string;
};
type SavedUpi = {
  id: string;
  vpa: string;
  label: string;
};

const CARDS_KEY = 'zopmop.paymentMethods.cards';
const UPI_KEY = 'zopmop.paymentMethods.upis';

function detectBrand(num: string): CardBrand {
  const n = num.replace(/\s+/g, '');
  if (!n) return 'unknown';
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(36|3[89]|30[0-5]|3095)/.test(n)) return 'diners';
  if (/^352[89]|^35[3-8]/.test(n)) return 'jcb';
  if (/^(6011|65|64[4-9]|622(1(2[6-9]|[3-9])|[2-8]|9([01]|2[0-5])))/.test(n)) return 'discover';
  if (/^(60|81|82|508|353|356)/.test(n)) return 'rupay';
  return 'unknown';
}

function brandLabel(b: CardBrand) {
  return ({
    visa: 'VISA', mastercard: 'MC', rupay: 'RUPAY',
    amex: 'AMEX', diners: 'DINERS', discover: 'DISC',
    jcb: 'JCB', unknown: 'CARD',
  })[b];
}

function brandBg(b: CardBrand) {
  return ({
    visa: '#1A1F71',
    mastercard: '#0A0A0A',
    rupay: '#0A0A0A',
    amex: '#016FD0',
    diners: '#0079BE',
    discover: '#0A0A0A',
    jcb: '#0A0A0A',
    unknown: '#1A1A1C',
  })[b];
}

function formatCardInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiryInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 4);
  if (d.length < 3) return d;
  return `${d.slice(0, 2)}/${d.slice(2)}`;
}

function isValidExpiry(exp: string): boolean {
  const m = exp.match(/^(\d{2})\/(\d{2})$/);
  if (!m) return false;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);
  return endOfMonth >= now;
}

function isValidVpa(vpa: string): boolean {
  return /^[\w.\-]{2,}@[a-z]{2,}$/i.test(vpa.trim());
}

// Module cache: SecureStore reads are async; without this the skeleton flashes
// every time the user re-enters the screen. Reads still happen on mount to
// pick up updates from other tabs / external writes.
const paymentMemCache: { cards: SavedCard[] | null; upis: SavedUpi[] | null } = {
  cards: null,
  upis:  null,
};

export default function PaymentMethodsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [cards, setCards] = useState<SavedCard[]>(paymentMemCache.cards ?? []);
  const [upis, setUpis] = useState<SavedUpi[]>(paymentMemCache.upis ?? []);
  const [loading, setLoading] = useState(paymentMemCache.cards == null);
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addUpiOpen, setAddUpiOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [cardsRaw, upisRaw] = await Promise.all([
          SecureStore.getItemAsync(CARDS_KEY),
          SecureStore.getItemAsync(UPI_KEY),
        ]);
        if (cardsRaw) {
          const parsed = JSON.parse(cardsRaw) as SavedCard[];
          setCards(parsed);
          paymentMemCache.cards = parsed;
        } else {
          paymentMemCache.cards = [];
        }
        if (upisRaw) {
          const parsed = JSON.parse(upisRaw) as SavedUpi[];
          setUpis(parsed);
          paymentMemCache.upis = parsed;
        } else {
          paymentMemCache.upis = [];
        }
      } catch {} finally {
        setLoading(false);
      }
    })();
  }, []);

  async function persistCards(next: SavedCard[]) {
    setCards(next);
    paymentMemCache.cards = next;
    try { await SecureStore.setItemAsync(CARDS_KEY, JSON.stringify(next)); } catch {}
  }
  async function persistUpis(next: SavedUpi[]) {
    setUpis(next);
    paymentMemCache.upis = next;
    try { await SecureStore.setItemAsync(UPI_KEY, JSON.stringify(next)); } catch {}
  }

  function confirmDelete(label: string, onConfirm: () => void) {
    Alert.alert('Remove payment method?', `${label} will be removed from your account.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: onConfirm },
    ]);
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
          <Feather name="chevron-left" size={18} color={C.white} />
        </PressFx>
        <View style={{ flex: 1 }}>
          <Text style={s.hTitle}>Payment methods</Text>
          <Text style={s.hSub}>Cards and UPI used for bookings.</Text>
        </View>
        <View style={s.secure}>
          <Feather name="lock" size={11} color={C.green} />
          <Text style={s.secureText}>Secure</Text>
        </View>
      </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 48 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          {loading ? (
            <LoadingSkeleton variant="list" rows={3} />
          ) : (
            <>
              <SectionHeader>Cards</SectionHeader>
              <View style={s.card}>
                {cards.length === 0 ? (
                  <EmptyState icon="credit-card" text="No saved cards yet." />
                ) : cards.map((card, i) => (
                  <React.Fragment key={card.id}>
                    <View style={s.row}>
                      <BrandMark brand={card.brand} width={44} height={28} />
                      <View style={s.rowText}>
                        <Text style={s.rowTitle}>{card.bank} •••• {card.last4}</Text>
                        <Text style={s.rowMeta}>Expires {card.expiry} · {card.holder}</Text>
                      </View>
                      <PressFx
                        onPress={() => confirmDelete(`${card.bank} •••• ${card.last4}`,
                          () => persistCards(cards.filter((c) => c.id !== card.id)))}
                        style={s.trashBtn}
                      >
                        <Feather name="trash-2" size={16} color={C.danger} />
                      </PressFx>
                    </View>
                    {i < cards.length - 1 && <View style={s.divider} />}
                  </React.Fragment>
                ))}
                <View style={s.divider} />
                <PressFx style={s.addRow} onPress={() => setAddCardOpen(true)}>
                  <View style={s.addIcon}>
                    <Feather name="plus" size={16} color={C.amber} />
                  </View>
                  <Text style={s.addText}>Add new card</Text>
                  <Feather name="chevron-right" size={14} color="rgba(255,255,255,0.4)" />
                </PressFx>
              </View>

              <SectionHeader>UPI</SectionHeader>
              <View style={s.card}>
                {upis.length === 0 ? (
                  <EmptyState icon="smartphone" text="No UPI IDs linked." />
                ) : upis.map((upi, i) => (
                  <React.Fragment key={upi.id}>
                    <View style={s.row}>
                      <View style={[s.cardMini, { backgroundColor: C.upiPurple, width: 36, height: 36, borderRadius: 10 }]}>
                        <Text style={[s.cardMiniText, { fontSize: 10 }]}>UPI</Text>
                      </View>
                      <View style={s.rowText}>
                        <Text style={s.rowTitle}>{upi.vpa}</Text>
                        <Text style={s.rowMeta}>{upi.label}</Text>
                      </View>
                      <PressFx
                        onPress={() => confirmDelete(upi.vpa,
                          () => persistUpis(upis.filter((u) => u.id !== upi.id)))}
                        style={s.trashBtn}
                      >
                        <Feather name="trash-2" size={16} color={C.danger} />
                      </PressFx>
                    </View>
                    {i < upis.length - 1 && <View style={s.divider} />}
                  </React.Fragment>
                ))}
                <View style={s.divider} />
                <PressFx style={s.addRow} onPress={() => setAddUpiOpen(true)}>
                  <View style={s.addIcon}>
                    <Feather name="plus" size={16} color={C.amber} />
                  </View>
                  <Text style={s.addText}>Link a UPI ID</Text>
                  <Feather name="chevron-right" size={14} color="rgba(255,255,255,0.4)" />
                </PressFx>
              </View>

              <View style={s.disclaim}>
                <Feather name="shield" size={12} color="rgba(255,255,255,0.4)" />
                <Text style={s.disclaimText}>
                  Card numbers are never stored. We keep only the last 4 digits, brand and expiry.
                </Text>
              </View>
            </>
          )}
        </ScrollView>

      <AddCardSheet
        visible={addCardOpen}
        onClose={() => setAddCardOpen(false)}
        onSave={(c) => { persistCards([...cards, c]); setAddCardOpen(false); }}
      />
      <AddUpiSheet
        visible={addUpiOpen}
        onClose={() => setAddUpiOpen(false)}
        onSave={(u) => { persistUpis([...upis, u]); setAddUpiOpen(false); }}
      />
    </View>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionHeader}>{children}</Text>;
}

function EmptyState({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Feather name={icon} size={18} color="rgba(255,255,255,0.45)" />
      </View>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

function AddCardSheet({
  visible, onClose, onSave,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (c: SavedCard) => void;
}) {
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [bank, setBank] = useState('');
  const [error, setError] = useState('');
  const slide = useRef(new Animated.Value(500)).current;

  useEffect(() => {
    if (visible) {
      setNumber(''); setHolder(''); setExpiry(''); setCvv(''); setBank(''); setError('');
      Animated.spring(slide, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220 }).start();
    } else {
      Animated.timing(slide, { toValue: 500, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);

  const digits = number.replace(/\s+/g, '');
  const brand = detectBrand(digits);

  function handleSave() {
    if (digits.length < 13 || digits.length > 19) { setError('Card number looks invalid.'); return; }
    if (!isValidExpiry(expiry)) { setError('Expiry must be a future MM/YY.'); return; }
    if (cvv.length < 3 || cvv.length > 4) { setError('CVV must be 3 or 4 digits.'); return; }
    if (holder.trim().length < 2) { setError('Cardholder name required.'); return; }
    onSave({
      id: `c_${Date.now()}`,
      brand,
      bank: bank.trim() || 'Card',
      last4: digits.slice(-4),
      expiry,
      holder: holder.trim(),
    });
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={sh.backdrop} activeOpacity={1} onPress={onClose} />
        <Animated.View style={[sh.sheet, { transform: [{ translateY: slide }] }]}>
          <View style={sh.handle} />
          <View style={sh.header}>
            <Text style={sh.title}>Add card</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={sh.close} activeOpacity={0.7}>
              <Feather name="x" size={18} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>

          <Field label="Card number" icon="credit-card">
            <TextInput
              style={sh.input}
              value={number}
              onChangeText={(t) => { setNumber(formatCardInput(t)); if (error) setError(''); }}
              placeholder="1234 5678 9012 3456"
              placeholderTextColor="rgba(255,255,255,0.35)"
              keyboardType="number-pad"
              maxLength={23}
            />
            <BrandMark brand={brand} />
          </Field>

          <Field label="Cardholder name" icon="user">
            <TextInput
              style={sh.input}
              value={holder}
              onChangeText={(t) => { setHolder(t); if (error) setError(''); }}
              placeholder="Name on card"
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="words"
              maxLength={40}
            />
          </Field>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Field label="Expiry" icon="calendar">
                <TextInput
                  style={sh.input}
                  value={expiry}
                  onChangeText={(t) => { setExpiry(formatExpiryInput(t)); if (error) setError(''); }}
                  placeholder="MM/YY"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="number-pad"
                  maxLength={5}
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="CVV" icon="lock">
                <TextInput
                  style={sh.input}
                  value={cvv}
                  onChangeText={(t) => { setCvv(t.replace(/\D/g, '').slice(0, 4)); if (error) setError(''); }}
                  placeholder="•••"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                />
              </Field>
            </View>
          </View>

          <Field label="Bank or nickname" icon="briefcase" optional>
            <TextInput
              style={sh.input}
              value={bank}
              onChangeText={setBank}
              placeholder="HDFC Bank"
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="words"
              maxLength={30}
            />
          </Field>

          {error ? <Text style={sh.error}>{error}</Text> : null}

          <TouchableOpacity activeOpacity={0.9} onPress={handleSave} style={sh.saveBtn}>
            <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
              <Defs>
                <SvgLinearGradient id="saveGrad" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0%" stopColor={C.amberHi} />
                  <Stop offset="60%" stopColor={C.amber} />
                  <Stop offset="100%" stopColor={C.amberLo} />
                </SvgLinearGradient>
              </Defs>
              <Rect width="100%" height="100%" rx="14" fill="url(#saveGrad)" />
            </Svg>
            <Text style={sh.saveText}>Save card</Text>
          </TouchableOpacity>
          <Text style={sh.disclaim}>
            Card number is verified locally. Only last 4 digits, brand and expiry are stored.
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'valid'; name: string }
  | { kind: 'invalid'; message: string };

function AddUpiSheet({
  visible, onClose, onSave,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (u: SavedUpi) => void;
}) {
  const { token } = useAuth();
  const [vpa, setVpa] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const slide = useRef(new Animated.Value(500)).current;
  const verifySeq = useRef(0);

  useEffect(() => {
    if (visible) {
      setVpa(''); setLabel(''); setError(''); setVerify({ kind: 'idle' });
      Animated.spring(slide, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220 }).start();
    } else {
      Animated.timing(slide, { toValue: 500, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (!isValidVpa(vpa)) {
      setVerify({ kind: 'idle' });
      return;
    }
    if (!token || token === '__guest__') {
      setVerify({ kind: 'idle' });
      return;
    }
    setVerify({ kind: 'checking' });
    const seq = ++verifySeq.current;
    const handle = setTimeout(async () => {
      try {
        const res = await validateVpa(token, vpa.trim().toLowerCase());
        if (seq !== verifySeq.current) return;
        if (res.valid) {
          setVerify({ kind: 'valid', name: res.customer_name?.trim() || 'Verified' });
        } else {
          setVerify({ kind: 'invalid', message: 'UPI ID not found.' });
        }
      } catch (err) {
        if (seq !== verifySeq.current) return;
        const msg = err instanceof Error ? err.message : 'Verification unavailable.';
        setVerify({ kind: 'invalid', message: msg });
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [vpa, visible, token]);

  function handleSave() {
    if (!isValidVpa(vpa)) { setError('UPI ID looks invalid.'); return; }
    if (verify.kind !== 'valid') { setError('Verify the UPI ID first.'); return; }
    onSave({
      id: `u_${Date.now()}`,
      vpa: vpa.trim().toLowerCase(),
      label: label.trim() || verify.name || 'Personal',
    });
  }

  const canSave = verify.kind === 'valid';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={sh.backdrop} activeOpacity={1} onPress={onClose} />
        <Animated.View style={[sh.sheet, { transform: [{ translateY: slide }] }]}>
          <View style={sh.handle} />
          <View style={sh.header}>
            <Text style={sh.title}>Link a UPI ID</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={sh.close} activeOpacity={0.7}>
              <Feather name="x" size={18} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>

          <Field label="UPI ID" icon="at-sign">
            <TextInput
              style={sh.input}
              value={vpa}
              onChangeText={(t) => { setVpa(t.replace(/\s+/g, '')); if (error) setError(''); }}
              placeholder="yourname@bank"
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              maxLength={50}
            />
            <VerifyBadge state={verify} />
          </Field>

          <Field label="Label" icon="tag" optional>
            <TextInput
              style={sh.input}
              value={label}
              onChangeText={setLabel}
              placeholder={verify.kind === 'valid' ? verify.name : 'Personal'}
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="words"
              maxLength={30}
            />
          </Field>

          {error ? <Text style={sh.error}>{error}</Text> : null}

          <TouchableOpacity
            activeOpacity={0.9}
            onPress={handleSave}
            disabled={!canSave}
            style={[sh.saveBtn, !canSave && { opacity: 0.4 }]}
          >
            <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
              <Defs>
                <SvgLinearGradient id="upiSaveGrad" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0%" stopColor={C.amberHi} />
                  <Stop offset="60%" stopColor={C.amber} />
                  <Stop offset="100%" stopColor={C.amberLo} />
                </SvgLinearGradient>
              </Defs>
              <Rect width="100%" height="100%" rx="14" fill="url(#upiSaveGrad)" />
            </Svg>
            <Text style={sh.saveText}>Save UPI ID</Text>
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function VerifyBadge({ state }: { state: VerifyState }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'checking') {
    return (
      <View style={sh.verifyBadge}>
        <LoadingBars size="small" color="rgba(255,255,255,0.6)" />
      </View>
    );
  }
  if (state.kind === 'valid') {
    return (
      <View style={[sh.verifyBadge, { backgroundColor: 'rgba(34,197,94,0.16)' }]}>
        <Feather name="check" size={12} color={C.green} />
        <Text style={[sh.verifyText, { color: C.green }]} numberOfLines={1}>{state.name}</Text>
      </View>
    );
  }
  return (
    <View style={[sh.verifyBadge, { backgroundColor: 'rgba(239,68,68,0.16)' }]}>
      <Feather name="x" size={12} color={C.danger} />
      <Text style={[sh.verifyText, { color: C.danger }]}>{state.message}</Text>
    </View>
  );
}

function BrandMark({ brand, width = 38, height = 24 }: { brand: CardBrand; width?: number; height?: number }) {
  if (brand === 'mastercard') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#0A0A0A" />
        <Circle cx="15" cy="12" r="6.2" fill="#EB001B" />
        <Circle cx="23" cy="12" r="6.2" fill="#F79E1B" fillOpacity="0.95" />
        <Path d="M19 7.2a6.2 6.2 0 0 0 0 9.6 6.2 6.2 0 0 0 0-9.6z" fill="#FF5F00" />
      </Svg>
    );
  }
  if (brand === 'visa') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#1A1F71" />
        <SvgText x="19" y="16" fontSize="10" fontWeight="900" fontStyle="italic"
          fill="#FFFFFF" textAnchor="middle" letterSpacing="0.5">VISA</SvgText>
        <Rect x="0" y="20" width="38" height="2" fill="#F7B600" />
      </Svg>
    );
  }
  if (brand === 'amex') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#016FD0" />
        <SvgText x="19" y="15.5" fontSize="8.5" fontWeight="900" fill="#FFFFFF"
          textAnchor="middle" letterSpacing="0.4">AMEX</SvgText>
      </Svg>
    );
  }
  if (brand === 'rupay') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#0A0A0A" />
        <SvgText x="4" y="16" fontSize="10" fontWeight="900" fontStyle="italic"
          fill="#F47216">Ru</SvgText>
        <SvgText x="16" y="16" fontSize="10" fontWeight="900" fontStyle="italic"
          fill="#0E8A47">Pay</SvgText>
      </Svg>
    );
  }
  if (brand === 'diners') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#0079BE" />
        <Circle cx="19" cy="12" r="7" fill="#FFFFFF" />
        <Path d="M16 6.6a6 6 0 0 0 0 10.8z" fill="#0079BE" />
        <Path d="M22 6.6a6 6 0 0 1 0 10.8z" fill="#0079BE" />
      </Svg>
    );
  }
  if (brand === 'discover') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#0A0A0A" />
        <SvgText x="19" y="14" fontSize="6.5" fontWeight="900" fill="#FFFFFF"
          textAnchor="middle" letterSpacing="0.3">DISCOVER</SvgText>
        <Circle cx="28" cy="14.5" r="3.2" fill="#FF6000" />
      </Svg>
    );
  }
  if (brand === 'jcb') {
    return (
      <Svg width={width} height={height} viewBox="0 0 38 24">
        <Rect width="38" height="24" rx="4" fill="#FFFFFF" />
        <Rect x="2" y="4" width="10" height="16" rx="1.5" fill="#0E4C96" />
        <Rect x="14" y="4" width="10" height="16" rx="1.5" fill="#BC2228" />
        <Rect x="26" y="4" width="10" height="16" rx="1.5" fill="#1B8B3E" />
        <SvgText x="7" y="15" fontSize="7" fontWeight="900" fill="#FFFFFF" textAnchor="middle">J</SvgText>
        <SvgText x="19" y="15" fontSize="7" fontWeight="900" fill="#FFFFFF" textAnchor="middle">C</SvgText>
        <SvgText x="31" y="15" fontSize="7" fontWeight="900" fill="#FFFFFF" textAnchor="middle">B</SvgText>
      </Svg>
    );
  }
  return (
    <Svg width={width} height={height} viewBox="0 0 38 24">
      <Rect width="38" height="24" rx="4" fill="#1A1A1C" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      <Rect x="6" y="9" width="26" height="2" rx="1" fill="rgba(255,255,255,0.4)" />
      <Rect x="6" y="13" width="14" height="2" rx="1" fill="rgba(255,255,255,0.25)" />
    </Svg>
  );
}

function Field({
  label, icon, optional, children,
}: {
  label: string;
  icon: keyof typeof Feather.glyphMap;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, marginLeft: 2 }}>
        <Text style={sh.fieldLabel}>{label}</Text>
        {optional && <Text style={sh.fieldOptional}>Optional</Text>}
      </View>
      <View style={sh.fieldCard}>
        <Feather name={icon} size={16} color="rgba(255,255,255,0.5)" />
        {children}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  head: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingBottom: 14,
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  hTitle: { fontFamily: FontFamily.extrabold, fontSize: 24, color: C.white, letterSpacing: -0.6, lineHeight: 28 },
  hSub: { fontFamily: FontFamily.medium, fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  secure: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: 99,
    backgroundColor: 'rgba(34,197,94,0.14)',
  },
  secureText: { fontFamily: FontFamily.semibold, fontSize: 10, color: C.green },

  sectionHeader: {
    fontFamily: FontFamily.bold, fontSize: 11, letterSpacing: 1.3,
    color: 'rgba(255,255,255,0.45)',
    paddingHorizontal: 24, paddingTop: 22, paddingBottom: 8,
    textTransform: 'uppercase',
  },

  card: {
    marginHorizontal: 20,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: FontFamily.bold, fontSize: 13.5, color: C.white, letterSpacing: -0.1, lineHeight: 16 },
  rowMeta: { fontFamily: FontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  trashBtn: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(239,68,68,0.10)',
  },
  cardMini: {
    width: 44, height: 28, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  cardMiniText: {
    fontFamily: FontFamily.extrabold, fontSize: 9,
    color: C.white, letterSpacing: 0.6,
  },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)' },

  addRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
  },
  addIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  addText: { flex: 1, fontFamily: FontFamily.bold, fontSize: 13.5, color: C.amber, letterSpacing: -0.1 },

  empty: {
    paddingVertical: 22, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  emptyIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  emptyText: { fontFamily: FontFamily.medium, fontSize: 12.5, color: 'rgba(255,255,255,0.5)' },

  disclaim: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 24, paddingTop: 22,
  },
  disclaimText: {
    flex: 1,
    fontFamily: FontFamily.medium, fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    lineHeight: 16,
  },
});

const sh = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#101012',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center', marginBottom: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  title: {
    flex: 1,
    fontFamily: FontFamily.extrabold, fontSize: 20,
    color: C.white, letterSpacing: -0.4,
  },
  close: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  fieldLabel: {
    fontFamily: FontFamily.semibold, fontSize: 12,
    color: 'rgba(255,255,255,0.65)',
  },
  fieldOptional: {
    fontFamily: FontFamily.medium, fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
  },
  fieldCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    height: 52, paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    fontFamily: FontFamily.semibold, fontSize: 15,
    color: C.white, paddingVertical: 0,
  },
  brandTag: {
    fontFamily: FontFamily.extrabold, fontSize: 9,
    color: C.amber, letterSpacing: 0.6,
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 99,
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  verifyBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.06)',
    maxWidth: 140,
  },
  verifyText: {
    fontFamily: FontFamily.semibold, fontSize: 10,
  },
  error: {
    fontFamily: FontFamily.semibold, fontSize: 12,
    color: '#EF4444', marginBottom: 10,
  },
  saveBtn: {
    height: 54, borderRadius: 14, marginTop: 6,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.amber, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  saveText: {
    fontFamily: FontFamily.extrabold, fontSize: 16,
    color: C.ink, letterSpacing: 0.2,
  },
  disclaim: {
    fontFamily: FontFamily.regular, fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center', marginTop: 12, lineHeight: 16,
  },
});
