import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SkeletonBox } from '../SkeletonBox';
import { C } from '../../theme/screen';

const TILE = (340 - 20 * 2 - 12) / 2;

export function HomeScreenSkeleton() {
  return (
    <View style={s.root}>
      <View style={s.headerRow}>
        <View style={{ flex: 1, gap: 8 }}>
          <SkeletonBox width="55%" height={11} borderRadius={4} />
          <SkeletonBox width="80%" height={20} borderRadius={6} />
        </View>
        <SkeletonBox width={36 as any} height={36} borderRadius={18} />
      </View>

      <View style={s.searchRow}>
        <SkeletonBox width="100%" height={48} borderRadius={14} />
      </View>

      <SkeletonBox width="40%" height={11} borderRadius={4} style={s.sectionHeader} />

      <View style={s.gridRow}>
        <ServiceCard />
        <ServiceCard />
      </View>
      <View style={s.gridRow}>
        <ServiceCard />
        <ServiceCard />
      </View>

      <SkeletonBox width="35%" height={11} borderRadius={4} style={s.sectionHeader} />

      <View style={s.bannerWrap}>
        <SkeletonBox width="100%" height={120} borderRadius={20} />
      </View>
    </View>
  );
}

function ServiceCard() {
  return (
    <View style={s.card}>
      <SkeletonBox width={48 as any} height={48} borderRadius={12} />
      <View style={{ gap: 6, marginTop: 10 }}>
        <SkeletonBox width="75%" height={13} borderRadius={5} />
        <SkeletonBox width="50%" height={11} borderRadius={5} />
      </View>
      <SkeletonBox width="40%" height={14} borderRadius={5} style={{ marginTop: 14 }} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingTop: 8, backgroundColor: C.bg, flex: 1 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16,
  },
  searchRow: { paddingHorizontal: 20, paddingBottom: 8 },
  sectionHeader: { marginHorizontal: 24, marginTop: 22, marginBottom: 12 },
  gridRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 12,
  },
  card: {
    flex: 1,
    height: 132,
    paddingVertical: 4,
  },
  bannerWrap: { paddingHorizontal: 20, marginTop: 4 },
});

export default HomeScreenSkeleton;
