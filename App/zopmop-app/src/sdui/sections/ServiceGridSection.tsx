// SDUI adapter for the home "Popular services" grid. Dark glass cards on the
// dark home backdrop — first card is "featured" (full width, taller thumb).
// Each card has the icon-stage (radial-spotlit) thumb, rating chip, add button,
// name, and price + strikethrough MRP.

import React, { useCallback } from 'react';
import {
  Text,
  View,
  StyleSheet,
  Dimensions,
  type TextStyle,
} from 'react-native';
import { Image } from 'expo-image';

import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { PressFx } from '../../components/ui/PressFx';
import { GlassCard } from '../../components/home/GlassCard';
import { ServiceThumb } from '../../components/home/ServiceThumb';
import { serviceIcon } from '../../components/home/serviceIcon';
import { useCart } from '../../context/CartContext';
import { useTheme } from '../../context/ThemeContext';
import { haptics } from '../../utils/haptics';
import type { ApiService } from '../../api/services';
import type { MainStackParamList } from '../../types/navigation';
import type { SduiAction, ServiceGridData } from '../types';

interface Props {
  data: ServiceGridData;
  onAction: (action: SduiAction) => void;
}

const { width: SCREEN_W } = Dimensions.get('window');
const H_PAD     = 20;
const COL_GAP   = 10;
const NUM_COLS  = 2;
const CARD_W    = (SCREEN_W - H_PAD * 2 - COL_GAP) / NUM_COLS;

const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };

