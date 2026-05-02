import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

// Modal: frosted-glass backdrop (per design system), centered card, ESC + click
// outside to close. Accessibility: focus is NOT trapped here — keep modals
// shallow, use Drawer for deep workflows.
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" />
          <motion.div
            className={`relative card-elevated w-full ${width} mx-4 p-6`}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div className="flex items-start justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
                <button
                  onClick={onClose}
                  className="text-text-muted hover:text-text-primary transition"
                  aria-label="close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ConfirmModal: for any write action. Plain-English impact line + confirm/cancel.
// `requirePhrase`: optional gate (typed-confirmation pattern from spec).
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  impact,
  confirmLabel = 'Confirm',
  destructive = false,
  requirePhrase,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  impact: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  requirePhrase?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!open) { setTyped(''); setBusy(false); } }, [open]);

  const phraseOk = !requirePhrase || typed === requirePhrase;
  const confirmCls = destructive ? 'btn-danger' : 'btn-primary';

  async function go() {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title} width="max-w-lg">
      <div className="text-sm text-text-secondary mb-6">{impact}</div>
      {requirePhrase && (
        <div className="mb-6">
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
            Type <span className="font-mono text-text-primary">{requirePhrase}</span> to confirm
          </label>
          <input
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className={confirmCls}
          onClick={go}
          disabled={!phraseOk || busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
