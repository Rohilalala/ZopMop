import React from 'react';
import {
  
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from './ui/LoadingBars';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../theme';

const C = {
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberLo: '#E88F00',
  ink: '#0D0D0F',
};

type Props = {
  label: string;
  onPress?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  showChevron?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
};

export function PrimaryButton({
  label,
  onPress,
  isLoading = false,
  disabled = false,
  showChevron = false,
  style,
  textStyle,
  testID,
}: Props) {
  const isDisabled = disabled || isLoading;
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: isLoading }}
      style={[s.btn, isDisabled && !isLoading && s.disabled, style]}
    >
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinearGradient id="primaryBtnGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={C.amberHi} />
            <Stop offset="60%" stopColor={C.amber} />
            <Stop offset="100%" stopColor={C.amberLo} />
          </SvgLinearGradient>
        </Defs>
        <Rect width="100%" height="100%" rx="14" fill="url(#primaryBtnGrad)" />
      </Svg>
      <View style={s.inner}>
        {isLoading ? (
          <LoadingBars color={C.ink} />
        ) : (
          <>
            <Text style={[s.label, textStyle]} numberOfLines={1}>
              {label}
            </Text>
            {showChevron && <Feather name="chevron-right" size={14} color={C.ink} />}
          </>
        )}
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: {
    height: 54,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: C.amber,
    shadowOpacity: 0.4,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  disabled: { opacity: 0.6 },
  inner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
  },
  label: {
    fontFamily: FontFamily.extrabold,
    fontSize: 14,
    color: C.ink,
    letterSpacing: -0.1,
  },
});

export default PrimaryButton;
