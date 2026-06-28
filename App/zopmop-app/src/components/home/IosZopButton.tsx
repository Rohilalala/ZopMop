// IosZopButton — the Zop mascot floating over the native iOS tab bar.
//
// Mirrors the original custom bar, where the mascot half-overhangs above the
// bar's centre. It's an independent overlay (NOT a tab) so pressing it opens the
// Zop chat over the current screen instead of switching scenes (a navigator tab
// would black out the app behind the chat). Shown only on the tab routes.

import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ZopFull from '../../../assets/zop/zop-full.svg';
import ZopChat from '../ZopChat';
import { navigationRef } from '../../navigation/navigationRef';

const ZOP = 60;
const TAB_ROUTES = new Set(['Home', 'AllServices', 'Bookings', 'Profile']);

export function IosZopButton() {
  const insets = useSafeAreaInsets();
  const [chatVisible, setChatVisible] = useState(false);
  const [onTab, setOnTab] = useState<boolean>(
    () => (navigationRef.isReady() ? TAB_ROUTES.has(navigationRef.getCurrentRoute()?.name ?? '') : false),
  );

  useEffect(() => {
    const sync = () => {
      if (navigationRef.isReady()) {
        setOnTab(TAB_ROUTES.has(navigationRef.getCurrentRoute()?.name ?? ''));
      }
    };
    sync();
    return navigationRef.addListener('state', sync);
  }, []);

  return (
    <>
      {onTab && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            // Sit above the native tab bar (~49pt) so the mascot half-overhangs
            // the bar's top edge at centre, like the old custom bar.
            bottom: insets.bottom + 20,
            alignItems: 'center',
            zIndex: 60,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Zop chat"
            onPress={() => setChatVisible(true)}
            // Hit area = just the mascot body (no hitSlop expansion) so the
            // native tabs underneath/around it stay tappable.
            style={{ width: ZOP, height: ZOP }}
          >
            <ZopFull width={ZOP} height={ZOP} />
          </Pressable>
        </View>
      )}
      <ZopChat visible={chatVisible} onClose={() => setChatVisible(false)} />
    </>
  );
}
