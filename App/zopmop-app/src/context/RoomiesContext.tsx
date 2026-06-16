import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import * as RoomiesAPI from '../api/roomies';
import { ROOMIES_ENABLED } from '../config/features';
import type {
  BookGroupChorePayload,
  BookGroupChoreResponse,
  DeleteGroupResult,
  LeaveGroupResult,
  MyGroupResponse,
  SimplifiedDebt,
  VaultSummary,
} from '../api/roomies';

// ── Context type ──────────────────────────────────────────────────────────────

type RoomiesContextType = {
  /** The user's current household group, or null if not in one. */
  myGroup: MyGroupResponse | null;
  vault: VaultSummary | null;
  ledger: SimplifiedDebt[];
  loading: boolean;
  /** true when a BookGroupChore response includes debt_cap_warning (edge case 4). */
  debtCapWarning: boolean;

  refresh: () => Promise<void>;
  refreshVault: () => Promise<void>;
  refreshLedger: () => Promise<void>;
  bookGroupChore: (groupID: string, payload: BookGroupChorePayload) => Promise<BookGroupChoreResponse>;
  topUpPrepaid: (memberID: string, groupID: string, amount: number) => Promise<void>;
  settleExternal: (debtID: string) => Promise<void>;
  verifySettlement: (debtID: string) => Promise<void>;
  leaveGroup: (groupID: string, userID: string, force?: boolean) => Promise<LeaveGroupResult>;
  deleteGroup: (groupID: string, force?: boolean) => Promise<DeleteGroupResult>;
  dismissDebtCapWarning: () => void;
};

// ── Context ───────────────────────────────────────────────────────────────────

const RoomiesContext = createContext<RoomiesContextType | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function RoomiesProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();

  const [myGroup, setMyGroup] = useState<MyGroupResponse | null>(null);
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [ledger, setLedger] = useState<SimplifiedDebt[]>([]);
  const [loading, setLoading] = useState(false);
  const [debtCapWarning, setDebtCapWarning] = useState(false);

  const groupId = myGroup?.group.id ?? null;

  // Load the user's group membership once on auth.
  const refresh = useCallback(async () => {
    if (!ROOMIES_ENABLED || !token) {
      setMyGroup(null);
      return;
    }
    try {
      const data = await RoomiesAPI.getMyGroup(token);
      setMyGroup(data);
    } catch {
      // non-fatal — keep stale data
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshVault = useCallback(async () => {
    if (!token || !groupId) {
      setVault(null);
      return;
    }
    try {
      const data = await RoomiesAPI.getVault(token, groupId);
      setVault(data);
    } catch {
      // non-fatal
    }
  }, [token, groupId]);

  const refreshLedger = useCallback(async () => {
    if (!token || !groupId) {
      setLedger([]);
      return;
    }
    try {
      const data = await RoomiesAPI.getLedger(token, groupId);
      setLedger(data);
    } catch {
      setLedger([]);
    }
  }, [token, groupId]);

  // Re-fetch vault + ledger whenever the active group changes.
  useEffect(() => {
    if (!groupId) {
      setVault(null);
      setLedger([]);
      return;
    }
    setLoading(true);
    Promise.all([refreshVault(), refreshLedger()]).finally(() => setLoading(false));
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll vault + ledger every 15s so all devices see balance/debt updates.
  const refreshVaultRef = useRef(refreshVault);
  const refreshLedgerRef = useRef(refreshLedger);
  refreshVaultRef.current = refreshVault;
  refreshLedgerRef.current = refreshLedger;

  useEffect(() => {
    if (!groupId) return;
    const id = setInterval(() => {
      refreshVaultRef.current();
      refreshLedgerRef.current();
    }, 15_000);
    return () => clearInterval(id);
  }, [groupId]);

  // Poll group membership every 30s to detect joins/leaves.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!ROOMIES_ENABLED || !token) return;
    const id = setInterval(() => refreshRef.current(), 30_000);
    return () => clearInterval(id);
  }, [token]);

  const bookGroupChore = useCallback(
    async (groupID: string, payload: BookGroupChorePayload): Promise<BookGroupChoreResponse> => {
      if (!token) throw new Error('Not authenticated');
      const resp = await RoomiesAPI.bookGroupChore(token, groupID, payload);
      if (resp.debt_cap_warning) setDebtCapWarning(true);
      await Promise.all([refreshVault(), refreshLedger()]);
      return resp;
    },
    [token, refreshVault, refreshLedger],
  );

  const topUpPrepaid = useCallback(
    async (memberID: string, groupID: string, amount: number) => {
      if (!token) throw new Error('Not authenticated');
      await RoomiesAPI.topUpPrepaid(token, memberID, { group_id: groupID, amount });
      await refreshVault();
    },
    [token, refreshVault],
  );

  const settleExternal = useCallback(
    async (debtID: string) => {
      if (!token) throw new Error('Not authenticated');
      await RoomiesAPI.markSettlementExternal(token, debtID);
      await refreshLedger();
    },
    [token, refreshLedger],
  );

  const verifySettlement = useCallback(
    async (debtID: string) => {
      if (!token) throw new Error('Not authenticated');
      await RoomiesAPI.verifySettlement(token, debtID);
      await refreshLedger();
    },
    [token, refreshLedger],
  );

  const leaveGroup = useCallback(
    async (groupID: string, userID: string, force = false): Promise<LeaveGroupResult> => {
      if (!token) throw new Error('Not authenticated');
      const result = await RoomiesAPI.leaveGroup(token, groupID, userID, force);
      if (result.left) {
        setMyGroup(null);
        setVault(null);
        setLedger([]);
      }
      return result;
    },
    [token],
  );

  const deleteGroup = useCallback(
    async (groupID: string, force = false): Promise<DeleteGroupResult> => {
      if (!token) throw new Error('Not authenticated');
      const result = await RoomiesAPI.deleteGroup(token, groupID, force);
      if (result.deleted) {
        setMyGroup(null);
        setVault(null);
        setLedger([]);
      }
      return result;
    },
    [token],
  );

  const dismissDebtCapWarning = useCallback(() => setDebtCapWarning(false), []);

  return (
    <RoomiesContext.Provider
      value={{
        myGroup,
        vault,
        ledger,
        loading,
        debtCapWarning,
        refresh,
        refreshVault,
        refreshLedger,
        bookGroupChore,
        topUpPrepaid,
        settleExternal,
        verifySettlement,
        leaveGroup,
        deleteGroup,
        dismissDebtCapWarning,
      }}
    >
      {children}
    </RoomiesContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRoomies() {
  const ctx = useContext(RoomiesContext);
  if (!ctx) throw new Error('useRoomies must be used within RoomiesProvider');
  return ctx;
}
