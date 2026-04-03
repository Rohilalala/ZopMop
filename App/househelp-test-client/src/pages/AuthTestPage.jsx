import { useState } from 'react';
import { sendOTP, verifyOTP } from '../api/auth.api';
import client from '../api/client';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function AuthTestPage() {
  const [phone, setPhone] = useState('+919876543210');
  const [otp, setOtp] = useState('000000');

  const [sendState, setSendState] = useState({ loading: false, data: null, status: null });
  const [verifyState, setVerifyState] = useState({ loading: false, data: null, status: null });
  const [rateState, setRateState] = useState({ loading: false, data: null, status: null });

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

  const handleRateLimit = async () => {
    setRateState({ loading: true, data: null, status: null });
    let promises = [];
    for (let i = 0; i < 35; i++) {
      promises.push(
        client.get('http://localhost:8080/health', { baseURL: '' }).then(res => res.status).catch(err => err.response?.status || 500)
      );
    }
    
    // Attempt all rapidly
    const responses = await Promise.all(promises);
    
    // Tally them
    const tally = {};
    responses.forEach(s => {
      tally[s] = (tally[s] || 0) + 1;
    });

    setRateState({
      loading: false,
      data: {
        total_requests: 35,
        status_codes_received: tally,
        summary: tally['429'] ? 'Rate limit hit accurately!' : 'Rate limit not hit'
      },
      status: 200
    });
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Auth Tests & Limits</h1>
        <p className="text-gray-400">Test OTP states without triggering a global login, alongside Redis limiters.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Send OTP</h2>
        <div className="flex gap-4 items-end mb-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-400 mb-1">Phone Number</label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button 
            onClick={() => runCall(sendOTP, setSendState, phone)}
            disabled={sendState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50 h-[42px]"
          >
            Send OTP
          </button>
        </div>
        {sendState.loading && <LoadingSpinner />}
        <ResponseViewer response={sendState.data} statusCode={sendState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Verify OTP</h2>
        <div className="flex gap-4 items-end mb-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-400 mb-1">Phone Number</label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-400 mb-1">OTP</label>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button 
            onClick={() => runCall(verifyOTP, setVerifyState, phone, otp)}
            disabled={verifyState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50 h-[42px]"
          >
            Verify OTP
          </button>
        </div>
        {verifyState.loading && <LoadingSpinner />}
        <ResponseViewer response={verifyState.data} statusCode={verifyState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-semibold text-white">Rate Limit Test</h2>
            <p className="text-gray-400 text-sm mt-1">Fires 35 concurrent requests to /health rapidly to test Redis IP windowing limit.</p>
          </div>
          <button 
            onClick={handleRateLimit}
            disabled={rateState.loading}
            className="bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded text-sm disabled:opacity-50"
          >
            Hammer /health x35
          </button>
        </div>
        {rateState.loading && <LoadingSpinner text="Firing 35 requests..." />}
        <ResponseViewer response={rateState.data} statusCode={rateState.status} />
      </div>

    </div>
  );
}
