import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const AMBER = '#F5A300';

export interface ZopQuickReply {
  label: string;
  value: string;
}

interface Props {
  replies: ZopQuickReply[];
  onPick: (reply: ZopQuickReply) => void;
}

/**
 * Compact chip row rendered under the assistant message when the LLM is
 * asking a discrete-choice question (period, now-or-scheduled, confirm).
 * Tap → fires the chip's value as the user's next message.
 */
export default function ZopQuickReplies({ replies, onPick }: Props) {
  if (!replies?.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {replies.map((r) => (
        <Pressable
          key={r.value}
          onPress={() => onPick(r)}
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        >
          <Text style={styles.label}>{r.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 6,
    paddingTop: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(245,163,0,0.12)',
    borderColor: 'rgba(245,163,0,0.35)',
    borderWidth: 1,
  },
  chipPressed: {
    backgroundColor: 'rgba(245,163,0,0.25)',
  },
  label: {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
});
