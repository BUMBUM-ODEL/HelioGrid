import { Database, Download, Search, Clock, Zap, Battery, Sun, Activity,
         Wifi, WifiOff, Thermometer, CheckCircle, Signal, Trash2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { useState, useEffect, useRef } from 'react';
import * as api from '../utils/api';
import { useEnergySystem } from '../contexts/EnergySystemContext';

interface SensorReading {
  id: number;
  timestamp: string;
  gridVoltage: number;
  gridCurrent: number;
  gridPower: number;
  gridFrequency: number;
  gridPowerFactor: number;
  solarVoltage: number;
  solarCurrent: number;
  solarPower: number;
  batteryVoltage: number;
  batteryCurrent: number;
  batteryPower: number;
  inverterVoltage: number;
  inverterCurrent: number;
  inverterPower: number;
  inverterFrequency: number;
}

interface NetworkLog {
  id:             number;
  timestamp:      string;
  localLatency:   number | null;
  localStatus:    'online' | 'offline';
  internetStatus: 'online' | 'offline';
  temperature:    number;
  tempStatus:     string;
  signalQuality:  string;
}

export function SensorDataLogsView() {
  const { systemTemp } = useEnergySystem();

  // ══ SECTION 1 — SENSOR DATA ══════════════════════════════════════════════
  const [sensorData,  setSensorData]  = useState<SensorReading[]>([]);
  const [isLoading,   setIsLoading]   = useState(true);
  const [searchTerm,  setSearchTerm]  = useState('');
  const [filterType,  setFilterType]  = useState<'all' | 'grid' | 'solar' | 'battery'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const itemsPerPage = 10;

  // [FIX-STACKING] Track the active 5s poll interval in a ref so we can cancel it
  // before starting a new one when refreshTrigger changes. Without this, every Refresh
  // click stacked a new interval on top of existing ones → duplicate rows in the table.
  const sensorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (sensorIntervalRef.current !== null) {
      clearInterval(sensorIntervalRef.current);
      sensorIntervalRef.current = null;
    }
    const fetchSensorHistory = async () => {
      try {
        const res = await fetch('/api/sensor-data/logs?limit=200&hours=24&raw=1');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const history: any[] = Array.isArray(json) ? json : (json.logs ?? []);
        if (history.length > 0) {
          const toNum = (v: unknown): number => { const n = parseFloat(String(v ?? 0)); return isNaN(n) ? 0 : n; };
          const formatted: SensorReading[] = history.map((record, index) => ({
            id:               index + 1,
            timestamp:        record.timestamp,
            gridVoltage:      toNum(record.grid_voltage),
            gridCurrent:      toNum(record.grid_current),
            gridPower:        toNum(record.grid_power),
            gridFrequency:    toNum(record.grid_frequency),
            gridPowerFactor:  0.98,
            solarVoltage:     toNum(record.solar_dc_voltage),
            solarCurrent:     toNum(record.solar_dc_current),
            solarPower:        toNum(record.solar_dc_power ?? record.solar_power),
            batteryVoltage:   toNum(record.battery_pack_voltage),
            batteryCurrent:   toNum(record.battery_pack_current),
            batteryPower:     toNum(record.battery_pack_power),
            inverterVoltage:  toNum(record.inverter_voltage),
            inverterCurrent:  toNum(record.inverter_current),
            inverterPower:    toNum(record.inverter_power),
            inverterFrequency: toNum(record.inverter_frequency),
          }));
          setSensorData(formatted);
        } else {
          setSensorData([]);
        }
      } catch (error) {
        console.error('Error fetching sensor history:', error);
        setSensorData([]);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSensorHistory();
    sensorIntervalRef.current = setInterval(fetchSensorHistory, 5000);
    return () => {
      if (sensorIntervalRef.current !== null) {
        clearInterval(sensorIntervalRef.current);
        sensorIntervalRef.current = null;
      }
    };
  }, [refreshTrigger]); // refreshTrigger re-runs fetch on button click — now safe (old interval cancelled first)

  const downloadSensorCSV = () => {
    const headers = [
      'Timestamp',
      'Grid Voltage (V)', 'Grid Current (A)', 'Grid Power (W)', 'Grid Frequency (Hz)', 'Grid PF',
      'Inverter Voltage (V)', 'Inverter Current (A)', 'Inverter Power (W)', 'Inverter Frequency (Hz)',
      'Solar Voltage (V)', 'Solar Current (A)', 'Solar Power (W)',
      'Battery Voltage (V)', 'Battery Current (A)', 'Battery Power (W)',
    ];
    const csvContent = [
      headers.join(','),
      ...sensorData.map(row => [
        (ts => { const d=new Date(ts); if(isNaN(d)) return ts; const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const dy=String(d.getUTCDate()).padStart(2,'0'); const h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const s=String(d.getUTCSeconds()).padStart(2,'0'); const ampm=h>=12?'PM':'AM'; const h12=h%12||12; return `${mo} ${dy}, ${String(h12).padStart(2,'0')}:${m}:${s} ${ampm}`; })(row.timestamp),
        row.gridVoltage.toFixed(2), row.gridCurrent.toFixed(2),
        row.gridPower.toFixed(2), row.gridFrequency.toFixed(2),
        row.gridPowerFactor.toFixed(3),
        (row.inverterVoltage??0).toFixed(2), (row.inverterCurrent??0).toFixed(2),
        (row.inverterPower??0).toFixed(2), (row.inverterFrequency??0).toFixed(2),
        row.solarVoltage.toFixed(2), row.solarCurrent.toFixed(2), row.solarPower.toFixed(2),
        row.batteryVoltage.toFixed(2), row.batteryCurrent.toFixed(2), row.batteryPower.toFixed(2),
      ].join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.setAttribute('href', URL.createObjectURL(blob));
    link.setAttribute('download', `sensor_data_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredData = sensorData.filter(item => {
    const matchesFilter = (() => {
      if (filterType === 'grid')    return item.gridVoltage > 0 || item.gridPower > 0;
      if (filterType === 'solar')   return item.solarVoltage > 0 || item.solarPower > 0;
      if (filterType === 'battery') return item.batteryVoltage > 0;
      return true;
    })();
    if (!matchesFilter) return false;
    const term = searchTerm.toLowerCase().trim();
    if (!term) return true;
    return [
      (ts => { const d=new Date(ts); if(isNaN(d)) return ts; const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const dy=String(d.getUTCDate()).padStart(2,'0'); const h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const s=String(d.getUTCSeconds()).padStart(2,'0'); const ampm=h>=12?'PM':'AM'; const h12=h%12||12; return `${mo} ${dy}, ${String(h12).padStart(2,'0')}:${m}:${s} ${ampm}`; })(item.timestamp),
      item.gridVoltage.toFixed(1), item.gridCurrent.toFixed(2),
      item.gridPower.toFixed(1), item.gridFrequency.toFixed(2),
      item.solarVoltage.toFixed(1), item.solarCurrent.toFixed(2),
      item.solarPower.toFixed(1), item.batteryVoltage.toFixed(1),
      item.batteryCurrent.toFixed(2), item.batteryPower.toFixed(1),
    ].join(' ').toLowerCase().includes(term);
  });

  const totalPages    = Math.max(1, Math.ceil(filteredData.length / itemsPerPage));
  const safePage      = Math.min(currentPage, totalPages);
  const paginatedData = filteredData.slice((safePage - 1) * itemsPerPage, safePage * itemsPerPage);

  const avg = (key: keyof SensorReading) =>
    sensorData.length === 0
      ? '—'
      : (sensorData.reduce((s, d) => s + (d[key] as number), 0) / sensorData.length).toFixed(1);

  // ══ SECTION 2 — NETWORK & TEMPERATURE ═══════════════════════════════════
  const [localLatency,   setLocalLatency]   = useState<number | null>(null);
  const [localStatus,    setLocalStatus]    = useState<'online' | 'offline' | 'checking'>('checking');
  const [internetStatus, setInternetStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [uptime,         setUptime]         = useState(0);
  const [downtime,       setDowntime]       = useState(0);
  const uptimeRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const downtimeRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIdRef          = useRef(1);
  const latestInternetRef = useRef<'online' | 'offline'>('offline');

  const [netLogs,   setNetLogs]   = useState<NetworkLog[]>([]);
  const [netSearch, setNetSearch] = useState('');
  const [netFilter, setNetFilter] = useState<'all' | 'online' | 'offline' | 'warning'>('all');
  const [netPage,   setNetPage]   = useState(1);
  const [isDelSensor, setIsDelSensor] = useState(false);
  const [isDelNet,    setIsDelNet]    = useState(false);
  const [delMsg,      setDelMsg]      = useState('');

  const handleDeleteSensor = async () => {
    if (!confirm('Delete ALL sensor data logs? This cannot be undone.')) return;
    setIsDelSensor(true);
    try {
      const res = await fetch('/api/sensor-data/history', { method: 'DELETE' });
      if (res.ok) { setDelMsg('Deleted!'); setSensorData([]); setIsLoading(true); setRefreshTrigger(t => t + 1); }
      else setDelMsg('Failed');
    } catch { setDelMsg('Error'); }
    setTimeout(() => { setIsDelSensor(false); setDelMsg(''); }, 2000);
  };

  const handleDeleteNet = async () => {
    if (!confirm('Delete ALL network logs? This cannot be undone.')) return;
    setIsDelNet(true);
    try {
      const res = await fetch('/api/network-logs', { method: 'DELETE' });
      if (res.ok) { setDelMsg('Deleted!'); }
      else setDelMsg('Failed');
    } catch { setDelMsg('Error'); }
    setTimeout(() => { setIsDelNet(false); setDelMsg(''); }, 2000);
  };

  const netPerPage = 15;

  const getTempStatus = (t: number): string => {
    if (t >= 60) return 'Critical';
    if (t >= 50) return 'Warning';
    if (t > 0)   return 'Normal';
    return 'No Data';
  };

  const getSignalQuality = (ms: number | null): string => {
    if (ms === null) return 'Offline';
    if (ms < 20)     return 'Excellent';
    if (ms < 50)     return 'Good';
    if (ms < 100)    return 'Fair';
    return 'Poor';
  };

  const formatDuration = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const latencyColor = (ms: number | null): string => {
    if (ms === null) return 'text-red-500';
    if (ms < 20)     return 'text-green-600';
    if (ms < 50)     return 'text-green-500';
    if (ms < 100)    return 'text-yellow-600';
    return 'text-red-500';
  };

  const statusBadge = (s: 'online' | 'offline'): string =>
    s === 'online' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600';

  const tempBadge = (s: string): string => {
    if (s === 'Critical') return 'bg-red-100 text-red-700';
    if (s === 'Warning')  return 'bg-orange-100 text-orange-700';
    if (s === 'Elevated') return 'bg-yellow-100 text-yellow-700';
    if (s === 'Normal')   return 'bg-green-100 text-green-700';
    return 'bg-slate-100 text-slate-500';
  };

  const measureLatency = async () => {
    const start = performance.now();
    let ms:     number | null        = null;
    let status: 'online' | 'offline' = 'offline';

    // ── Step 1: Measure latency ──
    try {
      await fetch('/api/system/health', {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      ms     = Math.round(performance.now() - start);
      status = 'online';
      setLocalLatency(ms);
      setLocalStatus('online');
      if (downtimeRef.current) { clearInterval(downtimeRef.current); downtimeRef.current = null; }
      if (!uptimeRef.current)  { uptimeRef.current = setInterval(() => setUptime(p => p + 1), 1000); }
    } catch {
      setLocalLatency(null);
      setLocalStatus('offline');
      setDowntime(0);
      if (uptimeRef.current)    { clearInterval(uptimeRef.current); uptimeRef.current = null; setUptime(0); }
      if (!downtimeRef.current) { downtimeRef.current = setInterval(() => setDowntime(p => p + 1), 1000); }
    }

    // ── Step 2: Save to DB + update UI log ──
    try {
      await fetch('/api/network-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localLatency:   ms,
          localStatus:    status,
          internetStatus: latestInternetRef.current,
          temperature:    systemTemp,
          tempStatus:     getTempStatus(systemTemp),
          signalQuality:  getSignalQuality(ms),
        }),
      });
    } catch { /* silent fail */ }

    // ── Step 3: Update in-memory log ──
    setNetLogs(prev => {
      const entry: NetworkLog = {
        id:             logIdRef.current++,
        timestamp:      new Date().toISOString(),
        localLatency:   ms,
        localStatus:    status,
        internetStatus: latestInternetRef.current,
        temperature:    systemTemp,
        tempStatus:     getTempStatus(systemTemp),
        signalQuality:  getSignalQuality(ms),
      };
      return [entry, ...prev].slice(0, 500);
    });
};

  const checkInternet = async () => {
    try {
      await fetch('https://www.google.com/generate_204', { method: 'HEAD', cache: 'no-store', mode: 'no-cors', signal: AbortSignal.timeout(3000) });
      setInternetStatus('online');
      latestInternetRef.current = 'online';
    } catch {
      setInternetStatus('offline');
      latestInternetRef.current = 'offline';
    }
  };

  useEffect(() => {
    // Load existing logs from DB on mount
    fetch('/api/network-logs?limit=500')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          const mapped: NetworkLog[] = data.map((r: any) => ({
            id:             r.id,
            timestamp:      r.timestamp,
            localLatency:   r.local_latency_ms,
            localStatus:    r.local_status as 'online' | 'offline',
            internetStatus: r.internet_status as 'online' | 'offline',
            temperature:    r.temperature,
            tempStatus:     r.temp_status,
            signalQuality:  r.signal_quality,
          }));
          setNetLogs(mapped);
          logIdRef.current = (data[0]?.id ?? 0) + 1;
        }
      })
      .catch(() => {});

    measureLatency();
    checkInternet();
    const localInt    = setInterval(measureLatency,  5000);
    const internetInt = setInterval(checkInternet,  15000);
    return () => {
      clearInterval(localInt);
      clearInterval(internetInt);
      if (uptimeRef.current)   clearInterval(uptimeRef.current);
      if (downtimeRef.current) clearInterval(downtimeRef.current);
    };
  }, []);

  const downloadNetCSV = () => {
    const headers = ['Timestamp','Local Latency (ms)','Local Status','Internet Status','Temperature (C)','Temp Status','Signal Quality'];
    const rows = netLogs.map(r => [
      (ts => { const d=new Date(ts); if(isNaN(d)) return ts; const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const dy=String(d.getUTCDate()).padStart(2,'0'); const h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const s=String(d.getUTCSeconds()).padStart(2,'0'); const ampm=h>=12?'PM':'AM'; const h12=h%12||12; return `${mo} ${dy}, ${String(h12).padStart(2,'0')}:${m}:${s} ${ampm}`; })(r.timestamp),
      r.localLatency ?? 'N/A', r.localStatus, r.internetStatus,
      r.temperature.toFixed(1), r.tempStatus, r.signalQuality,
    ].join(','));
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `network_logs_${new Date().toISOString().split('T')[0]}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const filteredNetLogs = netLogs.filter(log => {
    const matchesFilter = (() => {
      if (netFilter === 'online')  return log.localStatus === 'online';
      if (netFilter === 'offline') return log.localStatus === 'offline';
      if (netFilter === 'warning') return log.tempStatus === 'Warning' || log.tempStatus === 'Critical' || log.signalQuality === 'Poor' || log.signalQuality === 'Fair';
      return true;
    })();
    if (!matchesFilter) return false;
    const term = netSearch.toLowerCase().trim();
    if (!term) return true;
    return [new Date(log.timestamp).toLocaleString(), log.localStatus, log.internetStatus, log.signalQuality, log.tempStatus, log.localLatency?.toString() ?? '', log.temperature.toFixed(1)].join(' ').toLowerCase().includes(term);
  });

  const netTotalPages = Math.max(1, Math.ceil(filteredNetLogs.length / netPerPage));
  const netSafePage   = Math.min(netPage, netTotalPages);
  const paginatedNet  = filteredNetLogs.slice((netSafePage - 1) * netPerPage, netSafePage * netPerPage);

  const onlineCount  = netLogs.filter(l => l.localStatus === 'online').length;
  const offlineCount = netLogs.filter(l => l.localStatus === 'offline').length;
  const validLatency = netLogs.filter(l => l.localLatency !== null);
  const avgLatency   = validLatency.length > 0 ? Math.round(validLatency.reduce((s, l) => s + (l.localLatency ?? 0), 0) / validLatency.length) : null;
  const avgTemp      = netLogs.length > 0 ? (netLogs.reduce((s, l) => s + l.temperature, 0) / netLogs.length).toFixed(1) : '—';

  return (
    <div className="p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-6">

      {/* PAGE HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 sm:space-y-2">
          <h1 className="text-xl sm:text-2xl lg:text-3xl">Energy &amp; Network Logs</h1>
          <p className="text-xs sm:text-sm lg:text-base text-slate-600">
            Sensor readings, network latency, internet uptime &amp; device temperature monitoring
          </p>
        </div>
      </div>

      {/* ── PART 1: SENSOR DATA LOGS ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-600" />
          Sensor Data Logs
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => { setIsLoading(true); setRefreshTrigger(t => t + 1); }} className="bg-blue-600 hover:bg-blue-700">
            <RefreshCw className="w-4 h-4 mr-2"/>Refresh
          </Button>
          <Button onClick={handleDeleteSensor} disabled={isDelSensor} className="bg-red-600 hover:bg-red-700 disabled:opacity-50">
            <Trash2 className="w-4 h-4 mr-2"/>{delMsg || (isDelSensor ? 'Deleting...' : 'Delete All')}
          </Button>
          <Button onClick={downloadSensorCSV} disabled={sensorData.length === 0}
            className="sm:w-auto bg-green-600 hover:bg-green-700 disabled:opacity-50">
            <Download className="w-4 h-4 mr-2"/>Download CSV
          </Button>
        </div>
      </div>

      {/* Sensor Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#eff6ff,#dbeafe)',border:'1px solid #bfdbfe'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-4 h-4" style={{color:'#2563eb'}} />
              <div className="text-xs font-medium" style={{color:'#1d4ed8'}}>Total Records</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#1e3a8a'}}>{sensorData.length}</div>
            <div className="text-xs flex items-center gap-1 mt-1" style={{color:'#2563eb'}}>
              <Activity className="w-3 h-3" />{isLoading ? 'Loading…' : 'Live updating'}
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f5f3ff,#ede9fe)',border:'1px solid #ddd6fe'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4" style={{color:'#7c3aed'}} />
              <div className="text-xs font-medium" style={{color:'#6d28d9'}}>Avg Grid Voltage</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#4c1d95'}}>{avg('gridVoltage')}{sensorData.length > 0 ? 'V' : ''}</div>
            <div className="text-xs mt-1" style={{color:'#7c3aed'}}>Normal Range</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fffbeb,#fef3c7)',border:'1px solid #fde68a'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sun className="w-4 h-4" style={{color:'#d97706'}} />
              <div className="text-xs font-medium" style={{color:'#b45309'}}>Avg Solar Power</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#78350f'}}>{avg('solarPower')}{sensorData.length > 0 ? 'W' : ''}</div>
            <div className="text-xs mt-1" style={{color:'#d97706'}}>Active Generation</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0fdf4,#dcfce7)',border:'1px solid #bbf7d0'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2">
              <Battery className="w-4 h-4" style={{color:'#16a34a'}} />
              <div className="text-xs font-medium" style={{color:'#15803d'}}>Avg Battery V</div>
            </div>
            <div className="text-2xl font-bold" style={{color:'#14532d'}}>{avg('batteryVoltage')}{sensorData.length > 0 ? 'V' : ''}</div>
            <div className="text-xs mt-1" style={{color:'#16a34a'}}>Healthy</div>
          </CardContent>
        </Card>
      </div>

      {/* Sensor Search + Filter */}
      <Card className="border-slate-200 shadow-lg">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" placeholder="Search by value, voltage, power, frequency…" value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
            </div>
            <div className="flex gap-2">
              {(['all','grid','solar','battery'] as const).map(f => (
                <Button key={f} variant={filterType === f ? 'default' : 'outline'} size="sm"
                  onClick={() => { setFilterType(f); setCurrentPage(1); }} className="text-xs capitalize">{f}</Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sensor Table */}
      <Card className="border-slate-200 shadow-lg">
        <CardHeader className="pb-3" style={{background:'linear-gradient(135deg,#eff6ff,#dbeafe)',borderBottom:'1px solid #bfdbfe',borderRadius:'12px 12px 0 0'}}>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg" style={{color:'#1d4ed8'}}>
            <Clock className="w-4 h-4 sm:w-5 sm:h-5" style={{color:'#2563eb'}} />Sensor Readings (Real-time)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-slate-500 text-sm">Loading sensor data…</div>
          ) : sensorData.length === 0 ? (
            <div className="text-center py-12">
              <Database className="w-14 h-14 mx-auto text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">No sensor data recorded yet</p>
              <p className="text-xs text-slate-400 mt-1">Data appears here once sensors start logging to the database.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="text-xs sm:text-sm" style={{ minWidth: '900px', width: '100%' }}>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left p-2 text-slate-600 font-medium whitespace-nowrap sticky left-0 bg-slate-50 z-10">Timestamp</th>
                      {/* Grid */}
                      <th className="text-right p-2 text-blue-600 font-medium whitespace-nowrap">Grid V</th>
                      <th className="text-right p-2 text-blue-600 font-medium whitespace-nowrap">Grid A</th>
                      <th className="text-right p-2 text-blue-600 font-medium whitespace-nowrap">Grid W</th>
                      <th className="text-right p-2 text-blue-600 font-medium whitespace-nowrap">Grid Hz</th>
                      {/* Inverter */}
                      <th className="text-right p-2 text-purple-600 font-medium whitespace-nowrap">Inv V</th>
                      <th className="text-right p-2 text-purple-600 font-medium whitespace-nowrap">Inv A</th>
                      <th className="text-right p-2 text-purple-600 font-medium whitespace-nowrap">Inv W</th>
                      <th className="text-right p-2 text-purple-600 font-medium whitespace-nowrap">Inv Hz</th>
                      {/* Solar */}
                      <th className="text-right p-2 text-amber-600 font-medium whitespace-nowrap">Solar V</th>
                      <th className="text-right p-2 text-amber-600 font-medium whitespace-nowrap">Solar A</th>
                      <th className="text-right p-2 text-amber-600 font-medium whitespace-nowrap">Solar W</th>
                      {/* Battery */}
                      <th className="text-right p-2 text-green-600 font-medium whitespace-nowrap">Batt V</th>
                      <th className="text-right p-2 text-green-600 font-medium whitespace-nowrap">Batt A</th>
                      <th className="text-right p-2 text-green-600 font-medium whitespace-nowrap">Batt W</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedData.map(row => (
                      <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="p-2 text-slate-900 whitespace-nowrap sticky left-0 bg-white hover:bg-slate-50 z-10">
                          {(ts => { const d=new Date(ts); if(isNaN(d)) return ts; const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const dy=String(d.getUTCDate()).padStart(2,'0'); const h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const s=String(d.getUTCSeconds()).padStart(2,'0'); const ampm=h>=12?'PM':'AM'; const h12=h%12||12; return `${mo} ${dy}, ${String(h12).padStart(2,'0')}:${m}:${s} ${ampm}`; })(row.timestamp)}
                        </td>
                        {/* Grid */}
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.gridVoltage.toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.gridCurrent.toFixed(2)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.gridPower.toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.gridFrequency.toFixed(2)}</td>
                        {/* Inverter */}
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{(row.inverterVoltage??0).toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{(row.inverterCurrent??0).toFixed(2)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{(row.inverterPower??0).toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{(row.inverterFrequency??0).toFixed(1)}</td>
                        {/* Solar */}
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.solarVoltage.toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.solarCurrent.toFixed(2)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.solarPower.toFixed(1)}</td>
                        {/* Battery */}
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.batteryVoltage.toFixed(1)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.batteryCurrent.toFixed(2)}</td>
                        <td className="p-2 text-right text-slate-900 whitespace-nowrap">{row.batteryPower.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <div className="text-xs sm:text-sm text-slate-600">
                  Showing {filteredData.length === 0 ? 0 : (safePage - 1) * itemsPerPage + 1}–{Math.min(safePage * itemsPerPage, filteredData.length)} of {filteredData.length} records
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={safePage === 1}>Previous</Button>
                  <span className="flex items-center px-2 text-xs text-slate-600">{safePage} / {totalPages}</span>
                  <Button size="sm" variant="outline" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Sensor Specs */}
      <Card className="border-slate-200 shadow-lg" style={{background:'linear-gradient(135deg,#eff6ff,#e0f2fe)'}}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg" style={{color:'#1d4ed8'}}>
            <Database className="w-4 h-4 sm:w-5 sm:h-5" style={{color:'#2563eb'}} />Sensor Specifications
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2">PZEM-004T (Grid AC)</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• Voltage: 80–260V AC</div>
                <div>• Current: 0–100A</div>
                <div>• Frequency: 45–65Hz</div>
                <div>• Sample Rate: 1 reading/second</div>
              </div>
            </div>
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2">WCS1500 + Resistor Divider (DC)</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• Solar Voltage: Resistor Divider (ADC)</div>
                <div>• Solar Current: WCS1500 ×4 (A0–A3 via Arduino)</div>
                <div>• Battery Voltage: Resistor Divider (ADC)</div>
                <div>• Battery Current: INA219 × 2 — B1 (0x41) + B2 (0x44) @ I²C (12V×2 series = 24V 100Ah pack)</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── PART 2: NETWORK & TEMPERATURE LOGS ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2">
        <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
          <Wifi className="w-4 h-4 text-sky-600" />Network &amp; Temperature Logs
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => {
              fetch('/api/network-logs?limit=500').then(r=>r.json()).then(data => {
                // [FIX] Flask returns flat array — d.logs was always undefined → empty list on refresh
                const arr = Array.isArray(data) ? data : (data.logs ?? []);
                const mapped: NetworkLog[] = arr.map((r: any) => ({
                  id:             r.id,
                  timestamp:      r.timestamp,
                  localLatency:   r.local_latency_ms,
                  localStatus:    r.local_status as 'online' | 'offline',
                  internetStatus: r.internet_status as 'online' | 'offline',
                  temperature:    r.temperature,
                  tempStatus:     r.temp_status,
                  signalQuality:  r.signal_quality,
                }));
                setNetLogs(mapped);
              }).catch(() => {});
            }} className="bg-blue-600 hover:bg-blue-700">
            <RefreshCw className="w-4 h-4 mr-2"/>Refresh
          </Button>
          <Button onClick={handleDeleteNet} disabled={isDelNet} className="bg-red-600 hover:bg-red-700 disabled:opacity-50">
            <Trash2 className="w-4 h-4 mr-2"/>{delMsg || (isDelNet ? 'Deleting...' : 'Delete All')}
          </Button>
          <Button onClick={downloadNetCSV} disabled={netLogs.length === 0}
            className="sm:w-auto bg-green-600 hover:bg-green-700 disabled:opacity-50">
            <Download className="w-4 h-4 mr-2"/>Download CSV
          </Button>
        </div>
      </div>

      {/* Live Status Bar */}
      <div className={`rounded-lg border p-3 flex flex-wrap gap-4 items-center text-sm ${
        localStatus === 'online' ? 'bg-green-50 border-green-200' :
        localStatus === 'offline' ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'
      }`}>
        <div className="flex items-center gap-2">
          {localStatus === 'offline' ? <WifiOff className="w-4 h-4 text-red-500" /> : <Wifi className="w-4 h-4 text-green-600" />}
          <span className="font-medium text-slate-800">
            Flask API:&nbsp;{localStatus === 'online' ? 'Connected' : localStatus === 'offline' ? 'Offline' : 'Checking…'}
          </span>
        </div>
        {localLatency !== null && <span className={`font-semibold ${latencyColor(localLatency)}`}>{localLatency} ms</span>}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${internetStatus === 'online' ? 'bg-green-500' : internetStatus === 'offline' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          <span className="text-slate-600 text-xs">
            Internet:&nbsp;{internetStatus === 'online' ? 'Online' : internetStatus === 'offline' ? 'Offline' : '…'}
          </span>
        </div>
        {localStatus === 'online'  && uptime   > 0 && <span className="text-xs text-green-700">Uptime: {formatDuration(uptime)}</span>}
        {localStatus === 'offline' && downtime > 0 && <span className="text-xs text-red-600">Down for: {formatDuration(downtime)}</span>}
        <div className="flex items-center gap-1.5 ml-auto">
          <Thermometer className="w-4 h-4 text-orange-500" />
          <span className="font-semibold text-slate-800">{systemTemp.toFixed(1)}°C</span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${tempBadge(getTempStatus(systemTemp))}`}>{getTempStatus(systemTemp)}</span>
        </div>
      </div>

      {/* Network Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#eff6ff,#dbeafe)',border:'1px solid #bfdbfe'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2"><Database className="w-4 h-4" style={{color:'#2563eb'}} /><span className="text-xs font-medium" style={{color:'#1d4ed8'}}>Total Records</span></div>
            <div className="text-2xl font-bold" style={{color:'#1e3a8a'}}>{netLogs.length}</div>
            <div className="text-xs flex items-center gap-1 mt-1" style={{color:'#2563eb'}}><Activity className="w-3 h-3" />Live logging (5s)</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#f0fdf4,#dcfce7)',border:'1px solid #bbf7d0'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2"><Signal className="w-4 h-4" style={{color:'#16a34a'}} /><span className="text-xs font-medium" style={{color:'#15803d'}}>Avg Latency</span></div>
            <div className={`text-2xl font-bold ${latencyColor(avgLatency)}`}>{avgLatency !== null ? `${avgLatency} ms` : '—'}</div>
            <div className="text-xs mt-1" style={{color:'#16a34a'}}>{getSignalQuality(avgLatency)}</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#ecfdf5,#d1fae5)',border:'1px solid #a7f3d0'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2"><CheckCircle className="w-4 h-4" style={{color:'#059669'}} /><span className="text-xs font-medium" style={{color:'#065f46'}}>Online / Offline</span></div>
            <div className="text-2xl font-bold" style={{color:'#064e3b'}}>{onlineCount}<span className="text-sm font-normal" style={{color:'#6ee7b7'}}> / {offlineCount}</span></div>
            <div className="text-xs mt-1" style={{color:'#059669'}}>{netLogs.length > 0 ? `${Math.round((onlineCount / netLogs.length) * 100)}% uptime` : '—'}</div>
          </CardContent>
        </Card>
        <Card className="shadow-lg" style={{background:'linear-gradient(135deg,#fff7ed,#ffedd5)',border:'1px solid #fed7aa'}}>
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-2"><Thermometer className="w-4 h-4" style={{color:'#ea580c'}} /><span className="text-xs font-medium" style={{color:'#9a3412'}}>Avg Temperature</span></div>
            <div className="text-2xl font-bold" style={{color:'#7c2d12'}}>{avgTemp}{netLogs.length > 0 ? '°C' : ''}</div>
            <div className="text-xs mt-1" style={{color:'#ea580c'}}>DS18B20 device sensor</div>
          </CardContent>
        </Card>
      </div>

      {/* Network Search + Filter */}
      <Card className="border-slate-200 shadow-lg">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" placeholder="Search by status, latency, temperature, quality…" value={netSearch}
                onChange={e => { setNetSearch(e.target.value); setNetPage(1); }}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
            </div>
            <div className="flex gap-2 flex-wrap">
              {(['all','online','offline','warning'] as const).map(f => (
                <Button key={f} variant={netFilter === f ? 'default' : 'outline'} size="sm"
                  onClick={() => { setNetFilter(f); setNetPage(1); }} className="text-xs capitalize">{f}</Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Network Table */}
      <Card className="border-slate-200 shadow-lg">
        <CardHeader className="pb-3" style={{background:'linear-gradient(135deg,#f0f9ff,#e0f2fe)',borderBottom:'1px solid #7dd3fc',borderRadius:'12px 12px 0 0'}}>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg" style={{color:'#0369a1'}}>
            <Clock className="w-4 h-4 sm:w-5 sm:h-5" style={{color:'#0284c7'}} />Network &amp; Temperature Log (Real-time)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {netLogs.length === 0 ? (
            <div className="text-center py-12">
              <Wifi className="w-14 h-14 mx-auto text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">Waiting for first measurement…</p>
              <p className="text-xs text-slate-400 mt-1">Logs appear here every 5 seconds.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left   p-2 text-slate-600 font-medium">Timestamp</th>
                      <th className="text-center p-2 text-slate-600 font-medium">Local API</th>
                      <th className="text-right  p-2 text-slate-600 font-medium">Latency</th>
                      <th className="text-center p-2 text-slate-600 font-medium">Signal</th>
                      <th className="text-center p-2 text-slate-600 font-medium">Internet</th>
                      <th className="text-right  p-2 text-slate-600 font-medium">Temp °C</th>
                      <th className="text-center p-2 text-slate-600 font-medium">Temp Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedNet.map(log => (
                      <tr key={log.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="p-2 text-slate-700 whitespace-nowrap">
                          {(ts => { const d=new Date(ts); if(isNaN(d)) return ts; const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const dy=String(d.getUTCDate()).padStart(2,'0'); const h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const s=String(d.getUTCSeconds()).padStart(2,'0'); const ampm=h>=12?'PM':'AM'; const h12=h%12||12; return `${mo} ${dy}, ${String(h12).padStart(2,'0')}:${m}:${s} ${ampm}`; })(log.timestamp)}
                        </td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(log.localStatus)}`}>{log.localStatus}</span>
                        </td>
                        <td className={`p-2 text-right font-medium ${latencyColor(log.localLatency)}`}>
                          {log.localLatency !== null ? `${log.localLatency} ms` : '—'}
                        </td>
                        <td className="p-2 text-center">
                          <span className={`text-xs font-medium ${
                            log.signalQuality === 'Excellent' ? 'text-green-600' :
                            log.signalQuality === 'Good'      ? 'text-green-500' :
                            log.signalQuality === 'Fair'      ? 'text-yellow-600' :
                            log.signalQuality === 'Poor'      ? 'text-red-500' : 'text-slate-400'
                          }`}>{log.signalQuality}</span>
                        </td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(log.internetStatus)}`}>{log.internetStatus}</span>
                        </td>
                        <td className="p-2 text-right font-medium text-slate-900">
                          {log.temperature > 0 ? log.temperature.toFixed(1) : '—'}
                        </td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${tempBadge(log.tempStatus)}`}>{log.tempStatus}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <div className="text-xs sm:text-sm text-slate-600">
                  Showing {filteredNetLogs.length === 0 ? 0 : (netSafePage - 1) * netPerPage + 1}–{Math.min(netSafePage * netPerPage, filteredNetLogs.length)} of {filteredNetLogs.length} records
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setNetPage(p => Math.max(1, p - 1))} disabled={netSafePage === 1}>Previous</Button>
                  <span className="flex items-center px-2 text-xs text-slate-600">{netSafePage} / {netTotalPages}</span>
                  <Button size="sm" variant="outline" onClick={() => setNetPage(p => Math.min(netTotalPages, p + 1))} disabled={netSafePage === netTotalPages}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Network Info Card */}
      <Card className="border-slate-200 shadow-lg" style={{background:'linear-gradient(135deg,#f0f9ff,#e0f2fe)'}}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base" style={{color:'#0369a1'}}>
            <Signal className="w-4 h-4" style={{color:'#0284c7'}} />Monitoring Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">Network Monitoring</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• Local Ping — HEAD /api/system/health (Flask API)</div>
                <div>• Internet Check — google.com/generate_204 (every 15s)</div>
                <div>• Poll Interval — every 5 seconds</div>
                <div>• Excellent &lt;20ms · Good &lt;50ms · Fair &lt;100ms · Poor ≥100ms</div>
              </div>
            </div>
            <div className="bg-white/70 rounded-lg p-4">
              <div className="text-sm text-slate-900 mb-2 font-medium">Temperature Monitoring</div>
              <div className="space-y-1 text-xs text-slate-600">
                <div>• Sensor — DS18B20 (1-Wire, RPi GPIO)</div>
                <div>• Normal &lt;45°C · Elevated 45–59°C</div>
                <div>• Warning 60–69°C · Critical ≥70°C</div>
                <div>• Max 500 records stored per session</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
