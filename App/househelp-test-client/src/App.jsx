import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AnalyticsPage from './pages/AnalyticsPage';
import BookingsPage from './pages/BookingsPage';
import CustomersPage from './pages/CustomersPage';
import WorkersPage from './pages/WorkersPage';
import PendingProsPage from './pages/PendingProsPage';
import RefundsPage from './pages/RefundsPage';
import ServicesPage from './pages/ServicesPage';
import PromotionsPage from './pages/PromotionsPage';
import NotificationsPage from './pages/NotificationsPage';
import ContentPage from './pages/ContentPage';
import ConfigPage from './pages/ConfigPage';
import AuditLogPage from './pages/AuditLogPage';
import SduiPagesPage from './pages/SduiPagesPage';
import SduiAllowedActionsPage from './pages/SduiAllowedActionsPage';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<Layout requireAuth={true} />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"      element={<DashboardPage />} />
          <Route path="/analytics"      element={<AnalyticsPage />} />
          <Route path="/bookings"       element={<BookingsPage />} />
          <Route path="/customers"      element={<CustomersPage />} />
          <Route path="/workers"        element={<WorkersPage />} />
          <Route path="/pending-pros"   element={<PendingProsPage />} />
          <Route path="/refunds"        element={<RefundsPage />} />
          <Route path="/services"       element={<ServicesPage />} />
          <Route path="/promotions"     element={<PromotionsPage />} />
          <Route path="/notifications"  element={<NotificationsPage />} />
          <Route path="/content"        element={<ContentPage />} />
          <Route path="/config"         element={<ConfigPage />} />
          <Route path="/audit-log"      element={<AuditLogPage />} />
          <Route path="/sdui/pages"             element={<SduiPagesPage />} />
          <Route path="/sdui/allowed-actions"   element={<SduiAllowedActionsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
