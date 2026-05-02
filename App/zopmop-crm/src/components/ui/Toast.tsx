import { create } from 'zustand';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

// Imperative toast API. Components anywhere call `showToast({...})` without
// needing to thread context — this is global by design (see ToastHost in
// main.tsx).

type Kind = 'success' | 'error' | 'warning' | 'info';

type Toast = {
  id: number;
  kind: Kind;
  message: string;
  ttlMs: number;
};

type ToastStore = {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  remove: (id: number) => void;
};

let nextId = 1;
const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) =>
    set((s) => ({ toasts: [...s.toasts, { ...t, id: nextId++ }] })),
  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export function showToast(opts: { kind?: Kind; message: string; ttlMs?: number }) {
  const { kind = 'info', message, ttlMs = 4000 } = opts;
  const id = nextId;
  useToasts.getState().push({ kind, message, ttlMs });
  if (ttlMs > 0) setTimeout(() => useToasts.getState().remove(id), ttlMs);
}

const KIND_STYLES: Record<Kind, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  success: { icon: CheckCircle2, color: 'text-success' },
  error:   { icon: AlertTriangle, color: 'text-danger' },
  warning: { icon: AlertTriangle, color: 'text-warning' },
  info:    { icon: Info, color: 'text-text-secondary' },
};

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const remove = useToasts((s) => s.remove);
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => {
          const { icon: Icon, color } = KIND_STYLES[t.kind];
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24 }}
              className="pointer-events-auto card-elevated px-4 py-3 flex items-center gap-3 min-w-[280px] max-w-[420px] shadow-lg"
            >
              <Icon className={`shrink-0 w-5 h-5 ${color}`} />
              <span className="flex-1 text-sm text-text-primary">{t.message}</span>
              <button
                onClick={() => remove(t.id)}
                className="text-text-muted hover:text-text-primary transition"
                aria-label="dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
