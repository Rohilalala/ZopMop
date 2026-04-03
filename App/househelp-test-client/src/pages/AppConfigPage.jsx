import { useState } from 'react';
import { getConfig, getHome, getServices, getFAQs, getScreen } from '../api/app.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

function MethodRow({ title, description, badge, onClick, loading, response, status, inputSlot }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
      <div className="flex flex-col md:flex-row md:justify-between md:items-start mb-4 gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center space-x-3">
            <span>{title}</span>
            <span className="text-xs font-mono bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded">
              {badge}
            </span>
          </h2>
          <p className="text-gray-400 text-sm mt-1">{description}</p>
        </div>
        <div className="flex items-center space-x-3 shrink-0">
          {inputSlot}
          <button 
            onClick={onClick}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm disabled:opacity-50 whitespace-nowrap"
          >
            Test Endpoint
          </button>
        </div>
      </div>
      {loading && <LoadingSpinner />}
      <ResponseViewer response={response} statusCode={status} />
    </div>
  );
}

export default function AppConfigPage() {
  const [screenKey, setScreenKey] = useState('home');

  const [stateConfig, setStateConfig] = useState({ loading: false, data: null, status: null });
  const [stateHome, setStateHome] = useState({ loading: false, data: null, status: null });
  const [stateServices, setStateServices] = useState({ loading: false, data: null, status: null });
  const [stateFaqs, setStateFaqs] = useState({ loading: false, data: null, status: null });
  const [stateScreen, setStateScreen] = useState({ loading: false, data: null, status: null });

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

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Public App Resources</h1>
        <p className="text-gray-400">These endpoints are called by mobile apps on launch. No auth required.</p>
      </div>

      <MethodRow
        title="Public App Config"
        description="Global variables like min app versions, support email, maintenance mode."
        badge="GET /app/config"
        onClick={() => runCall(getConfig, setStateConfig)}
        {...stateConfig}
      />

      <MethodRow
        title="Home Screen Pack"
        description="Bundled payload containing banners, service categories, and home screen UI config in one roundtrip."
        badge="GET /app/home"
        onClick={() => runCall(getHome, setStateHome)}
        {...stateHome}
      />

      <MethodRow
        title="Service Categories"
        description="List all active service categories."
        badge="GET /app/services"
        onClick={() => runCall(getServices, setStateServices)}
        {...stateServices}
      />

      <MethodRow
        title="FAQs"
        description="List all active FAQs."
        badge="GET /app/faqs"
        onClick={() => runCall(getFAQs, setStateFaqs)}
        {...stateFaqs}
      />

      <MethodRow
        title="Screen Content config"
        description="Fetch Server-Driven UI JSON payload for a given screen key."
        badge="GET /app/screens/:key"
        onClick={() => runCall(getScreen, setStateScreen, screenKey)}
        {...stateScreen}
        inputSlot={
          <input
            type="text"
            value={screenKey}
            onChange={(e) => setScreenKey(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 w-32"
            placeholder="Key (e.g. home)"
          />
        }
      />
    </div>
  );
}
