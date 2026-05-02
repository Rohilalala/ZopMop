import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Pro Mode toggles every "advanced" surface across the app: bulk operations,
// raw JSON editors, manual mark-complete, force-disable, etc. Persisted in
// localStorage so it survives reload (per spec).
type ProModeState = {
  enabled: boolean;
  toggle: () => void;
  set: (v: boolean) => void;
};

export const useProMode = create<ProModeState>()(
  persist(
    (set) => ({
      enabled: false,
      toggle: () => set((s) => ({ enabled: !s.enabled })),
      set: (v) => set({ enabled: v }),
    }),
    { name: 'crm.proMode' },
  ),
);
