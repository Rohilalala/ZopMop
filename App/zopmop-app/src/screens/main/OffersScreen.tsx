import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';

const OFFERS = [
  {
    id: 'WARDROBE10',
    title: 'Flat 10% off on Complete Wardrobe',
    code: 'WARDROBE10',
    terms: [
      'Only applicable on Complete Wardrobe cleaning.',
      'Maximum discount upto ₹50',
    ],
  },
  {
    id: 'KIT10',
    title: 'Flat 10% off on Kitchen Cabinets',
    code: 'KIT10',
    terms: [
      'Only applicable on Kitchen Cabinets cleaning.',
      'Maximum discount upto ₹50',
    ],
  },
];

export default function OffersScreen() {
  const navigation = useNavigation();
  const [inputCode, setInputCode] = useState('');

  function handleApplyInput() {
    const code = inputCode.trim().toUpperCase();
    const match = OFFERS.find(o => o.code === code);
    if (match) {
      Alert.alert('Offer Applied!', `"${match.title}" has been applied.`);
    } else {
      Alert.alert('Invalid Code', 'This coupon code is not valid or has expired.');
    }
  }

  function handleApplyOffer(offer: typeof OFFERS[0]) {
    Alert.alert('Offer Applied!', `"${offer.title}" has been applied.`);
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Apply coupon</Text>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Input row */}
        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            placeholder="Type coupon code here"
            placeholderTextColor={Colors.textMuted}
            value={inputCode}
            onChangeText={setInputCode}
            autoCapitalize="characters"
            returnKeyType="done"
            onSubmitEditing={handleApplyInput}
          />
          <TouchableOpacity
            style={[s.applyBtn, !inputCode.trim() && s.applyBtnDisabled]}
            onPress={handleApplyInput}
            disabled={!inputCode.trim()}
            activeOpacity={0.8}
          >
            <Text style={s.applyBtnText}>Apply</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>Available coupons</Text>

        {OFFERS.map(offer => (
          <OfferCard key={offer.id} offer={offer} onApply={() => handleApplyOffer(offer)} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function OfferCard({
  offer,
  onApply,
}: {
  offer: typeof OFFERS[0];
  onApply: () => void;
}) {
  return (
    <View style={s.card}>
      {/* Top row */}
      <View style={s.cardTop}>
        <View style={s.offerIconBox}>
          <Ionicons name="pricetag-outline" size={22} color={Colors.primary} />
        </View>
        <View style={s.cardMeta}>
          <Text style={s.cardTitle}>{offer.title}</Text>
          <Text style={s.cardCode}>
            Use code <Text style={s.cardCodeBold}>{offer.code}</Text>
          </Text>
        </View>
        <TouchableOpacity style={s.cardApplyBtn} onPress={onApply} activeOpacity={0.8}>
          <Text style={s.cardApplyText}>Apply</Text>
        </TouchableOpacity>
      </View>

      <View style={s.divider} />

      {/* Terms */}
      <View style={s.terms}>
        {offer.terms.map((t, i) => (
          <View key={i} style={s.termRow}>
            <Text style={s.bullet}>•</Text>
            <Text style={s.termText}>{t}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
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
    color: Colors.text,
    letterSpacing: -0.5,
  },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  // Input
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    marginBottom: 24,
    ...Shadow.sm,
  },
  input: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
    paddingVertical: 8,
  },
  applyBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  applyBtnDisabled: { opacity: 0.4 },
  applyBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  sectionLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 14,
    textAlign: 'center',
  },

  // Card
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 14,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 10,
  },
  offerIconBox: {
    width: 48,
    height: 48,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMeta: { flex: 1 },
  cardTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 3,
  },
  cardCode: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  cardCodeBold: {
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  cardApplyBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardApplyText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  divider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 14 },

  terms: { padding: 14, gap: 4 },
  termRow: { flexDirection: 'row', gap: 6 },
  bullet: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  termText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
