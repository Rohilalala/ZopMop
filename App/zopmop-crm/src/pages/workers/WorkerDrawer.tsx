import { Drawer } from '@/components/ui/Drawer';

// Placeholder. Phase D's reported 803-LOC 4-tab drawer was a
// hallucination — the file was committed empty in 89f568f. This stub
// satisfies WorkersPage's import contract and shows admin workarounds
// until the real rebuild lands (filed P1 in docs/phase-12-backlog.md).

interface WorkerDrawerProps {
  workerId: string | null;
  onClose: () => void;
}

export function WorkerDrawer({ workerId, onClose }: WorkerDrawerProps) {
  return (
    <Drawer open={workerId != null} onClose={onClose}>
      <div className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Worker Detail</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Full worker detail view is being rebuilt. For pilot use, manage workers via:
          </p>
        </div>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>Manual deductions: SQL on admin_pro_deductions</li>
          <li>Leave adjustments: POST /admin/pro/:id/leave/allocate (curl)</li>
          <li>Push notifications: /push page (target_kind=specific, user_ids=[workerId])</li>
        </ul>
        {workerId && (
          <p className="text-xs text-muted-foreground font-mono">
            Worker ID: {workerId}
          </p>
        )}
      </div>
    </Drawer>
  );
}
