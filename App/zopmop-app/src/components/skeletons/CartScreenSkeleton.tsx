import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SkeletonBox } from '../SkeletonBox';
import { useC } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';

export function CartScreenSkeleton() {
  const c = useC();
  const { isDark } = useTheme();
  return (
    <View style={[s.root, { backgroundColor: c.bg }]}>
      <SkeletonBox width="35%" height={11} borderRadius={4} style={s.sectionHeader} />
      <View style={s.card}>
        <View style={s.row}>
          <SkeletonBox width={36 as any} height={36} borderRadius={11} />
          <View style={{ flex: 1, gap: 6 }}>
            <SkeletonBox width="40%" height={13} borderRadius={5} />
            <SkeletonBox width="80%" height={11} borderRadius={5} />
          </View>
        </View>
      </View>

      <SkeletonBox width="35%" height={11} borderRadius={4} style={s.sectionHeader} />
      <View style={s.card}>
        {[0, 1, 2].map((i) => (
          <View key={i}>
            <View style={s.row}>
              <SkeletonBox width={42 as any} height={42} borderRadius={11} />
              <View style={{ flex: 1, gap: 6 }}>
                <SkeletonBox width="60%" height={13} borderRadius={5} />
                <SkeletonBox width="30%" height={11} borderRadius={5} />
              </View>
              <SkeletonBox width={48 as any} height={14} borderRadius={5} />
              <SkeletonBox width={28 as any} height={28} borderRadius={8} />
            </View>
            {i < 2 && <View style={s.divider} />}
          </View>
        ))}
      </View>

      <SkeletonBox width="35%" height={11} borderRadius={4} style={s.sectionHeader} />
      <View style={s.card}>
        <View style={s.billRow}>
          <SkeletonBox width="30%" height={12} borderRadius={5} />
          <SkeletonBox width="20%" height={12} borderRadius={5} />
        </View>
        <View style={s.billRow}>
          <SkeletonBox width="38%" height={12} borderRadius={5} />
          <SkeletonBox width="18%" height={12} borderRadius={5} />
        </View>
        <View style={[s.billRow, s.totalRow, { borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.08)' }]}>
          <SkeletonBox width="28%" height={14} borderRadius={5} />
          <SkeletonBox width="22%" height={16} borderRadius={5} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingTop: 4, flex: 1 },
  sectionHeader: { marginHorizontal: 24, marginTop: 22, marginBottom: 12 },
  card: {
    marginHorizontal: 20,
    paddingVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  divider: { height: 1, backgroundColor: 'transparent', marginVertical: 8 },
  billRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  totalRow: {
    paddingTop: 12, marginTop: 6,
    borderTopWidth: 1, borderStyle: 'dashed',
  },
});

export default CartScreenSkeleton;
