import { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';
import { useTheme } from '../context/ThemeContext';
import { C as darkC, lightC, type ScreenColors } from './screen';

type ColorToken = keyof ScreenColors;
type ColorProp =
  | 'backgroundColor'
  | 'color'
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor';

// Animated style tweening one colour prop between the dark and light palettes
// as the theme `progress` (0 = dark, 1 = light) animates. interpolateColor
// handles rgba (incl. alpha), so the glass tokens cross-fade correctly.
//
// It's a hook — call at the top level of a component (fixed set, not in loops).
export function useAnimatedColor(prop: ColorProp, token: ColorToken) {
  const { progress } = useTheme();
  return useAnimatedStyle(() => {
    'worklet';
    return { [prop]: interpolateColor(progress.value, [0, 1], [darkC[token], lightC[token]]) };
  });
}
