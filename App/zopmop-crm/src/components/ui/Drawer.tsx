import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

// Drawer: right-side slide-in panel. Used for entity detail views (user,
// worker, order). Wider than a Modal — entire workflow lives inside.
//
// Backdrop closes the drawer; ESC closes too. We don't trap focus; if a
// drawer hosts a modal-style confirmation, that ConfirmModal renders above.
export function Drawer({
  open,
  onClose,
  width = 'max-w-2xl',
  children,
}: {
  open: boolean;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
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
          className="fixed inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
          <motion.aside
            className={`absolute top-0 right-0 h-full w-full ${width} bg-surface border-l border-border flex flex-col`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-text-muted hover:text-text-primary transition z-10"
              aria-label="close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
