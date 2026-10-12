// SystemModulesView.tsx
// PATCHES:
//   [FIX-1] Save Settings — POSTs to /api/system/config (was local state only)
//   [FIX-2] emailServiceHealth — fetched from /api/system/health (was hardcoded true)
//   [FIX-3] Buzzer indicator — warning modules show OFF badge (critical only)
//   [FIX-4] Module 6 Safe Mode — failsafe mode (K4 closed) no longer shows as critical
//   [FIX-5] Response time stats displayed in recent anomaly section (Objective 3b)
//   [FIX-6] Buzzer state polled from /api/buzzer/state (not inferred from anomaly flags)
//   [FIX-7] Stop Buzzer button — calls /api/buzzer/stop when buzzer is active
//   [FIX-8] Anomaly engine type shown in module card (Spike High / Drift Low etc.)

import { Cpu, Zap, Battery, Sun, Shield, TrendingUp, Activity, Save, Volume2, VolumeX, PowerOff, Settings, Clock, Square } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { useState, useEffect, useCallback } from 'react';
import { useEnergySystem, AnomalyLogEntry } from '../contexts/EnergySystemContext';

// ============================================================================
// BUZZER INDICATOR
// ============================================================================
function BuzzerIndicator({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!active) { setVisible(true); return; }
    const iv = setInterval(() => setVisible(v => !v), 400);
    return () => clearInterval(iv);
  }, [active]);
  return (
    <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.68rem] font-semibold border transition-all shrink-0 ${
      active ? 'bg-red-100 text-red-700 border-red-300' : 'bg-slate-100 text-slate-400 border-slate-200'
    }`}>
      {active
        ? <Volume2 className={`w-3 h-3 shrink-0 ${visible ? 'opacity-100' : 'opacity-20'}`} />
        : <VolumeX className="w-3 h-3 shrink-0 opacity-40" />
      }
      <span className="whitespace-nowrap pr-0.5">{active ? 'Buzzer ON' : 'Buzzer OFF'}</span>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export function SystemModulesView() {
  const {
    gridAnomaly, inverterAnomaly, batteryAnomaly, solarAnomaly,
    tempAnomaly, sensorFault, anomalyLogs, contactorClosed,
    controlMode, systemCondition, anomalyLevel, controlAuthority,
    gridVoltage, gridFrequency, inverterVoltage, inverterFrequency,
    batteryVoltage, batterySOC, batteryFull, solarPower, solarEfficiency,
    systemTemp, gridAssistActive, totalSwitches, lastSwitchTime,
  } = useEnergySystem();

  // [FIX-2] Fetch emailServiceHealth from API
  const [emailServiceHealth, setEmailServiceHealth] = useState<boolean | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // [FIX-6] Real buzzer state polled from /api/buzzer/state every 2s
  const [buzzerApiActive, setBuzzerApiActive] = useState(false);
  const [buzzerTriggeredAt, setBuzzerTriggeredAt] = useState<string | null>(null);
  const [stopBuzzerStatus, setStopBuzzerStatus] = useState<'idle' | 'stopping'>('idle');

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/system/health');
        if (res.ok) {
          const data = await res.json();
          setEmailServiceHealth(data.status === 'healthy');
        } else {
          setEmailServiceHealth(false);
        }
      } catch {
        setEmailServiceHealth(false);
      }
    };
    checkHealth();
    const id = setInterval(checkHealth, 30_000);
    return () => clearInterval(id);
  }, []);

  // [FIX-6] Poll buzzer state from API
  useEffect(() => {
    const pollBuzzer = async () => {
      try {
        const res = await fetch('/api/buzzer/state');
        if (res.ok) {
          const d = await res.json();
          setBuzzerApiActive(d.active ?? false);
          setBuzzerTriggeredAt(d.triggered_at ?? null);
        }
      } catch { /* ignore */ }
    };
    pollBuzzer();
    const id = setInterval(pollBuzzer, 2_000);
    return () => clearInterval(id);
  }, []);

  // [FIX-7] Stop buzzer handler
  const handleStopBuzzer = useCallback(async () => {
    setStopBuzzerStatus('stopping');
    try {
      await fetch('/api/buzzer/stop', { method: 'POST' });
      setBuzzerApiActive(false);
    } catch { /* ignore */ }
    setStopBuzzerStatus('idle');
  }, []);

  // [FIX-1] Load settings from DB on mount
  const [settings, setSettings] = useState({
    autoSwitch: true,
    gridVoltageMin: 200, gridVoltageMax: 245,
    gridFrequencyMin: 59, gridFrequencyMax: 61,
    inverterVoltageMin: 207, inverterVoltageMax: 253,
    batteryMinVoltage: 23.0, batteryCriticalVoltage: 21.6, batteryFullVoltage: 26.4,
    solarMinPower: 20,
    anomalyAlerts: true,
  });

  useEffect(() => {
    fetch('/api/system/config')
      .then(r => r.json())
      .then(data => {
        const c = data?.config ?? {};
        setSettings(prev => ({
          ...prev,
          gridVoltageMin:         Number(c.grid_voltage_min       ?? prev.gridVoltageMin),
          gridVoltageMax:         Number(c.grid_voltage_max       ?? prev.gridVoltageMax),
          gridFrequencyMin:       Number(c.grid_freq_min          ?? prev.gridFrequencyMin),
          gridFrequencyMax:       Number(c.grid_freq_max          ?? prev.gridFrequencyMax),
          inverterVoltageMin:     Number(c.inverter_voltage_min   ?? prev.inverterVoltageMin),
          inverterVoltageMax:     Number(c.inverter_voltage_max   ?? prev.inverterVoltageMax),
          batteryMinVoltage:      Number(c.battery_warning_v      ?? prev.batteryMinVoltage),
          batteryCriticalVoltage: Number(c.battery_critical_v     ?? prev.batteryCriticalVoltage),
          batteryFullVoltage:     Number(c.battery_full_v         ?? prev.batteryFullVoltage),
          solarMinPower:          Number(c.solar_min_power_pct    ?? prev.solarMinPower),
          autoSwitch:             c.auto_switch_enabled === '1',
          anomalyAlerts:          c.anomaly_alerts_enabled === '1',
        }));
      })
      .catch(() => {/* use defaults */});
  }, []);

  // [FIX-1] Save Settings to DB
  const handleSaveSettings = useCallback(async () => {
    setSaveStatus('saving');
    try {
      const payload = {
        grid_voltage_min:       String(settings.gridVoltageMin),
        grid_voltage_max:       String(settings.gridVoltageMax),
        grid_freq_min:          String(settings.gridFrequencyMin),
        grid_freq_max:          String(settings.gridFrequencyMax),
        inverter_voltage_min:   String(settings.inverterVoltageMin),
        inverter_voltage_max:   String(settings.inverterVoltageMax),
        battery_warning_v:      String(settings.batteryMinVoltage),
        battery_critical_v:     String(settings.batteryCriticalVoltage),
        battery_full_v:         String(settings.batteryFullVoltage),
        solar_min_power_pct:    String(settings.solarMinPower),
        auto_switch_enabled:    settings.autoSwitch ? '1' : '0',
        anomaly_alerts_enabled: settings.anomalyAlerts ? '1' : '0',
      };
      const res = await fetch('/api/system/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [settings]);

  // [FIX-6] Use real API state instead of inferring from anomaly flags
  const isBuzzerActive = buzzerApiActive;

  const moduleBuzzer = {
    sensor:   sensorFault,
    grid:     gridAnomaly     === 'critical',
    inverter: inverterAnomaly === 'critical',
    battery:  batteryAnomaly  === 'critical',
    solar:    solarAnomaly    === 'critical',
    safeMode: !contactorClosed && anomalyLevel === 'critical' && controlMode !== 'failsafe',
  };

  const gridStatusStr  = gridVoltage === 0    ? 'No Data' : `${gridVoltage.toFixed(1)}V · ${gridFrequency.toFixed(1)}Hz`;
  const invStatusStr   = inverterVoltage === 0 ? 'No Data' : `${inverterVoltage.toFixed(1)}V · ${inverterFrequency.toFixed(1)}Hz`;
  const batStatusStr   = batteryVoltage === 0  ? 'No Data' : `${batteryVoltage.toFixed(2)}V · ${batterySOC.toFixed(1)}% SOC${batteryFull ? ' · Full' : ''}`;
  const solarStatusStr = solarPower === 0      ? 'No Data' : `${solarPower.toFixed(0)}W · ${solarEfficiency.toFixed(1)}% eff`;
  const tempStatusStr  = systemTemp === 0      ? 'No Data' : `${systemTemp.toFixed(1)}°C`;

  const activeSensorCount = [gridVoltage, inverterVoltage, batteryVoltage, solarPower, systemTemp].filter(v => v > 0).length;

  const systemModules = [
    {
      id: 1, name: 'Sensor Integrity Validation', sensors: 'All Sensors + RTC DS3231',
      standard: 'IEC 61000-4-30', icon: Shield, color: 'red',
      anomalyState: sensorFault ? 'critical' : 'none', buzzerActive: moduleBuzzer.sensor,
      liveReading: `${activeSensorCount}/6 sensors active`,
      thresholds: [
        'Normal: All sensors responding, data timestamped within 15s (IEC 61000-4-30 Class A)',
        'Critical: Sensor freeze detected (>15s stale) or invalid readings → default to Grid',
      ],
      action: 'Default to Grid (K2/SSR2 ON); Buzzer ON 5s; suspend switching; email alert; log event',
    },
    {
      id: 2, name: 'Grid AC Monitoring', sensors: 'PZEM-004T (Voltage/Frequency)',
      standard: 'IEC 60364 / IEEE 1547', icon: Zap, color: 'blue',
      anomalyState: gridAnomaly, buzzerActive: moduleBuzzer.grid,
      liveReading: gridStatusStr,
      thresholds: [
        'Normal: 210–241V, 59–61Hz — stable grid operation',
        'Warning: 200–209V or 241–245V → Dashboard alert only. No buzzer, no email.',
        'Critical: <200V or >245V; OR |Δf|>1Hz → SSR2/K2+SSR3/K3 isolated; Buzzer 5s; email alert',
        'Dropout: V=0V or V<23V (10% Vn) → Critical immediate (no confirm delay)',
        'Spike: |ΔV|≥8V → Warning; |ΔV|≥23V + outside 207–253V → Critical',
        'Drift: 1V<|ΔV|≤7V → Warning; ≥3 readings outside 207–253V → Critical',
      ],
      action: 'Critical anomaly triggers immediate grid isolation. Dropout fires buzzer+email on first reading.',
    },
    {
      id: 3, name: 'Inverter AC Monitoring', sensors: 'PZEM-004T (Inverter AC Output)',
      standard: 'IEEE 1547 / IEC 60364', icon: Activity, color: 'purple',
      anomalyState: inverterAnomaly, buzzerActive: moduleBuzzer.inverter,
      liveReading: invStatusStr,
      thresholds: [
        'Normal: 207–253V (±10% of 230V), 59–61Hz — stable inverter output',
        'Warning: |Δf|>1Hz → Dashboard alert only. No buzzer, no email.',
        'Critical: <207V or >253V → Shed Loads; Grid Backup (K2 ON if grid safe); Buzzer 5s; email alert',
        'Dropout: V=0V or V<23V → Critical immediate (no confirm delay)',
        'Spike: |ΔV|≥8V → Warning; |ΔV|≥23V + outside range → Critical',
        'Drift: 1V<|ΔV|≤7V → Warning; ≥3 readings outside 207–253V → Critical',
      ],
      action: 'Load shedding and grid fallback when inverter output is unstable. Dropout fires immediately.',
    },
    {
      id: 4, name: 'Battery Safety Monitoring', sensors: 'INA219 × 2 (DC Voltage/Current — 2S Series)',
      standard: 'Lead Acid Gel SOC-based', icon: Battery, color: 'green',
      anomalyState: batteryAnomaly, buzzerActive: moduleBuzzer.battery,
      liveReading: batStatusStr,
      thresholds: [
        'Normal: 23.0–27.6V — Nominal pack 25.6V (Lead Acid Gel 24V)',
        'Full: ≥26.4V → K3 OFF (float charge cut-off)',
        'Warning: <23.0V (~50% SOC) → Dashboard alert only. No buzzer, no email.',
        'Critical: <21.6V (deep discharge) OR >27.6V (overcharge) → Buzzer 5s; email; MCCB alert',
      ],
      action: 'Inverter + MCCB primary protection. Buzzer + email on critical only. Admin must inspect.',
    },
    {
      id: 5, name: 'Solar PV Output Monitoring', sensors: 'WCS1500 x4 (String Current)',
      standard: 'IEC 61215', icon: Sun, color: 'amber',
      anomalyState: solarAnomaly, buzzerActive: moduleBuzzer.solar,
      liveReading: solarStatusStr,
      thresholds: [
        'Normal: >60% rated capacity (>1320W of 2360W rated array)',
        'Warning: 20–60% rated (440–1320W) → Dashboard alert only. No buzzer, no email.',
        'Critical: <20% Prated (<440W) → Grid Backup ON (SSR3/K3); Buzzer 5s; email alert',
        'String Mismatch: current variance >50% across strings → Critical; >30% → Warning',
      ],
      action: 'Automatic grid backup when solar insufficient. String fault triggers relay isolation.',
    },
    {
      id: 6, name: 'Safe Mode (Contactor Control)', sensors: 'All subsystems',
      standard: 'Master Cutoff', icon: PowerOff, color: 'cyan',
      anomalyState: !contactorClosed
        ? 'critical'
        : controlMode === 'failsafe'
          ? 'warning'
          : anomalyLevel === 'none' ? 'none' : anomalyLevel,
      buzzerActive: moduleBuzzer.safeMode,
      liveReading: `Contactor ${contactorClosed ? 'CLOSED' : 'OPEN'} · ${controlMode === 'failsafe' ? 'Failsafe Island' : 'Normal'} · Temp ${tempStatusStr}`,
      thresholds: [
        'Failsafe: ANY critical anomaly — relay action taken, K4 stays CLOSED',
        'Shutdown: Manual or double fault — K4 OPEN, outlets disconnected',
        'Resume: All monitored values return to normal. Manual reset required.',
      ],
      action: 'Master cutoff ensures no unsafe power flow — documented for panel review',
    },
  ];

  const getColorClasses = (color: string, anomalyState: string) => {
    if (anomalyState === 'critical') return { bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700', dot: 'bg-red-500' };
    if (anomalyState === 'warning')  return { bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-700', dot: 'bg-yellow-500' };
    const colors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
      blue:   { bg: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700',   dot: 'bg-blue-500'   },
      green:  { bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  dot: 'bg-green-500'  },
      amber:  { bg: 'bg-amber-50',  border: 'border-amber-300',  text: 'text-amber-700',  dot: 'bg-amber-500'  },
      cyan:   { bg: 'bg-cyan-50',   border: 'border-cyan-300',   text: 'text-cyan-700',   dot: 'bg-cyan-500'   },
      red:    { bg: 'bg-red-50',    border: 'border-red-300',    text: 'text-red-700',    dot: 'bg-red-500'    },
      purple: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', dot: 'bg-purple-500' },
    };
    return colors[color] ?? colors.blue;
  };

  const AnomalyBadge = ({ state }: { state: string }) => {
    if (state === 'critical') return (
      <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium whitespace-nowrap shrink-0 bg-red-100 text-red-700 border-red-300">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />Critical
      </span>
    );
    if (state === 'warning') return (
      <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium whitespace-nowrap shrink-0 bg-yellow-100 text-yellow-700 border-yellow-300">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 inline-block" />Warning
      </span>
    );
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium whitespace-nowrap shrink-0 bg-transparent text-green-700 border-green-300">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />Normal
      </span>
    );
  };

  const criticalCount = systemModules.filter(m => m.anomalyState === 'critical').length;
  const warningCount  = systemModules.filter(m => m.anomalyState === 'warning').length;

  const emailsSent   = anomalyLogs.filter((l: AnomalyLogEntry) => l.emailStatus === 'Sent').length;
  const emailsFailed = anomalyLogs.filter((l: AnomalyLogEntry) => l.emailStatus === 'Failed').length;
  const emailsQueued = anomalyLogs.filter((l: AnomalyLogEntry) => l.emailStatus === 'Queued').length;
  const buzzerEvents = anomalyLogs.filter((l: AnomalyLogEntry) => l.buzzer === 'ON' && l.severity === 'Critical').length;
  const criticalLogs = anomalyLogs.filter((l: AnomalyLogEntry) => l.severity === 'Critical').length;

  // [FIX-5] Avg response time
  const critWithTime = anomalyLogs.filter((l: AnomalyLogEntry) => l.severity === 'Critical' && (l as any).responseTimeMs != null);
  const avgRespMs    = critWithTime.length > 0
    ? Math.round(critWithTime.reduce((s: number, l: AnomalyLogEntry) => s + ((l as any).responseTimeMs ?? 0), 0) / critWithTime.length)
    : null;

  return (
    <div className="p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-6">

      {/* PAGE HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 sm:space-y-2">
          <h1 className="text-xl sm:text-2xl lg:text-3xl  text-slate-800">System Modules &amp; Rules</h1>
          <p className="text-xs sm:text-sm lg:text-base text-slate-600">
            Monitoring modules, threshold rules, and automated system configuration
          </p>
        </div>
        <div className="flex items-center gap-3">
          <BuzzerIndicator active={isBuzzerActive} />
          {isBuzzerActive && (
            <Button
              onClick={handleStopBuzzer}
              disabled={stopBuzzerStatus === 'stopping'}
              className="sm:w-auto text-white border bg-red-600 hover:bg-red-700 border-red-700"
            >
              <Square className="w-4 h-4 mr-2" />
              {stopBuzzerStatus === 'stopping' ? 'Stopping...' : 'Stop Buzzer'}
            </Button>
          )}
          <Button
            onClick={handleSaveSettings}
            disabled={saveStatus === 'saving'}
            className={`sm:w-auto text-white border ${
              saveStatus === 'saved'  ? 'bg-blue-600 border-blue-700' :
              saveStatus === 'error'  ? 'bg-red-600 border-red-700'   :
              saveStatus === 'saving' ? 'bg-slate-400 border-slate-500' :
              'bg-green-600 hover:bg-green-700 border-green-700'
            }`}
          >
            <Save className="w-4 h-4 mr-2" />
            {saveStatus === 'saving' ? 'Saving...' :
             saveStatus === 'saved'  ? '✓ Saved to DB' :
             saveStatus === 'error'  ? '✗ Save Failed' : 'Save Settings'}
          </Button>
        </div>
      </div>

      {/* STATS ROW */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <Card className="border-slate-200 shadow-lg"><CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1"><Settings className="w-4 h-4 text-cyan-600" /><div className="text-xs text-slate-600">Active Modules</div></div>
          <div className="text-xl sm:text-2xl text-slate-900">{systemModules.length}/{systemModules.length}</div>
          <div className="text-xs text-green-600">All Running</div>
        </CardContent></Card>

        <Card className="border-slate-200 shadow-lg"><CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1"><Cpu className="w-4 h-4 text-blue-600" /><div className="text-xs text-slate-600">Sensors</div></div>
          <div className="text-xl sm:text-2xl text-slate-900">{activeSensorCount}/5</div>
          <div className={`text-xs ${activeSensorCount === 5 ? 'text-green-600' : activeSensorCount > 0 ? 'text-yellow-600' : 'text-red-500'}`}>
            {activeSensorCount === 5 ? 'All Online' : activeSensorCount > 0 ? `${5 - activeSensorCount} offline` : 'Pending connection'}
          </div>
        </CardContent></Card>

        <Card className="border-slate-200 shadow-lg"><CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-4 h-4 text-green-600" /><div className="text-xs text-slate-600">System</div></div>
          <div className={`text-xl sm:text-2xl mt-0.5 ${
            systemCondition === 'Optimal' ? 'text-green-600' : systemCondition === 'Critical' ? 'text-red-600' : 'text-yellow-600'
          }`}>{systemCondition}</div>
          <div className={`text-xs ${criticalCount > 0 ? 'text-red-500' : warningCount > 0 ? 'text-yellow-500' : 'text-slate-400'}`}>
            {criticalCount > 0 ? `${criticalCount} critical` : warningCount > 0 ? `${warningCount} warning` : 'All clear'}
          </div>
        </CardContent></Card>

        <Card className={`shadow-lg ${isBuzzerActive ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}><CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1">
            {isBuzzerActive ? <Volume2 className="w-4 h-4 text-red-500" /> : <VolumeX className="w-4 h-4 text-slate-400" />}
            <div className="text-xs text-slate-600">Buzzer</div>
          </div>
          <div className={`text-xl sm:text-2xl mt-0.5 ${isBuzzerActive ? 'text-red-600' : 'text-slate-400'}`}>
            {isBuzzerActive ? 'ACTIVE' : 'SILENT'}
          </div>
          <div className={`text-xs ${isBuzzerActive ? 'text-red-400' : 'text-slate-400'}`}>
            {isBuzzerActive
              ? `5s pulse · ${buzzerTriggeredAt ? new Date(buzzerTriggeredAt).toLocaleTimeString() : 'active'}`
              : 'No critical anomaly'}
          </div>
        </CardContent></Card>
      </div>

      {/* MODULE CARDS */}
      <div className="space-y-3 sm:space-y-4">
        {systemModules.map(module => {
          const colors = getColorClasses(module.color, module.anomalyState);
          const Icon   = module.icon;
          return (
            <Card key={module.id} className={`border-2 ${colors.border} ${colors.bg} shadow-lg hover:shadow-xl transition-all`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="p-2 rounded-lg bg-white shadow-sm">
                      <Icon className={`w-5 h-5 ${colors.text}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-sm sm:text-base text-slate-900">{module.name}</CardTitle>
                      <div className="text-xs text-slate-600 mt-0.5">{module.sensors}</div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {module.standard && (
                          <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700">{module.standard}</span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                          module.anomalyState === 'critical' ? 'bg-red-100 text-red-700' :
                          module.anomalyState === 'warning'  ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-600'
                        }`}>{module.liveReading}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <BuzzerIndicator active={module.anomalyState === 'critical' && module.buzzerActive} />
                    <AnomalyBadge state={module.anomalyState} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="bg-white/70 rounded-lg p-3">
                  <div className="text-xs text-slate-500 mb-2">Threshold Rules:</div>
                  <div className="space-y-1.5">
                    {module.thresholds.map((rule, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <div className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />
                        <span className="text-xs sm:text-sm text-slate-900">{rule}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white/70 rounded-lg p-3">
                  <div className="text-xs text-slate-500 mb-1">Automated Response:</div>
                  <div className="text-xs sm:text-sm text-slate-900">{module.action}</div>
                </div>
                {(module.anomalyState === 'critical' || module.anomalyState === 'warning') && (
                  <div className={`px-3 py-2 rounded-lg flex items-center gap-2 border ${
                    module.anomalyState === 'critical' ? 'bg-red-100 border-red-200' : 'bg-yellow-100 border-yellow-200'
                  }`}>
                    {module.anomalyState === 'critical'
                      ? <Volume2 className="w-3.5 h-3.5 text-red-600 shrink-0" />
                      : <VolumeX className="w-3.5 h-3.5 text-yellow-600 shrink-0" />
                    }
                    <span className={`text-xs font-medium ${module.anomalyState === 'critical' ? 'text-red-700' : 'text-yellow-700'}`}>
                      {module.anomalyState === 'critical'
                        ? '🔴 CRITICAL — Buzzer ON (5s) + Email Alert sent'
                        : '🟡 WARNING — Dashboard alert only (no buzzer, no email)'}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* SETTINGS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Threshold Settings */}
        <Card className="border-slate-200 shadow-lg">
          <CardHeader className="pb-3">
            <CardTitle className="text-base sm:text-lg">Threshold Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { label: 'Grid Voltage Min (V)',         key: 'gridVoltageMin',          step: 1   },
              { label: 'Grid Voltage Max (V)',         key: 'gridVoltageMax',          step: 1   },
              { label: 'Grid Frequency Min (Hz)',      key: 'gridFrequencyMin',        step: 1   },
              { label: 'Grid Frequency Max (Hz)',      key: 'gridFrequencyMax',        step: 1   },
              { label: 'Inverter Voltage Min (V)',     key: 'inverterVoltageMin',      step: 1   },
              { label: 'Inverter Voltage Max (V)',     key: 'inverterVoltageMax',      step: 1   },
              { label: 'Battery Warning Voltage (V)',  key: 'batteryMinVoltage',       step: 0.1 },
              { label: 'Battery Critical Voltage (V)', key: 'batteryCriticalVoltage', step: 0.1 },
              { label: 'Battery Full Voltage (V)',     key: 'batteryFullVoltage',      step: 0.1 },
            ].map(({ label, key, step }) => (
              <div key={key}>
                <label className="text-sm text-gray-900 block mb-2">{label}</label>
                <input
                  type="number" step={step}
                  value={(settings as unknown as Record<string, number>)[key]}
                  onChange={e => setSettings({ ...settings, [key]: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
            ))}
            <div>
              <label className="text-sm text-gray-900 block mb-2">Solar Min Power (% of rated)</label>
              <input type="number" value={settings.solarMinPower}
                onChange={e => setSettings({ ...settings, solarMinPower: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              <p className="text-xs text-slate-400 mt-1">Critical &lt;20% of 2200W = &lt;440W</p>
            </div>
          </CardContent>
        </Card>

        {/* Automation + Status */}
        <Card className="border-slate-200 shadow-lg">
          <CardHeader className="pb-3">
            <CardTitle className="text-base sm:text-lg">Automation Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { label: 'Auto Source Switching', sub: 'Automatically switch between power sources', key: 'autoSwitch' },
              { label: 'Anomaly Detection',     sub: 'Enable real-time anomaly alerts',            key: 'anomalyAlerts' },
            ].map(({ label, sub, key }) => (
              <div key={key} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <div>
                  <div className="text-sm text-gray-900">{label}</div>
                  <div className="text-xs text-gray-500">{sub}</div>
                </div>
                <button
                  onClick={() => setSettings({ ...settings, [key]: !(settings as any)[key] })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${(settings as any)[key] ? 'bg-green-500' : 'bg-gray-300'}`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${(settings as any)[key] ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
            ))}

            {/* Current System Status */}
            <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg border border-green-200">
              <div className="text-sm text-slate-900 mb-3">Current System Status</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-600">Control Mode</div>
                  <div className={`text-lg font-semibold ${
                    controlMode === 'solar' ? 'text-amber-600' : controlMode === 'grid' ? 'text-blue-600' :
                    controlMode === 'shutdown' ? 'text-red-600' : 'text-orange-600'
                  }`}>{controlMode.charAt(0).toUpperCase() + controlMode.slice(1)}</div>
                  <div className={`text-[0.65rem] mt-0.5 ${
                    controlAuthority === 'safety_override' ? 'text-red-500' :
                    controlAuthority === 'manual' ? 'text-amber-500' : 'text-slate-400'
                  }`}>
                    {controlAuthority === 'safety_override' ? 'Safety Override' : controlAuthority === 'manual' ? 'Manual' : 'Auto'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-600">System Health</div>
                  <div className={`text-lg font-semibold ${
                    systemCondition === 'Optimal' ? 'text-green-600' : systemCondition === 'Critical' ? 'text-red-600' : 'text-yellow-600'
                  }`}>{systemCondition}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-600">Contactor / K3</div>
                  <div className={`text-lg font-semibold ${contactorClosed ? 'text-green-600' : 'text-red-600'}`}>
                    {contactorClosed ? 'CLOSED' : 'OPEN'}
                  </div>
                  <div className={`text-[0.65rem] mt-0.5 ${gridAssistActive ? 'text-teal-600' : 'text-slate-400'}`}>
                    K3 Grid Assist: {gridAssistActive ? 'Active' : 'Standby'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-600">Buzzer / Temp</div>
                  <div className={`text-lg font-semibold ${isBuzzerActive ? 'text-red-600' : 'text-slate-400'}`}>
                    {isBuzzerActive ? 'Active' : 'Silent'}
                  </div>
                  <div className={`text-[0.65rem] mt-0.5 ${systemTemp >= 60 ? 'text-red-500' : systemTemp >= 50 ? 'text-yellow-600' : 'text-slate-400'}`}>
                    {systemTemp > 0 ? `${systemTemp.toFixed(1)}°C` : 'No temp data'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-600">SSR Switches</div>
                  <div className="text-lg font-semibold text-slate-700">{totalSwitches}</div>
                  <div className="text-[0.65rem] text-slate-400 mt-0.5">Last: {lastSwitchTime}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-600">Email Service</div>
                  <div className={`text-lg font-semibold ${
                    emailServiceHealth === null ? 'text-slate-400' :
                    emailServiceHealth ? 'text-green-600' : 'text-red-500'
                  }`}>
                    {emailServiceHealth === null ? 'Checking...' : emailServiceHealth ? 'Online' : 'Offline'}
                  </div>
                  <div className="text-[0.65rem] text-slate-400 mt-0.5">
                    {emailsSent} sent · {emailsFailed > 0 ? `${emailsFailed} failed` : `${emailsQueued} queued`}
                  </div>
                </div>
              </div>
            </div>

            {/* Recent Anomaly Events */}
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div className="text-sm text-slate-600 mb-2">Recent Anomaly Events</div>
              <div className="flex items-center justify-between">
                <div className="text-2xl sm:text-3xl text-slate-900">
                  {anomalyLogs.length}
                  <span className="text-sm font-normal text-slate-500 ml-1">logged</span>
                </div>
                <div className="text-xs text-slate-400 text-right space-y-0.5">
                  <div className={criticalLogs > 0 ? 'text-red-500' : ''}>{criticalLogs} critical events</div>
                  <div>{emailsSent} emails sent</div>
                  <div>{buzzerEvents} buzzer events</div>
                  {avgRespMs !== null && (
                    <div className="text-blue-600 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      avg {avgRespMs}ms response
                    </div>
                  )}
                  {emailsFailed > 0 && <div className="text-red-400">{emailsFailed} emails failed</div>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
