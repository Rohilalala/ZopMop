import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AppConfigPage from './pages/AppConfigPage';
import AuthTestPage from './pages/AuthTestPage';
import BookingsPage from './pages/BookingsPage';
import UsersPage from './pages/UsersPage';
import AdminConfigPage from './pages/AdminConfigPage';
import AppContentPage from './pages/AppContentPage';
import PromotionsPage from './pages/PromotionsPage';
import AuditLogPage from './pages/AuditLogPage';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        
        {/* Protected routes wrapped in Layout */}
        <Route element={<Layout requireAuth={true} />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/app-config" element={<AppConfigPage />} />
          <Route path="/auth-test" element={<AuthTestPage />} />
          <Route path="/bookings" element={<BookingsPage />} />
          
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/admin/config" element={<AdminConfigPage />} />
          <Route path="/admin/content" element={<AppContentPage />} />
          <Route path="/admin/promotions" element={<PromotionsPage />} />
          <Route path="/admin/audit-log" element={<AuditLogPage />} />
        </Route>

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
