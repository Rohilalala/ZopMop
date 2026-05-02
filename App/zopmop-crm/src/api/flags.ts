import { api } from './client';

export type FlagDef = {
  key: string;
  name: string;
  description: string;
  category: string;
  type: 'bool' | 'number' | 'string' | 'enum' | 'json';
  default: unknown;
  min?: number;
  max?: number;
  enum_options?: string[];
};

export type Flag = { def: FlagDef; value: unknown };

export type Snapshot = {
  id: string;
  admin_email?: string | null;
  reason?: string | null;
  flags: Record<string, unknown>;
  diff?: Record<string, unknown>;
  created_at: string;
};

export async function listFlags(): Promise<Flag[]> {
  return (await api.get<{ flags: Flag[] }>('/admin/flags')).data.flags;
}

export async function updateFlag(key: string, value: unknown, reason?: string): Promise<void> {
  await api.put(`/admin/flags/${encodeURIComponent(key)}`, { value, reason });
}

export async function listSnapshots(): Promise<Snapshot[]> {
  return (await api.get<{ snapshots: Snapshot[] }>('/admin/flags/snapshots')).data.snapshots;
}

export async function rollbackSnapshot(id: string): Promise<void> {
  await api.post(`/admin/flags/snapshots/${id}/rollback`);
}
