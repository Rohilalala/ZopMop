import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const AMBER = '#F5A300';

export interface ZopSlot {
  id: string;
  slot_date: string;
  start_time: string; // "07:00"
  end_time: string;   // "07:30"
  period: 'morning' | 'afternoon' | 'evening' | string;
  is_available?: boolean;
}

export interface ZopSlotPeriod {
  label: string; // "Morning"
  slots: ZopSlot[];
}

interface Props {
  periods: ZopSlotPeriod[];
  /** Initial period to show. Defaults to first available period. */
  initialPeriod?: string;
  onPick: (slot: ZopSlot) => void;
}

/**
 * Tappable slot picker. Shows slots grouped by period (morning / afternoon /
 * evening) with a segment selector at the top. Tapping a slot fires onPick.
 *
 * Replaces the previous text-list approach where Zop would dump 28 slot rows
 * in the chat bubble — now the LLM just says "here are the slots — tap one"
 * and this card renders the data.
 */
export default function ZopSlotCard({ periods, initialPeriod, onPick }: Props) {
  const periodsWithSlots = useMemo(
    () => periods.filter((p) => p.slots.length > 0),
    [periods],
  );

  const [active, setActive] = useState<string>(() => {
    if (initialPeriod) {
      const match = periodsWithSlots.find(
        (p) => p.label.toLowerCase() === initialPeriod.toLowerCase(),
      );
      if (match) return match.label;
    }
    return periodsWithSlots[0]?.label ?? '';
  });

  const activePeriod = periodsWithSlots.find((p) => p.label === active);

  if (!periodsWithSlots.length) {
    return (
      <View style={styles.card}>
        <Text style={styles.empty}>No slots available.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.tabs}>
        {periodsWithSlots.map((p) => {
          const isActive = p.label === active;
          return (
            <Pressable
              key={p.label}
              onPress={() => setActive(p.label)}
              style={[styles.tab, isActive && styles.tabActive]}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView
        horizontal={false}
        style={styles.slotsScroll}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <View style={styles.slotsGrid}>
          {(activePeriod?.slots ?? []).map((s) => (
            <Pressable
              key={s.id}
              onPress={() => onPick(s)}
              style={({ pressed }) => [
                styles.slot,
                pressed && styles.slotPressed,
              ]}
            >
              <Text style={styles.slotText}>
                {fmt12h(s.start_time)} – {fmt12h(s.end_time)}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function fmt12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mStr} ${ampm}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(245,163,0,0.18)',
    borderWidth: 1,
    borderRadius: 18,
    padding: 12,
    maxWidth: 320,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 3,
    marginBottom: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 9,
  },
  tabActive: {
    backgroundColor: AMBER,
  },
  tabText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  tabTextActive: {
    color: '#0A0A0A',
    fontFamily: 'PlusJakartaSans_700Bold',
  },
  slotsScroll: {
    maxHeight: 220,
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  slot: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderColor: 'rgba(245,163,0,0.22)',
    borderWidth: 1,
  },
  slotPressed: {
    backgroundColor: 'rgba(245,163,0,0.20)',
  },
  slotText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: 'PlusJakartaSans_500Medium',
  },
  empty: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontFamily: 'PlusJakartaSans_400Regular',
  },
});
