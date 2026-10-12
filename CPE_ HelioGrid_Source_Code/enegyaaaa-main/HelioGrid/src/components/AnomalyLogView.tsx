// AnomalyLogView.tsx — v2.3
// BASE: original design (document index 3) — unchanged visual style
// ADDS ON TOP:
//   - Normal severity: color + icon + filter button + stat count
//   - Per-source columns: Grid → gridV/gridI/gridHz | Inverter → invV/invI/invHz
//   - Battery + Solar removed from table (still in expandable detail)
//   - Action column: Grid dropout → "SSR2 Grid outlet OFF"
//                    Inverter dropout → "SSR1 Solar/Inverter outlet OFF"
//   - Expandable row detail (click row → full context fields)
//   - mapRow moved to top-level, called in handleRefresh + context sync
//   - CSV includes all context fields

import { Download, Shield, RefreshCw, Trash2, Zap, Activity, Search,
         AlertTriangle, CheckCircle, Timer, ChevronDown, ChevronRight,
         Bell, Mail, Thermometer, Battery, Sun } from 'lucide-react';
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { useEnergySystem } from '../contexts/EnergySystemContext';
import type { AnomalyLogEntry } from '../contexts/EnergySystemContext';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getSeverityStyle = (severity: string): React.CSSProperties => {
  switch (severity?.toLowerCase()) {
    case 'critical': return {background:'#ef4444',color:'#fff',outline:'1px solid #dc2626'};
    case 'high':     return {background:'#f97316',color:'#fff',outline:'1px solid #ea580c'};
    case 'medium':
    case 'warning':  return {background:'#fbbf24',color:'#78350f',outline:'1px solid #f59e0b'};
    case 'low':      return {background:'#38bdf8',color:'#fff',outline:'1px solid #0ea5e9'};
    case 'normal':   return {background:'#22c55e',color:'#fff',outline:'1px solid #16a34a'};
    default:         return {background:'#e2e8f0',color:'#475569'};
  }
};
const getSeverityColor = (severity: string) => '';

const getSeverityIcon = (severity: string) => {
  switch (severity?.toLowerCase()) {
    case 'critical':
    case 'high':   return '⚡';
    case 'warning':
    case 'medium': return '⚠';
    case 'normal': return '✓';
    case 'low':    return '·';
    default:       return '·';
  }
};

const getTypeStyle = (type: string): React.CSSProperties => {
  const t = (type ?? '').toLowerCase();
  if (t.includes('dropout'))   return {background:'#ef4444',color:'#fff',outline:'1px solid #dc2626'};
  if (t.includes('spike'))     return {background:'#f97316',color:'#fff',outline:'1px solid #ea580c'};
  if (t.includes('drift'))     return {background:'#fbbf24',color:'#78350f',outline:'1px solid #f59e0b'};
  if (t.includes('normal'))    return {background:'#22c55e',color:'#fff',outline:'1px solid #16a34a'};
  return {background:'#e2e8f0',color:'#475569'};
};
const getTypeColor = (type: string) => '';

const getRowBg = (severity: string) => {
  switch (severity?.toLowerCase()) {
    case 'critical': return 'bg-red-50 border-l-2 border-l-red-400';
    case 'high':     return 'bg-orange-50 border-l-2 border-l-orange-400';
    case 'warning':
    case 'medium':   return 'bg-amber-50/50 border-l-2 border-l-amber-300';
    case 'normal':   return 'bg-emerald-50/30 border-l-2 border-l-emerald-200';
    default:         return '';
  }
};

const formatResponseTime = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

const fmtV = (v: any) => {
  if (v == null || v === '' || v === '—') return '0.0V';
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? '0.0V' : `${n.toFixed(1)}V`;
};
const fmtN = (v: any, unit: string, d = 1) => {
  if (v == null || v === '' || v === '—') return `0.${'0'.repeat(d)}${unit}`;
  const n = parseFloat(String(v));
  return isNaN(n) ? `0.${'0'.repeat(d)}${unit}` : `${n.toFixed(d)}${unit}`;
};

// ─── Action message builder ───────────────────────────────────────────────────
function buildAction(entry: AnomalyLogEntry, source: 'grid' | 'inverter'): string {
  const type = (entry.type ?? '').toLowerCase();
  const sev  = (entry.severity ?? '').toLowerCase();
  if (type === 'dropout' || (sev === 'critical' && fmtV(entry.gridVoltage) === '0.0V')) {
    return source === 'grid' ? 'SSR2 Grid outlet OFF' : 'SSR1 Solar/Inverter outlet OFF';
  }
  if (sev === 'normal' || type.includes('normal')) {
    return entry.message || `${source === 'grid' ? 'Grid' : 'Inverter'} voltage nominal`;
  }
  return entry.message || entry.systemAction || '—';
}

