import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { checkAppVersion } from '../api/appVersion';
import { registerForceUpdateCallback, type ForceUpdateInfo } from '../api/client';
import UpdateRequiredScreen from '../screens/UpdateRequiredScreen';

type GateState = { visible: boolean; force: boolean; info: ForceUpdateInfo };
const HIDDEN: GateState = { visible: false, force: false, info: {} };

// UpdateGate renders nothing until the installed build is below the backend's
// minimum, then overlays UpdateRequiredScreen. It checks on launch and whenever
// the app returns to the foreground, and reacts to a 426 from any request
// mid-session (registered force-update callback). Fails open on any error so a
// flaky check never strands the user.
export default function UpdateGate() {
  const [state, setState] = useState<GateState>(HIDDEN);
  // A soft (optional) prompt the user dismissed this session shouldn't re-nag
  // on every resume. A hard (forced) block ignores this.
  const softDismissed = useRef(false);

  const run = useCallback(async () => {
    try {
      const r = await checkAppVersion();
      if (!r.needs_update) {
        setState((s) => (s.visible && !s.force ? HIDDEN : s));
        return;
      }
      if (!r.force && softDismissed.current) return;
      setState({
        visible: true,
        force: r.force,
        info: { message: r.message, store_url: r.store_url, min_version: r.min_version },
      });
    } catch {
      // fail open
    }
  }, []);

  useEffect(() => {
    run();
    registerForceUpdateCallback((info) => setState({ visible: true, force: true, info }));
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run();
    });
    return () => sub.remove();
  }, [run]);

  if (!state.visible) return null;
  return (
    <UpdateRequiredScreen
      info={state.info}
      force={state.force}
      onLater={() => {
        softDismissed.current = true;
        setState(HIDDEN);
      }}
    />
  );
}
