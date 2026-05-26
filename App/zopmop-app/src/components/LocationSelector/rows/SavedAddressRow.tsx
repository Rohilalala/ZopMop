import React, { useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  PanResponder,
  Alert,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../../theme';
import type { ApiAddress } from '../../../api/addresses';
import type { LSThemeTokens } from '../utils/theme';

const SWIPE_W = 76;

const TAG_ICONS: Record<ApiAddress['tag'], keyof typeof Feather.glyphMap> = {
  Home: 'home',
  Work: 'briefcase',
  Other: 'map-pin',
};

interface Props {
  address: ApiAddress;
  isCurrent: boolean;
  showActions: boolean;
  t: LSThemeTokens;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function SavedAddressRow({
  address,
  isCurrent,
  showActions,
  t,
  onSelect,
  onEdit,
  onDelete,
}: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeState = useRef<'closed' | 'left' | 'right'>('closed');

  const snap = (to: number) => {
    Animated.spring(translateX, {
      toValue: to,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
    if (to === 0) swipeState.current = 'closed';
  };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        showActions && Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        if (!showActions) return;
        const base =
          swipeState.current === 'left'
            ? -SWIPE_W
            : swipeState.current === 'right'
              ? SWIPE_W
              : 0;
        translateX.setValue(
          Math.max(-SWIPE_W, Math.min(SWIPE_W, base + g.dx)),
        );
      },
      onPanResponderRelease: (_, g) => {
        if (!showActions) { snap(0); return; }
        if (swipeState.current === 'closed') {
          if (g.dx < -30) {
            snap(-SWIPE_W);
            swipeState.current = 'left';
          } else if (g.dx > 30) {
            snap(SWIPE_W);
            swipeState.current = 'right';
          } else {
            snap(0);
          }
        } else {
          const back =
            (swipeState.current === 'left' && g.dx > 20) ||
            (swipeState.current === 'right' && g.dx < -20);
          if (back) {
            snap(0);
          } else {
            snap(swipeState.current === 'left' ? -SWIPE_W : SWIPE_W);
          }
        }
      },
    }),
  ).current;

  const handleDelete = () => {
    Alert.alert('Delete Address', 'Delete this saved address?', [
      { text: 'Cancel', style: 'cancel', onPress: () => snap(0) },
      { text: 'Delete', style: 'destructive', onPress: () => { snap(0); onDelete(); } },
    ]);
  };

  const icoStyle = isCurrent
    ? { backgroundColor: t.amberFill, borderColor: t.amberBorder }
    : { backgroundColor: t.glass, borderColor: t.glassBorderHi };

  return (
    <View style={s.wrap}>
      {showActions && (
        <>
          <View style={[s.action, s.actionLeft]}>
            <TouchableOpacity
              style={[s.deleteBtn, { backgroundColor: t.danger }]}
              onPress={handleDelete}
              activeOpacity={0.85}
            >
              <Feather name="trash-2" size={16} color="#FFFFFF" />
              <Text style={s.actionText}>Delete</Text>
            </TouchableOpacity>
          </View>
          <View style={[s.action, s.actionRight]}>
            <TouchableOpacity
              style={[s.editBtn, { backgroundColor: t.amber }]}
              onPress={() => { snap(0); onEdit(); }}
              activeOpacity={0.85}
            >
              <Feather name="edit-2" size={16} color={t.ink} />
              <Text style={[s.actionText, { color: t.ink }]}>Edit</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
      <Animated.View
        style={[
          s.row,
          {
            backgroundColor: t.surface,
            borderColor: t.glassBorderHi,
            transform: [{ translateX }],
          },
        ]}
        {...pan.panHandlers}
      >
        <TouchableOpacity style={s.inner} onPress={onSelect} activeOpacity={0.7}>
          <View style={[s.iconBox, icoStyle]}>
            <Feather
              name={TAG_ICONS[address.tag]}
              size={15}
              color={isCurrent ? t.amber : t.textMuted}
            />
          </View>
          <View style={s.textCol}>
            <View style={s.titleRow}>
              <Text style={[s.label, { color: t.text }]} numberOfLines={1}>
                {address.title || address.tag}
              </Text>
              {isCurrent && (
                <View style={[s.tagPill, { backgroundColor: t.amberFill, borderColor: t.amberBorder }]}>
                  <Text style={[s.tagText, { color: t.amber }]}>Current</Text>
                </View>
              )}
            </View>
            <Text style={[s.addr, { color: t.textMuted }]} numberOfLines={1}>
              {address.full_address}
            </Text>
          </View>
          {showActions ? (
            <View style={s.more}>
              <Feather name="more-horizontal" size={16} color={t.textMuted} />
            </View>
          ) : (
            <Feather name="chevron-right" size={13} color={t.textMuted} />
          )}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { height: 64, marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  action: { position: 'absolute', top: 0, bottom: 0, width: SWIPE_W },
  actionLeft: { left: 0 },
  actionRight: { right: 0 },
  deleteBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  editBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionText: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  row: {
    height: 64,
    borderRadius: 14,
    borderWidth: 0.5,
  },
  inner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 14,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  textCol: { flex: 1, minWidth: 0 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  label: {
    fontFamily: FontFamily.bold,
    fontSize: 13.5,
    letterSpacing: -0.05,
  },
  tagPill: {
    borderRadius: 99,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: 1,
  },
  tagText: {
    fontFamily: FontFamily.bold,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  addr: {
    fontFamily: FontFamily.medium,
    fontSize: 12,
    lineHeight: 15,
  },
  more: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
