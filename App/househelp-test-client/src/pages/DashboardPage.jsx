import { useState } from 'react';
import { getDashboard } from '../api/admin.api';
import client from '../api/client';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function DashboardPage() {
  const [healthState, setHealthState] = useState({ loading: false, data: null, status: null });
  const [statsState, setStatsState] = useState({ loading: false, data: null, status: null });

  const checkHealth = async () => {
    setHealthState({ loading: true, data: null, status: null });
    try {
      const { data, status } = await client.get('http://localhost:8080/health', { baseURL: '' });
      setHealthState({ loading: false, data, status });
    } catch (err) {
      setHealthState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const loadStats = async () => {
    setStatsState({ loading: true, data: null, status: null });
    try {
      const data = await getDashboard();
      setStatsState({ loading: false, data, status: 200 });
    } catch (err) {
      setStatsState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold text-white mb-2">System Dashboard</h1>
      
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-semibold text-white">System Health</h2>
            <p className="text-gray-400 text-sm">Validates API gateway is up and uncached.</p>
          </div>
          <button 
            onClick={checkHealth}
            disabled={healthState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm disabled:opacity-50"
          >
            Check /health
          </button>
        </div>
        {healthState.loading && <LoadingSpinner />}
        <ResponseViewer response={healthState.data} statusCode={healthState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-semibold text-white">Admin Dashboard Stats</h2>
            <p className="text-gray-400 text-sm">Protected route that fetches active database metrics.</p>
          </div>
          <button 
            onClick={loadStats}
            disabled={statsState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm disabled:opacity-50"
          >
            Load Stats
          </button>
        </div>

        {statsState.status === 200 && statsState.data && (
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg text-center">
              <p className="text-sm text-gray-400 font-medium">Total Users</p>
              <p className="text-2xl font-bold text-indigo-400 mt-1">{statsState.data.total_users || 0}</p>
            </div>
            <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg text-center">
              <p className="text-sm text-gray-400 font-medium">Total Helpers</p>
              <p className="text-2xl font-bold text-indigo-400 mt-1">{statsState.data.total_helpers || 0}</p>
            </div>
            <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg text-center">
              <p className="text-sm text-gray-400 font-medium">Active Bookings</p>
              <p className="text-2xl font-bold text-indigo-400 mt-1">{statsState.data.active_bookings || 0}</p>
            </div>
            <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg text-center">
              <p className="text-sm text-gray-400 font-medium">Revenue Today</p>
              <p className="text-2xl font-bold text-indigo-400 mt-1">₹{(statsState.data.revenue_today_cents || 0) / 100}</p>
            </div>
          </div>
        )}

        {statsState.loading && <LoadingSpinner />}
        <ResponseViewer response={statsState.data} statusCode={statsState.status} />
      </div>
    </div>
  );
}
