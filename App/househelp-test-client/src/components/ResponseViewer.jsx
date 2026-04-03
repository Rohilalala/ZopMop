import { useState } from 'react';
import StatusBadge from './StatusBadge';
import { Copy, CheckCircle2 } from 'lucide-react';

export default function ResponseViewer({ response, statusCode }) {
  const [copied, setCopied] = useState(false);

  if (!response && !statusCode) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-4 rounded border border-gray-700 bg-gray-900 overflow-hidden shadow">
      <div className="flex justify-between items-center px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center space-x-3">
          <span className="text-sm font-medium text-gray-300">API Response</span>
          <StatusBadge statusCode={statusCode} />
        </div>
        <button
          onClick={handleCopy}
          className="text-gray-400 hover:text-white transition-colors"
          title="Copy JSON"
        >
          {copied ? <CheckCircle2 size={16} className="text-green-500" /> : <Copy size={16} />}
        </button>
      </div>
      <div className="p-4 overflow-x-auto">
        <pre className="text-sm text-green-400 font-mono">
          {JSON.stringify(response, null, 2)}
        </pre>
      </div>
    </div>
  );
}
