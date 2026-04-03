import { useState } from 'react';
import { getConfig, updateConfig, bulkUpdateConfig } from '../api/admin.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function AdminConfigPage() {
  const [configState, setConfigState] = useState({ loading: false, data: null, status: null });
  const [bulkState, setBulkState] = useState({ loading: false, data: null, status: null });
  const [bulkJson, setBulkJson] = useState('{\n  "app.maintenance_mode": "false"\n}');

  // Local state to track input changes before saving individual keys
  const [localEdits, setLocalEdits] = useState({});

  const loadConfig = async () => {
    setConfigState({ loading: true, data: null, status: null });
    try {
      const data = await getConfig();
      setConfigState({ loading: false, data, status: 200 });
      // Reset local edits
      setLocalEdits({});
    } catch (err) {
      setConfigState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const handleSaveIndividual = async (key) => {
    const newValue = localEdits[key];
    if (newValue === undefined) return; // No change made locally
    
    try {
      await updateConfig(key, newValue);
      alert(`Saved ${key}`);
      loadConfig(); // refresh all
    } catch(err) {
      alert("Failed: " + (err.response?.data?.error || err.message));
    }
  };

  const handleBulkSave = async () => {
    setBulkState({ loading: true, data: null, status: null });
    try {
      let parsed;
      try {
        parsed = JSON.parse(bulkJson);
      } catch (e) {
        throw new Error("Invalid JSON structure");
      }
      
      const payload = Object.entries(parsed).map(([key, value]) => ({ key, value }));
      const data = await bulkUpdateConfig(payload);
      setBulkState({ loading: false, data, status: 200 });
      loadConfig();
    } catch (err) {
      setBulkState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  // Helper handling input maps
  const getInputValue = (configItem) => {
    if (localEdits[configItem.key] !== undefined) {
      return localEdits[configItem.key];
    }
    return configItem.value;
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Live Business Configuration</h1>
        <p className="text-gray-400">Dynamically update algorithm constants without deploying code.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">All Config Keys</h2>
          <button 
            onClick={loadConfig}
            disabled={configState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50"
          >
            Load Config
          </button>
        </div>

        {configState.status === 200 && configState.data?.configs && (
          <div className="overflow-x-auto mb-4 border border-gray-800 rounded">
            <table className="w-full text-sm text-left text-gray-300">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800">
                <tr>
                  <th className="px-4 py-3 w-1/3">Key / Desc</th>
                  <th className="px-4 py-3 w-1/2">Value</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {configState.data.configs.map(c => (
                  <tr key={c.key} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-3">
                      <p className="font-mono text-indigo-400 font-bold">{c.key}</p>
                      <p className="text-xs text-gray-500 mt-1">{c.description}</p>
                      <span className="bg-gray-700 px-1 rounded text-[10px] mt-1 inline-block">{c.value_type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <input 
                        type="text" 
                        value={getInputValue(c)}
                        onChange={(e) => setLocalEdits({...localEdits, [c.key]: e.target.value})}
                        className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-indigo-500 font-mono text-sm"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                       <button 
                         onClick={() => handleSaveIndividual(c.key)} 
                         disabled={localEdits[c.key] === undefined || localEdits[c.key] === c.value}
                         className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-30 transition-colors"
                       >
                         Save
                       </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {configState.loading && <LoadingSpinner />}
        <ResponseViewer response={configState.data} statusCode={configState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Bulk Update Configurations</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-400 mb-1">JSON Payload map (Key:Value)</label>
          <textarea
            value={bulkJson}
            onChange={(e) => setBulkJson(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-green-400 font-mono text-sm focus:outline-none focus:border-indigo-500 h-32"
          />
        </div>
        <button 
          onClick={handleBulkSave}
          disabled={bulkState.loading}
          className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50"
        >
          POST Bulk Save
        </button>
        {bulkState.loading && <LoadingSpinner />}
        <ResponseViewer response={bulkState.data} statusCode={bulkState.status} />
      </div>

    </div>
  );
}
