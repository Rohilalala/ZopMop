import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SkeletonBox } from '../SkeletonBox';
import { useC } from '../../theme/screen';

export function BookingsScreenSkeleton() {
  const c = useC();
  return (
    <View style={[s.root, { backgroundColor: c.bg }]}>
      <View style={s.tabRow}>
        <SkeletonBox width={86 as any} height={32} borderRadius={16} />
        <SkeletonBox width={86 as any} height={32} borderRadius={16} />
        <SkeletonBox width={86 as any} height={32} borderRadius={16} />
      </View>

      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={s.card}>
          <View style={s.row}>
            <SkeletonBox width={44 as any} height={44} borderRadius={11} />
            <View style={{ flex: 1, gap: 8 }}>
              <SkeletonBox width="60%" height={14} borderRadius={5} />
              <SkeletonBox width="40%" height={11} borderRadius={5} />
            </View>
            <SkeletonBox width={56 as any} height={24} borderRadius={99} />
          </View>
          <View style={s.divider} />
          <View style={s.metaRow}>
            <SkeletonBox width="35%" height={11} borderRadius={5} />
            <SkeletonBox width="22%" height={13} borderRadius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingTop: 8, flex: 1 },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 18,
  },
  card: {
    marginHorizontal: 20, marginBottom: 22,
    paddingVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  divider: { height: 1, backgroundColor: 'transparent', marginVertical: 12 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});

export default BookingsScreenSkeleton;
