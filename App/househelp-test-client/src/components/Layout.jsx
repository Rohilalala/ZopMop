import { Outlet, Navigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Globe } from 'lucide-react';

export default function Layout({ requireAuth = true }) {
  const { token, user } = useContext(AuthContext);

  if (requireAuth && !token) {
    return <Navigate to="/login" replace />;
  }

  // Helper check for role if needed on specific routes can be done in pages or wrapper router

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex font-sans">
      <Sidebar />
      <div className="flex-1 ml-64 flex flex-col h-screen overflow-hidden">
        {/* Top banner */}
        <div className="h-12 bg-indigo-900 border-b border-indigo-700 flex items-center px-6 justify-between shrink-0">
          <div className="flex items-center text-sm font-medium text-indigo-100 space-x-2">
            <Globe size={16} />
            <span>Backend: http://localhost:8080</span>
          </div>
          {user && (
            <div className="text-xs text-indigo-200">
              Authenticated as: <span className="font-bold text-white">{user.phone}</span> ({user.role})
            </div>
          )}
        </div>
        
        {/* Page content */}
        <div className="flex-1 overflow-auto p-8">
          <div className="max-w-6xl mx-auto">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
