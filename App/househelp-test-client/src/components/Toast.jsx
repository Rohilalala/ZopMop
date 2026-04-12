import { CheckCircle, XCircle, Info, X } from 'lucide-react';

const ICONS = {
  success: <CheckCircle size={16} className="text-green-400 shrink-0" />,
  error:   <XCircle    size={16} className="text-red-400   shrink-0" />,
  info:    <Info       size={16} className="text-blue-400  shrink-0" />,
};

const BG = {
  success: 'bg-gray-900 border-green-700',
  error:   'bg-gray-900 border-red-700',
  info:    'bg-gray-900 border-blue-700',
};

export default function Toaster({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 min-w-72 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-xl text-sm text-white animate-slide-in ${BG[t.type] || BG.info}`}
        >
          {ICONS[t.type] || ICONS.info}
          <span className="flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
