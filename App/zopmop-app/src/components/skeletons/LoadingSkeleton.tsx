// Generic content-shaped skeleton. Pass `variant` to pick the silhouette that
// best matches the screen body it replaces. All boxes use the shared SkeletonBox
// (linear-gradient shimmer). Designed as a drop-in for `<LoadingBars />`
// blocks that occupy a screen / list / section. Subtle by default — no card
// outlines, no borders; just shimmer-tinted blocks on the page background.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { SkeletonBox } from '../SkeletonBox';

type Variant =
  | 'list'        // Stacked rows: avatar + 2 lines + tail
  | 'list-grid'   // 2-col tile grid
  | 'block'       // Title + paragraph + chip row
  | 'bubbles'     // Chat-style alternating bubbles
  | 'card'        // Single card body
  | 'screen'      // Header + section + grid (full screen body)
  | 'big';        // Large centred status block

type Props = {
  variant?: Variant;
  rows?: number;
};

export function LoadingSkeleton({ variant = 'list', rows = 4 }: Props) {
  switch (variant) {
    case 'list-grid':
      return <GridSkeleton rows={Math.ceil(rows / 2)} />;
    case 'block':
      return <BlockSkeleton />;
    case 'bubbles':
      return <BubblesSkeleton rows={rows} />;
    case 'card':
      return <CardSkeleton />;
    case 'screen':
      return <ScreenSkeleton />;
    case 'big':
      return <BigSkeleton />;
    case 'list':
    default:
      return <ListSkeleton rows={rows} />;
  }
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <View style={s.listWrap}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={s.row}>
          <SkeletonBox width={40 as any} height={40} borderRadius={12} />
          <View style={{ flex: 1, gap: 8 }}>
            <SkeletonBox width="58%" height={12} borderRadius={5} />
            <SkeletonBox width="36%" height={10} borderRadius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}

function GridSkeleton({ rows }: { rows: number }) {
  return (
    <View style={s.gridWrap}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={s.gridRow}>
          <Tile />
          <Tile />
        </View>
      ))}
    </View>
  );
}

function Tile() {
  return (
    <View style={s.tile}>
      <SkeletonBox width={42 as any} height={42} borderRadius={12} />
      <View style={{ gap: 6, marginTop: 12 }}>
        <SkeletonBox width="72%" height={12} borderRadius={5} />
        <SkeletonBox width="48%" height={10} borderRadius={5} />
      </View>
    </View>
  );
}

function BlockSkeleton() {
  return (
    <View style={s.blockWrap}>
      <SkeletonBox width="50%" height={14} borderRadius={6} />
      <View style={{ gap: 8, marginTop: 14 }}>
        <SkeletonBox width="100%" height={10} borderRadius={5} />
        <SkeletonBox width="90%" height={10} borderRadius={5} />
        <SkeletonBox width="74%" height={10} borderRadius={5} />
      </View>
    </View>
  );
}

function BubblesSkeleton({ rows }: { rows: number }) {
  return (
    <View style={s.bubblesWrap}>
      {Array.from({ length: rows }).map((_, i) => {
        const me = i % 2 === 1;
        const w: `${number}%` = me ? '50%' : '64%';
        return (
          <View
            key={i}
            style={[s.bubbleRow, { justifyContent: me ? 'flex-end' : 'flex-start' }]}
          >
            <SkeletonBox width={w} height={36} borderRadius={14} />
          </View>
        );
      })}
    </View>
  );
}

function CardSkeleton() {
  return (
    <View style={s.cardOuter}>
      <View style={s.row}>
        <SkeletonBox width={44 as any} height={44} borderRadius={14} />
        <View style={{ flex: 1, gap: 8 }}>
          <SkeletonBox width="55%" height={13} borderRadius={5} />
          <SkeletonBox width="38%" height={10} borderRadius={5} />
        </View>
      </View>
      <View style={{ gap: 8, marginTop: 14 }}>
        <SkeletonBox width="100%" height={10} borderRadius={5} />
        <SkeletonBox width="84%" height={10} borderRadius={5} />
      </View>
    </View>
  );
}

function ScreenSkeleton() {
  return (
    <View style={s.screenWrap}>
      <View style={s.headerRow}>
        <View style={{ flex: 1, gap: 8 }}>
          <SkeletonBox width="50%" height={11} borderRadius={4} />
          <SkeletonBox width="78%" height={18} borderRadius={6} />
        </View>
        <SkeletonBox width={32 as any} height={32} borderRadius={16} />
      </View>
      <SkeletonBox
        width="100%"
        height={44}
        borderRadius={14}
        style={{ marginBottom: 18 }}
      />
      <SkeletonBox width="36%" height={11} borderRadius={4} style={{ marginBottom: 12 }} />
      <GridSkeleton rows={2} />
    </View>
  );
}

function BigSkeleton() {
  return (
    <View style={s.bigWrap}>
      <SkeletonBox width={104 as any} height={104} borderRadius={52} />
      <View style={{ gap: 10, alignItems: 'center', marginTop: 22 }}>
        <SkeletonBox width={160 as any} height={14} borderRadius={6} />
        <SkeletonBox width={220 as any} height={11} borderRadius={5} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  listWrap: { paddingHorizontal: 20, paddingTop: 18, gap: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 4,
  },
  gridWrap: { paddingHorizontal: 20, paddingTop: 8 },
  gridRow: { flexDirection: 'row', gap: 18, marginBottom: 22 },
  tile: { flex: 1 },
  blockWrap: { paddingHorizontal: 20, paddingTop: 18 },
  bubblesWrap: { paddingHorizontal: 16, paddingTop: 16, gap: 14 },
  bubbleRow: { flexDirection: 'row' },
  cardOuter: { padding: 20 },
  screenWrap: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 4,
    paddingBottom: 16,
  },
  bigWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
});

export default LoadingSkeleton;