// ─── mapRow — top-level so handleRefresh and context sync both use same mapping
function mapRow(r: any): AnomalyLogEntry {
  return {
    id:           r.id,
    timestamp:    r.timestamp,
    level:
      (r.severity === 'Critical' || r.severity === 'High')   ? 'critical' :
      (r.severity === 'Warning'  || r.severity === 'Medium') ? 'warning'  : 'none',
    subsystem:    r.source       ?? r.subsystem        ?? 'System',
    message:      r.message      ?? r.systemAction     ?? r.system_action ?? '',
    severity:     r.severity     ?? 'Normal',
    type:         r.type         ?? 'Event',
    source:       r.source       ?? 'System',
    systemAction: r.systemAction ?? r.system_action    ?? '',
    gridVoltage:  r.gridVoltage  ?? r.grid_voltage     ?? '—',
    solarPower:   r.solarPower   ?? r.solar_power      ?? '—',
    battery:      r.battery      ?? r.battery_soc      ?? '—',
    status:       r.status       ?? 'Monitoring',
    emailStatus:  r.emailStatus  ?? r.email_status     ?? 'N/A',
    buzzer:       r.buzzer       ?? r.buzzer_status    ?? 'OFF',
    resolvedAt:       r.resolvedAt       ?? r.resolved_at       ?? null,
    responseTimeMs:   r.responseTimeMs   ?? r.response_time_ms  ?? null,
    inverterPower:    r.inverterPower    ?? r.inverter_power     ?? null,
    systemTemp:       r.systemTemp       ?? r.system_temp        ?? null,
    detectedAt:       r.detectedAt       ?? r.detected_at        ?? null,
    actionAt:         r.actionAt         ?? r.action_at          ?? null,
    anomalyLabel:     r.anomalyLabel     ?? r.anomaly_label      ?? null,
    anomalySource:    r.anomalySource    ?? r.anomaly_source     ?? null,
    anomalyDelta:     r.anomalyDelta     ?? r.anomaly_delta      ?? null,
    confirmCount:     r.confirmCount     ?? r.confirm_count      ?? null,
    contextGridCurrent:    r.contextGridCurrent    ?? r.context_grid_current    ?? null,
    contextInvVoltage:     r.contextInvVoltage     ?? r.context_inv_voltage     ?? null,
    contextInvCurrent:     r.contextInvCurrent     ?? r.context_inv_current     ?? null,
    contextGridFrequency:  r.contextGridFrequency  ?? r.context_grid_frequency  ?? null,
    contextInvFrequency:   r.contextInvFrequency   ?? r.context_inv_frequency   ?? null,
    contextBatteryVoltage: r.contextBatteryVoltage ?? r.context_battery_voltage ?? null,
    contextBatteryCurrent: r.contextBatteryCurrent ?? r.context_battery_current ?? null,
    contextSolarPower:     r.contextSolarPower     ?? r.context_solar_power     ?? null,
    contextSensorStatus:   r.contextSensorStatus   ?? r.context_sensor_status   ?? null,
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function buildStats(logs: AnomalyLogEntry[]) {
  const critical = logs.filter(e => e.severity === 'Critical').length;
  const high     = logs.filter(e => e.severity === 'High').length;
  const warning  = logs.filter(e => e.severity === 'Warning' || e.severity === 'Medium').length;
  const normal   = logs.filter(e => e.severity === 'Normal'  || e.severity === 'Low').length;
  const resolved = logs.filter(e => e.status === 'Resolved').length;
  const withTime = logs.filter(e => e.responseTimeMs != null);
  const avgMs    = withTime.length > 0
    ? Math.round(withTime.reduce((s, e) => s + (e.responseTimeMs ?? 0), 0) / withTime.length)
    : null;
  return { critical, high, warning, normal, resolved, avgMs, total: logs.length };
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCSV(logs: AnomalyLogEntry[], filename: string, source: 'grid' | 'inverter') {
  const src = source === 'grid' ? 'Grid' : 'Inverter';
  const headers = [
    'Timestamp', 'Type', 'Severity', 'Source',
    `${src} Voltage (V)`, `${src} Current (A)`, `${src} Frequency (Hz)`, `${src} Power (W)`,
    'Delta V', 'Confirm Count',
    'Battery Voltage (V)', 'Battery Current (A)', 'Battery SOC',
    'Solar Power (W)', 'Sensor Status', 'System Temp (°C)',
    'Status', 'Response Time', 'Buzzer', 'Email Status', 'Action',
  ];
  const esc = (v: any): string => {
    if (v == null || v === '') return '';
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = logs.map(e => [
    esc(e.timestamp), esc(e.type), esc(e.severity), esc(e.source),
    esc(fmtV(source === 'inverter' ? (e.contextInvVoltage ?? e.gridVoltage) : e.gridVoltage)),
    esc(fmtN(source === 'inverter' ? e.contextInvCurrent : e.contextGridCurrent, '', 3)),
    esc(fmtN(source === 'inverter' ? e.contextInvFrequency : e.contextGridFrequency, '', 2)),
    esc(source === 'inverter'
      ? fmtN(e.inverterPower, '', 1)
      : (() => { const v = e.gridVoltage ? Number(e.gridVoltage) : null; const i = e.contextGridCurrent != null ? Number(e.contextGridCurrent) : null; return (v && i) ? (v * i).toFixed(1) : ''; })()
    ),
    esc(e.anomalyDelta != null ? (Number(e.anomalyDelta) > 0 ? '+' : '') + Number(e.anomalyDelta).toFixed(1) + 'V' : ''),
    esc(e.confirmCount),
    esc(fmtN(e.contextBatteryVoltage, '', 2)),
    esc(fmtN(e.contextBatteryCurrent, '', 3)),
    esc(e.battery),
    esc(fmtN(e.contextSolarPower, '', 1)),
    esc(e.contextSensorStatus),
    esc(fmtN(e.systemTemp, '', 1)),
    esc(e.status),
    esc(e.responseTimeMs != null ? formatResponseTime(e.responseTimeMs) : ''),
    esc(e.buzzer), esc(e.emailStatus),
    esc(buildAction(e, source)),
  ].join(','));
  const csv  = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.style.display = 'none';
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── Expandable Row Detail ────────────────────────────────────────────────────
function EntryDetail({ entry }: { entry: AnomalyLogEntry }) {
  const items: { label: string; value: string | null | undefined; icon?: React.ReactNode }[] = [
    { label: 'Detected At',     value: entry.detectedAt },
    { label: 'Action At',       value: entry.actionAt },
    { label: 'Resolved At',     value: entry.resolvedAt },
    { label: 'Response Time',   value: formatResponseTime(entry.responseTimeMs) },
    { label: 'Confirm Count',   value: entry.confirmCount != null ? `${entry.confirmCount}× confirmed` : null },
    { label: 'Anomaly Label',   value: entry.anomalyLabel ?? null },
    { label: 'Anomaly Source',  value: entry.anomalySource ?? null },
    { label: 'Inverter Voltage',value: entry.contextInvVoltage != null ? `${Number(entry.contextInvVoltage).toFixed(1)} V` : null, icon: <Zap className="w-3 h-3 text-violet-400" /> },
    { label: 'System Temp',     value: entry.systemTemp != null ? `${Number(entry.systemTemp).toFixed(1)} °C` : null, icon: <Thermometer className="w-3 h-3 text-orange-400" /> },
    { label: 'Battery Voltage', value: entry.contextBatteryVoltage != null ? `${Number(entry.contextBatteryVoltage).toFixed(2)} V` : null, icon: <Battery className="w-3 h-3 text-blue-400" /> },
    { label: 'Battery Current', value: entry.contextBatteryCurrent != null ? `${Number(entry.contextBatteryCurrent).toFixed(3)} A` : null },
    { label: 'Battery SOC',     value: entry.battery !== '—' ? String(entry.battery) : null },
    { label: 'Solar Power',     value: entry.contextSolarPower != null ? `${Number(entry.contextSolarPower).toFixed(1)} W` : null, icon: <Sun className="w-3 h-3 text-amber-400" /> },
    { label: 'Sensor Status',   value: entry.contextSensorStatus ?? null },
    { label: 'Buzzer',          value: entry.buzzer,      icon: <Bell className="w-3 h-3 text-slate-400" /> },
    { label: 'Email Status',    value: entry.emailStatus, icon: <Mail className="w-3 h-3 text-slate-400" /> },
    { label: 'System Action',   value: entry.systemAction || null },
  ].filter(i => i.value != null && i.value !== '' && i.value !== '—');

  if (items.length === 0) return (
    <div className="text-xs text-slate-400 italic px-2 py-1">No additional context data</div>
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2 px-2 py-2">
      {items.map(({ label, value, icon }) => (
        <div key={label} className="flex items-start gap-1.5">
          {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
          <div>
            <div className="text-[0.6rem] text-slate-400 uppercase tracking-wider">{label}</div>
            <div className="text-xs text-slate-700 font-mono">{value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Section Panel ────────────────────────────────────────────────────────────
type FilterType = 'all' | 'critical' | 'warning' | 'normal' | 'resolved';

function SectionPanel({
  logs, endpoint, label, accentColor, source, onRefresh, onLogsUpdate,
}: {
  logs: AnomalyLogEntry[];
  endpoint: string;
  label: string;
  accentColor: 'blue' | 'violet';
  source: 'grid' | 'inverter';
  onRefresh: () => void;
  onLogsUpdate?: (logs: AnomalyLogEntry[]) => void;
}) {
  const [isDeleting,   setIsDeleting]   = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deleteMsg,    setDeleteMsg]    = useState('');
  const [searchTerm,   setSearchTerm]   = useState('');
  const [filterType,   setFilterType]   = useState<FilterType>('all');
  const [currentPage,  setCurrentPage]  = useState(1);
  const [expandedId,   setExpandedId]   = useState<number | null>(null);
  const itemsPerPage = 10;
  const dateStr = new Date().toISOString().split('T')[0];

  const accent = accentColor === 'violet'
    ? { iconColor: '#7c3aed', ring: 'focus:ring-violet-500', headerColor: '#7c3aed', gradientClass: 'from-violet-50 to-purple-50' }
    : { iconColor: '#2563eb', ring: 'focus:ring-sky-500',    headerColor: '#0284c7', gradientClass: 'from-blue-50 to-sky-50' };

  // [FIX] mapRow called here so raw DB rows are correctly shaped
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const res  = await fetch(`${endpoint}?limit=500`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.logs) && onLogsUpdate) {
        onLogsUpdate(data.logs.map(mapRow));
      } else { onRefresh(); }
    } catch { onRefresh(); }
    finally { setIsRefreshing(false); setCurrentPage(1); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ALL ${label} anomaly logs? This cannot be undone.`)) return;
    setIsDeleting(true); setDeleteMsg('');
    try {
      const res  = await fetch(endpoint, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setDeleteMsg(`Deleted ${data.deleted ?? 'all'}`);
        onRefresh();
      } else { setDeleteMsg(data.error ? `Error: ${data.error}` : 'Failed'); }
    } catch { setDeleteMsg('Network error'); }
    finally { setIsDeleting(false); setTimeout(() => setDeleteMsg(''), 3000); }
  };

  const s = buildStats(logs);

  const filtered = logs.filter(entry => {
    const sev = (entry.severity ?? '').toLowerCase();
    const ok =
      filterType === 'critical' ? (sev === 'critical' || sev === 'high')   :
      filterType === 'warning'  ? (sev === 'warning'  || sev === 'medium') :
      filterType === 'normal'   ? (sev === 'normal'   || sev === 'low')    :
      filterType === 'resolved' ? entry.status === 'Resolved' : true;
    if (!ok) return false;
    const t = searchTerm.toLowerCase().trim();
    if (!t)  return true;
    return [
      entry.timestamp, entry.type, entry.severity, entry.source,
      entry.subsystem, entry.message, entry.systemAction,
      entry.gridVoltage, entry.anomalyLabel ?? '', entry.status,
      entry.contextSensorStatus ?? '',
    ].join(' ').toLowerCase().includes(t);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
  const safePage   = Math.min(currentPage, totalPages);
  const paginated  = filtered.slice((safePage - 1) * itemsPerPage, safePage * itemsPerPage);

  // Per-source column labels
  const isGrid = source === 'grid';
  const vLabel = isGrid ? 'Grid V'  : 'Inv V';
  const iLabel = isGrid ? 'Grid I'  : 'Inv I';
  const hLabel = isGrid ? 'Grid Hz' : 'Inv Hz';
  const wLabel = isGrid ? 'Grid W'  : 'Inv W';

  return (
    <div className="space-y-4">

      {/* Title + actions — original style */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
          <Zap className="w-4 h-4" style={{color: accent.iconColor}} />
          {label} Anomaly Logs
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={handleRefresh} disabled={isRefreshing}
            className="bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button onClick={handleDelete} disabled={isDeleting}
            className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
            <Trash2 className="w-4 h-4 mr-2" />
            {deleteMsg || (isDeleting ? 'Deleting…' : 'Delete All')}
          </Button>
          <Button
            onClick={() => exportCSV(filtered, `${label.toLowerCase().replace(/\s+/g, '_')}_anomaly_${dateStr}.csv`, source)}
            disabled={filtered.length === 0}
            className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50">
            <Download className="w-4 h-4 mr-2" />Download CSV
          </Button>
        </div>
      </div>

      {/* 5 Stat Cards — colored with inline styles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#eff6ff,#e0f2fe)',borderColor:'#bfdbfe'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4" style={{color:'#2563eb'}} />
              <div className="text-xs font-medium" style={{color:'#1d4ed8'}}>Total Events</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#1e3a8a'}}>{s.total}</div>
            <div className="text-xs flex items-center gap-1 mt-1" style={{color:'#2563eb'}}>
              <Activity className="w-3 h-3" />All recorded
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fef2f2,#fee2e2)',borderColor:'#fecaca'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" style={{color:'#dc2626'}} />
              <div className="text-xs font-medium" style={{color:'#b91c1c'}}>Critical / High</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#7f1d1d'}}>
              {s.critical}<span className="text-sm font-normal" style={{color:'#f87171'}}> / {s.high}</span>
            </div>
            <div className="text-xs mt-1" style={{color:'#ef4444'}}>
              {s.warning} warning{s.warning !== 1 ? 's' : ''}
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fffbeb,#fef3c7)',borderColor:'#fde68a'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" style={{color:'#d97706'}} />
              <div className="text-xs font-medium" style={{color:'#b45309'}}>Warning</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#78350f'}}>{s.warning}</div>
            <div className="text-xs mt-1" style={{color:'#d97706'}}>caution events</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0fdf4,#dcfce7)',borderColor:'#bbf7d0'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4" style={{color:'#16a34a'}} />
              <div className="text-xs font-medium" style={{color:'#15803d'}}>Normal / Low</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#14532d'}}>{s.normal}</div>
            <div className="text-xs mt-1" style={{color:'#16a34a'}}>nominal events</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#faf5ff,#f3e8ff)',borderColor:'#e9d5ff'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Timer className="w-4 h-4" style={{color:'#9333ea'}} />
              <div className="text-xs font-medium" style={{color:'#7e22ce'}}>Avg Response Time</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#581c87'}}>
              {s.avgMs != null ? formatResponseTime(s.avgMs) : '—'}
            </div>
            <div className="text-xs mt-1" style={{color:'#9333ea'}}>
              {s.resolved} resolved · Obj 3b
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0f9ff,#e0f2fe)',borderColor:'#7dd3fc'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4" style={{color:'#0369a1'}} />
              <div className="text-xs font-medium" style={{color:'#075985'}}>Type Counts</div>
            </div>
            <div className="space-y-0.5 mt-1">
              {(()=>{
                const d=logs.filter(e=>(e.type??'').toLowerCase().includes('dropout')).length;
                const sp=logs.filter(e=>(e.type??'').toLowerCase().includes('spike')).length;
                const dr=logs.filter(e=>(e.type??'').toLowerCase().includes('drift')).length;
                const n=logs.filter(e=>(e.type??'').toLowerCase().includes('normal')).length;
                return(<>
                  <div className="flex justify-between text-xs"><span style={{color:'#ef4444'}}>Dropout</span><span className="font-mono font-bold" style={{color:'#7f1d1d'}}>{d}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#f97316'}}>Spike</span><span className="font-mono font-bold" style={{color:'#7c2d12'}}>{sp}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#d97706'}}>Drift</span><span className="font-mono font-bold" style={{color:'#78350f'}}>{dr}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#16a34a'}}>Normal</span><span className="font-mono font-bold" style={{color:'#14532d'}}>{n}</span></div>
                </>);
              })()}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search + Filter — original style, added Normal button */}
      <Card className="border-slate-200 shadow-lg">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by timestamp, type, severity, message, source…"
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                className={`w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 ${accent.ring}`}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {([
                { key: 'all',      label: 'All',      count: s.total,             activeStyle: {background:'#2563eb',color:'#fff',borderColor:'#1d4ed8'}, inactiveStyle: {borderColor:'#93c5fd',color:'#1d4ed8'} },
                { key: 'critical', label: 'Critical', count: s.critical + s.high, activeStyle: {background:'#dc2626',color:'#fff',borderColor:'#b91c1c'}, inactiveStyle: {borderColor:'#fca5a5',color:'#b91c1c'} },
                { key: 'warning',  label: 'Warning',  count: s.warning,           activeStyle: {background:'#d97706',color:'#fff',borderColor:'#b45309'}, inactiveStyle: {borderColor:'#fcd34d',color:'#b45309'} },
                { key: 'normal',   label: 'Normal',   count: s.normal,            activeStyle: {background:'#16a34a',color:'#fff',borderColor:'#15803d'}, inactiveStyle: {borderColor:'#86efac',color:'#15803d'} },
                { key: 'resolved', label: 'Resolved', count: s.resolved,          activeStyle: {background:'#9333ea',color:'#fff',borderColor:'#7e22ce'}, inactiveStyle: {borderColor:'#d8b4fe',color:'#7e22ce'} },
              ] as const).map(({ key, label, count, activeStyle, inactiveStyle }) => (
                <button
                  key={key}
                  onClick={() => { setFilterType(key as FilterType); setCurrentPage(1); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all"
                  style={filterType === key ? activeStyle : inactiveStyle}
                >
                  {label}
                  <span className="ml-1.5 font-mono text-[0.6rem] opacity-80">{count}</span>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table Card — original style, new columns + expandable rows */}
      <Card className="border-slate-200 shadow-lg">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Zap className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.headerColor}} />
            {label} Anomaly Log
            <span className="ml-auto text-xs font-normal text-slate-400">{filtered.length} events</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <div className="text-center py-12">
              <Shield className="w-14 h-14 mx-auto text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">No anomalies detected</p>
              <p className="text-xs text-slate-400 mt-1">System is operating normally.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm" style={{ minWidth: '960px' }}>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="w-6 p-2" />
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Timestamp</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Type</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Severity</th>
                      <th className="text-right p-2 text-blue-600 font-medium whitespace-nowrap">{vLabel}</th>
                      <th className="text-right p-2 text-blue-500 font-medium whitespace-nowrap">{iLabel}</th>
                      <th className="text-right p-2 text-indigo-500 font-medium whitespace-nowrap">{hLabel}</th>
                      <th className="text-right p-2 text-purple-600 font-medium whitespace-nowrap">{wLabel}</th>
                      <th className="text-right p-2 text-orange-500 font-medium whitespace-nowrap">ΔV</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Status</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Rsp</th>
                      <th className="text-left p-2 text-slate-600 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="py-10 text-center text-xs text-slate-400">
                          No results match your search or filter.
                        </td>
                      </tr>
                    ) : paginated.map(entry => {
                      const isExpanded = expandedId === entry.id;
                      const action = buildAction(entry, source);
                      return (
                        <React.Fragment key={entry.id}>
                          <tr
                            className={`border-b border-slate-100 hover:bg-slate-50/80 transition-colors cursor-pointer ${getRowBg(entry.severity)}`}
                            onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                          >
                            <td className="p-2 text-slate-400">
                              {isExpanded
                                ? <ChevronDown className="w-3 h-3" />
                                : <ChevronRight className="w-3 h-3" />}
                            </td>
                            <td className="p-2 text-slate-700 whitespace-nowrap font-mono text-xs">{entry.timestamp}</td>
                            <td className="p-2 whitespace-nowrap">
                              <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold" style={getTypeStyle(entry.type ?? '')}>
                                {entry.type ?? 'Unknown'}
                              </span>
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={getSeverityStyle(entry.severity)}>
                                <span style={{fontSize:'10px'}}>{getSeverityIcon(entry.severity)}</span>
                                {entry.severity}
                              </span>
                            </td>
                            <td className="p-2 text-right text-slate-900 whitespace-nowrap font-mono">
                              {isGrid
                                ? fmtV(entry.gridVoltage)
                                : fmtV(entry.contextInvVoltage ?? entry.gridVoltage)}
                            </td>
                            <td className="p-2 text-right text-slate-700 whitespace-nowrap font-mono">
                              {isGrid
                                ? fmtN(entry.contextGridCurrent, 'A', 2)
                                : fmtN(entry.contextInvCurrent,  'A', 2)}
                            </td>
                            <td className="p-2 text-right text-slate-700 whitespace-nowrap font-mono">
                              {isGrid
                                ? (entry.contextGridFrequency != null
                                    ? fmtN(entry.contextGridFrequency, 'Hz', 2)
                                    : (() => {
                                        const m = (entry.message || '').match(/Frequency ([\d.]+)Hz/);
                                        return m ? `${parseFloat(m[1]).toFixed(2)}Hz` : '0.00Hz';
                                      })())
                                : fmtN(entry.contextInvFrequency, 'Hz', 2)}
                            </td>
                            <td className="p-2 text-right text-slate-700 whitespace-nowrap font-mono">
                              {isGrid
                                ? (() => {
                                    // [FIX-GRID-W] Compute grid power from V×I (no dedicated power field in anomaly log)
                                    const v = entry.gridVoltage ? Number(entry.gridVoltage) : null;
                                    const i = entry.contextGridCurrent != null ? Number(entry.contextGridCurrent) : null;
                                    return (v && i) ? fmtN(v * i, 'W', 1) : '—';
                                  })()
                                : fmtN(entry.inverterPower, 'W')}
                            </td>
                            <td className="p-2 text-right whitespace-nowrap font-mono">
                              {entry.anomalyDelta != null ? (
                                <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold
                                  ${Number(entry.anomalyDelta) < 0 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                                  {Number(entry.anomalyDelta) > 0 ? '+' : ''}{Number(entry.anomalyDelta).toFixed(1)}V
                                </span>
                              ) : <span className="text-slate-400 font-mono text-xs">0.0V</span>}
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold
                                ${(entry.status ?? '').toLowerCase() === 'resolved' ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
                                : (entry.status ?? '').toLowerCase() === 'active'   ? 'bg-red-500 text-white ring-1 ring-red-600'
                                : 'bg-slate-100 text-slate-600'}`}>
                                {entry.status ?? 'Monitoring'}
                              </span>
                            </td>
                            <td className="p-2 whitespace-nowrap font-mono text-xs text-slate-500">
                              {formatResponseTime(entry.responseTimeMs)}
                            </td>
                            <td className="p-2 text-slate-600 truncate max-w-[200px] text-xs" title={action}>
                              {action}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <td colSpan={12} className="px-4 py-2">
                                <EntryDetail entry={entry} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination — original style */}
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <div className="text-xs sm:text-sm text-slate-600">
                  Showing{' '}
                  {filtered.length === 0 ? 0 : (safePage - 1) * itemsPerPage + 1}–{Math.min(safePage * itemsPerPage, filtered.length)}{' '}
                  of {filtered.length} events
                </div>
                <div className="flex gap-2 items-center">
                  <Button size="sm" variant="outline"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}>Previous</Button>
                  <span className="px-2 text-xs text-slate-600">{safePage} / {totalPages}</span>
                  <Button size="sm" variant="outline"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Detection Thresholds — original style */}
      <Card className="border-slate-200 shadow-lg" style={{background: accentColor === 'violet' ? 'linear-gradient(135deg,#f5f3ff,#ede9fe)' : 'linear-gradient(135deg,#eff6ff,#e0f2fe)'}}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Zap className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.iconColor}} />Detection Thresholds — {label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">Voltage Anomalies</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• Dropout — sustained V &lt; {isGrid ? '184 V (0.80 pu)' : '176 V (0.80 pu)'} or sensor loss</div>
                <div>• Spike High — ΔV ≥ {isGrid ? '11.5 V (5 % of 230V)' : '11.0 V (5 % of 220V)'} above nominal</div>
                <div>• Drift — slow deviation outside ±5 % over window</div>
                <div>• Normal — V within {isGrid ? '207–253 V · 60Hz nominal' : '209–231 V · 60Hz nominal'}, no anomaly detected</div>
              </div>
            </div>
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">System Response</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• {isGrid ? 'SSR2 K2 OFF — Grid outlet isolated on dropout' : 'SSR1 K1 OFF — Solar/Inverter outlet isolated on dropout'}</div>
                <div>• Buzzer alert — 5 s pulse on Critical only</div>
                <div>• IEEE 1547 §4.2.3 — 5-min reconnect timer (K3)</div>
                <div>• Response time logged — Objective 3b indicator</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

// ─── DC Section Panel (Battery + Solar PV) ───────────────────────────────────
function DCSectionPanel({
  logs, endpoint, label, accentColor, vn, onLogsUpdate,
}: {
  logs:         any[];
  endpoint:     string;
  label:        string;
  accentColor:  'emerald' | 'amber';
  vn:           number;
  onLogsUpdate: (logs: any[]) => void;
}) {
  const [isDeleting,   setIsDeleting]   = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deleteMsg,    setDeleteMsg]    = useState('');
  const [searchTerm,   setSearchTerm]   = useState('');
  const [filterType,   setFilterType]   = useState<FilterType>('all');
  const [currentPage,  setCurrentPage]  = useState(1);
  const [expandedId,   setExpandedId]   = useState<number | null>(null);
  const itemsPerPage = 10;
  const dateStr = new Date().toISOString().split('T')[0];

  const isEmerald = accentColor === 'emerald';
  const accent = isEmerald
    ? { iconColor: '#059669', ring: 'focus:ring-emerald-500', headerColor: '#059669', gradientClass: 'from-emerald-50 to-green-50' }
    : { iconColor: '#d97706', ring: 'focus:ring-amber-500',   headerColor: '#d97706', gradientClass: 'from-amber-50 to-yellow-50' };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const res  = await fetch(`${endpoint}?limit=500`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.logs)) onLogsUpdate(data.logs);
    } catch { /* ignore */ }
    finally { setIsRefreshing(false); setCurrentPage(1); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ALL ${label} DC anomaly logs? This cannot be undone.`)) return;
    setIsDeleting(true); setDeleteMsg('');
    try {
      const res  = await fetch(endpoint, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setDeleteMsg(`Deleted ${data.deleted ?? 'all'}`); onLogsUpdate([]); }
      else setDeleteMsg(data.error ? `Error: ${data.error}` : 'Failed');
    } catch { setDeleteMsg('Network error'); }
    finally { setIsDeleting(false); setTimeout(() => setDeleteMsg(''), 3000); }
  };

  // Build stats — same shape as buildStats() but for DC log fields
  const critical = logs.filter(e => e.severity === 'Critical').length;
  const warning  = logs.filter(e => e.severity === 'Warning').length;
  const normal   = logs.filter(e => e.severity === 'Normal').length;
  const resolved = logs.filter(e => e.status === 'Resolved').length;
  const voltages = logs.map(e => e.voltage).filter((v: any) => Number(v) > 0);
  const minV     = voltages.length ? Math.min(...voltages.map(Number)) : null;
  const s = { total: logs.length, critical, high: 0, warning, normal, resolved, avgMs: null as number | null, minV };

  const filtered = logs.filter((entry: any) => {
    const sev = (entry.severity ?? '').toLowerCase();
    const ok =
      filterType === 'critical' ? sev === 'critical' :
      filterType === 'warning'  ? sev === 'warning'  :
      filterType === 'normal'   ? sev === 'normal'   :
      filterType === 'resolved' ? entry.status === 'Resolved' : true;
    if (!ok) return false;
    const t = searchTerm.toLowerCase().trim();
    if (!t) return true;
    return [
      entry.timestamp, entry.anomaly_type, entry.severity,
      entry.detail, entry.context_note, entry.status,
    ].join(' ').toLowerCase().includes(t);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
  const safePage   = Math.min(currentPage, totalPages);
  const paginated  = filtered.slice((safePage - 1) * itemsPerPage, safePage * itemsPerPage);

  const exportDCCSV = () => {
    const headers = ['Timestamp','Source','Type','Severity','Voltage(V)','DeltaV','PU','Confirmed','Battery SOC','Solar Power(W)','Grid Voltage(V)','Temp(C)','Status','Resolved At','Detail','Context Note'];
    const esc = (v: any) => { if (v == null) return ''; const s = String(v); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
    const rows = filtered.map((e: any) => [
      esc(e.timestamp), esc(e.source), esc(e.anomaly_type), esc(e.severity),
      esc(e.voltage != null ? Number(e.voltage).toFixed(3) : ''),
      esc(e.delta_v != null ? (Number(e.delta_v) >= 0 ? '+' : '') + Number(e.delta_v).toFixed(3) : ''),
      esc(e.pu != null ? Number(e.pu).toFixed(4) : ''),
      esc(e.confirmed ? 'Yes' : 'Suppressed'),
      esc(e.battery_soc != null ? `${e.battery_soc}%` : ''),
      esc(e.solar_power != null ? Number(e.solar_power).toFixed(1) : ''),
      esc(e.grid_voltage != null ? Number(e.grid_voltage).toFixed(1) : ''),
      esc(e.system_temp != null ? Number(e.system_temp).toFixed(1) : ''),
      esc(e.status), esc(e.resolved_at ?? ''), esc(e.detail), esc(e.context_note ?? ''),
    ].join(','));
    const csv  = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `${label.toLowerCase().replace(/\s+/g,'_')}_anomaly_${dateStr}.csv`;
    a.style.display = 'none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="space-y-4">

      {/* Title + actions — same as SectionPanel */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
          {isEmerald ? <Battery className="w-4 h-4" style={{color: accent.iconColor}} /> : <Sun className="w-4 h-4" style={{color: accent.iconColor}} />}
          {label} Anomaly Logs
          <span className="text-xs font-normal text-slate-400 ml-1">Vn = {vn}V</span>
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={handleRefresh} disabled={isRefreshing}
            className="bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button onClick={handleDelete} disabled={isDeleting}
            className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
            <Trash2 className="w-4 h-4 mr-2" />
            {deleteMsg || (isDeleting ? 'Deleting…' : 'Delete All')}
          </Button>
          <Button onClick={exportDCCSV} disabled={filtered.length === 0}
            className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50">
            <Download className="w-4 h-4 mr-2" />Download CSV
          </Button>
        </div>
      </div>

      {/* 5 Stat Cards — exact same as SectionPanel */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#eff6ff,#e0f2fe)',borderColor:'#bfdbfe'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4" style={{color:'#2563eb'}} />
              <div className="text-xs font-medium" style={{color:'#1d4ed8'}}>Total Events</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#1e3a8a'}}>{s.total}</div>
            <div className="text-xs flex items-center gap-1 mt-1" style={{color:'#2563eb'}}>
              <Activity className="w-3 h-3" />All recorded
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fef2f2,#fee2e2)',borderColor:'#fecaca'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" style={{color:'#dc2626'}} />
              <div className="text-xs font-medium" style={{color:'#b91c1c'}}>Critical</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#7f1d1d'}}>{s.critical}</div>
            <div className="text-xs mt-1" style={{color:'#ef4444'}}>
              {s.warning} warning{s.warning !== 1 ? 's' : ''}
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fffbeb,#fef3c7)',borderColor:'#fde68a'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" style={{color:'#d97706'}} />
              <div className="text-xs font-medium" style={{color:'#b45309'}}>Warning</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#78350f'}}>{s.warning}</div>
            <div className="text-xs mt-1" style={{color:'#d97706'}}>caution events</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0fdf4,#dcfce7)',borderColor:'#bbf7d0'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4" style={{color:'#16a34a'}} />
              <div className="text-xs font-medium" style={{color:'#15803d'}}>Normal</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#14532d'}}>{s.normal}</div>
            <div className="text-xs mt-1" style={{color:'#16a34a'}}>nominal events</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fdf4ff,#fae8ff)',borderColor:'#f0abfc'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4" style={{color:'#a855f7'}} />
              <div className="text-xs font-medium" style={{color:'#7e22ce'}}>Min Voltage</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#581c87'}}>
              {s.minV != null ? s.minV.toFixed(2) : '—'}
            </div>
            <div className="text-xs mt-1" style={{color:'#a855f7'}}>
              {s.resolved} resolved · V recorded
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0f9ff,#e0f2fe)',borderColor:'#7dd3fc'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4" style={{color:'#0369a1'}} />
              <div className="text-xs font-medium" style={{color:'#075985'}}>Type Counts</div>
            </div>
            <div className="space-y-0.5 mt-1">
              {(()=>{
                const d=logs.filter((e:any)=>(e.anomaly_type??'').toLowerCase().includes('dropout')).length;
                const sp=logs.filter((e:any)=>(e.anomaly_type??'').toLowerCase().includes('spike')).length;
                const dr=logs.filter((e:any)=>(e.anomaly_type??'').toLowerCase().includes('drift')).length;
                const n=logs.filter((e:any)=>(e.anomaly_type??'').toLowerCase().includes('normal')).length;
                return(<>
                  <div className="flex justify-between text-xs"><span style={{color:'#ef4444'}}>Dropout</span><span className="font-mono font-bold" style={{color:'#7f1d1d'}}>{d}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#f97316'}}>Spike</span><span className="font-mono font-bold" style={{color:'#7c2d12'}}>{sp}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#d97706'}}>Drift</span><span className="font-mono font-bold" style={{color:'#78350f'}}>{dr}</span></div>
                  <div className="flex justify-between text-xs"><span style={{color:'#16a34a'}}>Normal</span><span className="font-mono font-bold" style={{color:'#14532d'}}>{n}</span></div>
                </>);
              })()}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search + Filter — exact same as SectionPanel */}
      <Card className="border-slate-200 shadow-lg">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by timestamp, type, severity, detail…"
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                className={`w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 ${accent.ring}`}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {([
                { key: 'all',      label: 'All',      count: s.total,    activeStyle: {background:'#2563eb',color:'#fff',borderColor:'#1d4ed8'}, inactiveStyle: {borderColor:'#93c5fd',color:'#1d4ed8'} },
                { key: 'critical', label: 'Critical', count: s.critical, activeStyle: {background:'#dc2626',color:'#fff',borderColor:'#b91c1c'}, inactiveStyle: {borderColor:'#fca5a5',color:'#b91c1c'} },
                { key: 'warning',  label: 'Warning',  count: s.warning,  activeStyle: {background:'#d97706',color:'#fff',borderColor:'#b45309'}, inactiveStyle: {borderColor:'#fcd34d',color:'#b45309'} },
                { key: 'normal',   label: 'Normal',   count: s.normal,   activeStyle: {background:'#16a34a',color:'#fff',borderColor:'#15803d'}, inactiveStyle: {borderColor:'#86efac',color:'#15803d'} },
                { key: 'resolved', label: 'Resolved', count: s.resolved, activeStyle: {background:'#9333ea',color:'#fff',borderColor:'#7e22ce'}, inactiveStyle: {borderColor:'#d8b4fe',color:'#7e22ce'} },
              ] as const).map(({ key, label: lbl, count, activeStyle, inactiveStyle }) => (
                <button
                  key={key}
                  onClick={() => { setFilterType(key as FilterType); setCurrentPage(1); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all"
                  style={filterType === key ? activeStyle : inactiveStyle}
                >
                  {lbl}
                  <span className="ml-1.5 font-mono text-[0.6rem] opacity-80">{count}</span>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table Card — same as SectionPanel with DC-specific columns */}
      <Card className="border-slate-200 shadow-lg">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            {isEmerald ? <Battery className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.headerColor}} /> : <Sun className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.headerColor}} />}
            {label} Anomaly Log
            <span className="ml-auto text-xs font-normal text-slate-400">{filtered.length} events</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <div className="text-center py-12">
              <Shield className="w-14 h-14 mx-auto text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">No DC anomalies detected</p>
              <p className="text-xs text-slate-400 mt-1">System is operating normally.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm" style={{ minWidth: '900px' }}>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="w-6 p-2" />
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Timestamp</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Type</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Severity</th>
                      <th className="text-right p-2 font-medium whitespace-nowrap" style={{color: isEmerald ? '#059669' : '#d97706'}}>Voltage</th>
                      <th className="text-right p-2 text-orange-500 font-medium whitespace-nowrap">ΔV</th>
                      <th className="text-right p-2 text-violet-500 font-medium whitespace-nowrap">PU</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Confirmed</th>
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap">Status</th>
                      <th className="text-left p-2 text-slate-600 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-10 text-center text-xs text-slate-400">
                          No results match your search or filter.
                        </td>
                      </tr>
                    ) : paginated.map((entry: any) => {
                      const isExpanded = expandedId === entry.id;
                      return (
                        <React.Fragment key={entry.id}>
                          <tr
                            className={`border-b border-slate-100 hover:bg-slate-50/80 transition-colors cursor-pointer ${getRowBg(entry.severity)}`}
                            onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                          >
                            <td className="p-2 text-slate-400">
                              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            </td>
                            <td className="p-2 text-slate-700 whitespace-nowrap font-mono text-xs">{entry.timestamp}</td>
                            <td className="p-2 whitespace-nowrap">
                              <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold" style={getTypeStyle(entry.anomaly_type ?? '')}>
                                {entry.anomaly_type ?? 'Unknown'}
                              </span>
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={getSeverityStyle(entry.severity)}>
                                <span style={{fontSize:'10px'}}>{getSeverityIcon(entry.severity)}</span>
                                {entry.severity}
                              </span>
                            </td>
                            <td className="p-2 text-right font-mono whitespace-nowrap text-slate-900">
                              {entry.voltage != null ? `${Number(entry.voltage).toFixed(2)}V` : '0.00V'}
                            </td>
                            <td className="p-2 text-right whitespace-nowrap font-mono">
                              {entry.delta_v != null ? (
                                <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold
                                  ${Number(entry.delta_v) < 0 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                                  {Number(entry.delta_v) >= 0 ? '+' : ''}{Number(entry.delta_v).toFixed(2)}V
                                </span>
                              ) : <span className="text-slate-400 font-mono text-xs">0.00V</span>}
                            </td>
                            <td className="p-2 text-right font-mono text-xs text-slate-600 whitespace-nowrap">
                              {entry.pu != null ? Number(entry.pu).toFixed(3) : '0.000'}
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              {entry.confirmed
                                ? <span className="text-xs text-emerald-600 font-medium">✓ Yes</span>
                                : <span className="text-xs text-amber-600 font-medium">✗ Suppressed</span>}
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold
                                ${(entry.status ?? '').toLowerCase() === 'resolved' ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
                                : (entry.status ?? '').toLowerCase() === 'active'   ? 'bg-red-500 text-white ring-1 ring-red-600'
                                : 'bg-slate-100 text-slate-600'}`}>
                                {entry.status ?? 'Monitoring'}
                              </span>
                            </td>
                            <td className="p-2 text-slate-600 truncate max-w-[200px] text-xs" title={entry.detail}>
                              {entry.detail}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <td colSpan={10} className="px-4 py-2">
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2">
                                  {[
                                    { label: 'PU (V/Vn)',    value: entry.pu != null ? Number(entry.pu).toFixed(4) : null },
                                    { label: 'Delta V',      value: entry.delta_v != null ? `${Number(entry.delta_v) >= 0 ? '+' : ''}${Number(entry.delta_v).toFixed(3)}V` : null },
                                    { label: 'Confirmed',    value: entry.confirmed ? '✓ Yes' : '✗ Suppressed (load-switch)' },
                                    { label: 'Context Note', value: entry.context_note || null },
                                    { label: 'Battery SOC',  value: entry.battery_soc != null ? `${entry.battery_soc}%` : null, icon: <Battery className="w-3 h-3 text-green-400" /> },
                                    { label: 'Solar Power',  value: entry.solar_power != null ? `${Number(entry.solar_power).toFixed(1)}W` : null, icon: <Sun className="w-3 h-3 text-amber-400" /> },
                                    { label: 'Grid Voltage', value: entry.grid_voltage != null ? `${Number(entry.grid_voltage).toFixed(1)}V` : null, icon: <Zap className="w-3 h-3 text-blue-400" /> },
                                    { label: 'System Temp',  value: entry.system_temp != null ? `${Number(entry.system_temp).toFixed(1)}°C` : null, icon: <Thermometer className="w-3 h-3 text-orange-400" /> },
                                    { label: 'Resolved At',  value: entry.resolved_at ?? null },
                                    { label: 'System Action',value: entry.status ?? null },
                                  ].filter(i => i.value != null && i.value !== '' && i.value !== '—').map(({ label: lbl, value, icon }) => (
                                    <div key={lbl} className="flex items-start gap-1.5">
                                      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
                                      <div>
                                        <div className="text-[0.6rem] text-slate-400 uppercase tracking-wider">{lbl}</div>
                                        <div className="text-xs text-slate-700 font-mono">{value}</div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination — exact same as SectionPanel */}
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <div className="text-xs sm:text-sm text-slate-600">
                  Showing{' '}
                  {filtered.length === 0 ? 0 : (safePage - 1) * itemsPerPage + 1}–{Math.min(safePage * itemsPerPage, filtered.length)}{' '}
                  of {filtered.length} events
                </div>
                <div className="flex gap-2 items-center">
                  <Button size="sm" variant="outline"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}>Previous</Button>
                  <span className="px-2 text-xs text-slate-600">{safePage} / {totalPages}</span>
                  <Button size="sm" variant="outline"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Detection Thresholds — same as SectionPanel threshold card */}
      <Card className="border-slate-200 shadow-lg" style={{background: isEmerald ? 'linear-gradient(135deg,#ecfdf5,#f0fdf4)' : 'linear-gradient(135deg,#fffbeb,#fefce8)'}}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            {isEmerald ? <Battery className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.iconColor}} /> : <Sun className="w-4 h-4 sm:w-5 sm:h-5" style={{color: accent.iconColor}} />}
            Detection Thresholds — {label} (Vn = {vn}V)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">DC Voltage Anomalies</div>
              <div className="space-y-1 text-xs text-slate-600">
                {isEmerald ? (
                  // Battery: 0.95/0.90 pu dropout | 20%/30% spike | 15%/20% drift
                  <>
                    <div>• Dropout — V &lt; {(vn * 0.95).toFixed(1)}V (0.95 pu) 2–4 samples → Warning</div>
                    <div>• Dropout — V &lt; {(vn * 0.90).toFixed(1)}V (0.90 pu) ≥5 samples → Critical</div>
                    <div>• Dropout — 0V → instant Critical (sensor fault)</div>
                    <div>• Overcharge — V &gt; 29V → instant Critical</div>
                    <div>• Spike — |ΔV| ≥ {(vn * 0.20).toFixed(1)}V (20% Vn) → Warning</div>
                    <div>• Spike — |ΔV| ≥ {(vn * 0.30).toFixed(1)}V (30% Vn) → Critical</div>
                    <div>• Drift — ≥15% from baseline for 10+ samples → Warning</div>
                    <div>• Drift — ≥20% from baseline for 20+ samples → Critical</div>
                  </>
                ) : (
                  // Solar: 0.75/0.41 pu dropout | 10%/20% spike (outside band) | 8%/15% drift
                  <>
                    <div>• Dropout — V &lt; {(vn * 0.75).toFixed(1)}V (0.75 pu) 2–4 samples → Warning</div>
                    <div>• Dropout — V &lt; {(vn * 0.41).toFixed(1)}V (0.41 pu) ≥5 samples → Critical</div>
                    <div>• Dropout — 0V daytime → instant Critical | 0V night → Normal</div>
                    <div>• Spike — |ΔV| ≥ {(vn * 0.10).toFixed(1)}V (10% Vn) outside band → Warning</div>
                    <div>• Spike — |ΔV| ≥ {(vn * 0.20).toFixed(1)}V (20% Vn) → Critical</div>
                    <div>• Drift — ≥8% from baseline for 10+ samples → Warning</div>
                    <div>• Drift — ≥15% from baseline for 20+ samples → Critical</div>
                  </>
                )}
              </div>
            </div>
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">System Response</div>
              <div className="space-y-1 text-xs text-slate-600">
                {isEmerald ? (
                  <>
                    <div>• Battery DC monitoring — email alert on Warning/Critical</div>
                    <div>• MCCB protection — inverter handles deep discharge cutoff</div>
                    <div>• Normal band — 23.0V – 27.5V (inverter+solar ON) · 24–26V (idle)</div>
                    <div>• 2× JSL 12V 100Ah in series · Voltage Divider (ratio 2.33)</div>
                  </>
                ) : (
                  <>
                    <div>• Solar PV DC monitoring — display only, no relay action</div>
                    <div>• Arduino WCS1500 (current) + Voltage Divider (A4) → DC readings</div>
                    <div>• Normal band — 80V – 105V daytime · 0V at night = Normal</div>
                    <div>• JAM72D40-580 2S2P · Vmp 42.37V × 2 = 84.74V nominal</div>
                  </>
                )}
                <div>• Context suppression — load-switching events filtered</div>
                <div>• Logged to {isEmerald ? 'dc_battery_anomaly_logs' : 'dc_solar_anomaly_logs'}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

// ─── One-time cleanup button ───────────────────────────────────────────────────
function CleanupButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState('');
  const [done, setDone] = useState(false);

  const handleCleanup = async () => {
    if (!confirm('Remove fake dropout records caused by PZEM serial errors? This cannot be undone.')) return;
    setBusy(true); setMsg('');
    try {
      const res  = await fetch('/api/anomaly-logs/cleanup-serial-errors', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setMsg(`Removed ${data.deleted ?? 0} fake records`);
        setDone(true); onDone();
      } else { setMsg(data.error ? `Error: ${data.error}` : 'Failed'); }
    } catch { setMsg('Network error'); }
    finally { setBusy(false); setTimeout(() => setMsg(''), 4000); }
  };

  if (done && !msg) return null;
  return (
    <Button onClick={handleCleanup} disabled={busy || done} variant="outline"
      className="border-amber-400 text-amber-700 hover:bg-amber-50 disabled:opacity-50 text-xs">
      <Trash2 className="w-3 h-3 mr-1.5" />
      {msg || (busy ? 'Cleaning…' : 'Remove PZEM Error Logs')}
    </Button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export function AnomalyLogView() {
  const {
    gridAnomalyLogs:     ctxGridLogs = [],
    inverterAnomalyLogs: ctxInvLogs  = [],
    refreshData,
  } = useEnergySystem();

  const [gridLogs,    setGridLogs]    = useState<AnomalyLogEntry[]>(ctxGridLogs);
  const [invLogs,     setInvLogs]     = useState<AnomalyLogEntry[]>(ctxInvLogs);
  const [batDcLogs,   setBatDcLogs]   = useState<any[]>([]);
  const [solDcLogs,   setSolDcLogs]   = useState<any[]>([]);

  React.useEffect(() => { setGridLogs(ctxGridLogs); }, [ctxGridLogs]);
  React.useEffect(() => { setInvLogs(ctxInvLogs);   }, [ctxInvLogs]);

  // Fetch DC logs on mount + every 30s
  const fetchDC = React.useCallback(async () => {
    try {
      const [br, sr] = await Promise.all([
        fetch('/api/dc-anomaly-logs/battery?limit=500'),
        fetch('/api/dc-anomaly-logs/solar?limit=500'),
      ]);
      const bd = await br.json().catch(() => ({}));
      const sd = await sr.json().catch(() => ({}));
      if (Array.isArray(bd.logs)) setBatDcLogs(bd.logs);
      if (Array.isArray(sd.logs)) setSolDcLogs(sd.logs);
    } catch { /* non-critical */ }
  }, []);

  React.useEffect(() => {
    fetchDC();
    const id = setInterval(fetchDC, 30_000);
    return () => clearInterval(id);
  }, [fetchDC]);

  return (
    <div className="p-3 sm:p-4 lg:p-6 xl:p-8 space-y-8 sm:space-y-10">

      {/* Page Header — original style */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 sm:space-y-2">
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-semibold text-slate-900">
            Anomaly Detection Logs
          </h1>
          <p className="text-xs sm:text-sm lg:text-base text-slate-600">
            AC voltage anomaly detection (Grid &amp; Inverter) · DC low-voltage detection (Battery &amp; Solar PV)
          </p>
        </div>
        <CleanupButton onDone={() => { setGridLogs([]); setInvLogs([]); refreshData(); }} />
      </div>

      {/* AC Sections */}
      <SectionPanel key="grid"     label="Grid AC"     logs={gridLogs} endpoint="/api/anomaly-logs/grid"     accentColor="blue"   source="grid"     onRefresh={refreshData} onLogsUpdate={setGridLogs} />
      <div className="border-t border-slate-200" />
      <SectionPanel key="inverter" label="Inverter AC" logs={invLogs}  endpoint="/api/anomaly-logs/inverter" accentColor="violet" source="inverter" onRefresh={refreshData} onLogsUpdate={setInvLogs} />

      {/* DC Sections */}
      <div className="border-t-2 border-slate-300" />
      <DCSectionPanel
        label="Battery Pack DC"
        logs={batDcLogs}
        endpoint="/api/dc-anomaly-logs/battery"
        accentColor="emerald"
        vn={24.0}
        onLogsUpdate={setBatDcLogs}
      />
      <div className="border-t border-slate-200" />
      <DCSectionPanel
        label="Solar PV DC"
        logs={solDcLogs}
        endpoint="/api/dc-anomaly-logs/solar"
        accentColor="amber"
        vn={84.74}
        onLogsUpdate={setSolDcLogs}
      />

      {/* System Protection */}
      <Card className="border-slate-200 shadow-lg" style={{background:'linear-gradient(135deg,#ecfdf5,#f0fdf4)'}}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Shield className="w-4 h-4 sm:w-5 sm:h-5" style={{color:'#059669'}} />System Protection Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            {/* Grid monitoring — blue */}
            <div className="rounded-lg p-3 flex items-center justify-between" style={{background:'linear-gradient(135deg,#eff6ff,#dbeafe)',border:'1px solid #bfdbfe'}}>
              <div>
                <div className="text-sm font-semibold" style={{color:'#1d4ed8'}}>Grid Monitoring</div>
                <div className="text-xs mt-0.5" style={{color:'#3b82f6'}}>Active · PZEM-004T → grid_anomaly_logs</div>
              </div>
              <div className="w-2 h-2 rounded-full flex-shrink-0 ml-3 animate-pulse" style={{background:'#3b82f6'}} />
            </div>
            {/* Inverter monitoring — violet */}
            <div className="rounded-lg p-3 flex items-center justify-between" style={{background:'linear-gradient(135deg,#f5f3ff,#ede9fe)',border:'1px solid #ddd6fe'}}>
              <div>
                <div className="text-sm font-semibold" style={{color:'#6d28d9'}}>Inverter Monitoring</div>
                <div className="text-xs mt-0.5" style={{color:'#7c3aed'}}>Active · PZEM-004T → inverter_anomaly_logs</div>
              </div>
              <div className="w-2 h-2 rounded-full flex-shrink-0 ml-3 animate-pulse" style={{background:'#7c3aed'}} />
            </div>
            {/* Battery DC monitoring — emerald */}
            <div className="rounded-lg p-3 flex items-center justify-between" style={{background:'linear-gradient(135deg,#ecfdf5,#d1fae5)',border:'1px solid #a7f3d0'}}>
              <div>
                <div className="text-sm font-semibold" style={{color:'#065f46'}}>Battery DC Monitoring</div>
                <div className="text-xs mt-0.5" style={{color:'#059669'}}>Active · Voltage Divider (A5) → dc_battery_anomaly_logs</div>
              </div>
              <div className="w-2 h-2 rounded-full flex-shrink-0 ml-3 animate-pulse" style={{background:'#059669'}} />
            </div>
            {/* Solar PV DC monitoring — amber */}
            <div className="rounded-lg p-3 flex items-center justify-between" style={{background:'linear-gradient(135deg,#fffbeb,#fef3c7)',border:'1px solid #fde68a'}}>
              <div>
                <div className="text-sm font-semibold" style={{color:'#92400e'}}>Solar PV DC Monitoring</div>
                <div className="text-xs mt-0.5" style={{color:'#d97706'}}>Active · WCS1500 + Voltage Divider (A4) → dc_solar_anomaly_logs</div>
              </div>
              <div className="w-2 h-2 rounded-full flex-shrink-0 ml-3 animate-pulse" style={{background:'#d97706'}} />
            </div>
            {/* SSR Management — orange */}
            <div className="rounded-lg p-3" style={{background:'linear-gradient(135deg,#fff7ed,#ffedd5)',border:'1px solid #fed7aa'}}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{color:'#9a3412'}}>SSR Management</div>
                <div className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse" style={{background:'#ea580c'}} />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[0.6rem] font-bold" style={{background:'#7c3aed',color:'#fff'}}>K1</span>
                  <span className="text-xs" style={{color:'#c2410c'}}>SSR1 — Solar/Inverter outlet</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[0.6rem] font-bold" style={{background:'#1d4ed8',color:'#fff'}}>K2</span>
                  <span className="text-xs" style={{color:'#c2410c'}}>SSR2 — Grid outlet</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[0.6rem] font-bold" style={{background:'#dc2626',color:'#fff'}}>K3</span>
                  <span className="text-xs" style={{color:'#c2410c'}}>Emergency · 5-min reconnect (IEEE 1547)</span>
                </div>
              </div>
            </div>
            {/* Alert system — rose */}
            <div className="rounded-lg p-3 flex items-center justify-between" style={{background:'linear-gradient(135deg,#fff1f2,#ffe4e6)',border:'1px solid #fecdd3'}}>
              <div>
                <div className="text-sm font-semibold" style={{color:'#9f1239'}}>Alert System</div>
                <div className="text-xs mt-0.5" style={{color:'#e11d48'}}>Active · Buzzer (5 s) + Email</div>
              </div>
              <div className="w-2 h-2 rounded-full flex-shrink-0 ml-3 animate-pulse" style={{background:'#e11d48'}} />
            </div>
          </div>
          <div className="rounded-lg p-4" style={{background:'rgba(255,255,255,0.7)'}}>
            <div className="text-sm font-medium text-slate-900 mb-2">Standards Compliance</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-slate-600">
              <div>• IEEE 1547 §4.2.3 — K3 anti-islanding + 5-min reconnect timer</div>
              <div>• ISO/IEC 30141 — IoT 3-layer architecture (Sensing → Network → App)</div>
              <div>• IEC 61000-4-30 — Sensor integrity validation with freeze detection</div>
              <div>• IEC 61215 — Solar PV string mismatch &amp; output monitoring</div>
              <div className="sm:col-span-2 font-medium text-slate-700">
                • Response time logging active — Objective 3b measurable indicator
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
