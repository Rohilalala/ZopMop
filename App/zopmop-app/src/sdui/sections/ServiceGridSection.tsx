// SDUI adapter for a 2-column service grid. There is no existing 2-col grid
// component in src/components/home — UsualsRow is horizontal-only — so this
// builds a minimal one that mirrors the UsualsRow card visual style.
// TODO(sdui): adapter — replace with a shared ServiceCard component once the
// design system has one.

import React, { useCallback } from 'react';
import {
  FlatList,
  Text,
  View,
  StyleSheet,
  Dimensions,
  type TextStyle,
} from 'react-native';

import { PressFx } from '../../components/ui/PressFx';
import type { ApiService } from '../../api/services';
import type { SduiAction, ServiceGridData } from '../types';

interface Props {
  data: ServiceGridData;
  onAction: (action: SduiAction) => void;
}

const { width: SCREEN_W } = Dimensions.get('window');
const H_PAD     = 20;
const COL_GAP   = 12;
const NUM_COLS  = 2;
const CARD_W    = (SCREEN_W - H_PAD * 2 - COL_GAP * (NUM_COLS - 1)) / NUM_COLS;

const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };

export function ServiceGridSection({ data, onAction }: Props) {
  const handlePress = useCallback(
    (svc: ApiService) => {
      onAction({
        trigger: 'tap',
        type:    'navigate',
        screen:  'ServiceDetail',
        params:  { serviceId: svc.id },
      });
    },
    [onAction],
  );

  if (!data.services || data.services.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={[fontExtra, styles.title]}>{data.title}</Text>
      <FlatList
        data={data.services}
        keyExtractor={(s) => s.id}
        numColumns={NUM_COLS}
        scrollEnabled={false}
        contentContainerStyle={styles.list}
        columnWrapperStyle={{ gap: COL_GAP }}
        ItemSeparatorComponent={() => <View style={{ height: COL_GAP }} />}
        renderItem={({ item }) => (
          <ServiceCard service={item} onPress={() => handlePress(item)} />
        )}
      />
    </View>
  );
}

function ServiceCard({
  service,
  onPress,
}: {
  service: ApiService;
  onPress: () => void;
}) {
  return (
    <PressFx
      onPress={onPress}
      style={{
        width:           CARD_W,
        height:          168,
        borderRadius:    20,
        backgroundColor: service.bg_color || '#EEF2FF',
        padding:         14,
        justifyContent:  'space-between',
      }}
    >
      <Text style={{ fontSize: 32 }}>{service.emoji ?? '🧹'}</Text>
      <View>
        <Text
          style={[fontBold, { fontSize: 14, color: '#0F172A', lineHeight: 18 }]}
          numberOfLines={2}
        >
          {service.name}
        </Text>
        <Text style={[fontMed, { fontSize: 12, color: '#475569', marginTop: 4 }]}>
          ₹{(service.base_price_cents / 100).toFixed(0)}
        </Text>
      </View>
    </PressFx>
  );
}

const styles = StyleSheet.create({
  wrap:  { marginTop: 28, paddingHorizontal: H_PAD },
  title: { fontSize: 22, color: '#0F172A', letterSpacing: -0.4, marginBottom: 14 },
  list:  { paddingBottom: 4 },
});
