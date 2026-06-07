import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ListChecks } from 'lucide-react';

import { sduiApi, sduiKeys } from '@/api/sdui';
import { Card, EmptyState, Skeleton } from '@/components/ui';

// SDUI pages index. Lists every page that has SDUI configs; a row drills into
// the per-page lifecycle view at /sdui/:pageId.
export function SduiPagesPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: sduiKeys.pages, queryFn: sduiApi.listPages });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SDUI Pages</h1>
          <p className="text-sm text-text-secondary mt-1">
            Server-driven UI configs — draft, stage, activate, and roll back per page.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => nav('/sdui/allowed-actions')}>
          <ListChecks className="w-4 h-4" />Action allowlist
        </button>
      </div>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left">Page</th>
              <th className="px-4 py-3 text-right w-12" />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-t border-border">
                  {[...Array(2)].map((_, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>
                  ))}
                </tr>
              ))
            ) : (q.data?.length ?? 0) === 0 ? (
              <tr><td colSpan={2}><EmptyState title="No SDUI pages" body="No pages have configs yet." /></td></tr>
            ) : (
              q.data?.map((pageId) => (
                <tr
                  key={pageId}
                  className="border-t border-border cursor-pointer hover:bg-primary/5"
                  onClick={() => nav(`/sdui/${pageId}`)}
                >
                  <td className="px-4 py-3 font-mono">{pageId}</td>
                  <td className="px-4 py-3 text-right text-text-muted"><ChevronRight className="w-4 h-4 inline" /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
