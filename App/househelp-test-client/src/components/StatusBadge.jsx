const STYLES = {
  // Booking statuses
  pending:     'bg-yellow-500/15 text-yellow-400  border-yellow-700/40',
  accepted:    'bg-blue-500/15   text-blue-400    border-blue-700/40',
  in_progress: 'bg-indigo-500/15 text-indigo-300  border-indigo-700/40',
  completed:   'bg-green-500/15  text-green-400   border-green-700/40',
  cancelled:   'bg-red-500/15    text-red-400     border-red-700/40',
  // User/helper statuses
  active:      'bg-green-500/15  text-green-400   border-green-700/40',
  suspended:   'bg-red-500/15    text-red-400     border-red-700/40',
  available:   'bg-green-500/15  text-green-400   border-green-700/40',
  busy:        'bg-amber-500/15  text-amber-400   border-amber-700/40',
  offline:     'bg-gray-500/15   text-gray-400    border-gray-700/40',
};

const LABELS = {
  in_progress: 'In Progress',
};

export default function StatusBadge({ status }) {
  const key = String(status ?? '').toLowerCase();
  const style = STYLES[key] || 'bg-gray-500/15 text-gray-400 border-gray-700/40';
  const label = LABELS[key] || String(status ?? '—').replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${style}`}>
      {label}
    </span>
  );
}
