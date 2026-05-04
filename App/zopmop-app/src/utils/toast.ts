import Toast from 'react-native-toast-message';
import { haptics } from './haptics';

type Opts = { title?: string; duration?: number };

export function showError(message: string, opts: Opts = {}) {
  haptics.error();
  Toast.show({
    type: 'error',
    text1: opts.title ?? 'Something went wrong',
    text2: message,
    position: 'top',
    visibilityTime: opts.duration ?? 3500,
  });
}

export function showSuccess(message: string, opts: Opts = {}) {
  haptics.success();
  Toast.show({
    type: 'success',
    text1: opts.title ?? 'Done',
    text2: message,
    position: 'top',
    visibilityTime: opts.duration ?? 2500,
  });
}

export function showInfo(message: string, opts: Opts = {}) {
  Toast.show({
    type: 'info',
    text1: opts.title ?? message,
    text2: opts.title ? message : undefined,
    position: 'top',
    visibilityTime: opts.duration ?? 2500,
  });
}
