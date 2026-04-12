import { useState } from 'react';
import { Send, Users, Wrench, Globe } from 'lucide-react';
import { broadcastNotification } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const TARGETS = [
  { id: 'customers', label: 'Customers', desc: 'All users with customer role', icon: Users },
  { id: 'pros',      label: 'Workers',   desc: 'All registered helpers',        icon: Wrench },
  { id: 'all',       label: 'Everyone',  desc: 'All users across all roles',    icon: Globe },
];

export default function NotificationsPage() {
  const [target, setTarget] = useState('customers');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const { toasts, toast } = useToast();

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) { toast('Title and body required', 'error'); return; }
    if (!window.confirm(`Send push notification to all ${target}?\n\n"${title}"\n${body}`)) return;
    setSending(true);
    try {
      await broadcastNotification({ title: title.trim(), body: body.trim(), target });
      toast('Notification sent');
      setTitle('');
      setBody('');
    } catch (err) {
      toast(err.response?.data?.error || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const selectedTarget = TARGETS.find((t) => t.id === target);

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div>
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <p className="text-gray-400 text-sm mt-0.5">Broadcast push notifications to user segments</p>
      </div>

      <div className="max-w-xl space-y-6">
        {/* Target selector */}
        <div>
          <p className="text-sm font-medium text-gray-300 mb-3">Send to</p>
          <div className="grid grid-cols-3 gap-3">
            {TARGETS.map(({ id, label, desc, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTarget(id)}
                className={`flex flex-col items-start p-4 rounded-xl border text-left transition-colors ${
                  target === id
                    ? 'border-indigo-500 bg-indigo-500/10 text-white'
                    : 'border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-gray-200'
                }`}
              >
                <Icon size={18} className={target === id ? 'text-indigo-400' : 'text-gray-600'} />
                <p className="text-sm font-medium mt-2">{label}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Compose */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <p className="text-sm font-medium text-white">Compose Message</p>

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Notification title..."
              maxLength={64}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <p className="text-right text-xs text-gray-600 mt-1">{title.length}/64</p>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Message body..."
              maxLength={200}
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
            />
            <p className="text-right text-xs text-gray-600 mt-1">{body.length}/200</p>
          </div>
        </div>

        {/* Preview */}
        {(title || body) && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-wide">Preview</p>
            <div className="bg-gray-800 rounded-xl p-4 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-xs">Z</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{title || 'Title...'}</p>
                <p className="text-xs text-gray-400 mt-0.5">{body || 'Body...'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={sending || !title.trim() || !body.trim()}
          className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors disabled:opacity-40"
        >
          <Send size={15} />
          {sending ? 'Sending...' : `Send to ${selectedTarget?.label}`}
        </button>
      </div>
    </div>
  );
}
