import { Loader2 } from 'lucide-react';

export default function LoadingSpinner({ text = 'Loading...' }) {
  return (
    <div className="flex items-center space-x-2 text-indigo-500 my-2">
      <Loader2 className="animate-spin" size={20} />
      <span className="text-sm font-medium">{text}</span>
    </div>
  );
}
