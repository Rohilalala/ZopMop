import { Outlet, Navigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';

export default function Layout({ requireAuth = true }) {
  const { user } = useContext(AuthContext);

  if (requireAuth && !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex font-sans">
      <Sidebar />
      <div className="flex-1 ml-60 flex flex-col h-screen overflow-hidden">
        <div className="flex-1 overflow-auto">
          <div className="p-8 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
