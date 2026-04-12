import { X } from 'lucide-react';
import { useEffect } from 'react';

export default function Modal({ open, isOpen, onClose, title, children, maxWidth = 'max-w-lg' }) {
  const visible = open || isOpen;
  useEffect(() => {
    if (!visible) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <div className={`relative w-full ${maxWidth} bg-gray-900 border border-gray-700 rounded-xl shadow-2xl`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        {/* Body */}
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// Reusable form field helper used inside modals
export function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
