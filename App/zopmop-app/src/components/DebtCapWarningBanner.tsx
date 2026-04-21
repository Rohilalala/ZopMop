import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../context/ThemeContext';
import { FontFamily, FontSize, Spacing } from '../theme';
import { lightColors } from '../theme/colors';

type C = typeof lightColors;

function createStyles(c: C) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.dangerBg,
      borderLeftWidth: 4,
      borderLeftColor: c.danger,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.sm,
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.sm,
      borderRadius: 8,
    },
    text: {
      flex: 1,
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.danger,
      marginRight: Spacing.sm,
    },
    dismiss: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.sm,
      color: c.danger,
    },
  });
}

interface Props {
  onDismiss: () => void;
}

/**
 * Non-blocking red banner shown when a roommate exceeds the ₹1,000 debt soft cap.
 * Edge case 4: displays warning but never blocks the transaction flow.
 */
export default function DebtCapWarningBanner({ onDismiss }: Props) {
  const c = useColors();
  const s = React.useMemo(() => createStyles(c), [c]);

  return (
    <View style={s.banner}>
      <Text style={s.text}>
        A roommate has exceeded the ₹1,000 debt limit. Transactions are still allowed.
      </Text>
      <Pressable onPress={onDismiss} hitSlop={8}>
        <Text style={s.dismiss}>✕</Text>
      </Pressable>
    </View>
  );
}
