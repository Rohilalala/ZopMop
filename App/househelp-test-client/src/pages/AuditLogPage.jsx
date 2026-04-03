import { useState, useEffect } from 'react';
import { getAuditLog } from '../api/admin.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function AuditLogPage() {
  const [listState, setListState] = useState({ loading: false, data: null, status: null });

  const runList = async () => {
    setListState({ loading: true, data: null, status: null });
    try {
      const data = await getAuditLog();
      setListState({ loading: false, data, status: 200 });
    } catch (err) {
      setListState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  useEffect(() => {
    runList();
  }, []);

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">System Audit Logs</h1>
        <p className="text-gray-400">Read-only event stream of all configuration operations.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">Event Log</h2>
          <button onClick={runList} className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm transition-colors">Refresh Log</button>
        </div>

        {listState.status === 200 && listState.data?.logs && (
          <div className="overflow-x-auto mb-4 border border-gray-800 rounded">
            <table className="w-full text-sm text-left text-gray-300">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Admin ID</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Delta</th>
                </tr>
              </thead>
              <tbody>
                {listState.data.logs.map(log => (
                  <tr key={log.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-indigo-300">{log.admin_id}</td>
                    <td className="px-4 py-3">
                      <span className="bg-gray-700 px-2 py-0.5 rounded text-xs">{log.target_type}</span>
                      <p className="text-[10px] font-mono mt-1 text-gray-500 truncate w-24">({log.target_id})</p>
                    </td>
                    <td className="px-4 py-3"><span className="text-yellow-400 font-semibold">{log.action}</span></td>
                    <td className="px-4 py-3 max-w-xs truncate text-[10px] font-mono text-gray-400 hover:white-space-normal">
                      {log.new_value !== 'null' ? `${log.old_value} -> ${log.new_value}` : 'N/A'}
                    </td>
                  </tr>
                ))}
                {listState.data.logs.length === 0 && (
                  <tr>
                    <td colSpan="5" className="px-4 py-8 text-center text-gray-500">No logs found in the database.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {listState.loading && <LoadingSpinner />}
        <ResponseViewer response={listState.data} statusCode={listState.status} />
      </div>

    </div>
  );
}
