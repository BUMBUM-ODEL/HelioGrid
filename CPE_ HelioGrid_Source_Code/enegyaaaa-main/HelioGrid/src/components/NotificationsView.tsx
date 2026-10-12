import { AlertTriangle, CheckCircle, Mail, Clock, Filter, Download, Search, Bell, Zap, Battery, Grid3x3, TrendingUp, Shield, AlertCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useEnergySystem } from '../contexts/EnergySystemContext';
import type { AnomalyLogEntry } from '../contexts/EnergySystemContext';

interface Notification {
  id:           number;
  timestamp:    string;
  date:         string;
  time:         string;
  faultType:    string;
  severity:     'critical' | 'warning' | 'info';
  source:       string;
  affectedLoad: string;
  systemAction: string;
  voltageLabel: string;
  voltageValue: string;
  anomalyDelta: string;
  anomalyType:  string;
  batterySOC:   string;
  resolution:   string;
  emailStatus:  'Sent' | 'Failed' | 'Queued' | 'N/A';
}

// [FIX-BUG4] Friendly label — same mapping as AnomalyLogView
function friendlyLabel(type: string, severity: string): string {
  const t = (type ?? '').toLowerCase().trim();
  const isCrit = severity === 'Critical' || severity === 'High';
  if (t === 'dropout')    return '⚡ Dropout';
  if (t === 'spike high') return '📈 Spike — High Voltage';
  if (t === 'spike low')  return '📉 Spike — Low Voltage';
  if (t === 'drift high') return '↗ Drift — High Voltage';
  if (t === 'drift low')  return '↘ Drift — Low Voltage';
  if (t.includes('dropout'))  return '⚡ Dropout';
  if (t.includes('spike'))    return t.includes('low') ? '📉 Spike — Low Voltage' : '📈 Spike — High Voltage';
  if (t.includes('drift'))    return t.includes('low') ? '↘ Drift — Low Voltage' : '↗ Drift — High Voltage';
  if (t.includes('thermal') || t.includes('temp')) return isCrit ? '🌡 Thermal Shutdown' : '🌡 High Temperature';
  return type ? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'System Event';
}

