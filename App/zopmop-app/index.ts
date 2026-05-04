import { registerRootComponent } from 'expo';
import { enableFreeze } from 'react-native-screens';

import App from './App';

// Freeze blurred screens. With our nested bottom-tabs setup the inactive
// tabs stay mounted (so switching is instant) but freezing pauses their
// JS work + Reanimated loops while they're not visible — keeps the
// behind-the-scenes cost flat.
enableFreeze(true);

// Background message handler — must be registered at module top level, before
// AppRegistry, so the JS runtime is alive when FCM wakes the app for a
// data-only push. We no-op here: notifications with a `notification` payload
// are auto-displayed by the OS tray, and analytics hooks can be added later.
// Wrapped in try/catch so the app still boots in environments where the
// native messaging module is missing (Expo Go, pre-prebuild dev clients).
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const messagingMod = require('@react-native-firebase/messaging');
  const messaging = messagingMod?.default ?? messagingMod;
  messaging().setBackgroundMessageHandler(async () => {
    // No-op. Hook for analytics / silent-push handling later.
  });
} catch {
  // messaging native module unavailable — skip silently.
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
