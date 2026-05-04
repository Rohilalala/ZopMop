import { ReactNode } from 'react';
import { PermissionKey } from './permissions';
import { usePermission } from './usePermission';

type Props = {
  perm: PermissionKey;
  children: ReactNode;
  fallback?: ReactNode;
};

/** Renders children only if the current admin has the permission. */
export function Can({ perm, children, fallback = null }: Props) {
  const ok = usePermission(perm);
  return <>{ok ? children : fallback}</>;
}
