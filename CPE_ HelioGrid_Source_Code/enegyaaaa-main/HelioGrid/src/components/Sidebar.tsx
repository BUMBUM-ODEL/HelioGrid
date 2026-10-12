import {
  Home, History, Bell, User, LogOut, Zap, HelpCircle,
  BarChart3, Power, Database, Settings,
  ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import type { ViewType } from '../App';
import { useState } from 'react';
import { useEnergySystem } from '../contexts/EnergySystemContext';

interface SidebarProps {
  activeView: ViewType;
  setActiveView: (view: ViewType) => void;
  onClose: () => void;
  onLogout: () => void;
  /** Controlled collapse — pass these from App so the main content can flex-grow properly */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const scrollbarStyle: React.CSSProperties = {
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(148,163,184,0.25) transparent',
};

export function Sidebar({
  activeView,
  setActiveView,
  onClose,
  onLogout,
  collapsed: collapsedProp,
  onToggleCollapse,
}: SidebarProps) {
  const [collapsedInternal, setCollapsedInternal] = useState(false);
  const { gridAnomalyLogs, inverterAnomalyLogs } = useEnergySystem();

  const isCollapsed = collapsedProp !== undefined ? collapsedProp : collapsedInternal;
  const toggleCollapse = () => {
    if (onToggleCollapse) onToggleCollapse();
    else setCollapsedInternal(v => !v);
  };

  const anomalyCount = [...(gridAnomalyLogs ?? []), ...(inverterAnomalyLogs ?? [])]
    .filter(l => (l.status ?? '').toLowerCase() !== 'resolved').length;
  const [seenCount, setSeenCount] = useState(0);
  const visibleBadge = activeView === 'alert-config' ? 0 : Math.max(0, anomalyCount - seenCount);

  const allMenuItems = [
    { id: 'dashboard'      as ViewType, icon: Home,     label: 'Dashboard'            },
    { id: 'analytics'      as ViewType, icon: BarChart3, label: 'Real-Time Analytics' },
    { id: 'power-control'  as ViewType, icon: Power,    label: 'Power & Load Control' },
    { id: 'history'        as ViewType, icon: History,  label: 'Anomaly Logs'         },
    { id: 'alert-config'   as ViewType, icon: Bell,     label: 'Alert Configuration', badge: visibleBadge },
    { id: 'sensor-logs'    as ViewType, icon: Database, label: 'Sensor Data Logs'     },
    { id: 'system-modules' as ViewType, icon: Settings, label: 'System Modules'       },
    { id: 'admin'          as ViewType, icon: User,     label: 'Admin'                },
  ];

  const handleClick = (view: ViewType) => {
    if (view === 'alert-config') setSeenCount(anomalyCount);
    setActiveView(view);
    onClose();
  };
  const handleLogout = () => { onClose(); setTimeout(() => onLogout(), 300); };

  return (
    <div
      className="h-full bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 text-white flex flex-col shadow-2xl transition-all duration-300 overflow-hidden"
      style={{ width: isCollapsed ? '60px' : '220px', minWidth: isCollapsed ? '60px' : '220px' }}
    >

      {/* ── Header ── */}
      <div
        className="flex-shrink-0 border-b border-white/10"
        style={{
          padding: isCollapsed ? '12px 6px' : '10px 10px 10px 12px',
        }}
      >
        {isCollapsed ? (
          /* Collapsed: icon + toggle stacked, all centered */
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => handleClick('dashboard')}
              title="Dashboard"
              className="w-9 h-9 bg-gradient-to-br from-sky-400 to-blue-600 rounded-xl flex items-center justify-center shadow-lg hover:shadow-sky-500/50 transition-shadow"
            >
              <Zap className="w-5 h-5 text-white" />
            </button>
            <button
              onClick={toggleCollapse}
              title="Expand sidebar"
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors text-white/50 hover:text-white"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          /* Expanded: single row — icon | text (flex-1) | toggle */
          <div className="flex items-center gap-2">
            {/* Logo icon — NOT a button so it doesn't break the row layout */}
            <button
              onClick={() => handleClick('dashboard')}
              className="flex-shrink-0 w-9 h-9 bg-gradient-to-br from-sky-400 to-blue-600 rounded-xl flex items-center justify-center shadow-lg hover:shadow-sky-500/50 transition-shadow"
            >
              <Zap className="w-5 h-5 text-white" />
            </button>

            {/* Text block — takes remaining space */}
            <button
              onClick={() => handleClick('dashboard')}
              className="flex-1 min-w-0 text-left hover:opacity-90 transition-opacity"
            >
              <p className="text-sm font-medium truncate leading-tight">HelioGrid</p>
              <p className="text-xs text-blue-300 truncate leading-tight">Campus Resilience</p>
            </button>

            {/* Collapse toggle — rightmost */}
            <button
              onClick={toggleCollapse}
              title="Collapse sidebar"
              className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors text-white/50 hover:text-white"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <nav
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{
          padding: isCollapsed ? '10px 6px' : '10px 8px',
          ...scrollbarStyle,
        }}
      >
        <div className="space-y-0.5">
          {allMenuItems.map((item, idx) => {
            const isActive = activeView === item.id;
            const showDivider = idx === 3;

            return (
              <div key={item.id}>
                {showDivider && <div className="h-px bg-white/10 my-2" />}
                <button
                  onClick={() => handleClick(item.id)}
                  title={item.label}
                  className={`w-full flex items-center rounded-xl transition-all duration-200 relative py-2.5 ${
                    isCollapsed
                      ? 'justify-center px-0'
                      : 'gap-3 px-3 text-left'
                  } ${
                    isActive
                      ? 'bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-lg shadow-blue-500/30'
                      : 'text-blue-100 hover:bg-white/10 hover:translate-x-1'
                  }`}
                >
                  <item.icon className="w-5 h-5 flex-shrink-0" />

                  {!isCollapsed && (
                    <>
                      <span className="flex-1 truncate text-sm">{item.label}</span>
                      {(item as any).badge > 0 && (
                        <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center animate-pulse">
                          {(item as any).badge > 99 ? '99+' : (item as any).badge}
                        </span>
                      )}
                    </>
                  )}

                  {isCollapsed && (item as any).badge > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </nav>

      {/* ── Footer ── */}
      <div
        className="border-t border-white/10 flex-shrink-0 space-y-1"
        style={{ padding: isCollapsed ? '10px 6px' : '10px 8px' }}
      >
        <button
          title="Help & Docs"
          className={`w-full flex items-center rounded-xl text-blue-100 hover:bg-white/10 transition-all py-2.5 ${
            isCollapsed ? 'justify-center px-0' : 'gap-3 px-3 hover:translate-x-1'
          }`}
        >
          <HelpCircle className="w-5 h-5 flex-shrink-0" />
          {!isCollapsed && <span className="truncate text-sm">Help &amp; Docs</span>}
        </button>
        <button
          onClick={handleLogout}
          title="Logout"
          className={`w-full flex items-center rounded-xl text-red-300 hover:bg-red-500/20 transition-all py-2.5 ${
            isCollapsed ? 'justify-center px-0' : 'gap-3 px-3 hover:translate-x-1'
          }`}
        >
          <LogOut className="w-5 h-5 flex-shrink-0" />
          {!isCollapsed && <span className="truncate text-sm">Logout</span>}
        </button>
      </div>
    </div>
  );
}
