import { useState, useEffect, useCallback } from 'react';
import { User, LogOut, Mail, Shield, Cpu, Database, Wifi, Thermometer,
         HardDrive, Activity, Zap, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { useEnergySystem } from '../contexts/EnergySystemContext';
import type { GoogleUser } from '../App';

interface AdminViewProps {
  googleUser: GoogleUser | null;
  onLogout: () => void;
}

interface SystemHealth {
  status:    'healthy' | 'degraded';
  database:  string;
  hardware: {
    grid_pzem:       boolean;
    inverter_pzem:   boolean;
    arduino:         boolean;
    dht_sensor:      boolean;
    ina219_b1:       boolean;
    ina219_b2:       boolean;
  };
  sensors: {
    grid_pzem:     string;
    inverter_pzem: string;
    arduino:       string;
    dht22:         string;
  };
  thermal: {
    current_temp:    number;
    shutdown_active: boolean;
  };
}

export function AdminView({ googleUser, onLogout }: AdminViewProps) {
  const { systemTemp, anomalyLogs } = useEnergySystem();

  const username = googleUser?.name  || 'Admin';
  const email    = googleUser?.email || 'admin@campus-energy.edu';
  const picture  = googleUser?.picture || '';

  // ── Session timing ────────────────────────────────────────────────────────
  const [loginTime] = useState(() =>
    new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  );
  const [sessionStart] = useState(Date.now);
  const [sessionDuration, setSessionDuration] = useState('0m');

  useEffect(() => {
    const tick = () => {
      const elapsed = Math.floor((Date.now() - sessionStart) / 60000);
      const h = Math.floor(elapsed / 60), m = elapsed % 60;
      setSessionDuration(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [sessionStart]);

  // ── Live network latency ──────────────────────────────────────────────────
  const [networkLatency, setNetworkLatency] = useState<number | null>(null);
  const [networkOnline,  setNetworkOnline]  = useState(true);

  const measureLatency = useCallback(async () => {
    const t0 = performance.now();
    try {
      await fetch('/api/system/health', { method: 'HEAD', cache: 'no-store' });
      setNetworkLatency(Math.round(performance.now() - t0));
      setNetworkOnline(true);
    } catch {
      setNetworkLatency(null);
      setNetworkOnline(false);
    }
  }, []);

  useEffect(() => {
    measureLatency();
    const id = setInterval(measureLatency, 10_000);
    return () => clearInterval(id);
  }, [measureLatency]);

  const latencyLabel   = networkLatency === null ? 'Offline' : `${networkLatency} ms`;
  const latencyColor   = networkLatency === null ? 'text-red-600'
    : networkLatency < 50  ? 'text-green-600'
    : networkLatency < 150 ? 'text-yellow-600'
    : 'text-red-600';
  const signalQuality  = networkLatency === null ? 'Offline'
    : networkLatency < 50  ? 'Excellent'
    : networkLatency < 150 ? 'Good'
    : networkLatency < 300 ? 'Fair'
    : 'Poor';

  // ── /api/system/health ────────────────────────────────────────────────────
  const [health,        setHealth]        = useState<SystemHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [lastRefresh,   setLastRefresh]   = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/system/health');
      if (r.ok) { setHealth(await r.json()); setLastRefresh(new Date()); }
    } catch { /* keep previous */ }
    finally   { setHealthLoading(false); }
  }, []);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, 30_000);
    return () => clearInterval(id);
  }, [fetchHealth]);

  // ── Live DB record count ──────────────────────────────────────────────────
  const [dbRecords, setDbRecords] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const r = await fetch('/api/sensor-data/logs?limit=1');
        if (r.ok) { const d = await r.json(); setDbRecords(d.total_count ?? null); }
      } catch { /* ignore */ }
    };
    fetchCount();
    const id = setInterval(fetchCount, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived from context ──────────────────────────────────────────────────
  const totalAnomalies = anomalyLogs.length;
  const todayAnomalies = anomalyLogs.filter(e => {
    const d = new Date(e.timestamp), now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth()    === now.getMonth()    &&
           d.getDate()     === now.getDate();
  }).length;
  const lastAlertTime = anomalyLogs.length > 0
    ? (() => {
        const diffMin = Math.round((Date.now() - new Date(anomalyLogs[0].timestamp).getTime()) / 60000);
        return diffMin < 60 ? `${diffMin} min ago` : `${Math.floor(diffMin / 60)}h ago`;
      })()
    : 'None';

  // ── Safe sensor counts — only access hardware when health is not null ─────
  const hw = health?.hardware;
  const activeSensors = hw == null ? 0 : [
    hw.grid_pzem,
    hw.inverter_pzem,
    hw.arduino,
    hw.dht_sensor,
    hw.ina219_b21,
    hw.ina219_b2,
  ].filter(Boolean).length;
  const totalSensors = 6;
  const dbHealthy = health?.database === 'connected';

  return (
    <div className="min-h-screen p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 sm:space-y-2">
          <h1 className="text-xl sm:text-2xl lg:text-3xl">Admin Account</h1>
          <p className="text-xs sm:text-sm text-slate-600">Manage your account and system settings</p>
        </div>
        <button onClick={fetchHealth}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors text-slate-700">
          <RefreshCw className={`w-4 h-4 ${healthLoading ? 'animate-spin' : ''}`} />
          {lastRefresh
            ? `Updated ${lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
            : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">

        {/* ═══ LEFT COLUMN ═══════════════════════════════════════════════════ */}
        <div className="lg:col-span-1 space-y-4 sm:space-y-6">

          {/* Profile */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <User className="w-4 h-4 sm:w-5 sm:h-5 text-slate-600" /> Profile
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex flex-col items-center text-center">
                  {picture ? (
                    <img src={picture} alt={username} referrerPolicy="no-referrer"
                      className="w-20 h-20 sm:w-24 sm:h-24 rounded-full shadow-xl mb-3 object-cover border-4 border-sky-100" />
                  ) : (
                    <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-sky-500 to-blue-600 rounded-full flex items-center justify-center text-white shadow-xl mb-3">
                      <span className="text-2xl sm:text-3xl">{username[0].toUpperCase()}</span>
                    </div>
                  )}
                  <h3 className="text-base sm:text-lg text-slate-900">{username}</h3>
                  <p className="text-xs sm:text-sm text-slate-600">System Administrator</p>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-xs text-green-600">Active</span>
                  </div>
                </div>

                <div className="space-y-2 pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 text-xs sm:text-sm">
                    <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span className="text-slate-600 break-all">{email}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs sm:text-sm">
                    <Shield className="w-4 h-4 text-slate-400" />
                    <span className="text-slate-600">Full Access</span>
                  </div>
                  {googleUser && (
                    <div className="flex items-center gap-2 text-xs">
                      <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      <span className="text-slate-500">Signed in with Google</span>
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-slate-200">
                  <Button onClick={onLogout} variant="outline"
                    className="w-full justify-start text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200">
                    <LogOut className="w-4 h-4 mr-2" /> Logout
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Session info */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-base sm:text-lg">Session Info</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-xs sm:text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Logged In</span>
                  <span className="text-slate-900">{loginTime}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Session Duration</span>
                  <span className="text-slate-900">{sessionDuration}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Auth Method</span>
                  <span className="text-slate-900">{googleUser ? 'Google OAuth' : 'Email/Password'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">RPi Connection</span>
                  <span className={latencyColor}>{latencyLabel}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Contact */}
          <Card className="border-slate-200 shadow-lg bg-gradient-to-br from-blue-50 to-white">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Mail className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600" /> Contact Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="text-xs text-slate-600">Technical Support</div>
                <div className="flex items-start gap-2 text-xs sm:text-sm">
                  <Mail className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-slate-900">support@lspu.edu.ph</div>
                    <div className="text-slate-600 text-xs mt-0.5">24/7 Support Available</div>
                  </div>
                </div>
              </div>
              <div className="border-t border-slate-200 pt-3 space-y-2">
                <div className="text-xs text-slate-600">Campus Energy Office</div>
                <div className="text-xs sm:text-sm space-y-1">
                  {['Laguna State Polytechnic University', 'Siniloan Campus', 'Phone: (049) 123-4567'].map(t => (
                    <div key={t} className="flex items-center gap-2 text-slate-900">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" /><span>{t}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-slate-200 pt-3">
                <div className="text-xs text-slate-600 mb-2">Emergency Contact</div>
                <div className="p-2 rounded-lg bg-red-50 border border-red-200">
                  <div className="text-xs sm:text-sm text-red-900">For critical system failures, call:</div>
                  <div className="text-sm sm:text-base font-semibold text-red-700 mt-1">0917-XXX-XXXX</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ═══ RIGHT COLUMN ══════════════════════════════════════════════════ */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">

          {/* System Information */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Cpu className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600" /> System Information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                {/* RPi */}
                <div className="bg-gradient-to-br from-blue-50 to-white p-4 rounded-xl border border-blue-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                      <Cpu className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Microcontroller</div>
                      <div className="text-sm text-slate-900">Raspberry Pi 4B</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    {[['Model','Pi 4 Model B'],['RAM','4GB LPDDR4'],['CPU','Quad-core 1.5GHz']].map(([k,v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-slate-600">{k}</span><span className="text-slate-900">{v}</span>
                      </div>
                    ))}
                    <div className="flex justify-between">
                      <span className="text-slate-600">Status</span>
                      <span className={`flex items-center gap-1 ${networkOnline ? 'text-green-600' : 'text-red-600'}`}>
                        <div className={`w-2 h-2 rounded-full ${networkOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                        {networkOnline ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Database */}
                <div className="bg-gradient-to-br from-purple-50 to-white p-4 rounded-xl border border-purple-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg flex items-center justify-center">
                      <Database className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Database</div>
                      <div className="text-sm text-slate-900">MariaDB / MySQL</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Anomaly Logs</span>
                      <span className="text-slate-900">{totalAnomalies.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Sensor Records</span>
                      <span className="text-slate-900">{dbRecords !== null ? dbRecords.toLocaleString() : '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Status</span>
                      <span className={`flex items-center gap-1 ${dbHealthy ? 'text-green-600' : 'text-red-600'}`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${dbHealthy ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                        {healthLoading ? 'Checking…' : dbHealthy ? 'Connected' : 'Error'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Network */}
                <div className="bg-gradient-to-br from-green-50 to-white p-4 rounded-xl border border-green-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-green-600 rounded-lg flex items-center justify-center">
                      <Wifi className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Network</div>
                      <div className="text-sm text-slate-900">{networkOnline ? 'RPi Connected' : 'Disconnected'}</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Signal</span>
                      <span className={`flex items-center gap-1 ${networkOnline ? 'text-green-600' : 'text-red-600'}`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${networkOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                        {signalQuality}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Latency</span>
                      <span className={latencyColor}>{latencyLabel}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Arduino</span>
                      <span className={hw?.arduino ? 'text-green-600' : 'text-red-600'}>
                        {healthLoading ? '…' : hw?.arduino ? 'Connected' : 'Offline'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Temperature */}
                <div className="bg-gradient-to-br from-orange-50 to-white p-4 rounded-xl border border-orange-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">
                      <Thermometer className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Temperature</div>
                      <div className="text-sm text-slate-900">DHT22 Sensor</div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-2xl text-slate-900">{systemTemp.toFixed(1)}°C</div>
                    <div className="relative h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${
                        systemTemp >= 60 ? 'bg-gradient-to-r from-red-500 to-red-600'
                        : systemTemp >= 50 ? 'bg-gradient-to-r from-yellow-500 to-orange-500'
                        : 'bg-gradient-to-r from-green-500 to-yellow-500'
                      }`} style={{ width: `${Math.min((systemTemp / 80) * 100, 100)}%` }} />
                    </div>
                    <div className={`text-xs font-semibold ${
                      systemTemp >= 60 ? 'text-red-600' : systemTemp >= 50 ? 'text-yellow-600' : 'text-green-600'
                    }`}>
                      {systemTemp >= 60 ? 'Critical Overheat' : systemTemp >= 50 ? 'Elevated' : 'Normal'}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* System Monitoring */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" /> System Monitoring
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                {/* Sensors */}
                <div className="bg-gradient-to-br from-green-50 to-white p-4 rounded-xl border border-green-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-green-600 rounded-lg flex items-center justify-center">
                      <Cpu className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Sensors</div>
                      <div className="text-sm text-slate-900">Hardware Status</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Active</span>
                      <span>{healthLoading ? '…' : `${activeSensors} / ${totalSensors}`}</span>
                    </div>
                    {hw != null && ([
                      ['Grid PZEM-004T',     hw.grid_pzem],
                      ['Inverter PZEM-004T', hw.inverter_pzem],
                      ['Arduino (Solar)',    hw.arduino],
                      ['INA219 #1 (Bank A)', hw.ina219_b1 ?? false],
                      ['INA219 #2 (Bank B)', hw.ina219_b2 ?? false],
                      ['DHT22 (Temp)',       hw.dht_sensor],
                    ] as [string, boolean][]).map(([label, ok]) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-slate-500">{label}</span>
                        <span className={ok ? 'text-green-600' : 'text-red-500'}>{ok ? '✓' : '✗'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Anomaly alerts */}
                <div className="bg-gradient-to-br from-amber-50 to-white p-4 rounded-xl border border-amber-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-amber-500 to-amber-600 rounded-lg flex items-center justify-center">
                      <Zap className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Alerts</div>
                      <div className="text-sm text-slate-900">Anomaly Log</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Today</span><span>{todayAnomalies}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Total Logged</span><span>{totalAnomalies.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Last Alert</span>
                      <span className="text-amber-600">{lastAlertTime}</span>
                    </div>
                  </div>
                </div>

                {/* DB records */}
                <div className="bg-gradient-to-br from-blue-50 to-white p-4 rounded-xl border border-blue-200">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                      <HardDrive className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Database</div>
                      <div className="text-sm text-slate-900">Sensor Records</div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Total Records</span>
                      <span>{dbRecords !== null ? dbRecords.toLocaleString() : '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">DB Status</span>
                      <span className={dbHealthy ? 'text-green-600' : 'text-red-600'}>
                        {healthLoading ? '…' : dbHealthy ? 'Healthy' : 'Error'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Battery</span>
                      <span className="text-slate-900">INA219 ×2 (I²C)</span>
                    </div>
                  </div>
                </div>

                {/* Overall health */}
                <div className={`p-4 rounded-xl border ${
                  health?.status === 'healthy'
                    ? 'bg-gradient-to-br from-emerald-50 to-white border-emerald-200'
                    : 'bg-gradient-to-br from-red-50 to-white border-red-200'
                }`}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      health?.status === 'healthy'
                        ? 'bg-gradient-to-br from-emerald-500 to-emerald-600'
                        : 'bg-gradient-to-br from-red-500 to-red-600'
                    }`}>
                      <Shield className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Overall Health</div>
                      <div className="text-sm text-slate-900 capitalize">
                        {healthLoading ? 'Checking…' : health?.status ?? 'Unknown'}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Database</span>
                      <span className={dbHealthy ? 'text-green-600' : 'text-red-600'}>{health?.database ?? '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Thermal</span>
                      <span className={health?.thermal?.shutdown_active ? 'text-red-600' : 'text-green-600'}>
                        {health?.thermal?.shutdown_active ? 'Shutdown Active' : 'Normal'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Last Check</span>
                      <span className="text-slate-500">
                        {lastRefresh
                          ? lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* System Version */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-base sm:text-lg">System Version</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[
                  ['Platform',  'Raspberry Pi 4B'],
                  ['OS',        'Raspberry Pi OS'],
                  ['Python',    '3.13.0'],
                  ['Framework', 'Flask + React'],
                  ['Sensors',   'DC Battery Meter / PZEM-004T'],
                  ['Arduino',   'Uno (SSR / Buzzer)'],
                ].map(([k, v]) => (
                  <div key={k} className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div className="text-xs text-slate-600 mb-1">{k}</div>
                    <div className="text-sm text-slate-900">{v}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card className="border-slate-200 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-base sm:text-lg">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
                  <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs sm:text-sm text-slate-900">
                      {googleUser ? `Google OAuth login: ${email}` : `Login: ${email}`}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{loginTime}</div>
                  </div>
                </div>

                {anomalyLogs.slice(0, 3).map(log => (
                  <div key={log.id} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                      log.severity === 'Critical' ? 'bg-red-500'
                      : log.severity === 'High'   ? 'bg-orange-500'
                      : 'bg-yellow-500'
                    }`} />
                    <div>
                      <div className="text-xs sm:text-sm text-slate-900">{log.type}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {new Date(log.timestamp).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                        })} · {log.source}
                      </div>
                    </div>
                  </div>
                ))}

                {anomalyLogs.length === 0 && (
                  <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg border border-green-100">
                    <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 flex-shrink-0" />
                    <div className="text-xs sm:text-sm text-green-700">No anomalies detected — system running normally</div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}
