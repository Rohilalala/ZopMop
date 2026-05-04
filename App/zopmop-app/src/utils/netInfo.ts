// Defensive NetInfo wrapper. The native module ships in a custom dev client;
// older builds without the linked module would crash on import. We lazy-load
// and fail-open (assume online) so the offline-queue feature degrades to a
// no-op rather than taking down the screen.

type NetInfoState = { isConnected: boolean | null };
type NetInfoModule = {
  fetch: () => Promise<NetInfoState>;
  addEventListener: (cb: (state: NetInfoState) => void) => () => void;
};

let cached: NetInfoModule | null | undefined;

function load(): NetInfoModule | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('@react-native-community/netinfo');
    const NetInfo = mod?.default ?? mod;
    if (NetInfo && typeof NetInfo.fetch === 'function') {
      cached = NetInfo as NetInfoModule;
      return cached;
    }
  } catch {}
  cached = null;
  return null;
}

export async function isConnected(): Promise<boolean> {
  const NetInfo = load();
  if (!NetInfo) return true;
  try {
    const state = await NetInfo.fetch();
    return state.isConnected !== false;
  } catch {
    return true;
  }
}

export function addConnectivityListener(cb: (online: boolean) => void): () => void {
  const NetInfo = load();
  if (!NetInfo) return () => {};
  try {
    return NetInfo.addEventListener((state) => {
      cb(state.isConnected !== false);
    });
  } catch {
    return () => {};
  }
}
