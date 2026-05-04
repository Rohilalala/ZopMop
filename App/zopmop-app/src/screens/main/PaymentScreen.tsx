import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  StatusBar,
  NativeModules,
  NativeEventEmitter,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
  Path,
} from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { FontFamily } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import { clearCart } from '../../api/cart';
import { serviceIcon } from '../../components/home/serviceIcon';
import { haptics } from '../../utils/haptics';
import { showError, showSuccess, showInfo } from '../../utils/toast';
import { PrimaryButton } from '../../components/PrimaryButton';

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
  paytmBlue: '#00BAF2',
};

type PMKey = 'upi' | 'card' | 'wallet' | 'cod';
type UpiApp = 'gpay' | 'phonepe' | 'paytm' | 'upiid';

type SavedCard = {
  id: string;
  brand: 'visa' | 'rupay' | 'mastercard';
  bank: string;
  last4: string;
  expiry: string;
  holder?: string;
};

const SAVED_CARDS: SavedCard[] = [
  { id: 'c1', brand: 'visa',  bank: 'HDFC Bank', last4: '4521', expiry: '09/27', holder: 'Aarav R.' },
  { id: 'c2', brand: 'rupay', bank: 'SBI Card',  last4: '8847', expiry: '02/26' },
];

function getDigitsOnlyPhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.slice(-10);
}

const UPI_SCHEMES: Record<UpiApp, string[]> = {
  gpay:    ['tez://upi/pay', 'gpay://upi/pay'],
  phonepe: ['phonepe://pay'],
  paytm:   ['paytmmp://pay', 'paytm://pay'],
  upiid:   ['upi://pay'],
};

const MERCHANT_VPA = (process.env.EXPO_PUBLIC_MERCHANT_VPA ?? '').trim();

function buildUpiUri(scheme: string, opts: { vpa: string; name: string; amount: number; ref: string; note: string }) {
  const q = new URLSearchParams({
    pa: opts.vpa, pn: opts.name, am: opts.amount.toFixed(2),
    cu: 'INR', tr: opts.ref, tn: opts.note,
  }).toString();
  return `${scheme}?${q}`;
}

type RazorpayOptions = {
  key: string; amount: string; currency: 'INR'; name: string; description?: string;
  prefill?: { name?: string; contact?: string; email?: string; method?: string };
  method?: string;
  notes?: Record<string, string>;
  theme?: { color?: string };
};
type RazorpaySuccess = { razorpay_payment_id: string; razorpay_order_id?: string; razorpay_signature?: string };
type RazorpayFailure = { code?: number; description?: string };

function openRazorpayNative(options: RazorpayOptions): Promise<RazorpaySuccess> {
  const native = NativeModules as { RNRazorpayCheckout?: { open: (o: RazorpayOptions) => void }; RazorpayEventEmitter?: object };
  const checkoutModule = native.RNRazorpayCheckout;
  const eventSource = native.RazorpayEventEmitter ?? checkoutModule;
  if (!checkoutModule || typeof checkoutModule.open !== 'function' || !eventSource) {
    throw new Error('Razorpay native module is missing in this build. Rebuild with expo run:ios/android.');
  }
  const emitter = new NativeEventEmitter(eventSource as any);
  return new Promise<RazorpaySuccess>((resolve, reject) => {
    const onSuccess = emitter.addListener('Razorpay::PAYMENT_SUCCESS', (data: RazorpaySuccess) => {
      onSuccess.remove(); onError.remove(); resolve(data);
    });
    const onError = emitter.addListener('Razorpay::PAYMENT_ERROR', (data: RazorpayFailure) => {
      onSuccess.remove(); onError.remove(); reject(data);
    });
    try { checkoutModule.open(options); }
    catch (err) { onSuccess.remove(); onError.remove(); reject(err); }
  });
}

