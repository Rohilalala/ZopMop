import { useAuth } from '../store/auth';
import { PermissionKey, hasPermission } from './permissions';

export function usePermission(perm: PermissionKey): boolean {
  const role = useAuth(s => s.admin?.role);
  return hasPermission(role, perm);
}
