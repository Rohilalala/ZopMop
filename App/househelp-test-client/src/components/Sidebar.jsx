import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import {
  LayoutDashboard, BarChart2, CalendarCheck, Users, Wrench,
  Tag, Megaphone, Settings, FileText, Bell, ClipboardList, LogOut,
  Layers, ShieldCheck, UserCheck, IndianRupee,
} from 'lucide-react';

const navigation = [
  {
    section: 'OVERVIEW',
    links: [
      { label: 'Dashboard',   route: '/dashboard',  icon: LayoutDashboard },
      { label: 'Analytics',   route: '/analytics',  icon: BarChart2 },
    ],
  },
  {
    section: 'OPERATIONS',
    links: [
      { label: 'Bookings',    route: '/bookings',   icon: CalendarCheck },
      { label: 'Customers',   route: '/customers',  icon: Users },
      { label: 'Workers',     route: '/workers',    icon: Wrench },
      { label: 'Pending Pros', route: '/pending-pros', icon: UserCheck },
      { label: 'Refunds',     route: '/refunds',    icon: IndianRupee },
    ],
  },
  {
    section: 'CATALOGUE',
    links: [
      { label: 'Services',    route: '/services',    icon: ClipboardList },
      { label: 'Promotions',  route: '/promotions',  icon: Tag },
    ],
  },
  {
    section: 'PLATFORM',
    links: [
      { label: 'Notifications', route: '/notifications', icon: Bell },
      { label: 'Content',       route: '/content',        icon: Megaphone },
      { label: 'Config',        route: '/config',         icon: Settings },
      { label: 'Audit Log',     route: '/audit-log',      icon: FileText },
    ],
  },
  {
    section: 'SERVER-DRIVEN UI',
    links: [
      { label: 'Pages',           route: '/sdui/pages',           icon: Layers },
      { label: 'Allowed Actions', route: '/sdui/allowed-actions', icon: ShieldCheck },
    ],
  },
];

export default function Sidebar() {
  const { user, logout } = useContext(AuthContext);

  return (
    <div className="w-60 bg-gray-950 border-r border-gray-800 h-screen flex flex-col fixed left-0 top-0">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-xs">Z</span>
          </div>
          <div>
            <p className="text-sm font-bold text-white leading-none">ZopMop</p>
            <p className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wider">Owner Panel</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navigation.map((group) => (
          <div key={group.section} className="mb-4">
            <p className="px-5 text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1">
              {group.section}
            </p>
            <ul>
              {group.links.map(({ label, route, icon: Icon }) => (
                <li key={route}>
                  <NavLink
                    to={route}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-5 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-indigo-600/15 text-indigo-400 border-r-2 border-indigo-500'
                          : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
                      }`
                    }
                  >
                    <Icon size={15} className="shrink-0" />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* User footer */}
      {user && (
        <div className="px-4 py-3 border-t border-gray-800 shrink-0 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">{user.phone}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">{user.role}</p>
          </div>
          <button
            onClick={logout}
            title="Logout"
            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
          >
            <LogOut size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