export default function PaymentScreen() {
  const navigation = useNavigation<Nav>();
  const { user, token } = useAuth();
  const { items: cartItems, subtotalCents, refreshCart } = useCart();
  const insets = useSafeAreaInsets();

  const [selectedPM, setSelectedPM] = useState<PMKey>('upi');
  const [selectedUpi, setSelectedUpi] = useState<UpiApp>('gpay');
  const [selectedCardId, setSelectedCardId] = useState<string>(SAVED_CARDS[0]?.id ?? '');
  const [useNewCard, setUseNewCard] = useState(false);
  const [offerApplied, setOfferApplied] = useState(true);
  const [paying, setPaying] = useState(false);
  const [address, setAddress] = useState<ApiAddress | null>(null);

  useEffect(() => { refreshCart(); }, [refreshCart]);

  useEffect(() => {
    if (!token || token === '__guest__') return;
    listAddresses(token)
      .then((list) => setAddress(list.find((a) => a.tag === 'Home') ?? list[0] ?? null))
      .catch(() => {});
  }, [token]);

  const items = useMemo(() => {
    if (cartItems.length === 0) return [];
    return cartItems.map((it) => ({
      id: it.id,
      title: it.service_name,
      sub: `${it.duration_minutes} min · auto-matching`,
      price: Math.round(it.price_cents / 100),
      img: serviceIcon({ id: it.service_id, name: it.service_name }),
    }));
  }, [cartItems]);

  const itemTotal = items.length > 0 ? Math.round(subtotalCents / 100) : 0;
  const hasItems = items.length > 0;
  const serviceFee = hasItems ? 15 : 0;
  const taxes = hasItems ? Math.round(itemTotal * 0.05) : 0;
  const discount = offerApplied && hasItems ? Math.min(150, Math.round(itemTotal * 0.5)) : 0;
  const undiscounted = itemTotal + serviceFee + taxes;
  const total = Math.max(0, undiscounted - discount);

  const upiAppLabel: Record<UpiApp, string> = {
    gpay: 'GPay', phonepe: 'PhonePe', paytm: 'Paytm', upiid: 'UPI ID',
  };

  const selectedCard = SAVED_CARDS.find((c) => c.id === selectedCardId);

  const ctaLabel = useMemo(() => {
    if (selectedPM === 'upi') return `Pay with ${upiAppLabel[selectedUpi]}`;
    if (selectedPM === 'card') return useNewCard ? 'Pay securely' : 'Pay securely';
    if (selectedPM === 'wallet') return 'Pay with wallet';
    return 'Confirm booking';
  }, [selectedPM, selectedUpi, useNewCard]);

  async function tryUpiDirectIntent(): Promise<boolean> {
    if (!MERCHANT_VPA) return false;
    const schemes = UPI_SCHEMES[selectedUpi];
    const ref = `ZOP${Date.now()}`;
    const note = items.map((i) => i.title).join(', ').slice(0, 50) || 'ZopMop';
    for (const scheme of schemes) {
      const uri = buildUpiUri(scheme, {
        vpa: MERCHANT_VPA, name: 'ZopMop', amount: total, ref, note,
      });
      try {
        const supported = await Linking.canOpenURL(uri);
        if (supported) {
          await Linking.openURL(uri);
          showInfo(
            `Complete the ₹${total} payment in ${upiAppLabel[selectedUpi]}. We'll confirm it once your bank acknowledges.`,
            { title: 'Confirm in your UPI app' },
          );
          return true;
        }
      } catch {}
    }
    return false;
  }

  async function handlePay() {
    if (!hasItems) {
      showError('Add a service before paying.', { title: 'Cart empty' });
      return;
    }
    haptics.medium();
    if (selectedPM === 'cod') {
      showInfo('Pay your pro after the job is done.', { title: 'Cash on completion' });
      return;
    }

    if (selectedPM === 'upi' && selectedUpi !== 'upiid') {
      setPaying(true);
      try {
        const launched = await tryUpiDirectIntent();
        if (launched) return;
      } finally {
        setPaying(false);
      }
    }

    const razorpayKeyId = (process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID ?? '').trim();
    if (!razorpayKeyId) {
      showError('Set EXPO_PUBLIC_RAZORPAY_KEY_ID in zopmop-app/.env and restart the app.', { title: 'Missing Razorpay key' });
      return;
    }
    const rzpMethod =
      selectedPM === 'upi' ? 'upi'
      : selectedPM === 'card' ? 'card'
      : selectedPM === 'wallet' ? 'wallet'
      : undefined;

    setPaying(true);
    try {
      const result = await openRazorpayNative({
        key: razorpayKeyId,
        amount: String(Math.round(total * 100)),
        currency: 'INR',
        name: 'ZopMop',
        description: items.map((i) => i.title).join(', '),
        method: rzpMethod,
        prefill: {
          name: user?.name,
          contact: getDigitsOnlyPhone(user?.phone),
          method: rzpMethod,
        },
        notes: {
          source: 'zopmop-payment-screen',
          method: selectedPM,
          upi_app: selectedPM === 'upi' ? selectedUpi : '',
          card_ref: selectedPM === 'card' && !useNewCard ? selectedCardId : '',
        },
        theme: { color: C.amber },
      });
      showSuccess(`Payment ID: ${result.razorpay_payment_id}`, { title: 'Payment success' });
      if (token && token !== '__guest__') {
        try { await clearCart(token); } catch {}
      }
      await refreshCart();
      navigation.reset({ index: 0, routes: [{ name: 'Bookings' }] });
    } catch (err) {
      const failure = err as RazorpayFailure;
      const message = failure.description?.trim() || (err as Error)?.message || 'Payment cancelled or failed.';
      showError(message, { title: 'Payment not completed' });
    } finally {
      setPaying(false);
    }
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
          <Text style={s.hTitle}>Payment</Text>
          <Text style={s.hSub}>Step 3 of 3 · arriving in ~6 min</Text>
        </View>
        <View style={s.secure}>
          <Feather name="lock" size={11} color={C.green} />
          <Text style={s.secureText}>Secure</Text>
        </View>
      </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 160 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          <SectionHeader>Order summary</SectionHeader>
          <Card>
            {items.length === 0 ? (
              <Text style={s.emptyText}>Your cart is empty.</Text>
            ) : (
              items.map((it, i) => (
                <React.Fragment key={it.id}>
                  <View style={s.ord}>
                    <View style={s.ordIcon}>
                      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
                        <Defs>
                          <SvgLinearGradient id={`ordBg-${it.id}`} x1="0" y1="0" x2="0" y2="1">
                            <Stop offset="0%" stopColor="#1A1A1C" />
                            <Stop offset="100%" stopColor="#0F0F11" />
                          </SvgLinearGradient>
                          <SvgRadialGradient id={`ordTop-${it.id}`} cx="50%" cy="18%" rx="120%" ry="90%">
                            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.10" />
                            <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
                          </SvgRadialGradient>
                          <SvgRadialGradient id={`ordBot-${it.id}`} cx="50%" cy="110%" rx="80%" ry="60%">
                            <Stop offset="0%" stopColor="#F5A300" stopOpacity="0.16" />
                            <Stop offset="70%" stopColor="#F5A300" stopOpacity="0" />
                          </SvgRadialGradient>
                        </Defs>
                        <Rect width="100%" height="100%" rx="11" fill={`url(#ordBg-${it.id})`} />
                        <Rect width="100%" height="100%" rx="11" fill={`url(#ordTop-${it.id})`} />
                        <Rect width="100%" height="100%" rx="11" fill={`url(#ordBot-${it.id})`} />
                      </Svg>
                      {it.img && <Image source={it.img} style={s.ordImg} resizeMode="contain" />}
                    </View>
                    <View style={s.ordMeta}>
                      <Text style={s.ordTitle} numberOfLines={1}>{it.title}</Text>
                      <Text style={s.ordSub} numberOfLines={1}>{it.sub}</Text>
                    </View>
                    <Text style={s.ordPrice}>₹{it.price}</Text>
                  </View>
                  {i < items.length - 1 && <View style={s.divider} />}
                </React.Fragment>
              ))
            )}
            <View style={s.divider} />
            <View style={s.addrRow}>
              <View style={s.addrPin}>
                <Feather name="map-pin" size={16} color={C.amber} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.addrTitle}>{address?.tag ?? 'No address'}</Text>
                <Text style={s.addrSub} numberOfLines={2}>
                  {address?.full_address ?? 'Add a delivery address to continue.'}
                </Text>
              </View>
              <PressFx onPress={() => navigation.navigate('Addresses')}>
                <Text style={s.change}>Change</Text>
              </PressFx>
            </View>
          </Card>

          <SectionHeader>Offer</SectionHeader>
          <PressFx
            style={[s.offer, offerApplied && s.offerApplied]}
            onPress={() => setOfferApplied((v) => !v)}
          >
            <View style={[s.offerIcon, offerApplied && { backgroundColor: C.green }]}>
              {offerApplied
                ? <Feather name="check" size={14} color={C.ink} />
                : <Feather name="zap" size={14} color={C.ink} />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.offerTitle}>
                {offerApplied ? 'FIRST50 applied' : '3 offers available'}
              </Text>
              <Text style={s.offerSub} numberOfLines={1}>
                {offerApplied ? '50% off your first booking · max ₹150' : 'Save up to ₹150 on this booking'}
              </Text>
            </View>
            {offerApplied
              ? <Text style={s.offerSaved}>−₹150</Text>
              : <Feather name="chevron-right" size={14} color="rgba(255,255,255,0.5)" />}
          </PressFx>

          <SectionHeader>Pay using</SectionHeader>
          <View style={[s.card, { padding: 6 }]}>
            <PMTile
              selected={selectedPM === 'upi'}
              onPress={() => setSelectedPM('upi')}
              logo={<View style={[s.pmLogo, s.lgUpi]}><Text style={s.pmLogoText}>UPI</Text></View>}
              title="UPI"
              tag="Recommended"
              meta="Instant · No fee"
              extra={<Text style={s.pmCb}>Earn ₹10 ZopMop credit</Text>}
            />
            {selectedPM === 'upi' && (
              <View style={s.upiGrid}>
                <UpiTile selected={selectedUpi === 'gpay'} onPress={() => setSelectedUpi('gpay')} label="GPay">
                  <Svg width="18" height="18" viewBox="0 0 24 24">
                    <Path fill="#4285F4" d="M21 12a9 9 0 1 1-3-6.7L15 8a5 5 0 1 0 1.3 5.5H12v-3h9z" />
                  </Svg>
                </UpiTile>
                <UpiTile selected={selectedUpi === 'phonepe'} onPress={() => setSelectedUpi('phonepe')} label="PhonePe">
                  <View style={[s.upiBubble, { backgroundColor: C.upiPurple }]}>
                    <Text style={s.upiBubbleText}>PP</Text>
                  </View>
                </UpiTile>
                <UpiTile selected={selectedUpi === 'paytm'} onPress={() => setSelectedUpi('paytm')} label="Paytm">
                  <View style={[s.upiBubble, { backgroundColor: C.paytmBlue }]}>
                    <Text style={[s.upiBubbleText, { fontSize: 9 }]}>Paytm</Text>
                  </View>
                </UpiTile>
                <UpiTile selected={selectedUpi === 'upiid'} onPress={() => setSelectedUpi('upiid')} label="UPI ID">
                  <View style={[s.upiBubble, { backgroundColor: 'rgba(255,255,255,0.08)' }]}>
                    <Feather name="plus" size={14} color="rgba(255,255,255,0.7)" />
                  </View>
                </UpiTile>
              </View>
            )}

            <View style={s.dividerInset} />

            <PMTile
              selected={selectedPM === 'card'}
              onPress={() => setSelectedPM('card')}
              logo={
                <View style={[s.pmLogo, s.lgCard]}>
                  <Feather name="credit-card" size={18} color={C.white} />
                </View>
              }
              title="Card"
              tag={SAVED_CARDS.length > 0 ? '5% off' : undefined}
              meta={SAVED_CARDS.length > 0
                ? `${SAVED_CARDS.length} saved · or use a new one`
                : 'Visa · Mastercard · RuPay'}
            />
            {selectedPM === 'card' && (
              <View style={s.subCardWrap}>
                {SAVED_CARDS.map((card) => {
                  const on = !useNewCard && selectedCardId === card.id;
                  return (
                    <PressFx
                      key={card.id}
                      onPress={() => { setUseNewCard(false); setSelectedCardId(card.id); }}
                      style={[s.subCard, on && s.subCardOn]}
                    >
                      <View style={[s.cardMini, card.brand === 'visa' && s.cardMiniVisa]}>
                        <Text style={[s.cardMiniText, card.brand === 'visa' && { color: C.white }]}>
                          {card.brand.toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.subInfo}>{card.bank} •••• {card.last4}</Text>
                        <Text style={s.subInfoMeta}>
                          Expires {card.expiry}{card.holder ? ` · ${card.holder}` : ''}
                        </Text>
                      </View>
                      <View style={[s.radio, { width: 16, height: 16 }, on && s.radioOn]}>
                        {on && <View style={[s.radioCenter, { width: 6, height: 6 }]} />}
                      </View>
                    </PressFx>
                  );
                })}
                <PressFx
                  onPress={() => { setUseNewCard(true); setSelectedCardId(''); }}
                  style={[s.subCard, s.subCardAdd, useNewCard && s.subCardOn]}
                >
                  <Feather name="plus" size={14} color={C.amber} />
                  <Text style={s.subCardAddText}>Add new card</Text>
                </PressFx>
              </View>
            )}

            <PMTile
              selected={selectedPM === 'wallet'}
              onPress={() => setSelectedPM('wallet')}
              logo={<View style={[s.pmLogo, s.lgWallet]}><Text style={s.pmLogoText}>₹</Text></View>}
              title="ZopMop Wallet"
              meta="Balance ₹240 · partial pay"
            />

            <PMTile
              selected={selectedPM === 'cod'}
              onPress={() => setSelectedPM('cod')}
              logo={
                <View style={[s.pmLogo, s.lgCod]}>
                  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={C.ink} strokeWidth={2} strokeLinejoin="round">
                    <Rect x={2} y={6} width={20} height={13} rx={2} />
                    <Path d="M14.4 12.5a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0z" />
                  </Svg>
                </View>
              }
              title="Cash on completion"
              meta="Pay your pro after the job"
            />
          </View>

          <SectionHeader>Bill details</SectionHeader>
          <Card>
            <BillRow label="Item total" value={`₹${itemTotal}`} />
            <BillRow label="Service fee" value={`₹${serviceFee}`} />
            <BillRow label="Taxes & charges" value={`₹${taxes}`} />
            {offerApplied && <BillRow label="Discount (FIRST50)" value="−₹150" savings />}
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Total to pay</Text>
              <Text style={s.totalValue}>
                {discount > 0 && <Text style={s.totalStrike}>₹{undiscounted} </Text>}
                ₹{total}
              </Text>
            </View>
          </Card>
        </ScrollView>

        <View style={[s.payDock, { paddingBottom: 16 + insets.bottom }]}>
          <PrimaryButton
            label={`${ctaLabel} · ₹${total}`}
            onPress={handlePay}
            isLoading={paying}
            showChevron
          />
          <View style={s.trust}>
            <Feather name="shield" size={12} color={C.green} />
            <Text style={s.trustText}>256-bit encrypted · Razorpay verified</Text>
          </View>
        </View>
    </View>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionHeader}>{children}</Text>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