export function ServiceGridSection({ data, onAction }: Props) {
  const { addItem } = useCart();
  const { isDark } = useTheme();
  const s = useStyles();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  const handlePress = useCallback(
    (svc: ApiService) => {
      haptics.light();
      navigation.navigate('ServiceAbout', { service: svc });
    },
    [navigation],
  );

  const handleAdd = useCallback(
    async (svc: ApiService) => {
      try {
        await addItem(svc.id, svc.min_duration_minutes, svc.name, svc.base_price_paise);
      } catch {
        onAction({
          trigger: 'tap',
          type:    'toast',
          message: 'Could not add service. Try again.',
          variant: 'error',
        });
      }
    },
    [addItem, onAction],
  );

  const handleSeeAll = useCallback(() => {
    onAction({
      trigger: 'tap',
      type:    'navigate',
      screen:  'AllServices',
    });
  }, [onAction]);

  const services = data.services ?? [];
  if (services.length === 0) return null;

  const [featured, ...rest] = services;

  // Pair the remaining services into rows of 2 for a 2-col layout.
  const rows: ApiService[][] = [];
  for (let i = 0; i < rest.length; i += NUM_COLS) {
    rows.push(rest.slice(i, i + NUM_COLS));
  }

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Text style={[fontBold, s.title]}>{data.title || 'Popular services'}</Text>
        <PressFx onPress={handleSeeAll}>
          <Text style={[fontSemi, s.link]}>See all →</Text>
        </PressFx>
      </View>

      {featured && (
        <View style={{ marginBottom: COL_GAP }}>
          <ServiceCard
            service={featured}
            featured
            isDark={isDark}
            onPress={() => handlePress(featured)}
            onAdd={() => handleAdd(featured)}
          />
        </View>
      )}

      {rows.map((row, ri) => (
        <View
          key={ri}
          style={{ flexDirection: 'row', gap: COL_GAP, marginBottom: COL_GAP }}
        >
          {row.map((svc) => (
            <ServiceCard
              key={svc.id}
              service={svc}
              isDark={isDark}
              onPress={() => handlePress(svc)}
              onAdd={() => handleAdd(svc)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function ServiceCard({
  service,
  featured,
  isDark,
  onPress,
  onAdd,
}: {
  service: ApiService;
  featured?: boolean;
  isDark: boolean;
  onPress: () => void;
  onAdd: () => void;
}) {
  const price  = service.base_price_paise != null
    ? `₹${(service.base_price_paise / 100).toFixed(0)}`
    : '';
  const mrp    = service.mrp_paise ? `₹${(service.mrp_paise / 100).toFixed(0)}` : null;
  const rating = service.rating?.toFixed(1) ?? null;
  const reviewLabel =
    service.review_count > 1000
      ? `${(service.review_count / 1000).toFixed(1)}k`
      : `${service.review_count}`;
  const thumbH = featured ? 120 : 96;

  return (
    <PressFx
      onPress={onPress}
      style={{
        flex: featured ? undefined : 1,
        width: featured ? '100%' : undefined,
      }}
    >
      <GlassCard radius={18} style={{ padding: 12 }}>
        {/* Thumb / icon stage */}
        <View style={{ height: thumbH, position: 'relative' }}>
          <ServiceThumb height={thumbH} radius={12} featured={featured} />

          {/* mascot/glyph — 3D PNG render when available, else neutral vector glyph */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {(() => {
              const src = serviceIcon({ id: service.id, name: service.name });
              if (src) {
                return (
                  <Image
                    source={src}
                    contentFit="contain"
                    style={{
                      width:  featured ? '62%' : '78%',
                      height: featured ? '84%' : '78%',
                      shadowColor: '#0D0D0F',
                      shadowOffset: { width: 0, height: 12 },
                      shadowOpacity: 0.32,
                      shadowRadius: 18,
                    }}
                  />
                );
              }
              // No PNG render — neutral vector glyph (no emoji per project rule).
              return (
                <Feather
                  name="package"
                  size={featured ? 56 : 40}
                  color={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(13,13,15,0.35)'}
                />
              );
            })()}
          </View>

          {/* rating chip */}
          {rating && (
            <View
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 99,
                backgroundColor: 'rgba(255,255,255,0.95)',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <Text style={{ color: '#F5A300', fontSize: 10 }}>★</Text>
              <Text style={[fontBold, { color: '#0D0D0F', fontSize: 10 }]}>
                {rating}
                {featured && service.review_count > 0 ? ` · ${reviewLabel}` : ''}
              </Text>
            </View>
          )}

          {/* add button — Feather glyph renders centered (Text "+" had a
              line-height offset that pushed it visually low). Child Pressable
              captures the tap so the outer card press does not fire. */}
          <PressFx
            onPress={onAdd}
            style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: isDark ? '#0D0D0F' : '#FFFFFF',
              borderWidth: isDark ? 1 : 1,
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(13,13,15,0.08)',
              shadowColor: isDark ? 'transparent' : '#000',
              shadowOpacity: isDark ? 0 : 0.08,
              shadowRadius: isDark ? 0 : 8,
              shadowOffset: { width: 0, height: 2 },
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Feather name="plus" size={16} color="#F5A300" />
          </PressFx>
        </View>

      {/* meta */}
      <Text
        style={[
          fontBold,
          { fontSize: 13, color: isDark ? '#FFFFFF' : '#0D0D0F', letterSpacing: -0.13, marginTop: 10 },
        ]}
        numberOfLines={1}
      >
        {service.name}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          marginTop: 4,
          gap: 6,
        }}
      >
        <Text style={[fontExtra, { color: isDark ? '#FFFFFF' : '#0D0D0F', fontSize: 14 }]}>{price}</Text>
        {mrp && (
          <Text
            style={[
              fontMed,
              {
                color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(13,13,15,0.40)',
                fontSize: 11,
                textDecorationLine: 'line-through',
              },
            ]}
          >
            {mrp}
          </Text>
        )}
        {featured && service.min_duration_minutes ? (
          <Text
            style={[
              fontMed,
              {
                fontSize: 11,
                color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(13,13,15,0.50)',
                marginLeft: 'auto',
              },
            ]}
          >
            {service.min_duration_minutes} min
          </Text>
        ) : null}
      </View>
      </GlassCard>
    </PressFx>
  );
}

function useStyles() {
  const { isDark } = useTheme();
  return StyleSheet.create({
    wrap:  { marginTop: 24, paddingHorizontal: H_PAD },
    head:  {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      paddingBottom: 10,
    },
    title: { fontSize: 18, color: isDark ? '#FFFFFF' : '#0D0D0F', letterSpacing: -0.18 },
    link:  { fontSize: 12, color: '#F5A300' },
  });
}
