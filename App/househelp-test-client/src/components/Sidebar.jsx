import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { LogOut } from 'lucide-react';

const navigation = [
  {
    section: 'SYSTEM',
    links: [
      { label: 'Dashboard', route: '/dashboard' },
    ]
  },
  {
    section: 'TESTING',
    links: [
      { label: 'App Config', route: '/app-config' },
      { label: 'Auth Test', route: '/auth-test' },
      { label: 'Bookings', route: '/bookings' },
    ]
  },
  {
    section: 'ADMIN',
    links: [
      { label: 'Users & Helpers', route: '/admin/users' },
      { label: 'App Content', route: '/admin/content' },
      { label: 'Config Manager', route: '/admin/config' },
      { label: 'Promotions', route: '/admin/promotions' },
      { label: 'Audit Log', route: '/admin/audit-log' },
    ]
  }
];

export default function Sidebar() {
  const { user, logout } = useContext(AuthContext);

  return (
    <div className="w-64 bg-gray-900 border-r border-gray-800 h-screen flex flex-col fixed left-0 top-0">
      <div className="p-6 border-b border-gray-800 shrink-0">
        <h1 className="text-lg font-bold text-white tracking-wide">Househelp API</h1>
        <p className="text-xs text-gray-500 mt-1">Test Client v1.0</p>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        {navigation.map((group, idx) => (
          <div key={idx} className="mb-6">
            <h3 className="px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {group.section}
            </h3>
            <ul className="space-y-1">
              {group.links.map((link) => (
                <li key={link.route}>
                  <NavLink
                    to={link.route}
                    className={({ isActive }) =>
                      `block px-6 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-indigo-600/10 text-indigo-400 border-r-2 border-indigo-500'
                          : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                      }`
                    }
                  >
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {user && (
        <div className="p-4 border-t border-gray-800 shrink-0 bg-gray-800/30">
          <div className="flex items-center justify-between">
            <div className="overflow-hidden">
              <p className="text-sm font-medium text-white truncate">{user.phone}</p>
              <p className="text-xs text-gray-500 uppercase tracking-wide mt-1">{user.role}</p>
            </div>
            <button
              onClick={logout}
              className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
