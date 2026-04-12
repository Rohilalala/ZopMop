export default function StatCard({ title, value, sub, icon, color = 'indigo', loading = false }) {
  const colors = {
    indigo: 'text-indigo-400 bg-indigo-500/10',
    green:  'text-green-400  bg-green-500/10',
    amber:  'text-amber-400  bg-amber-500/10',
    red:    'text-red-400    bg-red-500/10',
    blue:   'text-blue-400   bg-blue-500/10',
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-start gap-4">
      {icon && (
        <div className={`p-2.5 rounded-lg ${colors[color]}`}>
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">{title}</p>
        {loading ? (
          <div className="h-7 w-24 bg-gray-800 rounded animate-pulse" />
        ) : (
          <p className={`text-2xl font-bold ${colors[color].split(' ')[0]}`}>{value ?? '—'}</p>
        )}
        {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}
