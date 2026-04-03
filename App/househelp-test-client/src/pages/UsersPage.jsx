import { useState } from 'react';
import { getUsers, suspendUser, unsuspendUser, getHelpers } from '../api/admin.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function UsersPage() {
  const [usersState, setUsersState] = useState({ loading: false, data: null, status: null });
  const [helpersState, setHelpersState] = useState({ loading: false, data: null, status: null });
  
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState('1');

  const runCall = async (apiFunc, setStateHandler, ...args) => {
    setStateHandler({ loading: true, data: null, status: null });
    try {
      const data = await apiFunc(...args);
      setStateHandler({ loading: false, data, status: 200 });
    } catch (err) {
      setStateHandler({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const handleAction = async (action, id) => {
    try {
      await action(id);
      // Refresh current view
      handleLoadUsers();
    } catch(err) {
      alert("Failed: " + (err.response?.data?.error || err.message));
    }
  };

  const handleLoadUsers = () => {
    const params = { page };
    if (search) params.search = search;
    if (role) params.role = role;
    runCall(getUsers, setUsersState, params);
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Users & Helpers</h1>
        <p className="text-gray-400">Admin management interface for backend authentication objects.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">All Users Search</h2>
        <div className="flex gap-4 items-end mb-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-400 mb-1">Search Phone/Name</label>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500">
              <option value="">All</option>
              <option value="customer">Customer</option>
              <option value="helper">Helper</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="w-20">
            <label className="block text-sm font-medium text-gray-400 mb-1">Page</label>
            <input type="number" min="1" value={page} onChange={(e) => setPage(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <button 
            onClick={handleLoadUsers}
            disabled={usersState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50 h-[42px]"
          >
            Load Users
          </button>
        </div>
        
        {usersState.status === 200 && usersState.data?.users && (
          <div className="overflow-x-auto mb-4 border border-gray-800 rounded">
            <table className="w-full text-sm text-left text-gray-300">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800">
                <tr>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Suspended</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersState.data.users.map(u => (
                  <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-medium">{u.phone}</td>
                    <td className="px-4 py-3">
                      <span className="bg-gray-700 px-2 py-1 rounded text-xs">{u.role}</span>
                    </td>
                    <td className="px-4 py-3">
                      {u.IsSuspended ? <span className="text-red-400 font-medium">Yes</span> : 'No'}
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                       {u.IsSuspended ? (
                         <button onClick={() => handleAction(unsuspendUser, u.id)} className="text-blue-400 hover:text-white hover:underline text-xs">Unsuspend</button>
                       ) : (
                         <button onClick={() => handleAction(suspendUser, u.id)} className="text-red-500 hover:text-white hover:underline text-xs">Suspend</button>
                       )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {usersState.loading && <LoadingSpinner />}
        <ResponseViewer response={usersState.data} statusCode={usersState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">All Helpers Roster</h2>
          <button 
            onClick={() => runCall(getHelpers, setHelpersState)}
            disabled={helpersState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50"
          >
            Load Helpers
          </button>
        </div>

        {helpersState.status === 200 && helpersState.data?.helpers && (
          <div className="overflow-x-auto mb-4 border border-gray-800 rounded">
            <table className="w-full text-sm text-left text-gray-300">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800">
                <tr>
                  <th className="px-4 py-3">User ID</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Rating</th>
                  <th className="px-4 py-3">Total Jobs</th>
                </tr>
              </thead>
              <tbody>
                {helpersState.data.helpers.map(h => (
                  <tr key={h.user_id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-mono text-xs">{h.user_id}</td>
                    <td className="px-4 py-3">
                      {h.is_available ? <span className="text-green-400">Available</span> : <span className="text-yellow-500">Busy</span>}
                    </td>
                    <td className="px-4 py-3">{h.rating === 0 ? 'N/A' : h.rating}</td>
                    <td className="px-4 py-3">{h.total_jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {helpersState.loading && <LoadingSpinner />}
        <ResponseViewer response={helpersState.data} statusCode={helpersState.status} />
      </div>

    </div>
  );
}
