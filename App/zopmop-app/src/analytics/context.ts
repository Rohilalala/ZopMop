// Analytics base context — every SDUI event includes these fields. The session
// id is generated once at module load (app launch) so it stays stable for the
// life of the JS bundle. user_id and config_version are filled in later by
// auth/SDUI hook code via setAnalyticsContext.

import { Platform } from 'react-native';
import Constants from 'expo-constants';

export interface AnalyticsContext {
  session_id:     string;
  user_id:        string | 'guest';
  app_version:    string;
  platform:       'ios' | 'android';
  config_version: string;
  experiment_id:  string | null;
}

// nanoid is in deps; fall back to a Math.random-based id if the import fails
// at runtime (e.g. older RN bundlers without conditional exports).
function generateSessionId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { nanoid } = require('nanoid/non-secure') as { nanoid: () => string };
    return nanoid();
  } catch {
    return Math.random().toString(36).slice(2, 18);
  }
}

const initialPlatform: 'ios' | 'android' =
  Platform.OS === 'ios' ? 'ios' : 'android';

const initialAppVersion: string =
  // expo-constants exposes the manifest version at runtime
  (Constants?.expoConfig?.version as string | undefined) ??
  // older Expo runtime fallback
  ((Constants as unknown as { manifest?: { version?: string } }).manifest?.version) ??
  'unknown';

export const analyticsContext: AnalyticsContext = {
  session_id:     generateSessionId(),
  user_id:        'guest',
  app_version:    initialAppVersion,
  platform:       initialPlatform,
  config_version: 'unknown',
  experiment_id:  null,
};

/** Merge partial updates into the singleton. Callers should use this on
 *  sign-in/out and after each SDUI page load. */
export function setAnalyticsContext(partial: Partial<AnalyticsContext>): void {
  Object.assign(analyticsContext, partial);
}
