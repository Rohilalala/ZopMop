export default function StatusBadge({ statusCode }) {
  if (!statusCode) return null;

  let color = 'bg-gray-500 text-white';
  if (statusCode >= 200 && statusCode < 300) color = 'bg-green-500 text-white';
  else if (statusCode >= 400 && statusCode < 500) color = 'bg-yellow-500 text-white';
  else if (statusCode >= 500) color = 'bg-red-500 text-white';

  return (
    <span className={`px-2 py-1 rounded text-xs font-bold ${color}`}>
      {statusCode}
    </span>
  );
}
