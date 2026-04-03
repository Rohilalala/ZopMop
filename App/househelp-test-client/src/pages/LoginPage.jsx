import { useState, useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { sendOTP, verifyOTP } from '../api/auth.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function LoginPage() {
  const { token, login } = useContext(AuthContext);
  
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('+919876543210');
  const [otp, setOtp] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [statusCode, setStatusCode] = useState(null);

  if (token) return <Navigate to="/dashboard" replace />;

  const handleSendOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResponse(null);
    setStatusCode(null);
    try {
      const data = await sendOTP(phone);
      setResponse(data);
      setStatusCode(200);
      setStep(2);
    } catch (err) {
      setResponse(err.response?.data || err.message);
      setStatusCode(err.response?.status || 500);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResponse(null);
    setStatusCode(null);
    try {
      const data = await verifyOTP(phone, otp);
      setResponse(data);
      setStatusCode(200);
      // Wait a moment to show success before redirecting
      setTimeout(() => {
        login(data.token, data.user);
      }, 1000);
    } catch (err) {
      setResponse(err.response?.data || err.message);
      setStatusCode(err.response?.status || 500);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-lg p-8 shadow-xl">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-white">Househelp API Login</h2>
          <p className="text-gray-400 mt-2 text-sm">Test Client Access</p>
        </div>

        {step === 1 ? (
          <form onSubmit={handleSendOTP} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Phone Number</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
                placeholder="+91..."
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded transition-colors disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOTP} className="space-y-4">
            <div>
              <p className="text-sm text-green-400 mb-4 bg-green-500/10 p-3 rounded border border-green-500/20">
                OTP sent to {phone}. Check terminal logs!
              </p>
              <label className="block text-sm font-medium text-gray-400 mb-1">Verification Code</label>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
                placeholder="123456"
                required
              />
            </div>
            <div className="flex space-x-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="w-1/3 bg-gray-800 hover:bg-gray-700 text-white font-medium py-2 px-4 rounded transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading}
                className="w-2/3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded transition-colors disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify OTP'}
              </button>
            </div>
          </form>
        )}

        {loading && <div className="mt-4 flex justify-center"><LoadingSpinner text="Connecting to API..." /></div>}
        <div className="mt-6">
          <ResponseViewer response={response} statusCode={statusCode} />
        </div>
      </div>
    </div>
  );
}