export function NotificationsView({ setActiveView }: { setActiveView?: (v: string) => void }) {
  const { anomalyLogs, gridAnomalyLogs, inverterAnomalyLogs, emailServiceHealth, refreshData } = useEnergySystem();
  // Merge all anomaly sources — grid + inverter + general
  const allLogs = [...(gridAnomalyLogs ?? []), ...(inverterAnomalyLogs ?? []), ...(anomalyLogs ?? [])]
    .filter((l, i, arr) => arr.findIndex(x => x.id === l.id && x.source === l.source) === i)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting,   setIsDeleting]   = useState(false);
  const [deleteMsg,    setDeleteMsg]    = useState('');

  // Friendly source — aligned with AnomalyLogView.friendlySource()
  const friendlySource = (source: string): string => {
    const s = (source ?? '').toLowerCase();
    if (s.includes('grid'))     return 'Grid Sensor (PZEM-004T)';
    if (s.includes('inverter')) return 'Inverter Sensor (PZEM-004T)';
    if (s.includes('battery'))  return 'Battery Sensor (INA219)';
    if (s.includes('solar') || s.includes('pv')) return 'Solar Sensor (WCS1500)';
    if (s.includes('temp') || s.includes('thermal')) return 'Temp Sensor (DHT22)';
    return source || 'System';
  };

  const notifications: Notification[] = allLogs.map((log: AnomalyLogEntry) => {
    const date = new Date(log.timestamp);
    const severityRaw = log.severity?.toLowerCase() ?? '';
    const severity: Notification['severity'] =
      severityRaw === 'critical' || severityRaw === 'high'   ? 'critical' :
      severityRaw === 'warning'  || severityRaw === 'medium' ? 'warning'  : 'info';

    const src = (log.source ?? '').toLowerCase();
    const affectedLoad =
      src.includes('grid')    ? 'All loads (K2 relay)' :
      src.includes('inverter')? 'All loads (K1 relay)' :
      src.includes('battery') ? 'System (battery bank)' :
      src.includes('solar')   ? 'PV array (2S2P)' : 'System';

    const batSOC = log.battery && log.battery !== '0.0' && log.battery !== '0.0%' && log.battery !== '0'
      ? log.battery : '—';

    const isInverterSrc = (log.source ?? '').toLowerCase().includes('inverter');
    const isGridSrc     = (log.source ?? '').toLowerCase().includes('grid');
    const voltLabel = isInverterSrc ? 'Inverter voltage' : isGridSrc ? 'Grid voltage' : 'Voltage';
    const voltVal   = isInverterSrc
      ? (log.inverterVoltage != null ? Number(log.inverterVoltage).toFixed(2) : log.gridVoltage || '—')
      : (log.gridVoltage || '—');
    const deltaNum  = log.anomalyDelta != null ? Number(log.anomalyDelta) : null;
    const deltaStr  = deltaNum != null ? `${deltaNum > 0 ? '+' : ''}${deltaNum.toFixed(1)}V` : '—';
    const typeLabel = isInverterSrc ? `Inverter · ${log.type ?? ''}` : isGridSrc ? `Grid · ${log.type ?? ''}` : (log.type ?? '');
    return {
      id:           log.id,
      timestamp:    log.timestamp,
      date:         date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }),
      time:         date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }),
      faultType:    friendlyLabel(log.type, log.severity),
      severity,
      source:       friendlySource(log.source),
      affectedLoad,
      systemAction: log.systemAction,
      voltageLabel: voltLabel,
      voltageValue: voltVal,
      anomalyDelta: deltaStr,
      anomalyType:  typeLabel,
      batterySOC:   batSOC,
      resolution:   log.status === 'Resolved'   ? 'System stabilized — returned to normal' :
                    log.status === 'Monitoring' ? 'Actively monitoring parameters'          :
                    log.status === 'Active'     ? 'Anomaly active — system responding'      :
                    'Alert logged',
      emailStatus:  log.emailStatus,
    };
  });

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'border-l-red-500 bg-red-50';
      case 'warning':  return 'border-l-yellow-500 bg-yellow-50';
      case 'info':     return 'border-l-blue-500 bg-blue-50';
      default:         return 'border-l-slate-500 bg-slate-50';
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'critical':
        return <span className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-full border border-red-300">Critical</span>;
      case 'warning':
        return <span className="px-2 py-1 text-xs bg-yellow-100 text-yellow-700 rounded-full border border-yellow-300">Warning</span>;
      case 'info':
        return <span className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded-full border border-blue-300">Info</span>;
      default:
        return <span className="px-2 py-1 text-xs bg-slate-100 text-slate-700 rounded-full">Unknown</span>;
    }
  };

  const getEmailStatusIcon = (status: string) => {
    if (status === 'Sent')   return <CheckCircle className="w-4 h-4 text-green-600" />;
    if (status === 'Failed') return <AlertTriangle className="w-4 h-4 text-red-600" />;
    return <Clock className="w-4 h-4 text-yellow-600" />;
  };

  const getSourceIcon = (source: string) => {
    if (source.includes('Grid'))                          return <Zap      className="w-4 h-4 text-blue-600"   />;
    if (source.includes('Solar') || source.includes('Panel')) return <Zap className="w-4 h-4 text-yellow-600" />;
    if (source.includes('Battery'))                       return <Battery  className="w-4 h-4 text-green-600"  />;
    if (source.includes('Outlet'))                        return <Grid3x3  className="w-4 h-4 text-purple-600" />;
    return                                                       <Shield   className="w-4 h-4 text-slate-600"  />;
  };

  // Context polls anomaly logs every 10s — no extra interval needed here

  const filteredNotifications = notifications.filter(notif => {
    const matchesSeverity = filterSeverity === 'all' || notif.severity === filterSeverity;
    const matchesSearch   = searchQuery === '' ||
      notif.faultType.toLowerCase().includes(searchQuery.toLowerCase()) ||
      notif.source.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSeverity && matchesSearch;
  });

  const exportToCSV = () => {
    // Columns match exactly what is shown on each notification card
    const headers = [
      'Timestamp',
      'Fault Type',
      'Severity',
      'Source',
      'Affected Load',
      'Voltage',
      'Delta V',
      'Battery SOC',
      'System Action',
      'Email Status',
    ];
    const esc = (v: string | number | null | undefined) => {
      if (v == null || v === '') return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = filteredNotifications.map(n => [
      esc(n.timestamp),
      esc(n.faultType),
      esc(n.severity),
      esc(n.source),
      esc(n.affectedLoad),
      esc(n.voltageValue),
      esc(n.anomalyDelta),
      esc(n.batterySOC),
      esc(n.systemAction),
      esc(n.emailStatus),
    ].join(','));
    // RFC 4180 \r\n + UTF-8 BOM for Excel
    const csv  = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `anomaly-alerts-${new Date().toISOString().split('T')[0]}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshData();
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const handleDeleteAll = async () => {
    if (!confirm('Delete ALL anomaly notifications? This cannot be undone.')) return;
    setIsDeleting(true); setDeleteMsg('');
    try {
      const results = await Promise.all([
        fetch('/api/anomaly-logs/grid',     { method: 'DELETE' }),
        fetch('/api/anomaly-logs/inverter', { method: 'DELETE' }),
        fetch('/api/anomaly-logs',          { method: 'DELETE' }),
      ]);
      const jsons = await Promise.all(results.map(r => r.json().catch(() => ({}))));
      const total = jsons.reduce((s, j) => s + (j.deleted ?? 0), 0);
      setDeleteMsg(`Deleted ${total} records`);
      await refreshData();
    } catch { setDeleteMsg('Network error'); }
    finally {
      setIsDeleting(false);
      setTimeout(() => setDeleteMsg(''), 3000);
    }
  };

  const criticalCount = notifications.filter(n => n.severity === 'critical').length;
  const warningCount  = notifications.filter(n => n.severity === 'warning').length;
  const infoCount     = notifications.filter(n => n.severity === 'info').length;
  const sentCount     = notifications.filter(n => n.emailStatus === 'Sent').length;
  const failedCount   = notifications.filter(n => n.emailStatus === 'Failed').length;

  return (
    <div className="min-h-screen p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-5">

      {/* HEADER */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-medium text-slate-900">Anomaly alerts &amp; notifications</h1>
          <p className="text-xs sm:text-sm text-slate-500">
            Real-time system fault detection and automated response tracking
          </p>
        </div>
        <button onClick={handleRefresh} disabled={isRefreshing}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm disabled:opacity-50 flex-shrink-0">
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}/>
          Refresh
        </button>
      </div>

      {/* Anomaly Summary Banner */}
      {notifications.length > 0 && (
        <div className={`rounded-xl border-2 px-4 py-3 flex items-center gap-3 shadow-sm ${
          criticalCount > 0 ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'}`}>
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 animate-pulse ${criticalCount > 0 ? 'bg-red-500' : 'bg-amber-500'}`} />
          <div className="flex-1 text-sm">
            <span className={`font-semibold mr-2 ${criticalCount > 0 ? 'text-red-800' : 'text-amber-800'}`}>
              {criticalCount > 0 ? '⚡ Critical Anomaly Detected' : '⚠ Anomaly Warning'}
            </span>
            <span className="text-xs opacity-75">
              {criticalCount > 0 && `${criticalCount} critical`}
              {criticalCount > 0 && warningCount > 0 && ' · '}
              {warningCount > 0 && `${warningCount} warning`}
              {' — check Anomaly Logs for details'}
            </span>
          </div>
          {setActiveView && (
            <button
              onClick={() => setActiveView('history')}
              className="shrink-0 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors">
              View Anomaly Logs →
            </button>
          )}
        </div>
      )}

      {/* Email Service Status */}
      <div className={`flex items-center gap-3 p-3 rounded-xl border-l-4 ${emailServiceHealth ? 'border-l-green-500 bg-green-50 border border-green-200' : 'border-l-red-500 bg-red-50 border border-red-200'}`}>
        <div className={`p-2 rounded-lg ${emailServiceHealth ? 'bg-green-100' : 'bg-red-100'}`}>
          <Mail className={`w-5 h-5 ${emailServiceHealth ? 'text-green-600' : 'text-red-600'}`}/>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-800">Email service:</span>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${emailServiceHealth ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}/>
              <span className={`text-sm font-medium ${emailServiceHealth ? 'text-green-700' : 'text-red-700'}`}>
                {emailServiceHealth ? 'Online & active' : 'Offline'}
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {emailServiceHealth
              ? `${sentCount} sent · ${failedCount} failed`
              : 'Email notifications unavailable. Alerts are logged locally.'}
          </p>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total alerts',   value: notifications.length, icon: Bell,          color: 'text-slate-700', bg: 'bg-slate-50',   border: 'border-slate-200', iconBg: 'bg-slate-100',   iconColor: 'text-slate-500' },
          { label: 'Critical',       value: criticalCount,         icon: AlertTriangle,  color: 'text-red-700',   bg: 'bg-red-50',     border: 'border-red-200',   iconBg: 'bg-red-100',     iconColor: 'text-red-600' },
          { label: 'Warnings',       value: warningCount,          icon: AlertCircle,    color: 'text-yellow-700',bg: 'bg-yellow-50',  border: 'border-yellow-200',iconBg: 'bg-yellow-100',  iconColor: 'text-yellow-600' },
          { label: 'Info',           value: infoCount,             icon: TrendingUp,     color: 'text-blue-700',  bg: 'bg-blue-50',    border: 'border-blue-200',  iconBg: 'bg-blue-100',    iconColor: 'text-blue-600' },
        ].map(s => {
          const Icon = s.icon;
          return (
            <div key={s.label} className={`flex items-center justify-between p-3 sm:p-4 rounded-xl border ${s.bg} ${s.border}`}>
              <div>
                <p className="text-xs text-slate-500 mb-1">{s.label}</p>
                <p className={`text-2xl sm:text-3xl font-medium ${s.color}`}>{s.value}</p>
              </div>
              <div className={`p-2.5 rounded-lg ${s.iconBg}`}>
                <Icon className={`w-5 h-5 ${s.iconColor}`}/>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filter & Search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"/>
          <input type="text" placeholder="Search by fault type or source…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"/>
        </div>
        <div className="relative sm:w-48">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"/>
          <select value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)}
            className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none">
            <option value="all">All severities</option>
            <option value="critical">Critical only</option>
            <option value="warning">Warning only</option>
            <option value="info">Info only</option>
          </select>
        </div>
        <button onClick={exportToCSV}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm flex-shrink-0">
          <Download className="w-4 h-4"/>Export CSV
        </button>
        <button onClick={handleDeleteAll} disabled={isDeleting || notifications.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm flex-shrink-0 disabled:opacity-50">
          <Trash2 className="w-4 h-4"/>{deleteMsg || (isDeleting ? 'Deleting…' : 'Delete All')}
        </button>
      </div>

      <div className="text-xs text-slate-400">
        Showing {filteredNotifications.length} of {notifications.length} alerts
      </div>

      {/* Notifications List */}
      <div className="space-y-3">
        {filteredNotifications.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <Bell className="w-10 h-10 text-slate-300 mb-3"/>
            <p className="text-slate-500 text-sm">No anomaly alerts found</p>
            <p className="text-xs text-slate-400 mt-1">The system is operating normally</p>
          </div>
        ) : (
          filteredNotifications.map(notif => (
            <div key={`${notif.source}-${notif.id}-${notif.timestamp}`} className={`rounded-xl border-l-4 border border-r border-t border-b shadow-sm hover:shadow-md transition-shadow ${getSeverityColor(notif.severity)}`}>
              <div className="p-3 sm:p-4">
                <div className="space-y-3">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="mt-0.5 flex-shrink-0">{getSourceIcon(notif.source)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <h3 className="text-sm sm:text-base font-medium text-slate-900 flex-1 leading-snug">{notif.faultType}</h3>
                          {getSeverityBadge(notif.severity)}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Clock className="w-3 h-3"/>
                          <span>{notif.date} at {notif.time}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Details grid */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div className="space-y-1.5 text-xs">
                      {[
                        { label: 'Source',         value: notif.source,       cls: 'text-slate-800 font-medium' },
                        { label: 'Affected load',  value: notif.affectedLoad, cls: 'text-slate-700' },
                        { label: 'System action',  value: notif.systemAction, cls: 'text-blue-700 font-medium' },
                        { label: 'Resolution',     value: notif.resolution,   cls: 'text-emerald-700' },
                      ].map(({ label, value, cls }) => (
                        <div key={label} className="flex items-start gap-2">
                          <span className="text-slate-400 w-24 flex-shrink-0">{label}:</span>
                          <span className={cls}>{value}</span>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { icon: Zap,     label: notif.voltageLabel, value: notif.voltageValue,  iconCls: 'text-blue-500' },
                        { icon: TrendingUp, label: 'Delta (ΔV)',    value: notif.anomalyDelta,  iconCls: 'text-orange-500' },
                        { icon: Battery, label: 'Battery SOC',  value: notif.batterySOC,   iconCls: 'text-green-500' },
                        { icon: Mail,    label: 'Email',        value: notif.emailStatus,  iconCls: 'text-slate-400', emailIcon: true },
                      ].map(({ icon: Icon, label, value, iconCls, emailIcon }) => (
                        <div key={label} className="bg-white p-2 rounded-lg border border-slate-200">
                          <div className="flex items-center gap-1 mb-1">
                            <Icon className={`w-3 h-3 ${iconCls}`}/>
                            <span className="text-[10px] text-slate-400">{label}</span>
                          </div>
                          {emailIcon ? (
                            <div className="flex items-center gap-1">
                              {getEmailStatusIcon(value as string)}
                              <span className="text-xs text-slate-700">{value}</span>
                            </div>
                          ) : (
                            <div className="text-sm text-slate-800 font-medium">{value}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Email Notification Info */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-50 border border-blue-200">
        <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0">
          <Mail className="w-5 h-5 text-blue-600"/>
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-medium text-blue-900 mb-2">Anomaly detection &amp; alert system</h4>
          <div className="space-y-1.5 text-xs text-blue-800">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0"/>
              <span><strong>Dropout Critical:</strong> V &lt; 0.80 pu (184V) for ≥5 samples, or V &lt; 0.10 pu (23V) instant → Buzzer 5s + Email</span>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0"/>
              <span><strong>Spike Critical:</strong> |ΔV| ≥ 10% Vn (23V) within 1–3 samples → Buzzer 5s + Email</span>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0"/>
              <span><strong>Drift Critical:</strong> deviation ≥ 5% Vn (11.5V) for ≥40 gradual samples → Buzzer 5s + Email</span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0"/>
              <span><strong>Warning level:</strong> Dropout/Spike/Drift below critical threshold → Dashboard only, no buzzer, no email</span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-blue-500 flex-shrink-0"/>
              <span>Context check active — load-switching events suppressed (ΔI &gt; 0.5A or ΔP &gt; 10W)</span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-blue-400 flex-shrink-0"/>
              <span>All alerts logged locally on Raspberry Pi 4B · Vn = 230V (IEEE 1547)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