function PMTile({
  selected, onPress, logo, title, tag, meta, extra,
}: {
  selected: boolean;
  onPress: () => void;
  logo: React.ReactNode;
  title: string;
  tag?: string;
  meta: string;
  extra?: React.ReactNode;
}) {
  return (
    <PressFx onPress={onPress} style={[s.pm, selected && s.pmSelected]}>
      {logo}
      <View style={s.pmInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={s.pmTitle}>{title}</Text>
          {tag && (
            <View style={s.pmTag}>
              <Text style={s.pmTagText}>{tag}</Text>
            </View>
          )}
        </View>
        <Text style={s.pmMeta}>{meta}</Text>
        {extra}
      </View>
      <View style={[s.radio, selected && s.radioOn]}>
        {selected && <View style={s.radioCenter} />}
      </View>
    </PressFx>
  );
}

function UpiTile({
  selected, onPress, label, children,
}: {
  selected: boolean;
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <PressFx onPress={onPress} style={[s.upiTile, selected && s.upiTileOn]}>
      {children}
      <Text style={s.upiLabel}>{label}</Text>
    </PressFx>
  );
}

function BillRow({ label, value, savings }: { label: string; value: string; savings?: boolean }) {
  return (
    <View style={s.billRow}>
      <Text style={[s.billLabel, savings && { color: C.green, fontFamily: FontFamily.semibold }]}>{label}</Text>
      <Text style={[s.billValue, savings && { color: C.green, fontFamily: FontFamily.semibold }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  // Header
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

  // Section header
  sectionHeader: {
    fontFamily: FontFamily.bold, fontSize: 11, letterSpacing: 1.3,
    color: 'rgba(255,255,255,0.45)',
    paddingHorizontal: 24, paddingTop: 18, paddingBottom: 8,
    textTransform: 'uppercase',
  },

  // Card
  card: {
    marginHorizontal: 20,
    borderRadius: 18,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.07)',
  },

  // Order row
  ord: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  ordIcon: { width: 42, height: 42, borderRadius: 11, position: 'relative', overflow: 'hidden' },
  ordImg: {
    position: 'absolute', left: '11%', top: '11%', width: '78%', height: '78%',
  },
  ordMeta: { flex: 1, minWidth: 0 },
  ordTitle: { fontFamily: FontFamily.bold, fontSize: 13.5, color: C.white, letterSpacing: -0.1, lineHeight: 16 },
  ordSub: { fontFamily: FontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  ordPrice: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },

  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 8 },
  dividerInset: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginHorizontal: 8 },

  // Address
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addrPin: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.14)',
  },
  addrTitle: { fontFamily: FontFamily.bold, fontSize: 13, color: C.white, letterSpacing: -0.1 },
  addrSub: { fontFamily: FontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 2, lineHeight: 15 },
  change: { fontFamily: FontFamily.bold, fontSize: 11, color: C.amber },

  // Offer
  offer: {
    marginHorizontal: 20,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1, borderStyle: 'dashed',
    borderColor: 'rgba(245,163,0,0.45)',
  },
  offerApplied: {
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderColor: 'rgba(34,197,94,0.4)',
    borderStyle: 'solid',
  },
  offerIcon: {
    width: 30, height: 30, borderRadius: 10,
    backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  offerTitle: { fontFamily: FontFamily.bold, fontSize: 12.5, color: C.white, letterSpacing: -0.05 },
  offerSub: { fontFamily: FontFamily.medium, fontSize: 10.5, color: 'rgba(255,255,255,0.55)', marginTop: 1 },
  offerSaved: { fontFamily: FontFamily.extrabold, fontSize: 11, color: C.green },

  // PM tile
  pm: {
    paddingVertical: 12, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 12,
  },
  pmSelected: {
    backgroundColor: 'rgba(245,163,0,0.06)',
    borderWidth: 1.5, borderColor: C.amber,
  },
  pmLogo: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  pmLogoText: { fontFamily: FontFamily.extrabold, fontSize: 11, color: C.white, letterSpacing: 0.4 },
  lgUpi: { backgroundColor: C.upiPurple },
  lgCard: {
    backgroundColor: '#1A1A1C',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  lgWallet: { backgroundColor: '#22C55E' },
  lgCod: { backgroundColor: C.amberHi },
  pmInfo: { flex: 1, minWidth: 0 },
  pmTitle: { fontFamily: FontFamily.bold, fontSize: 13.5, color: C.white, letterSpacing: -0.1, lineHeight: 16 },
  pmTag: {
    marginLeft: 6, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 99,
    backgroundColor: 'rgba(34,197,94,0.16)',
  },
  pmTagText: { fontFamily: FontFamily.extrabold, fontSize: 9.5, color: C.green, letterSpacing: 0.4 },
  pmMeta: { fontFamily: FontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  pmCb: { fontFamily: FontFamily.semibold, fontSize: 10, color: C.green, marginTop: 3 },

  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: C.amber, borderWidth: 2 },
  radioCenter: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber,
  },

  // UPI grid
  upiGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 8, paddingBottom: 10,
    gap: 8,
  },
  upiTile: {
    width: '23%',
    paddingVertical: 10, paddingHorizontal: 6,
    borderRadius: 12, alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.06)',
  },
  upiTileOn: { borderWidth: 1.5, borderColor: C.amber },
  upiBubble: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  upiBubbleText: { fontFamily: FontFamily.extrabold, fontSize: 9, color: C.white },
  upiLabel: { fontFamily: FontFamily.semibold, fontSize: 10, color: 'rgba(255,255,255,0.85)' },

  // Saved cards
  subCardWrap: { paddingHorizontal: 8, paddingBottom: 8, gap: 6 },
  subCard: {
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  subCardOn: { borderWidth: 1.5, borderColor: C.amber },
  subCardAdd: {
    justifyContent: 'center',
  },
  subCardAddText: {
    fontFamily: FontFamily.bold, fontSize: 12, color: C.amber,
  },
  cardMini: {
    width: 36, height: 24, borderRadius: 5,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#1A1A1C',
  },
  cardMiniVisa: { backgroundColor: '#1A1F71' },
  cardMiniText: {
    fontFamily: FontFamily.extrabold, fontSize: 8,
    color: C.amber, letterSpacing: 0.4,
  },
  subInfo: { fontFamily: FontFamily.semibold, fontSize: 11.5, color: C.white, letterSpacing: -0.05 },
  subInfoMeta: { fontFamily: FontFamily.medium, fontSize: 9.5, color: 'rgba(255,255,255,0.4)', marginTop: 1 },

  // Empty state
  emptyText: {
    fontFamily: FontFamily.medium, fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    paddingVertical: 12, textAlign: 'center',
  },

  // Bill
  billRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  billLabel: { fontFamily: FontFamily.medium, fontSize: 12.5, color: 'rgba(255,255,255,0.7)' },
  billValue: { fontFamily: FontFamily.medium, fontSize: 12.5, color: 'rgba(255,255,255,0.7)' },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 10, marginTop: 6,
    borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: 'rgba(255,255,255,0.08)',
  },
  totalLabel: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },
  totalValue: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },
  totalStrike: { textDecorationLine: 'line-through', opacity: 0.4, fontSize: 11, fontFamily: FontFamily.medium },

  // Pay dock
  payDock: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 16,
    backgroundColor: 'rgba(10,10,10,0.92)',
    borderTopWidth: 0.5, borderTopColor: 'rgba(255,255,255,0.08)',
  },
  payBtnWrap: {
    height: 54, borderRadius: 14, overflow: 'hidden',
    shadowColor: C.amber, shadowOpacity: 0.4, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  payBtnInner: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  payAmt: { fontFamily: FontFamily.extrabold, fontSize: 18, color: C.ink, letterSpacing: -0.4, lineHeight: 20 },
  paySub: { fontFamily: FontFamily.semibold, fontSize: 10.5, color: C.ink, opacity: 0.7, marginTop: 3 },
  payStrike: { textDecorationLine: 'line-through', opacity: 0.6 },
  payCta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payCtaText: { fontFamily: FontFamily.extrabold, fontSize: 14, color: C.ink, letterSpacing: -0.1 },

  trust: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, marginTop: 10,
  },
  trustText: { fontFamily: FontFamily.semibold, fontSize: 10.5, color: 'rgba(255,255,255,0.5)' },
});
