import { apiFetch } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AddressGroup {
  id: string;
  host_user_id: string;
  address_id: string;
  name: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}

export interface JoinGroupResponse {
  group: AddressGroup;
  address_added: boolean;
  address_label: string;
}

export interface MyGroupResponse {
  group: AddressGroup;
  members: AddressMember[];
  my_role: 'host' | 'member';
}

export interface AddressMember {
  id: string;
  user_id: string;
  address_group_id: string;
  prepaid_balance: number;
  role: 'host' | 'member';
  joined_at: string;
}

export interface SimplifiedDebt {
  from: string;
  to: string;
  amount: number;
}

export interface MemberBalance {
  user_id: string;
  balance: number;
}

export interface VaultSummary {
  total_balance: number;
  members: MemberBalance[];
}

export interface AffectedMember {
  user_id: string;
  deducted: number;
  shortfall_debt: number;
}

export interface BookGroupChoreResponse {
  chore_order_id: string;
  initiator_pays: number;
  debt_cap_warning: boolean;
  affected_members: AffectedMember[];
}

export interface LeaveGroupResult {
  pending_dues_warning: boolean;
  left: boolean;
}

export interface DeleteGroupResult {
  pending_dues_warning: boolean;
  members_with_balance?: MemberBalance[];
  deleted: boolean;
}

// ── Request payloads ──────────────────────────────────────────────────────────

export interface CreateGroupPayload {
  address_id: string;
  name: string;
}

export interface BookGroupChorePayload {
  total_amount: number;
  selected_member_ids: string[];
  idempotency_key: string;
}

export interface TopUpPayload {
  group_id: string;
  amount: number; // minimum 25000 units (₹250) — enforced server-side
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function createGroup(
  token: string,
  payload: CreateGroupPayload,
): Promise<AddressGroup> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to create group');
  }
  return validateShape<AddressGroup>(await res.json(), ['id', 'host_user_id', 'address_id', 'name']);
}

export async function joinGroup(
  token: string,
  code: string,
): Promise<JoinGroupResponse> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/join`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to join group');
  }
  return validateShape<JoinGroupResponse>(await res.json(), ['group', 'address_added', 'address_label']);
}

export async function getMyGroup(
  token: string,
): Promise<MyGroupResponse | null> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/me`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null; // backward compat
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to fetch group');
  }
  const data = await res.json();
  if (!data || !data.group) return null; // server returns {group:null} when not in a group
  return validateShape<MyGroupResponse>(data, ['group', 'members', 'my_role']);
}

export async function leaveGroup(
  token: string,
  groupID: string,
  userID: string,
  force = false,
): Promise<LeaveGroupResult> {
  const url = `${BASE_URL}/roomies/groups/${groupID}/members/${userID}${force ? '?force=true' : ''}`;
  const res = await apiFetch(url, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to leave group');
  }
  return validateShape<LeaveGroupResult>(await res.json(), ['pending_dues_warning', 'left']);
}

export async function transferHost(
  token: string,
  groupID: string,
  toUserID: string,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/${groupID}/transfer-host`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ to_user_id: toUserID }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to transfer host');
  }
}

export async function deleteGroup(
  token: string,
  groupID: string,
  force = false,
): Promise<DeleteGroupResult> {
  const url = `${BASE_URL}/roomies/groups/${groupID}${force ? '?force=true' : ''}`;
  const res = await apiFetch(url, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to delete group');
  }
  return validateShape<DeleteGroupResult>(await res.json(), ['pending_dues_warning', 'deleted']);
}

export async function bookGroupChore(
  token: string,
  groupID: string,
  payload: BookGroupChorePayload,
): Promise<BookGroupChoreResponse> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/${groupID}/book`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to book group chore');
  }
  return validateShape<BookGroupChoreResponse>(
    await res.json(),
    ['chore_order_id', 'initiator_pays', 'debt_cap_warning', 'affected_members'],
  );
}

export async function topUpPrepaid(
  token: string,
  memberID: string,
  payload: TopUpPayload,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/roomies/members/${memberID}/topup`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to top up wallet');
  }
}

export async function markSettlementExternal(
  token: string,
  debtID: string,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/roomies/debts/${debtID}/settle-external`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to mark debt as settled');
  }
}

export async function verifySettlement(
  token: string,
  debtID: string,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/roomies/debts/${debtID}/verify`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to verify settlement');
  }
}

export async function getLedger(
  token: string,
  groupID: string,
): Promise<SimplifiedDebt[]> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/${groupID}/ledger`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to fetch ledger');
  }
  const data = await res.json();
  if (!Array.isArray(data.ledger)) return [];
  return data.ledger as SimplifiedDebt[];
}

export async function getVault(
  token: string,
  groupID: string,
): Promise<VaultSummary> {
  const res = await apiFetch(`${BASE_URL}/roomies/groups/${groupID}/vault`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to fetch vault');
  }
  return validateShape<VaultSummary>(await res.json(), ['total_balance', 'members']);
}
