// ============================================================================
// KioskLCD.tsx — PATCHED v1.1
//
// v1.1 CHANGES:
//   [FIX-SOLAR-RATED-W] Updated hardcoded 2320W references to 2360W
//     for new JAM72D40-590/MB panels (4×590W = 2360W).
//     Line 602: dcPBarPct — was dividing by 2320 → now 2360.
//               Solar progress bar was clipping at 2320W, missing top 40W.
//     Line 714: Label "~2320 W max" → "~2360 W max", midpoint "1160" → "1180".
//   All other thresholds imported from EnergySystemContext (single source of truth).
// ============================================================================
import {
  Battery, Sun, Zap, Activity, Clock, AlertTriangle,
  Thermometer, Wifi, Shield, ChevronLeft, TrendingUp,
  TrendingDown, ArrowLeftRight, Palette, Power, AlertCircle,
} from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceDot,
} from 'recharts';
import {
  useEnergySystem,
  BAT_WARNING_LOW, BAT_FULL, BAT_CRITICAL_LOW,
  GRID_NORMAL_LOW, GRID_NORMAL_HIGH, GRID_CRITICAL_LOW, GRID_CRITICAL_HIGH, GRID_FREQ_CRIT,
  INV_CRITICAL_LOW, INV_CRITICAL_HIGH,
  SOLAR_CRITICAL_LOW, SOLAR_WARNING_LOW,
} from '../contexts/EnergySystemContext';
import * as api from '../utils/api';
import solarImg from '../assets/4panels.jpg';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Title, Tooltip as CJSTooltip, Legend as CJSLegend,
} from 'chart.js';
import { Line as CJSLine } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';
import { EnergyFlowScreensaver } from './EnergyFlowScreensaver';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Title, CJSTooltip, CJSLegend, annotationPlugin);

type ViewType = 'main' | 'grid' | 'solar' | 'battery' | 'panels' | 'graph' | 'ssr' | 'theme' | 'screensaver';
type ControlModeType = 'solar' | 'grid' | 'shutdown' | 'failsafe';

interface Theme { id: string; name: string; gradient: string; borderColor: string; textColor: string; }

const themes: Theme[] = [
  { id: 'default',  name: 'Ocean Blue',      gradient: 'from-slate-950 via-blue-950 to-slate-950',   borderColor: 'border-blue-700',   textColor: 'text-blue-400' },
  { id: 'sunset',   name: 'Sunset Orange',   gradient: 'from-slate-950 via-orange-950 to-slate-950', borderColor: 'border-orange-700', textColor: 'text-orange-400' },
  { id: 'forest',   name: 'Forest Green',    gradient: 'from-slate-950 via-green-950 to-slate-950',  borderColor: 'border-green-700',  textColor: 'text-green-400' },
  { id: 'midnight', name: 'Midnight Purple', gradient: 'from-slate-950 via-purple-950 to-slate-950', borderColor: 'border-purple-700', textColor: 'text-purple-400' },
];

// All thresholds imported from EnergySystemContext — single source of truth
// GRID_NORMAL_LOW=210, GRID_NORMAL_HIGH=241, GRID_CRITICAL_LOW=200, GRID_CRITICAL_HIGH=245
// BAT_WARNING_LOW=23, BAT_FULL=25.4, BAT_CRITICAL_LOW=21.6
// INV_CRITICAL_LOW=207, INV_CRITICAL_HIGH=253
// SOLAR_CRITICAL_LOW=464, SOLAR_WARNING_LOW=1392

const slideUpStyle = `
  @keyframes slideUp {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  @keyframes slideDown {
    from { transform: translateY(-60%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  .animate-slide-up   { animation: slideUp   0.32s cubic-bezier(0.22,1,0.36,1) both; }
  .animate-slide-down { animation: slideDown 0.28s cubic-bezier(0.22,1,0.36,1) both; }
  html,body,#root { margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:#000; }
  .scroll-blue::-webkit-scrollbar { width: 3px; }
  .scroll-blue::-webkit-scrollbar-track { background: transparent; }
  .scroll-blue::-webkit-scrollbar-thumb { background: rgba(59,130,246,0.4); border-radius: 99px; }
  .scroll-blue::-webkit-scrollbar-thumb:hover { background: rgba(59,130,246,0.65); }
`;

export function KioskLCD() {
  const systemData = useEnergySystem();

  const [currentView, setCurrentView]               = useState<ViewType>('main');
  const [animClass, setAnimClass]                   = useState('animate-slide-up');
  const [selectedTheme, setSelectedTheme]           = useState<Theme>(themes[0]);
  const [isDataLoaded, setIsDataLoaded]             = useState(false);
  const [localOutlet1Status, setLocalOutlet1Status] = useState(false);
  const [localOutlet2Status, setLocalOutlet2Status] = useState(false);
  const [graphSlide, setGraphSlide]                 = useState(0);
  const [historyData, setHistoryData]               = useState<any[]>([]);
  const [balanceData, setBalanceData]               = useState<any[]>([]);
  const [consumptionData, setConsumptionData]       = useState<any[]>([]);
  const [totals, setTotals]                         = useState({ solar: 0, grid: 0, battery: 0, inverter: 0 });
  const [touchStartX, setTouchStartX]               = useState<number | null>(null);
  // [FIX-TIME] Live ticking clock seeded from Flask server_time (RPi RTC).
  // Keeps serverTime variable intact for graph timestamp processing.
  const [displayTime, setDisplayTime] = useState<Date>(new Date());
  useEffect(() => {
    if (systemData.serverTime) setDisplayTime(new Date(systemData.serverTime));
  }, [systemData.serverTime]);
  useEffect(() => {
    const id = setInterval(() => setDisplayTime(prev => new Date(prev.getTime() + 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const navigateTo = (view: ViewType) => {
    setAnimClass(view === 'main' ? 'animate-slide-down' : 'animate-slide-up');
    setCurrentView(view);
  };


  // ── Screensaver: 2-minute idle timer ─────────────────────────────────
  const [showScreensaver, setShowScreensaver] = useState(false);
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const IDLE_MS = 1 * 60 * 1000; // 1 minute

  const resetIdle = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (showScreensaver) setShowScreensaver(false);
    idleTimerRef.current = setTimeout(() => setShowScreensaver(true), IDLE_MS);
  };

  useEffect(() => {
    resetIdle();
    window.addEventListener('pointermove', resetIdle);
    window.addEventListener('pointerdown', resetIdle);
    window.addEventListener('keydown', resetIdle);
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      window.removeEventListener('pointermove', resetIdle);
      window.removeEventListener('pointerdown', resetIdle);
      window.removeEventListener('keydown', resetIdle);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasAnyLiveMetric =
      Number(systemData.gridVoltage ?? 0) > 0 ||
      Number(systemData.inverterVoltage ?? 0) > 0 ||
      Number(systemData.solarVoltage ?? 0) > 0 ||
      Number(systemData.batteryVoltage ?? 0) > 0;
    if (hasAnyLiveMetric) setIsDataLoaded(true);
  }, [systemData.gridVoltage, systemData.inverterVoltage, systemData.solarVoltage, systemData.batteryVoltage]);

  // [FIX-OUTLET] Sync outlet status from context whenever it changes
  useEffect(() => {
    setLocalOutlet1Status(systemData.outlet1Status);
    setLocalOutlet2Status(systemData.outlet2Status);
  }, [systemData.outlet1Status, systemData.outlet2Status]);

  const acVoltage_raw   = systemData.inverterVoltage ?? 0;
  const acCurrent_raw   = systemData.inverterCurrent ?? 0;
  const solarPower_raw: number = Number(systemData.solarPower ?? 0);  // [BUG-FIX] Number()
  const battCurrentSigned_raw = Number(systemData.batteryCurrent ?? 0);
  const battCurrent_raw = Math.abs(battCurrentSigned_raw);
  const battVoltage_raw = systemData.batteryVoltage  ?? 0;
  const serverTime      = systemData.serverTime      ?? '';

  // ── Consume shared sensorHistory from context — no independent fetch ─────────
  // Context fetches every 30s; re-processes whenever the reference updates.
  useEffect(() => {
    const history = systemData.sensorHistory;
    const now = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });

    if (history && history.length > 0) {
      const rows = (history as any[]).slice().reverse();

      // Voltage + Current Trends
      const voltChart = rows.map((raw: any) => {
        const time = (ts => { const p=(ts||'').replace('T',' ').split(' '); const t=(p[1]||'').split(':'); const h=parseInt(t[0]||'0'); const m=(t[1]||'00'); const ampm=h>=12?'PM':'AM'; return `${h%12||12}:${m} ${ampm}`; })(raw.timestamp);
        const gridV = Number(raw.grid_voltage ?? 0), invV = Number(raw.inverter_voltage ?? 0);
        const batV  = Number(raw.battery_pack_voltage ?? 0), solV = Number(raw.solar_dc_voltage ?? 0);
        // [FIX-GRAPH] Replace 0V readings with null so Recharts skips them (no dramatic drop to 0)
        const gridVPlot = gridV > 0 ? gridV : null;
        const invVPlot  = invV  > 0 ? invV  : null;
        const batVPlot  = batV  > 0 ? batV  : null;
        const solVPlot  = solV  > 0 ? solV  : null;
        const gridFreq = Number(raw.grid_frequency ?? 60), invFreq = Number(raw.inverter_frequency ?? 60);
        const solPwr = Number(raw.solar_dc_power ?? 0), invI = Number(raw.inverter_current ?? 0);
        const solI = Number(raw.solar_dc_current ?? 0), batI = Number(raw.battery_pack_current ?? 0);
        const gA = gridV <= 0 ? 'none' : (gridV < GRID_CRITICAL_LOW || gridV > GRID_CRITICAL_HIGH || Math.abs(gridFreq - 60) > GRID_FREQ_CRIT) ? 'critical' : (gridV < GRID_NORMAL_LOW || gridV > GRID_NORMAL_HIGH) ? 'warning' : 'none';
        const iA = invV <= 0 ? 'none' : (invV < INV_CRITICAL_LOW || invV > INV_CRITICAL_HIGH) ? 'critical' : (invFreq < 59 || invFreq > 61) ? 'warning' : 'none';
        const bA = batV <= 0 ? 'none' : (batV < 21.0 || batV > 25.4) ? 'critical' : batV < 23.0 ? 'warning' : 'none';
        const sA = solPwr < 1 ? 'none' : solPwr < SOLAR_CRITICAL_LOW ? 'critical' : solPwr < SOLAR_WARNING_LOW ? 'warning' : 'none';
        const hasAnom = gA !== 'none' || iA !== 'none' || bA !== 'none' || sA !== 'none';
        const anomSev = (gA === 'critical' || iA === 'critical' || bA === 'critical' || sA === 'critical') ? 'critical' : 'warning';
        const maxV = Math.max(gridV > 0 ? gridV : 0, invV > 0 ? invV : 0, solV > 0 ? solV : 0, batV > 0 ? batV : 0, 0);
        const gridI = gridV > 0 && raw.grid_power ? parseFloat((Number(raw.grid_power) / gridV).toFixed(2)) : 0;
        const maxC = Math.max(gridI, invI, Math.abs(batI), solI, 0);
        return {
          time, batteryVoltage: batVPlot, gridVoltage: gridVPlot, inverterVoltage: invVPlot, solarVoltage: solVPlot,
          solarPowerW: solPwr, totalLoad: invV * invI,
          gridCurrent: gridI, solarCurrent: parseFloat(solI.toFixed(2)),
          batteryCurrent: parseFloat(Math.abs(batI).toFixed(2)), inverterCurrent: parseFloat(invI.toFixed(2)),
          anomaly: hasAnom, anomalySeverity: anomSev,
          voltageAnomalyY: hasAnom ? (maxV > 0 ? maxV + 10 : 15) : null,
          currentAnomalyY: hasAnom ? (maxC > 0 ? maxC + 0.3 : 0.5) : null,
          // [FIX-DB-LEVEL] Store DB anomaly levels + type for dot coloring and event labels
          grid_anomaly_level:     (raw.grid_anomaly_level     ?? '').toLowerCase(),
          inverter_anomaly_level: (raw.inverter_anomaly_level ?? '').toLowerCase(),
          grid_anomaly_type:      raw.grid_anomaly_type  ?? raw.anomaly_type ?? '',
          inv_anomaly_type:       raw.inv_anomaly_type   ?? raw.anomaly_type ?? '',
          dc_battery_anomaly_level: (raw.dc_battery_anomaly_level ?? '').toLowerCase(),
          dc_solar_anomaly_level:   (raw.dc_solar_anomaly_level   ?? '').toLowerCase(),
        };
      });

      // Energy Balance
      const balChart = rows.map((raw: any) => {
        const time = (ts => { const p=(ts||'').replace('T',' ').split(' '); const t=(p[1]||'').split(':'); const h=parseInt(t[0]||'0'); const m=(t[1]||'00'); const ampm=h>=12?'PM':'AM'; return `${h%12||12}:${m} ${ampm}`; })(raw.timestamp);
        const sp = Number(raw.solar_dc_power ?? 0), gp = Number(raw.grid_power ?? 0);
        const iv = Number(raw.inverter_voltage ?? 0), ic = Number(raw.inverter_current ?? 0);
        const invPwr = Number(raw.inverter_power ?? (iv * ic)); // [FIX] use DB power reading
        return { time, solarSupply: parseFloat(sp.toFixed(1)), gridSupply: parseFloat(gp.toFixed(1)), totalSupply: parseFloat((sp + gp).toFixed(1)), totalLoad: parseFloat(invPwr.toFixed(1)) };
      });

      // Consumption
      const conChart = rows.map((raw: any) => {
        const time = (ts => { const p=(ts||'').replace('T',' ').split(' '); const t=(p[1]||'').split(':'); const h=parseInt(t[0]||'0'); const m=(t[1]||'00'); const ampm=h>=12?'PM':'AM'; return `${h%12||12}:${m} ${ampm}`; })(raw.timestamp);
        const sp = Number(raw.solar_dc_power ?? 0), gp = Number(raw.grid_power ?? 0);
        const bv = Number(raw.battery_pack_voltage ?? 0), bi = Number(raw.battery_pack_current ?? 0);
        const invP = parseFloat((raw.inverter_ac_voltage ?? raw.inverterVoltage ?? 0) * (raw.inverter_ac_current ?? raw.inverterCurrent ?? 0) > 0
          ? ((raw.inverter_ac_voltage ?? 0) * (raw.inverter_ac_current ?? 0))
          : (raw.inverter_power ?? raw.inverterPower ?? 0));
        return { time, Grid: parseFloat(gp.toFixed(1)), Inverter: parseFloat(invP.toFixed(1)) };
      });

      const ih = 5 / 3600;
      setHistoryData(voltChart);
      setBalanceData(balChart);
      setConsumptionData(conChart);
      setTotals({
        inverter: parseFloat(conChart.reduce((s: number, d: any) => s + (d.Inverter ?? 0) * ih, 0).toFixed(2)),
        grid:    parseFloat(conChart.reduce((s: number, d: any) => s + d.Grid    * ih, 0).toFixed(2)),
        battery: 0,
      });
    } else if (!systemData.sensorHistoryLoading) {
      const batDis = battCurrentSigned_raw < 0 ? Math.abs(battCurrentSigned_raw) * battVoltage_raw : 0;
      setHistoryData([{ time: now, batteryVoltage: 0, gridVoltage: 0, inverterVoltage: 0, solarVoltage: 0, solarPowerW: 0, totalLoad: 0, gridCurrent: 0, solarCurrent: 0, batteryCurrent: 0, inverterCurrent: 0, anomaly: false, voltageAnomalyY: null, currentAnomalyY: null }]);
      setBalanceData([{ time: now, solarSupply: parseFloat(solarPower_raw.toFixed(1)), gridSupply: 0, totalSupply: parseFloat(solarPower_raw.toFixed(1)), totalLoad: parseFloat((acVoltage_raw * acCurrent_raw).toFixed(1)) }]);
      setConsumptionData([{ time: now, Grid: 0, Inverter: 0 }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemData.sensorHistory]);

  // ── Live sensor values ───────────────────────────────────────────────────────
  const gridVoltage: number   = Number(systemData.gridVoltage   ?? 0);  // [BUG-FIX] Number() — string from Flask kills bar width
  const gridCurrent: number   = Number(systemData.gridCurrent   ?? 0);
  const gridFrequency: number = Number(systemData.gridFrequency ?? 0);
  const solarVoltage: number      = Number(systemData.solarVoltage      ?? 0);  // [BUG-FIX] Number() wrap
  const solarCurrent: number      = Number(systemData.solarCurrent      ?? 0);
  const acVoltage: number         = Number(systemData.inverterVoltage   ?? 0);
  const acCurrent: number         = Number(systemData.inverterCurrent   ?? 0);
  const inverterFrequency: number = Number(systemData.inverterFrequency ?? 0);
  // [SOC] Resting open-circuit voltage table — JSL II VRLA Gel 24V (2S × 12V 100Ah)
  // Synced with BatteryHealthCard v8.0.
  // NEVER feed charging voltage (≥27V) into this table — it will return a false 100%.
  const _KIOSK_SOC_TABLE: [number,number][] = [
    [25.60,100],[25.40,98],[25.20,95],[25.00,90],
    [24.80,84],[24.60,78],[24.50,72],[24.30,62],
    [24.10,50],[24.00,43],[23.80,33],[23.60,23],
    [23.40,14],[23.20,7],[23.00,2],[22.50,0],
  ];
  const _kioskBatV = Number(systemData.batteryVoltage ?? 0);
  // Voltage smoothing — rolling avg of last 8 readings (same as BatteryHealthCard)
  const _kioskVSmooth = (() => {
    if (!(window as any).__kioskVH) (window as any).__kioskVH = [];
    const h = (window as any).__kioskVH as number[];
    if (_kioskBatV > 10) { h.push(_kioskBatV); if (h.length > 8) h.shift(); }
    return h.length > 0 ? h.reduce((a,b)=>a+b,0)/h.length : _kioskBatV;
  })();
  const _kioskIsCharging = Number(systemData.solarPower ?? 0) > 5 && _kioskBatV >= 27.0;
  // If charging, clamp lookup to resting max (25.6V) so we don't map 27V → false 100%
  const _kioskLookupV = _kioskIsCharging ? Math.min(_kioskVSmooth, 25.6) : _kioskVSmooth;
  const batteryHealth: number = (() => {
    if (_kioskLookupV <= 0) return 0;
    if (_kioskLookupV >= _KIOSK_SOC_TABLE[0][0]) return 100;
    if (_kioskLookupV <= _KIOSK_SOC_TABLE[_KIOSK_SOC_TABLE.length-1][0]) return 0;
    for (let i = 0; i < _KIOSK_SOC_TABLE.length-1; i++) {
      const [hv,hs] = _KIOSK_SOC_TABLE[i], [lv,ls] = _KIOSK_SOC_TABLE[i+1];
      if (_kioskLookupV <= hv && _kioskLookupV >= lv)
        return Math.round((ls + (_kioskLookupV-lv)/(hv-lv)*(hs-ls)) * 10) / 10;
    }
    return 0;
  })();
  const batteryVoltage: number    = Number(systemData.batteryVoltage    ?? 0);
  const batteryCurrent: number    = Math.abs(Number(systemData.batteryCurrent ?? 0));
  const systemTemp: number        = Number(systemData.systemTemp        ?? 0);
  const solarPower: number        = Number(systemData.solarPower        ?? 0);  // [BUG-FIX] Number() wrap
  const contactorClosed   = systemData.contactorClosed   ?? true;
  const k3Active          = systemData.k3Active          ?? false;
  const tempAnomaly       = systemData.tempAnomaly       ?? 'none';
  const batteryAnomaly    = systemData.batteryAnomaly    ?? 'none';
  const solarAnomaly      = systemData.solarAnomaly      ?? 'none';

  // [PZEM017] dual DC meter fields
  const batteryChargeA    = systemData.batteryChargeA    ?? 0;
  const batteryDischargeA = systemData.batteryDischargeA ?? 0;
  const batterySource     = systemData.batterySource     ?? 'INA219';
  const isINA219          = batterySource === 'INA219';

  const controlAuthority       = systemData.controlAuthority;
  const controlMode            = systemData.controlMode;
  const lastSwitchTime         = systemData.lastSwitchTime         ?? '—';
  const totalSwitches          = systemData.totalSwitches          ?? 0;
  const totalRecoveries        = systemData.totalRecoveries        ?? 0;
  const autoSwitchEnabled      = systemData.autoSwitchEnabled;
  const manualBlockedReason    = systemData.manualBlockedReason;
  const systemCondition        = systemData.systemCondition;
  const manualLockoutRemaining = systemData.manualLockoutRemaining ?? 0;

  // ── SSR hardware truth — synced exactly with UnifiedSSROutletCard ──────────
  // Uses ssrStates directly from context — same source as UnifiedSSR
  const K1_Solar      = systemData.ssrStates?.K1 ?? false;
  const K2_Grid       = systemData.ssrStates?.K2 ?? false;
  const K3_GridAssist = k3Active;
  // K4: use k4Closed directly (same as UnifiedSSR K4_Closed) — no extra conditions
  const SSR4_Closed   = systemData.k4Closed ?? false;
  const SSR4_Open     = !SSR4_Closed;
  const outletEnergized = SSR4_Closed && (K1_Solar || K2_Grid);

  // ── Dropout detection — SYNCED TO ARDUINO v6.5 ───────────────────────────
  const inverterPresent_kiosk = acVoltage > 50;
  const gridPresent_kiosk     = gridVoltage > 50;
  const bothDropped_kiosk     = (systemData.arduinoDropout ?? false) || (!inverterPresent_kiosk && !gridPresent_kiosk);
  const gridDropped_kiosk     = !gridPresent_kiosk;
  const inverterDropped_kiosk = !inverterPresent_kiosk;

  // ── Timer countdowns — direct from Arduino via EnergySystemContext ────────
  // NO local setInterval — Arduino is the single source of truth for all timers
  const k4DisplayLeft_kiosk       = systemData.arduinoK4LeftS       ?? 0;
  const k1DisplayLeft_kiosk       = systemData.arduinoK1LeftS       ?? 0;
  const k2DisplayLeft_kiosk       = systemData.arduinoK2LeftS       ?? 0;
  const recoveryDisplayLeft_kiosk = systemData.arduinoRecoveryLeftS ?? 0;

  const k4TimerRunning_kiosk  = k4DisplayLeft_kiosk > 0;
  const k1TimerRunning_kiosk  = k1DisplayLeft_kiosk > 0;
  const k2TimerRunning_kiosk  = k2DisplayLeft_kiosk > 0;
  const recoveryRunning_kiosk = recoveryDisplayLeft_kiosk > 0;

  // ── Emergency state — 100% derived from Arduino flags (NO local useState)
  // SYNCED TO UnifiedSSROutletCard — same logic, same source of truth
  const emergencyActive_kiosk = (systemData.arduinoEmergency ?? false) && !recoveryRunning_kiosk;
  const eStateKiosk = emergencyActive_kiosk ? 'emergency' : recoveryRunning_kiosk ? 'recovering' : 'idle';

  // ── [PATCH] Real active source voltage & current for outlets ────────────────
  const activeSourceVoltage = K1_Solar ? acVoltage : K2_Grid ? gridVoltage : 0;
  const activeSourceCurrent = K1_Solar ? acCurrent : K2_Grid ? gridCurrent : 0;

  // ── K3 grid assist label ─────────────────────────────────────────────────────
  const manilaHour    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })).getHours();
  const isHarvestTime = manilaHour >= 6 && manilaHour < 18;
  const k3IsCharging    = K3_GridAssist && isHarvestTime && batteryHealth >= 95 && solarPower > SOLAR_WARNING_LOW;
  const noGrid      = (systemData.gridAnomaly ?? 'none') === 'critical' || gridVoltage === 0;
  const batLow      = batteryVoltage > 0 && batteryVoltage < BAT_WARNING_LOW;
  const batDepleted = batteryVoltage > 0 && batteryVoltage < BAT_CRITICAL_LOW;

  const k3ModeLabel   = !K3_GridAssist ? 'STANDBY'
    : k3IsCharging ? 'GRID CHARGING'
    : !isHarvestTime ? 'GRID ASSISTING ← Night'
    : solarPower < SOLAR_CRITICAL_LOW ? 'GRID ASSISTING ← Cloudy'
    : batteryVoltage < BAT_WARNING_LOW ? 'GRID ASSISTING ← Bat Low'
    : 'GRID ASSISTING ← Grid';

  const getTempStatus = (t: number) =>
    t >= 60 ? { color: 'text-red-500',   bg: 'bg-red-500/30' }
    : t >= 50 ? { color: 'text-amber-400', bg: 'bg-amber-500/30' }
    :           { color: 'text-green-400',  bg: 'bg-green-500/30' };

  const gridPowerW: number = Number(systemData.gridPower ?? 0);
  const gridPower: string  = gridPowerW.toFixed(1);
  const gridStatus  = gridVoltage >= GRID_NORMAL_LOW && gridVoltage <= GRID_NORMAL_HIGH ? 'Stable' : gridVoltage > 0 ? 'Unstable' : 'No Power';
  const batteryStatus = batteryHealth >= 80 ? 'Excellent' : batteryHealth >= 60 ? 'Good' : batteryHealth >= 40 ? 'Fair' : batteryHealth >= 20 ? 'Low' : 'Critical';

  const getAuthorityBadge = () => {
    if (controlAuthority === 'safety_override') return { text: 'Safety Override', cls: 'bg-red-600/80 text-white border-red-500' };
    if (controlAuthority === 'manual')          return { text: 'Manual Control',  cls: 'bg-amber-600/80 text-white border-amber-500' };
    return                                             { text: 'Auto',            cls: 'bg-green-600/50 text-green-200 border-green-600' };
  };

  const TOTAL_SLIDES = 5;
  const handleTouchStart = (e: React.TouchEvent) => setTouchStartX(e.touches[0].clientX);
  const handleTouchEnd   = (e: React.TouchEvent) => {
    if (touchStartX === null) return;
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 40) {
      if (diff > 0 && graphSlide < TOTAL_SLIDES - 1) setGraphSlide(s => s + 1);
      if (diff < 0 && graphSlide > 0)                setGraphSlide(s => s - 1);
    }
    setTouchStartX(null);
  };

  const toggleOutlet = (id: number): void => {
    if (!SSR4_Closed || (!K1_Solar && !K2_Grid)) return;
    if (id === 1) {
      const next = !localOutlet1Status;
      setLocalOutlet1Status(next);
      systemData.setOutlet1Status(next);
    } else {
      const next = !localOutlet2Status;
      setLocalOutlet2Status(next);
      systemData.setOutlet2Status(next);
    }
  };

  const handleModeChange_ssr = (mode: 'solar' | 'grid' | 'shutdown'): void => {
    if (controlAuthority === 'auto') return;
    if (controlAuthority === 'safety_override') return;
    if (manualLockoutRemaining > 0) return;
    systemData.enterManualMode(mode);
  };

  const handleAutoSwitchToggle = (enableAuto: boolean): void => {
    if (controlAuthority === 'safety_override' || manualLockoutRemaining > 0) return;
    if (enableAuto) { systemData.exitManualMode(); }
    else            { systemData.setAutoSwitchEnabled(false); }
  };

  // isSafetyOverride in main body — used by globalDisabled_kiosk AND renderSSRDetail
  const isSafetyOverride      = controlAuthority === 'safety_override';
  // K1/K2 disabled during emergency OR recovery — same as UnifiedSSROutletCard
  const k1Disabled_kiosk      = eStateKiosk !== 'idle';
  const k2Disabled_kiosk      = eStateKiosk !== 'idle';
  const globalDisabled_kiosk  = bothDropped_kiosk || isSafetyOverride || eStateKiosk !== 'idle' || k4TimerRunning_kiosk;

  // ── Handlers — EXACT SAME as UnifiedSSROutletCard ────────────────────────
  const handleToggleK1_ssr = async (): Promise<void> => {
    if (k1Disabled_kiosk) return;
    const newK1 = !K1_Solar;
    const newMode = !newK1 && !K2_Grid ? 'shutdown' : newK1 && K2_Grid ? 'assist' : newK1 ? 'solar' : 'grid';
    try {
      await api.post('/ssr/state', { ssrStates: { SSR1: newK1, SSR2: K2_Grid, SSR3: K3_GridAssist, SSR4: true }, controlMode: newMode, autoSwitchEnabled: false, manualOverride: true, contactorClosed: true });
    } catch (e) { console.error('[Kiosk] K1 toggle failed', e); }
  };

  const handleToggleK2_ssr = async (): Promise<void> => {
    if (k2Disabled_kiosk) return;
    const newK2 = !K2_Grid;
    const newMode = !K1_Solar && !newK2 ? 'shutdown' : K1_Solar && newK2 ? 'assist' : newK2 ? 'grid' : 'solar';
    try {
      await api.post('/ssr/state', { ssrStates: { SSR1: K1_Solar, SSR2: newK2, SSR3: K3_GridAssist, SSR4: true }, controlMode: newMode, autoSwitchEnabled: false, manualOverride: true, contactorClosed: true });
    } catch (e) { console.error('[Kiosk] K2 toggle failed', e); }
  };

  const handleEmergency_ssr = async (): Promise<void> => {
    try { await api.post('/ssr/emergency', {}); }
    catch (err) { console.error('[Kiosk] Emergency failed:', err); }
  };

  const handleRecovery_ssr = async (): Promise<void> => {
    try { await api.post('/ssr/recovery', {}); }
    catch (err) { console.error('[Kiosk] Recovery failed:', err); }
  };

  // ============================================================================
  // MAIN MENU
  // ============================================================================
  const renderMainMenu = () => {
    return (
      <div className="relative h-full p-3 sm:p-4 md:p-6 flex flex-col text-white">
        <div className="flex items-center justify-between pb-2 sm:pb-3 border-b border-blue-700/50">
          <div className="flex items-center gap-2">
            <div className="h-6 sm:h-8 md:h-10 w-6 sm:w-8 md:w-10 bg-blue-500 rounded-full flex items-center justify-center">
              <Zap className="w-3 sm:w-4 md:w-5 h-3 sm:h-4 md:h-5 text-white"/>
            </div>
            <span className="text-4xl text-slate-100">HelioGrid</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border ${getTempStatus(systemTemp).bg} ${systemTemp >= 60 ? 'border-red-500/40' : systemTemp >= 50 ? 'border-orange-500/40' : 'border-green-500/40'}`}>
              <Thermometer className={`w-4 h-5 sm:w-4 sm:h-5 ${getTempStatus(systemTemp).color}`}/>
              <span className={`text-2xl ${getTempStatus(systemTemp).color}`}>{systemTemp.toFixed(1)}°C</span>
            </div>
            <button onClick={() => navigateTo('theme')} className="p-1.5 sm:p-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 transition-all active:scale-100">
              <Palette className="w-5 h-5 sm:w-6 sm:h-6 text-purple-300"/>
            </button>
            <Wifi className="w-5 h-5 sm:w-6 sm:h-6 text-green-400"/>
            <div className="flex items-center gap-1 text-2xl">
              <Clock className="w-5 h-5 sm:w-5 sm:h-5"/>
              <span className="hidden sm:inline">{displayTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-2 gap-2 sm:gap-3 md:gap-4 py-3">
          {/* GRID — main: Voltage, subtitle: Hz + status */}
          <button onClick={() => navigateTo('grid')} className="bg-gradient-to-br from-blue-900/60 to-cyan-800/30 hover:from-blue-800/70 hover:to-cyan-700/40 backdrop-blur-sm rounded-lg border border-blue-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
            <div className="flex items-center gap-1 sm:gap-2 mb-2"><Zap className="w-7 h-7 sm:w-5 sm:h-5 text-blue-400 flex-shrink-0"/><span className="text-2xl text-blue-200">Grid Monitoring</span></div>
            <div className="flex-1 flex items-center justify-center"><div className="text-center">
              <div className={`text-7xl sm:text-5xl md:text-6xl leading-none mb-1 ${systemData.gridAnomaly === 'critical' ? 'text-red-400' : systemData.gridAnomaly === 'warning' ? 'text-yellow-400' : 'text-blue-400'}`}>{gridVoltage.toFixed(0)}V</div>
              <div className={`text-lg ${systemData.gridAnomaly === 'critical' ? 'text-red-400' : systemData.gridAnomaly === 'warning' ? 'text-yellow-400' : 'text-green-400'}`}>
                {systemData.gridAnomaly === 'critical'
                  ? `✗ ${systemData.gridVoltageAnomaly?.label ?? 'Critical'}`
                  : systemData.gridAnomaly === 'warning'
                  ? `⚠ ${systemData.gridVoltageAnomaly?.label ?? 'Warning'}`
                  : gridVoltage > 0 ? '✓ Normal' : '— No Power'}
              </div>
            </div></div>
          </button>
          {/* SOLAR — main: Power (W), subtitle: Array Voltage */}
          <button onClick={() => navigateTo('solar')} className="bg-gradient-to-br from-amber-900/60 to-yellow-800/30 hover:from-amber-800/70 hover:to-yellow-700/40 backdrop-blur-sm rounded-lg border border-yellow-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
            <div className="flex items-center gap-1 sm:gap-2 mb-2"><Sun className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400 flex-shrink-0"/><span className="text-2xl text-yellow-200">Solar Monitoring</span></div>
            <div className="flex-1 flex items-center justify-center"><div className="text-center">
              <div className={`text-7xl sm:text-5xl md:text-6xl leading-none mb-1 ${systemData.inverterAnomaly === 'critical' ? 'text-red-400' : systemData.inverterAnomaly === 'warning' ? 'text-yellow-300' : acVoltage > 0 ? 'text-blue-400' : 'text-slate-400'}`}>
                {acVoltage.toFixed(0)}V
              </div>
              <div className={`text-lg ${systemData.inverterAnomaly === 'critical' ? 'text-red-400' : systemData.inverterAnomaly === 'warning' ? 'text-yellow-300' : acVoltage > 0 ? 'text-green-400' : 'text-slate-400'}`}>
                {systemData.inverterAnomaly === 'critical' ? '✗ Critical' : systemData.inverterAnomaly === 'warning' ? '⚠ Warning' : acVoltage > 0 ? '✓ Stable' : '— No Data'}
              </div>
            </div></div>
          </button>
          {/* BATTERY — main: SOC %, subtitle: Pack Voltage */}
          <button onClick={() => navigateTo('battery')} className="bg-gradient-to-br from-green-900/60 to-emerald-800/30 hover:from-green-800/70 hover:to-emerald-700/40 backdrop-blur-sm rounded-lg border border-green-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
            <div className="flex items-center gap-1 sm:gap-2 mb-2"><Battery className="w-4 h-4 sm:w-5 sm:h-5 text-green-400 flex-shrink-0"/><span className="text-2xl text-green-200">Battery Health</span></div>
            <div className="flex-1 flex items-center justify-center"><div className="text-center">
              <div className={`text-7xl sm:text-5xl md:text-6xl leading-none mb-1 ${batteryAnomaly === 'critical' ? 'text-red-400' : batteryAnomaly === 'warning' ? 'text-yellow-400' : 'text-green-400'}`}>{batteryHealth.toFixed(0)}%</div>
              <div className={`text-lg ${batteryAnomaly === 'critical' ? 'text-red-400' : batteryAnomaly === 'warning' ? 'text-yellow-400' : 'text-green-400'}`}>
                {batteryAnomaly === 'critical' ? '✗ Critical' : batteryAnomaly === 'warning' ? '⚠ Low' : batteryVoltage > 0 ? '✓ ' + batteryStatus : '— No Data'}
              </div>
            </div></div>
          </button>
          {/* GRAPH — inline card with System Status-style anomaly grid */}
          <button onClick={() => navigateTo('graph')} className="bg-gradient-to-br from-purple-900/60 to-pink-800/30 hover:from-purple-800/70 hover:to-pink-700/40 backdrop-blur-sm rounded-lg border border-purple-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1 sm:gap-2"><Activity className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400 flex-shrink-0"/><span className="text-2xl text-purple-200">Real-time Graph</span></div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-purple-300/60">Anomalies (24h)</span>
                {(() => {
                  const lvl = systemData.anomalyLevel ?? 'none';
                  return <div className={`w-2.5 h-2.5 rounded-full ${lvl === 'critical' ? 'bg-red-500 animate-pulse' : lvl === 'warning' ? 'bg-yellow-400 animate-pulse' : 'bg-green-500'}`}/>;
                })()}
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-between gap-2 pt-1">
              {(() => {
                const allSources = [
                  { key: 'grid',    level: systemData.gridAnomaly     ?? 'none' },
                  { key: 'solar',   level: systemData.inverterAnomaly ?? 'none' },
                  { key: 'battery', level: batteryAnomaly },
                  { key: 'solardc', level: solarAnomaly },
                ];
                const normalCount   = allSources.filter(a => a.level === 'none').length;
                const warningCount  = allSources.filter(a => a.level === 'warning').length;
                const criticalCount = allSources.filter(a => a.level === 'critical').length;
                const dropoutCount  = (systemData.gridAnomaly === 'critical' && gridVoltage === 0) || bothDropped_kiosk ? 1 : 0;
                const spikeCount    = [gridVoltage > GRID_CRITICAL_HIGH, acVoltage > INV_CRITICAL_HIGH].filter(Boolean).length;
                const driftCount    = allSources.filter(a => a.level === 'warning').length;
                const anyAnomaly    = warningCount > 0 || criticalCount > 0;

                const Box = ({ count, label, numColor, activeBg, activeBorder }: { count: number; label: string; numColor: string; activeBg: string; activeBorder: string }) => (
                  <div style={{flex:1, borderRadius:'10px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'10px 4px', border: `1.5px solid ${count > 0 ? '' : 'rgba(100,116,139,0.35)'}`, background: count > 0 ? '' : 'rgba(15,23,42,0.55)'}}
                    className={count > 0 ? `${activeBg} ${activeBorder}` : ''}>
                    <div className={`text-4xl font-black leading-none tabular-nums ${count > 0 ? numColor : 'text-slate-500'}`}>{count}</div>
                    <div className={`text-xs font-semibold mt-1.5 tracking-wide ${count > 0 ? 'text-slate-200' : 'text-slate-500'}`}>{label}</div>
                  </div>
                );

                return (
                  <>
                    <div className="flex gap-2">
                      <Box count={normalCount}   label="Normal"   numColor="text-green-400"  activeBg="bg-green-950/70"  activeBorder="border border-green-500/60"/>
                      <Box count={warningCount}  label="Warning"  numColor="text-yellow-400" activeBg="bg-yellow-950/70" activeBorder="border border-yellow-500/60"/>
                      <Box count={criticalCount} label="Critical" numColor="text-red-400"    activeBg="bg-red-950/70"    activeBorder="border border-red-500/60"/>
                    </div>
                    <div className="flex gap-2">
                      <Box count={dropoutCount} label="Dropout" numColor="text-red-400"    activeBg="bg-red-950/70"    activeBorder="border border-red-500/60"/>
                      <Box count={spikeCount}   label="Spike"   numColor="text-orange-400" activeBg="bg-orange-950/70" activeBorder="border border-orange-500/60"/>
                      <Box count={driftCount}   label="Drift"   numColor="text-yellow-400" activeBg="bg-yellow-950/70" activeBorder="border border-yellow-500/60"/>
                    </div>
                    <div className={`text-center text-sm py-1.5 rounded-lg border font-medium ${anyAnomaly ? 'text-red-300 border-red-500/30 bg-red-950/30' : 'text-green-400/80 border-green-500/25 bg-green-950/20'}`}>
                      {anyAnomaly ? `${criticalCount + warningCount} anomaly${criticalCount + warningCount > 1 ? 's' : ''} detected` : 'No anomalies detected'}
                    </div>
                  </>
                );
              })()}
            </div>
          </button>
        </div>
        <button onClick={() => navigateTo('ssr')} className="mb-2 bg-gradient-to-br from-cyan-900/60 to-indigo-800/30 hover:from-cyan-800/70 hover:to-indigo-700/40 backdrop-blur-sm rounded-lg border border-cyan-700/40 p-3 flex items-center justify-between shadow-lg transition-all active:scale-95 cursor-pointer">
          <div className="flex items-center gap-2"><ArrowLeftRight className="w-7 h-7 text-cyan-400"/><span className="text-2xl text-cyan-200">Power & Load Control</span></div>
          <div className="text-lg text-cyan-300">Manage outlets →</div>
        </button>

        <div className="backdrop-blur-sm rounded-lg px-2 sm:px-3 py-1.5 flex items-center justify-between border border-blue-700/20">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
              controlAuthority === 'safety_override' ? 'bg-red-500 animate-pulse' :
              controlAuthority === 'manual'          ? 'bg-amber-400 animate-pulse' :
              systemData.anomalyLevel === 'critical' ? 'bg-red-500 animate-pulse' :
              systemData.anomalyLevel === 'warning'  ? 'bg-yellow-400 animate-pulse' :
              SSR4_Closed                            ? 'bg-green-500 animate-pulse' :
                                                      'bg-red-500'
            }`}/>
            <span className={`text-lg ${
              controlAuthority === 'safety_override' ? 'text-red-300' :
              controlAuthority === 'manual'          ? 'text-amber-300' :
              systemData.anomalyLevel === 'critical' ? 'text-red-300' :
              systemData.anomalyLevel === 'warning'  ? 'text-yellow-300' :
              SSR4_Closed                            ? 'text-green-300' :
                                                      'text-red-300'
            }`}>{systemCondition}</span>
          </div>
          <div className={`absolute left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-xs border ${getAuthorityBadge().cls}`}>{getAuthorityBadge().text}</div>
          <div className="text-lg text-blue-400">v2.1.4</div>
        </div>
      </div>
    );
  };
  // ============================================================================
  // GRID DETAIL
  // ============================================================================
  const renderGridDetail = () => {
    const hasGridData = gridVoltage > 0;
    const gridAnom    = systemData.gridAnomaly ?? 'none';
    const gVoltStatus = !hasGridData ? 'No Data' : gridAnom === 'critical' ? 'Critical' : gridAnom === 'warning' ? 'Warning' : gridStatus;
    const gCurrStatus = !hasGridData ? 'No Data' : gridCurrent <= 5 ? 'Normal' : 'High';
    const gFreqStatus = !hasGridData ? 'No Data' : gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'Stable' : 'Unstable';
    const vBarPct  = hasGridData ? Math.max(2, Math.min(100, (gridVoltage  / 250)  * 100)) : 0;  // min 2% so bar visible
    const cBarPct  = hasGridData && gridCurrent > 0 ? Math.max(2, Math.min(100, (gridCurrent / 10) * 100)) : 0;
    const gPBarPct = hasGridData && gridPowerW  > 0 ? Math.max(2, Math.min(100, (gridPowerW  / 2500) * 100)) : 0;

    return (
      <div className="relative h-full p-3 sm:p-4 flex flex-col text-white overflow-hidden">
        <div className="relative flex items-center justify-between pb-3 border-b border-blue-600/60 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-blue-300 hover:text-blue-200 transition-colors">
            <ChevronLeft className="w-7 h-7"/><span className="text-3xl">Back</span>
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Zap className="w-8 h-8 text-blue-400"/>
            <span className="text-3xl">Grid Monitoring</span>
          </div>
          <div className={`w-3 h-3 rounded-full ${!hasGridData ? 'bg-slate-400' : gridAnom === 'none' ? 'bg-green-500 animate-pulse' : gridAnom === 'warning' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500 animate-pulse'}`}/>
        </div>
        <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 pt-3 min-h-0">
          <div style={{ border: `2px solid ${!hasGridData ? '#475569' : gridAnom === 'none' ? '#60a5fa' : gridAnom === 'warning' ? '#facc15' : '#f87171'}`, boxShadow: `0 0 12px ${!hasGridData ? 'rgba(71,85,105,0.3)' : gridAnom === 'none' ? 'rgba(96,165,250,0.4)' : 'rgba(248,113,113,0.4)'}` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Zap className={`w-6 h-6 ${!hasGridData ? 'text-slate-500' : gridAnom === 'none' ? 'text-blue-400' : gridAnom === 'warning' ? 'text-yellow-400' : 'text-red-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>Voltage</span></div>
              <span className={`text-2xl font-semibold ${!hasGridData ? 'text-slate-400' : gridAnom === 'none' ? 'text-green-400' : gridAnom === 'warning' ? 'text-yellow-400' : 'text-red-400'}`}>{gVoltStatus}</span>
            </div>
            <div className="flex items-end gap-2">
              <span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasGridData ? 'text-slate-500' : gridAnom === 'none' ? 'text-blue-400' : gridAnom === 'warning' ? 'text-yellow-400' : 'text-red-400'}`}>{gridVoltage.toFixed(1)}</span>
              <span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasGridData ? 'text-slate-500' : 'text-blue-300'}`}>V</span>
              {hasGridData && (gridVoltage > 230 ? <TrendingUp className="w-6 h-6 text-green-400 ml-auto mb-1"/> : gridVoltage < 230 ? <TrendingDown className="w-6 h-6 text-red-400 ml-auto mb-1"/> : null)}
            </div>
            <div>
              <div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all duration-700`} style={{ width: `${vBarPct}%`, background: !hasGridData ? '#475569' : gridAnom === 'none' ? 'linear-gradient(to right,#1d4ed8,#60a5fa)' : gridAnom === 'warning' ? 'linear-gradient(to right,#a16207,#facc15)' : 'linear-gradient(to right,#b91c1c,#f87171)' }}/></div>
              <div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0V</span><span>200V</span><span>250V max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Nom. Range</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-blue-300">200 – 240V</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasGridData ? '#475569' : '#c084fc'}`, boxShadow: `0 0 12px ${!hasGridData ? 'rgba(71,85,105,0.3)' : 'rgba(192,132,252,0.4)'}` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Activity className={`w-6 h-6 ${!hasGridData ? 'text-slate-500' : 'text-purple-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>Current</span></div>
              <span className={`text-2xl font-semibold ${!hasGridData ? 'text-slate-400' : gridCurrent <= 5 ? 'text-green-400' : 'text-yellow-400'}`}>{gCurrStatus}</span>
            </div>
            <div className="flex items-end gap-2">
              <span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasGridData ? 'text-slate-500' : 'text-purple-400'}`}>{gridCurrent.toFixed(2)}</span>
              <span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasGridData ? 'text-slate-500' : 'text-purple-300'}`}>A</span>
            </div>
            <div>
              <div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all duration-700`} style={{ width: `${cBarPct}%`, background: !hasGridData ? '#475569' : gridCurrent <= 5 ? 'linear-gradient(to right,#6b21a8,#c084fc)' : 'linear-gradient(to right,#a16207,#facc15)' }}/></div>
              <div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0A</span><span>5A</span><span>10A max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Max Load</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-purple-300">10A</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasGridData ? '#475569' : gridFrequency >= 59.5 && gridFrequency <= 60.5 ? '#818cf8' : '#facc15'}`, boxShadow: `0 0 12px rgba(129,140,248,0.4)` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Activity className={`w-6 h-6 ${!hasGridData ? 'text-slate-500' : 'text-indigo-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>Frequency</span></div>
              <span className={`text-2xl font-semibold ${!hasGridData ? 'text-slate-400' : gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'text-green-400' : 'text-yellow-400'}`}>{gFreqStatus}</span>
            </div>
            <div className="flex items-end gap-2">
              <span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasGridData ? 'text-slate-500' : 'text-indigo-400'}`}>{gridFrequency.toFixed(1)}</span>
              <span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasGridData ? 'text-slate-500' : 'text-indigo-300'}`}>Hz</span>
            </div>
            <div>
              <div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all duration-700`} style={{ width: `${Math.min(100, ((gridFrequency - 55) / 10) * 100)}%`, background: !hasGridData ? '#475569' : gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'linear-gradient(to right,#3730a3,#818cf8)' : 'linear-gradient(to right,#a16207,#facc15)' }}/></div>
              <div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>55Hz</span><span>60Hz</span><span>65Hz max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Nom. Freq</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-indigo-300">60 Hz</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasGridData ? '#475569' : '#22d3ee'}`, boxShadow: `0 0 12px rgba(34,211,238,0.4)` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Zap className={`w-6 h-6 ${!hasGridData ? 'text-slate-500' : 'text-cyan-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>Power Draw</span></div>
              <span className={`text-2xl font-semibold ${!hasGridData ? 'text-slate-400' : gridPowerW > 0 ? 'text-green-400' : 'text-slate-400'}`}>{!hasGridData ? 'No Data' : gridPowerW > 0 ? 'Active' : 'Idle'}</span>
            </div>
            <div className="flex items-end gap-2">
              <span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasGridData ? 'text-slate-500' : 'text-white'}`}>{gridPower}</span>
              <span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasGridData ? 'text-slate-500' : 'text-cyan-300'}`}>W</span>
            </div>
            <div>
              <div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all duration-700`} style={{ width: `${gPBarPct}%`, background: !hasGridData ? '#475569' : 'linear-gradient(to right,#0e7490,#22d3ee)' }}/></div>
              <div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0W</span><span>1250W</span><span>~2500W max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">PZEM-004T</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-cyan-300">{(gridPowerW / 1000).toFixed(3)} kW</span></div>
          </div>
        </div>
        <div className="text-lg text-slate-500 text-center pt-2 mt-1 border-t border-slate-700/40 flex-shrink-0">📡 PZEM-004T Sensor</div>
      </div>
    );
  };
// ============================================================================
// SOLAR DETAIL — MAX KIOSK SIZE for 7" LCD
// Font scale: labels 1.5rem · units 1.8rem · values 3.4–4rem · titles 2rem
// ============================================================================
  const renderSolarDetail = () => {
    const hasSolarData    = solarVoltage > 0 || solarCurrent > 0 || Number(systemData.solarPower ?? 0) > 0;
    const hasInverterData = acVoltage > 0 || acCurrent > 0;
    const solarAnom  = systemData.solarAnomaly   ?? 'none';
    const invAnom    = systemData.inverterAnomaly ?? 'none';
    const _rawAcP    = Number(systemData.inverterPower ?? 0);
    const acPowerNum: number = _rawAcP > 0 ? _rawAcP : (acVoltage > 0 && acCurrent > 0) ? parseFloat((acVoltage * acCurrent).toFixed(2)) : 0;
    const acStatusTxt = !hasInverterData ? 'No Data' : invAnom === 'critical' ? 'Critical' : invAnom === 'warning' ? 'Warning' : acPowerNum > 0 ? 'Active' : 'Idle';
    const pvVBarPct  = hasSolarData    ? Math.max(2, Math.min(100, (solarVoltage  / 104.74) * 100)) : 0;
    const invVBarPct = hasInverterData ? Math.max(2, Math.min(100, (acVoltage     / 231)    * 100)) : 0;
    const invIBarPct = hasInverterData ? Math.max(2, Math.min(100, (acCurrent     / 13.8)   * 100)) : 0;
    const pvVoltStatus = !hasSolarData ? 'No Data' : solarAnom === 'critical' ? 'Critical' : solarAnom === 'warning' ? 'Warning' : solarVoltage < 20 ? 'Low' : solarVoltage < 53 ? 'Fair' : 'Normal';
    const invVoltStatus = !hasInverterData ? 'No Data' : invAnom === 'critical' ? 'Critical' : invAnom === 'warning' ? 'Warning' : 'Stable';
    const invFreqStatus = !hasInverterData ? 'No Data' : inverterFrequency >= 59.5 && inverterFrequency <= 60.5 ? 'Stable' : 'Unstable';
    return (
      <div className="relative h-full p-3 sm:p-4 flex flex-col text-white overflow-hidden">
        <div className="relative flex items-center justify-between pb-3 border-b border-yellow-600/60 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-yellow-300 hover:text-yellow-200 transition-colors">
            <ChevronLeft className="w-7 h-7"/><span className="text-3xl">Back</span>
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Sun className="w-8 h-8 text-yellow-400"/>
            <span className="text-3xl">Solar Monitoring</span>
          </div>
          <div className={`w-3 h-3 rounded-full ${!hasSolarData && !hasInverterData ? 'bg-slate-400' : solarAnom === 'none' && invAnom === 'none' ? 'bg-green-500 animate-pulse' : (solarAnom === 'critical' || invAnom === 'critical') ? 'bg-red-500 animate-pulse' : 'bg-yellow-500 animate-pulse'}`}/>
        </div>
        <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 pt-3 min-h-0">
          <div style={{ border: `2px solid ${!hasSolarData ? '#475569' : solarAnom === 'none' ? '#fbbf24' : solarAnom === 'warning' ? '#facc15' : '#f87171'}`, boxShadow: `0 0 12px ${!hasSolarData ? 'rgba(71,85,105,0.3)' : 'rgba(251,191,36,0.4)'}` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Sun className={`w-6 h-6 ${!hasSolarData ? 'text-slate-500' : 'text-amber-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>PV Voltage</span></div><span className={`text-2xl font-semibold ${!hasSolarData ? 'text-slate-400' : solarAnom === 'none' ? 'text-green-400' : solarAnom === 'warning' ? 'text-yellow-400' : 'text-red-400'}`}>{pvVoltStatus}</span></div>
            <div className="flex items-end gap-2"><span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasSolarData ? 'text-slate-500' : 'text-amber-400'}`}>{solarVoltage.toFixed(1)}</span><span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasSolarData ? 'text-slate-500' : 'text-amber-300'}`}>V</span></div>
            <div><div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${pvVBarPct}%`, background: !hasSolarData ? '#475569' : 'linear-gradient(to right,#d97706,#fbbf24)' }}/></div><div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0V</span><span>52V</span><span>104.7V Voc</span></div></div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Vmp Target</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-amber-300">88.9V (2S)</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasInverterData ? '#475569' : invAnom === 'none' ? '#60a5fa' : invAnom === 'warning' ? '#facc15' : '#f87171'}`, boxShadow: `0 0 12px ${!hasInverterData ? 'rgba(71,85,105,0.3)' : 'rgba(96,165,250,0.4)'}` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Zap className={`w-6 h-6 ${!hasInverterData ? 'text-slate-500' : 'text-blue-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>INV Voltage</span></div><span className={`text-2xl font-semibold ${!hasInverterData ? 'text-slate-400' : invAnom === 'none' ? 'text-green-400' : invAnom === 'warning' ? 'text-yellow-400' : 'text-red-400'}`}>{invVoltStatus}</span></div>
            <div className="flex items-end gap-2"><span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasInverterData ? 'text-slate-500' : 'text-blue-400'}`}>{acVoltage.toFixed(1)}</span><span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasInverterData ? 'text-slate-500' : 'text-blue-300'}`}>V</span>{hasInverterData && (acVoltage > 220 ? <TrendingUp className="w-6 h-6 text-green-400 ml-auto mb-1"/> : acVoltage < 209 ? <TrendingDown className="w-6 h-6 text-red-400 ml-auto mb-1"/> : null)}</div>
            <div><div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${invVBarPct}%`, background: !hasInverterData ? '#475569' : 'linear-gradient(to right,#1d4ed8,#60a5fa)' }}/></div><div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0V</span><span>115V</span><span>231V max</span></div></div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Nom. Range</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-blue-300">209 – 231V</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasInverterData ? '#475569' : '#22d3ee'}`, boxShadow: `0 0 12px rgba(34,211,238,0.4)` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Zap className={`w-6 h-6 ${!hasInverterData ? 'text-slate-500' : 'text-cyan-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>AC Power</span></div><span className={`text-2xl font-semibold ${!hasInverterData ? 'text-slate-400' : 'text-green-400'}`}>{acStatusTxt}</span></div>
            <div className="flex items-end gap-2"><span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasInverterData ? 'text-slate-500' : 'text-cyan-400'}`}>{acPowerNum >= 1000 ? (acPowerNum/1000).toFixed(2) : acPowerNum.toFixed(0)}</span><span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasInverterData ? 'text-slate-500' : 'text-cyan-300'}`}>{acPowerNum >= 1000 ? 'kW' : 'W'}</span></div>
            <div><div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${hasInverterData && acPowerNum > 0 ? Math.max(2, Math.min((acPowerNum/3000)*100,100)) : 0}%`, background: !hasInverterData || acPowerNum === 0 ? 'rgba(71,85,105,0.6)' : 'linear-gradient(to right,#0e7490,#22d3ee)' }}/></div><div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0W</span><span>1500W</span><span>3000W max</span></div></div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">PZEM-004T</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-cyan-300">{(acPowerNum/1000).toFixed(3)} kW</span></div>
          </div>
          <div style={{ border: `2px solid ${!hasInverterData ? '#475569' : '#818cf8'}`, boxShadow: `0 0 12px rgba(129,140,248,0.4)` }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Activity className={`w-6 h-6 ${!hasInverterData ? 'text-slate-500' : 'text-indigo-400'}`}/><span style={{fontSize:'1.9rem',fontWeight:700}}>INV Current</span></div><span className={`text-2xl font-semibold ${!hasInverterData ? 'text-slate-400' : acCurrent <= 10 ? 'text-green-400' : 'text-yellow-400'}`}>{!hasInverterData ? 'No Data' : acCurrent <= 10 ? 'Normal' : 'High'}</span></div>
            <div className="flex items-end gap-2"><span style={{fontSize:'4.5rem',lineHeight:1,fontWeight:700}} className={`${!hasInverterData ? 'text-slate-500' : 'text-indigo-400'}`}>{acCurrent.toFixed(2)}</span><span style={{fontSize:'2.2rem',marginBottom:'0.4rem',fontWeight:600}} className={`${!hasInverterData ? 'text-slate-500' : 'text-indigo-300'}`}>A</span></div>
            <div><div className="h-5 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${invIBarPct}%`, background: !hasInverterData ? '#475569' : 'linear-gradient(to right,#3730a3,#818cf8)' }}/></div><div className="flex justify-between text-slate-500" style={{fontSize:'1.3rem'}}><span>0A</span><span>6.9A</span><span>13.8A max</span></div></div>
            <div className="flex items-center justify-between border-t border-slate-700/40 pt-2"><span className="text-2xl text-slate-400 font-medium">Rated Max</span><span style={{fontSize:'1.5rem',fontWeight:700}} className="text-indigo-300">13.8A</span></div>
          </div>
        </div>
        <div style={{ border: `2px solid ${!hasInverterData ? '#475569' : inverterFrequency >= 59.5 && inverterFrequency <= 60.5 ? '#818cf8' : '#facc15'}` }} className="rounded-xl bg-slate-800/70 px-4 py-2 mt-3 flex-shrink-0 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><Activity className={`w-5 h-5 ${!hasInverterData ? 'text-slate-500' : 'text-indigo-400'}`}/><span style={{fontSize:'1.6rem',fontWeight:700}}>Frequency</span></div>
          <div className="flex items-end gap-1"><span style={{fontSize:'2.8rem',lineHeight:1,fontWeight:700}} className={`${!hasInverterData ? 'text-slate-500' : 'text-indigo-400'}`}>{hasInverterData ? inverterFrequency.toFixed(1) : '0.0'}</span><span style={{fontSize:'1.6rem',marginBottom:'0.2rem',fontWeight:600}} className={`${!hasInverterData ? 'text-slate-500' : 'text-indigo-300'}`}>Hz</span></div>
          <div className="flex-1 flex flex-col gap-1"><div className="h-4 bg-slate-700 rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100,((inverterFrequency-55)/10)*100)}%`, background: !hasInverterData ? '#475569' : inverterFrequency >= 59.5 && inverterFrequency <= 60.5 ? 'linear-gradient(to right,#3730a3,#818cf8)' : 'linear-gradient(to right,#a16207,#facc15)' }}/></div><div className="flex justify-between text-slate-500" style={{fontSize:'1.1rem'}}><span>55Hz</span><span>60Hz</span><span>65Hz</span></div></div>
          <span className={`text-2xl font-semibold ${!hasInverterData ? 'text-slate-400' : inverterFrequency >= 59.5 && inverterFrequency <= 60.5 ? 'text-green-400' : 'text-yellow-400'}`}>{invFreqStatus}</span>
        </div>
        <div className="text-lg text-slate-500 text-center pt-2 mt-2 border-t border-slate-700/40 flex-shrink-0">📡 Resistor Divider (PV DC) · PZEM-004T (AC Inverter) · TG-30224M60 3kW</div>
      </div>
    );
  };
// renderBatteryDetail() — scroll fix applied
// REPLACE the entire renderBatteryDetail() in your KioskLCD.tsx with this
// ============================================================================
  const renderBatteryDetail = () => {
    const batteryBank2Voltage   = (systemData as any).batteryBank2Voltage   ?? 0;
    const batteryBankBAvailable = (systemData as any).batteryBankBAvailable ?? false;
    const batteryCapacityAh     = (systemData as any).batteryCapacityAh     ?? 100;
    const batteryAnomalyDetails = (systemData as any).batteryAnomalyDetails ?? [] as string[];

    const is200Ah       = batteryBankBAvailable;
    const capacityLabel = is200Ah ? '200Ah' : '100Ah';
    const bankLabel     = is200Ah ? 'Dual' : 'Single';
    const pzemCount     = is200Ah ? '2' : '1';
    const cellCount     = is200Ah ? '4× 12V' : '2× 12V';

    // INA219 dual: 0x41=B1, 0x44=B2 — each measures its own 12V cell directly
    const b1v = (systemData as any).battery1Voltage ?? 0;
    const b1i = (systemData as any).battery1Current ?? 0;
    const b2v = (systemData as any).battery2Voltage ?? 0;
    const b2i = (systemData as any).battery2Current ?? 0;
    const b1_ok = b1v > 2.0;
    const b2_ok = b2v > 2.0;

    // 12V Lead Acid SOC lookup per cell
    const calcCellSOC = (v: number): number => {
      if (v >= 12.7) return 100; if (v >= 12.5) return 90; if (v >= 12.3) return 80;
      if (v >= 12.1) return 70;  if (v >= 12.0) return 60; if (v >= 11.9) return 50;
      if (v >= 11.8) return 40;  if (v >= 11.6) return 30; if (v >= 11.5) return 20;
      if (v >= 11.0) return 10;  return 0;
    };

    const hasBattData = b1_ok || b2_ok || batteryVoltage > 0 || Math.abs(batteryCurrent) > 0;
    // Charging: solar active + terminal voltage above float threshold
    const isChargingDetail = Number(systemData.solarPower ?? 0) > 5 && batteryVoltage >= 27.0;
    const isCharging  = isChargingDetail || systemData.batteryCurrent > 0;
    const packSOC     = batteryHealth;
    const batPower    = (batteryVoltage * Math.abs(batteryCurrent)).toFixed(1);
    // Pack voltage = SERIES SUM (24V system: B1+B2)
    const packVoltageDisplay = (b1_ok || b2_ok)
      ? (b1_ok && b2_ok ? b1v + b2v : b1_ok ? b1v : b2v)
      : batteryVoltage;
    // Voltage bar: resting range 22.5V (0%) → 25.6V (100%)
    const voltPct     = !hasBattData ? 0
      : isChargingDetail ? 100  // clamp bar to full while charging (avoid misleading scale)
      : Math.max(0, Math.min(100, ((packVoltageDisplay - 22.5) / (25.6 - 22.5)) * 100));
    const b1SOCPct    = calcCellSOC(b1v);
    const b2SOCPct    = calcCellSOC(b2v);
    const batCurrentMax = is200Ah ? 200 : 100;
    const currPct     = Math.max(0, Math.min(100, (Math.abs(batteryCurrent) / batCurrentMax) * 100));

    // 24V series pack SOC lookup — resting OCV (JSL II Gel)
    // These thresholds match BatteryHealthCard v8.0 SOC_TABLE
    const calcPackSOC24 = (v: number): number => {
      if (v >= 25.60) return 100; if (v >= 25.40) return 98; if (v >= 25.20) return 95;
      if (v >= 25.00) return 90;  if (v >= 24.80) return 84; if (v >= 24.60) return 78;
      if (v >= 24.50) return 72;  if (v >= 24.30) return 62; if (v >= 24.10) return 50;
      if (v >= 24.00) return 43;  if (v >= 23.80) return 33; if (v >= 23.60) return 23;
      if (v >= 23.40) return 14;  if (v >= 23.20) return 7;  if (v >= 23.00) return 2;
      return 0;
    };

    // Compute pack SOC from 24V series resting voltage.
    // If charging, clamp lookup voltage to 25.6V (resting max) to avoid false 100%.
    const packVoltLookup = isChargingDetail ? Math.min(packVoltageDisplay, 25.6) : packVoltageDisplay;
    const computedPackSOC = (b1_ok || b2_ok)
      ? calcPackSOC24(packVoltLookup)
      : packSOC;

    const ringColor = !hasBattData ? '#475569'
      : computedPackSOC >= 80 ? '#34d399'
      : computedPackSOC >= 50 ? '#facc15'
      : computedPackSOC >= 20 ? '#fb923c'
      : '#f87171';
    const ringGlow = !hasBattData ? 'rgba(71,85,105,0.3)'
      : computedPackSOC >= 80 ? 'rgba(52,211,153,0.45)'
      : computedPackSOC >= 50 ? 'rgba(250,204,21,0.45)'
      : computedPackSOC >= 20 ? 'rgba(251,146,60,0.45)'
      : 'rgba(248,113,113,0.45)';
    const socTextClass = !hasBattData ? 'text-slate-400'
      : computedPackSOC >= 80 ? 'text-emerald-400'
      : computedPackSOC >= 50 ? 'text-yellow-400'
      : computedPackSOC >= 20 ? 'text-orange-400'
      : 'text-red-400';
    const socStatus = !hasBattData ? 'No Data'
      : computedPackSOC >= 80 ? 'Excellent'
      : computedPackSOC >= 50 ? 'Good'
      : computedPackSOC >= 20 ? 'Fair'
      : 'Critical';
    const voltStatus = !hasBattData ? 'No Data'
      : isChargingDetail ? 'Charging'
      : packVoltageDisplay >= 25.0 ? 'Normal'
      : packVoltageDisplay >= 23.8 ? 'Fair'
      : 'Low';
    const currStatus = !hasBattData ? 'No Data' : isCharging ? 'Charging' : 'Discharging';

    const VW = 240, VH = 420;
    const NW = 80, NH = 20, NR = 10;
    const BW = 220, BH = 370, BR = 26;
    const bx = (VW - BW) / 2, by = NH + 2;
    const nx = (VW - NW) / 2, ny = 0;
    const PAD = 12;
    const fillMaxH = BH - PAD * 2;
    const fillH    = Math.max(0, (computedPackSOC / 100) * fillMaxH);
    const fillY    = by + PAD + (fillMaxH - fillH);
    const fillX    = bx + PAD;
    const fillW    = BW - PAD * 2;
    const segments = [20, 40, 60, 80].map(pct => ({
      y: by + PAD + fillMaxH * (1 - pct / 100),
      active: computedPackSOC >= pct,
    }));

    const bankASOC = computedPackSOC;
    const bankBSOC = is200Ah ? (() => {
      const bv = batteryBank2Voltage;
      if (bv >= 25.4) return 100;
      if (bv >= 24.8) return 90;
      if (bv >= 24.6) return 80;
      if (bv >= 24.2) return 70;
      if (bv >= 24.0) return 60;
      if (bv >= 23.8) return 50;
      if (bv >= 23.6) return 40;
      if (bv >= 23.2) return 30;
      if (bv >= 23.0) return 20;
      if (bv >= 22.0) return 10;
      if (bv >= 21.6) return 5;
      return 0;
    })() : 0;

    type CellDef = { label: string; name: string; voltage: number; current: number; soc: number; online: boolean; };
    const cellDefs: CellDef[] = [
      { label: 'B1', name: 'Battery 1 (0x41)', voltage: b1v, current: b1i, soc: b1SOCPct, online: b1_ok },
      { label: 'B2', name: 'Battery 2 (0x44)', voltage: b2v, current: b2i, soc: b2SOCPct, online: b2_ok },
    ];

    // 12V Lead Acid thresholds (single cell, INA219)
    const getCellBorder = (soc: number, online: boolean) =>
      !online ? '#334155' : soc >= 80 ? '#34d399' : soc >= 50 ? '#facc15' : soc >= 20 ? '#fb923c' : '#f87171';
    const getCellStatusColor = (soc: number, online: boolean) =>
      !online ? 'text-slate-600' : soc >= 80 ? 'text-emerald-400' : soc >= 50 ? 'text-yellow-400' : soc >= 20 ? 'text-orange-400' : 'text-red-400';
    const getCellStatus = (soc: number, online: boolean) =>
      !online ? 'Offline' : soc >= 80 ? 'Excellent' : soc >= 50 ? 'Good' : soc >= 20 ? 'Fair' : 'Critical';

    return (
      <div className="relative h-full p-3 sm:p-4 flex flex-col text-white overflow-hidden">

        {/* Header */}
        <div className="relative flex items-center justify-between pb-3 border-b border-green-600/60 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-green-300 hover:text-green-200 transition-colors">
            <ChevronLeft className="w-7 h-7" /><span className="text-3xl">Back</span>
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Battery className="w-7 h-7 text-green-400" />
            <span className="text-3xl">Battery Health · {capacityLabel}</span>
          </div>
          <div className={`w-3 h-3 rounded-full ${
            batteryAnomaly === 'critical' ? 'bg-red-500 animate-pulse'
            : batteryAnomaly === 'warning' ? 'bg-yellow-400 animate-pulse'
            : !hasBattData ? 'bg-slate-400'
            : isCharging ? 'bg-green-500 animate-pulse'
            : 'bg-blue-500 animate-pulse'
          }`} />
        </div>

        {/* K3 banner */}
        {k3Active && (
          <div className="mt-2 flex-shrink-0 px-3 py-1.5 rounded-lg bg-teal-900/40 border border-teal-600/50 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
            <span className="text-base text-teal-300">
              K3 GRID ASSIST ACTIVE — {k3ModeLabel} ({batteryVoltage.toFixed(1)}V · switched {lastSwitchTime})
            </span>
          </div>
        )}

        {/* Anomaly banner */}
        {batteryAnomalyDetails.length > 0 && (
          <div className="mt-2 flex-shrink-0 px-3 py-1.5 rounded-lg bg-red-900/40 border border-red-600/50">
            <div className="text-xs font-semibold text-red-400 mb-1">⚠ Battery Anomalies</div>
            {batteryAnomalyDetails.map((msg: string, i: number) => (
              <div key={i} className="text-xs text-red-300">{msg}</div>
            ))}
          </div>
        )}

        {/* Two-column layout */}
        <div className="flex-1 flex gap-3 pt-3 min-h-0">

          {/* LEFT: Battery SVG */}
          <div
            className="flex-1 rounded-xl bg-slate-800/70 p-2 flex flex-col"
            style={{ border: `2px solid ${ringColor}`, boxShadow: `0 0 18px ${ringGlow}` }}
          >
            <div className="flex items-center justify-between flex-shrink-0 px-1 pt-1 pb-0">
              <div className="flex items-center gap-1.5">
                <Battery className={`w-5 h-5 ${socTextClass}`} />
                <span className="text-2xl text-slate-300 font-semibold">Pack SOC</span>
              </div>
              <span className={`text-lg font-semibold ${socTextClass}`}>{socStatus}</span>
            </div>

            <div className="flex-1 flex items-stretch min-h-0 w-full">
              <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet"
                style={{ width: '100%', height: '100%', overflow: 'visible', display: 'block' }}>
                <defs>
                  <clipPath id="battBodyClip">
                    <rect x={bx} y={by} width={BW} height={BH} rx={BR} ry={BR} />
                  </clipPath>
                  <linearGradient id="liquidGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ringColor} stopOpacity="1" />
                    <stop offset="100%" stopColor={ringColor} stopOpacity="0.55" />
                  </linearGradient>
                  <filter id="battGlow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                <rect x={nx} y={ny} width={NW} height={NH + BR / 2} rx={NR} ry={NR} fill="#1e293b" stroke={ringColor} strokeWidth="2" />
                <rect x={bx} y={by} width={BW} height={BH} rx={BR} ry={BR} fill="#0f172a" stroke={ringColor} strokeWidth="3" filter="url(#battGlow)" />
                {computedPackSOC > 0 && (
                  <rect x={fillX} y={fillY} width={fillW} height={Math.max(1, fillH)}
                    rx={Math.min(12, BR - 4)} ry={Math.min(12, BR - 4)}
                    fill="url(#liquidGrad)" clipPath="url(#battBodyClip)"
                    style={{ transition: 'y 1s cubic-bezier(0.4,0,0.2,1), height 1s cubic-bezier(0.4,0,0.2,1)' }}
                  />
                )}
                {/* segments removed — clean look */}
                {isCharging && hasBattData && (
                  <text x={VW / 2} y={by + BH * 0.50 + 14} textAnchor="middle" fontSize="80" fill="rgba(255,255,255,0.20)">⚡</text>
                )}
                <text x={VW / 2} y={by + BH * 0.36} textAnchor="middle" dominantBaseline="middle"
                  fontSize="64" fontWeight="bold" fill={hasBattData ? 'white' : '#475569'}
                >{computedPackSOC.toFixed(0)}%</text>
                <text x={VW / 2} y={by + BH * 0.36 + 64} textAnchor="middle" fontSize="24"
                  fill={hasBattData ? 'rgba(255,255,255,0.55)' : '#334155'}>{socStatus}</text>
                <text x={VW / 2} y={by + BH * 0.36 + 96} textAnchor="middle" fontSize="20"
                  fill={!hasBattData ? '#334155' : isCharging ? '#34d399' : '#93c5fd'}
                >{!hasBattData ? '— No Data' : isCharging ? '▲ Charging' : '▼ Discharging'}</text>
                <text x={VW / 2} y={by + BH - 52} textAnchor="middle" fontSize="18" fill="rgba(255,255,255,0.35)">Pack Power</text>
                <text x={VW / 2} y={by + BH - 20} textAnchor="middle" fontSize="38" fontWeight="bold"
                  fill={!hasBattData ? '#475569' : isCharging ? '#34d399' : '#60a5fa'}
                >{batPower} W</text>
              </svg>
            </div>

            <div className="flex-shrink-0 flex justify-center pt-1 border-t border-green-700/30">
              <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${
                'bg-green-900/60 text-green-400 border-green-700/50'
              }`}>
              📡 INA219 × 2 · 24V {capacityLabel} ({cellCount} Lead Acid {bankLabel})
              </span>
            </div>
          </div>

          {/* RIGHT: Total Pack */}
          <div className="flex-1 rounded-xl bg-slate-800/70 flex flex-col min-h-0" style={{ border: `2px solid ${!hasBattData ? '#475569' : ringColor}`, boxShadow: `0 0 12px ${!hasBattData ? 'rgba(71,85,105,0.3)' : ringGlow}` }}>
            <div className="flex items-center justify-between px-4 pt-3 pb-2 flex-shrink-0 border-b border-green-700/30">
              <div className="flex items-center gap-2"><Battery className={`w-6 h-6 ${socTextClass}`} /><span className="text-2xl text-slate-200 font-semibold">Total Pack</span></div>
              <span className={`text-xl font-semibold ${socTextClass}`}>{socStatus}</span>
            </div>
            <div className="px-4 pt-3 pb-2 flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xl text-slate-400">Pack Voltage <span className="text-lg text-slate-500">(JSL II 24V {capacityLabel})</span></span>
                <span className={`text-xl font-semibold ${!hasBattData ? 'text-slate-400' : isChargingDetail ? 'text-green-400' : packVoltageDisplay >= 25.0 ? 'text-green-400' : packVoltageDisplay >= 23.8 ? 'text-yellow-400' : 'text-red-400'}`}>{voltStatus}</span>
              </div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`font-bold leading-none ${!hasBattData ? 'text-slate-500' : socTextClass}`} style={{ fontSize: '4.5rem' }}>{packVoltageDisplay.toFixed(2)}</span>
                <span className={`font-semibold ${!hasBattData ? 'text-slate-500' : 'text-slate-300'}`} style={{ fontSize: '2rem', marginBottom: '0.4rem' }}>V · {capacityLabel}</span>
              </div>
              <div className="h-4 bg-slate-700 rounded-full overflow-hidden mb-1">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${voltPct}%`, background: !hasBattData ? '#334155' : packVoltageDisplay >= 24.6 ? 'linear-gradient(90deg,#065f46,#34d399)' : packVoltageDisplay >= 23.0 ? 'linear-gradient(90deg,#78350f,#fbbf24)' : 'linear-gradient(90deg,#7f1d1d,#f87171)' }} />
              </div>
              <div className="flex justify-between text-slate-500" style={{ fontSize: '1.2rem' }}><span>22.5V (0%)</span><span>24.0V (≈43%)</span><span>25.6V (100%)</span></div>
            </div>
            <div className="px-4 py-2 flex-shrink-0 border-t border-green-700/30">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xl text-slate-400">SOC Trend</span>
                <span className="text-lg text-slate-500">{hasBattData ? '— Stable' : '— No Data'}</span>
              </div>
              <div className="flex items-end gap-1 h-12">
                {[0.6,0.7,0.75,0.8,0.88,computedPackSOC/100].map((v,i) => (
                  <div key={i} className="flex-1 rounded-sm transition-all duration-700" style={{ height: `${Math.max(8,v*100)}%`, background: !hasBattData ? '#334155' : v >= 0.8 ? 'linear-gradient(to top,#065f46,#34d399)' : v >= 0.5 ? 'linear-gradient(to top,#78350f,#fbbf24)' : 'linear-gradient(to top,#7f1d1d,#f87171)', opacity: 0.5 + i * 0.1 }} />
                ))}
              </div>
              <div className="flex justify-between text-slate-600 mt-1" style={{ fontSize: '1.1rem' }}><span>-5</span><span>-4</span><span>-3</span><span>-2</span><span>-1</span><span>now</span></div>
            </div>
            <div className="px-4 py-2 flex-1 flex flex-col justify-between border-t border-green-700/30">
              <span className="text-xl text-slate-400 flex-shrink-0 mb-1">Voltage Reference — JSL II 24V VRLA</span>
              <div className="flex flex-col gap-1 flex-1 justify-center">
                {([{pct:100,v:'≥25.6V',color:'#34d399'},{pct:90,v:'25.0V',color:'#4ade80'},{pct:72,v:'24.5V',color:'#a3e635'},{pct:50,v:'24.1V',color:'#facc15'},{pct:43,v:'24.0V',color:'#fb923c'},{pct:23,v:'23.6V',color:'#ef4444'},{pct:7,v:'23.2V',color:'#dc2626'},{pct:0,v:'≤22.5V',color:'#7f1d1d'}] as {pct:number,v:string,color:string}[]).map(({pct,v,color})=>{
                  const active=hasBattData&&computedPackSOC>=pct;
                  return(<div key={pct} className="flex items-center gap-2"><span className="text-slate-500 w-10 text-right flex-shrink-0" style={{fontSize:'1.1rem'}}>{pct}%</span><div className="flex-1 h-3 bg-slate-700 rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-700" style={{width:active?'100%':'0%',background:color,opacity:active?1:0.2}}/></div><span className={`w-14 text-right flex-shrink-0 font-mono ${active?'text-slate-300':'text-slate-600'}`} style={{fontSize:'1.1rem'}}>{v}</span><div className="w-2 h-2 rounded-full flex-shrink-0" style={{backgroundColor:active?color:'#334155'}}/></div>);
                })}
              </div>
            </div>
          </div>{/* end right card */}
        </div>{/* end two-col */}

        {/* Footer */}
        <div className="text-lg text-slate-500 text-center pt-1.5 mt-1 border-t border-slate-700/40 flex-shrink-0">
          📡 INA219 × 2 · 24V {capacityLabel} Lead Acid ({cellCount} {bankLabel})
        </div>
      </div>
    );
  };

  // ============================================================================
  // PANELS DETAIL
  // ============================================================================
  const renderPanelsDetail = () => {
    // ── PANEL LOGIC — WCS1500 retired, inverterCurrent is the source of truth ──
    // 2S2P Array: 4× JAM72D40-590/MB panels
    //   String 1: PV-01 + PV-02 in series  → each panel carries the string current
    //   String 2: PV-03 + PV-04 in series  → each panel carries the string current
    //   Array   : String1 ∥ String2        → inverterCurrent = sum of both strings
    //
    // WCS1500 per-panel sensors retired (Arduino 1.33A noise floor, unreliable).
    // Proxy: inverterCurrent / 2 = per-string current = per-panel current (2S2P)
    //        solarVoltage / 2    = per-panel voltage   (two panels in series per string)
    //
    // Synced with SolarPanelsStatusCard derivePanels() — single source of truth.
    const PANEL_IMP = 13.28;  // JAM72D40-590/MB Imp (A) — datasheet
    const PANEL_ISC = 13.94;  // JAM72D40-590/MB Isc (A) — datasheet
    const PANEL_THRESH_GOOD    = 2.0;   // A/panel → good    (≥4A inverter total)
    const PANEL_THRESH_WARNING = 0.5;   // A/panel → warning
    const getManilaHour = (): number => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })).getHours();
    const isDay = (() => { const h = getManilaHour(); return h >= 6 && h < 18; })();
    const invI_panels = Number(systemData.inverterCurrent ?? 0);
    // Panels only active during daytime (6AM-6PM PHT) AND inverter has current.
    // Night = no harvest regardless of voltage. No inverter current = no array output.
    const hasLiveSensorData = isDay && invI_panels > 0;
    // perPanelCurrent: inverterCurrent / 2 (per-string in 2S2P, same for all 4 panels)
    const perPanelCurrent = hasLiveSensorData ? Math.max(0, parseFloat((invI_panels / 2).toFixed(2))) : 0;
    const panelBaseV      = solarVoltage > 0 ? solarVoltage / 2 : 0;

    type PanelEntry = { id: number; name: string; string: 1 | 2; voltage: number; current: number; power: number; health: number | null; status: 'good' | 'warning' | 'critical' | 'nodata'; faultReason?: string; isNight: boolean; isNoData: boolean; };
    const panels: PanelEntry[] = [0, 1, 2, 3].map((i) => {
      const strNum: 1 | 2 = i < 2 ? 1 : 2;
      const voltage = Math.max(0, parseFloat(panelBaseV.toFixed(1)));
      const power   = parseFloat((voltage * perPanelCurrent).toFixed(1));
      const health: number | null = (isDay && hasLiveSensorData) ? Math.min(100, Math.round((perPanelCurrent / PANEL_IMP) * 100)) : null;

      if (!hasLiveSensorData) return { id: i+1, name: `PV-0${i+1}`, string: strNum, voltage: 0, current: 0, power: 0, health: null, status: 'nodata', faultReason: !isDay ? 'Night — no harvest' : 'No inverter current', isNight: !isDay, isNoData: isDay };

      let status: 'good' | 'warning' | 'critical' = 'good';
      let faultReason: string | undefined;

      if (solarAnomaly === 'critical') {
        status = 'critical'; faultReason = 'Array critical — low output';
      } else if (solarAnomaly === 'warning' || perPanelCurrent < PANEL_THRESH_WARNING) {
        status = 'warning';
        if (perPanelCurrent < PANEL_THRESH_WARNING)
          faultReason = `Low output ${perPanelCurrent.toFixed(2)}A (cloud/low load)`;
      } else if (perPanelCurrent < PANEL_THRESH_GOOD) {
        status = 'warning';
      }

      return { id: i+1, name: `PV-0${i+1}`, string: strNum, voltage, current: perPanelCurrent, power, health, status, faultReason, isNight: false, isNoData: false };
    });
    const good = panels.filter(p => p.status === 'good' && !p.isNoData).length;
    const warn = panels.filter(p => p.status === 'warning').length;
    const crit = panels.filter(p => p.status === 'critical').length;
    const dotColor = !hasLiveSensorData ? 'bg-slate-500' : !isDay ? 'bg-slate-500' : solarAnomaly === 'critical' ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : solarAnomaly === 'warning' ? 'bg-amber-500 shadow-[0_0_10px_#f59e0b]' : 'bg-green-500 shadow-[0_0_10px_#22c55e]';
    const positions =
    [{ x: '28%', y: '23%' },
    { x: '43%', y: '23%' },
    { x: '58%', y: '23%' },
    { x: '73%', y: '23%' }];
    return (
      <div className="relative h-full w-full overflow-hidden bg-slate-950 font-sans text-white select-none flex flex-col">
        <div className="absolute inset-0 z-0 pointer-events-none opacity-20"><img src={solarImg} alt="Solar View" className="w-full h-full object-cover"/></div>
        {(!isDay || !hasLiveSensorData) && (<div className="absolute inset-0 z-0 pointer-events-none bg-slate-950/50"/>)}
        <div className="relative z-20 p-3 flex items-center justify-between border-b border-blue-500/30 flex-shrink-0" style={{ background: 'linear-gradient(to bottom, #0a0f2e 0%, #032b6b 100%)' }}>
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-yellow-600"><ChevronLeft className="w-7 h-7"/><span className="text-2xl uppercase tracking-tight">Back</span></button>
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2"><Sun className="w-7 h-7 text-yellow-600"/><span className="text-2xl">Solar Panels</span>{!hasLiveSensorData && <span className="text-sm text-slate-400 ml-1">— No Sensor</span>}{hasLiveSensorData && !isDay && <span className="text-sm text-slate-400 ml-1">— Night Mode</span>}</div>
          <div className={`w-3 h-3 rounded-full animate-pulse ${dotColor}`}/>
        </div>
        <div className="relative flex-1 z-10">
          {panels.map((panel, index) => {
            const pos = positions[index] || { x: '50%', y: '50%' };
            if (panel.isNoData) return (
              <div key={panel.id} className="absolute flex flex-col p-3 shadow-2xl z-30 rounded-xl border border-white/10 backdrop-blur-md" style={{ left: pos.x, top: pos.y, transform: 'translate(-50%,-50%)', backgroundColor: 'rgba(30,41,59,0.90)', width: '240px', minHeight: '110px' }}>
                <div className="flex justify-between items-center mb-1"><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-slate-500"/><span className="text-[10px] font-black text-white/90 uppercase tracking-tighter italic">{panel.name}</span><span className="text-[8px] text-white/40 font-mono ml-1">S{panel.string}</span></div><span className="text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-black/40 border border-white/5 text-slate-400">No Data</span></div>
                <div className="flex items-end gap-2 my-1"><span className="text-5xl font-black italic tracking-tighter leading-none text-slate-500">&#8212;</span><span className="text-2xl font-bold text-slate-500 mb-1">A</span></div>
                <div className="space-y-1 mb-2"><div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5"><div className="h-full bg-slate-600 w-0"/></div><div className="flex justify-between items-center px-0.5"><span className="text-[7px] text-white/30 font-black uppercase tracking-widest">PV Health</span><span className="text-[9px] font-black text-slate-500">—</span></div></div>
                <div className="px-1.5 py-0.5 rounded bg-black/50 border border-white/10"><span className="text-[7px] font-bold text-slate-400">No sensor connected</span></div>
              </div>
            );
            const isG = panel.status === 'good', isW = panel.status === 'warning';
            const boxBg = panel.isNight ? 'rgba(30,41,59,0.85)' : isG ? 'rgba(49,207,10,0.75)' : isW ? 'rgba(120,53,15,0.8)' : 'rgba(153,27,27,0.8)';
            const ac = panel.isNight ? 'text-slate-400' : isG ? 'text-emerald-400' : isW ? 'text-amber-400' : 'text-red-400';
            const bar = panel.isNight ? 'bg-slate-600' : isG ? 'bg-emerald-500' : isW ? 'bg-amber-500' : 'bg-red-600';
            const statusLabel = panel.isNight ? 'Night Mode' : isG ? 'Optimal' : isW ? 'Warning' : 'Critical';
            return (
              <div key={panel.id} className="absolute flex flex-col p-3 transition-all duration-700 shadow-2xl z-30 rounded-xl border border-white/10 backdrop-blur-md" style={{ left: pos.x, top: pos.y, transform: 'translate(-50%,-50%)', backgroundColor: boxBg, width: '280px', minHeight: panel.faultReason ? '130px' : '110px' }}>
                <div className="flex justify-between items-center mb-1"><div className="flex items-center gap-1.5"><div className={`w-1.5 h-1.5 rounded-full ${bar} ${panel.isNight ? '' : 'animate-pulse'}`}/><span className="text-[10px] font-black text-white/90 uppercase tracking-tighter italic">{panel.name}</span><span className="text-[8px] text-white/40 font-mono ml-1">S{panel.string}</span></div><span className={`text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-black/40 border border-white/5 ${ac}`}>{statusLabel}</span></div>
                <div className="flex items-end gap-2 my-1"><div className={`text-5xl font-black italic tracking-tighter leading-none ${panel.isNight ? 'text-slate-300' : 'text-white'}`}>{panel.current.toFixed(2)}</div><span className={`text-2xl font-bold mb-1 ${panel.isNight ? 'text-slate-400' : ac}`}>A</span></div>
                {panel.faultReason && (<div className="mb-1 px-1.5 py-0.5 rounded bg-black/50 border border-white/10"><span className={`text-[7px] font-bold ${ac}`}>{panel.faultReason}</span></div>)}
                <div className="mt-auto space-y-1.5">
                  <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5"><div className={`h-full ${bar} transition-all duration-1000`} style={{ width: panel.isNight ? '0%' : `${Math.min(100, (panel.current / PANEL_ISC) * 100)}%` }}/></div>
                  <div className="flex justify-between items-center px-0.5"><div className="flex items-center gap-2"><span className="text-[7px] text-white/40 font-black uppercase tracking-widest">PV Health</span><div className="w-20 h-[2px] bg-white/5 rounded-full overflow-hidden"><div className={`h-full ${bar} opacity-40`} style={{ width: panel.isNight ? '0%' : `${panel.health ?? 0}%` }}/></div></div><span className={`text-[9px] font-black ${panel.isNight ? 'text-slate-400' : ac}`}>{panel.isNight ? 'Night' : `${panel.health ?? 0}%`}</span></div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="relative z-20 pt-2 pb-5 border-t border-blue-500/30 flex-shrink-0" style={{ background: 'linear-gradient(to bottom, #032b6b 0%, #0a0f2e 100%)' }}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="border-r border-white/10"><div className="text-green-500 text-2xl font-normal leading-none">{!hasLiveSensorData ? 0 : good}</div><div className="text-[10px] text-green-500 font-normal uppercase tracking-[0.2em] mt-1">{!isDay ? 'Night' : 'Optimal'}</div></div>
            <div className="border-r border-white/10"><div className="text-amber-400 text-2xl font-normal leading-none">{!hasLiveSensorData ? 0 : warn}</div><div className="text-[10px] text-amber-400 font-normal uppercase tracking-[0.2em] mt-1">Warning</div></div>
            <div><div className="text-red-500 text-2xl font-normal leading-none">{!hasLiveSensorData ? 0 : crit}</div><div className="text-[10px] text-red-500 font-normal uppercase tracking-[0.2em] mt-1">Critical</div></div>
          </div>
          {!hasLiveSensorData && (<div className="text-center text-[10px] text-slate-500 mt-1 tracking-wide">No data — check solar voltage & inverter connection</div>)}
        </div>
      </div>
    );
  };

  // ============================================================================
  // GRAPH DETAIL — v2 (5 slides, Slide 4 = Chart.js Anomaly Detection)
  // ============================================================================
  const renderGraphDetail = () => {
    // ── Anomaly slide helpers — aligned to anomaly_engine.py ────────────────
    const G_WARN_LO = Math.round(0.91 * 230);  // 209V (0.91 pu)
    const G_WARN_HI = Math.round(1.10 * 230);  // 253V (1.10 pu)
    const G_CRIT_LO = Math.round(0.80 * 230);  // 184V (0.80 pu)
    const G_CRIT_HI = Math.round(1.15 * 230);  // 265V (1.15 pu)
    const clsGrid = (v: number) => v <= 0 ? 'none' : (v < G_CRIT_LO || v > G_CRIT_HI) ? 'critical' : (v < G_WARN_LO || v > G_WARN_HI) ? 'warning' : 'none';
    const clsInv  = (v: number) => v <= 0 ? 'none' : (v < INV_CRITICAL_LOW || v > INV_CRITICAL_HIGH) ? 'critical' : (v < G_WARN_LO || v > G_WARN_HI) ? 'warning' : 'none';
    const dotClr  = (cls: string) => cls === 'critical' ? '#ef4444' : cls === 'warning' ? '#eab308' : '#22c55e';
    const anomType = (v: number, cLo: number, cHi: number, wLo: number, wHi: number) =>
      v <= 0.10 * 230 ? 'Dropout' : v < cLo ? 'Dropout' : v > cHi ? 'Spike High' : v < wLo ? 'Dropout' : v > wHi ? 'Drift High' : 'Normal';
    const deltaLbl = (v: number, wLo: number, wHi: number) =>
      v === 0 ? `−${wLo}V dropout` : v < wLo ? `−${(wLo-v).toFixed(0)}V below` : v > wHi ? `+${(v-wHi).toFixed(0)}V above` : null;

    // Build Chart.js dataset from historyData
    const anomPts = historyData.map((d:any) => {
      const gv = d.gridVoltage != null && Number(d.gridVoltage) > 0 ? Number(d.gridVoltage) : null;
      const iv = d.inverterVoltage != null && Number(d.inverterVoltage) > 0 ? Number(d.inverterVoltage) : null;
      // [FIX-DB-DOTS] Use DB anomaly level — not static threshold
      const rawG = (d.grid_anomaly_level ?? '').toLowerCase();
      const rawI = (d.inverter_anomaly_level ?? '').toLowerCase();
      const gridCls = gv === null ? 'none'
        : rawG === 'critical' ? 'critical'
        : rawG === 'warning'  ? 'warning'
        : rawG === 'none'     ? 'none'
        : clsGrid(gv);
      const invCls = iv === null ? 'none'
        : rawI === 'critical' ? 'critical'
        : rawI === 'warning'  ? 'warning'
        : rawI === 'none'     ? 'none'
        : clsInv(iv);
      // [FIX-DB-TYPE] Use DB anomaly type — fallback to static anomType()
      const gridType = (d.grid_anomaly_type && d.grid_anomaly_type !== '')
        ? d.grid_anomaly_type
        : (gv !== null ? anomType(gv, G_CRIT_LO, G_CRIT_HI, G_WARN_LO, G_WARN_HI) : 'Normal');
      const invType = (d.inv_anomaly_type && d.inv_anomaly_type !== '')
        ? d.inv_anomaly_type
        : (iv !== null ? anomType(iv, G_CRIT_LO, G_CRIT_HI, G_WARN_LO, G_WARN_HI) : 'Normal');
      return { time: d.time, gridV: gv, invV: iv, gridCls, invCls, gridType, invType };
    });
    const anomAnnotations: Record<string, any> = {
      normalBand: { type: 'box', yMin: G_WARN_LO, yMax: G_WARN_HI, backgroundColor: 'rgba(34,197,94,0.05)', borderWidth: 0, drawTime: 'beforeDatasetsDraw' },
      wLo: { type: 'line', yMin: G_WARN_LO, yMax: G_WARN_LO, borderColor: 'rgba(234,179,8,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${G_WARN_LO}V`, position: 'start', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: -8 } },
      wHi: { type: 'line', yMin: G_WARN_HI, yMax: G_WARN_HI, borderColor: 'rgba(234,179,8,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${G_WARN_HI}V`, position: 'start', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: 8 } },
      cLo: { type: 'line', yMin: G_CRIT_LO, yMax: G_CRIT_LO, borderColor: 'rgba(239,68,68,0.45)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${G_CRIT_LO}V`, position: 'start', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: -8 } },
      cHi: { type: 'line', yMin: G_CRIT_HI, yMax: G_CRIT_HI, borderColor: 'rgba(239,68,68,0.45)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${G_CRIT_HI}V`, position: 'start', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: 8 } },
    };
    let bStart: number | null = null;
    anomPts.forEach((p, i) => {
      const bad = p.gridCls !== 'none' || p.invCls !== 'none';
      if (bad && bStart === null) bStart = i;
      if (!bad && bStart !== null) {
        const dur = Math.round((i - bStart) * 5);
        anomAnnotations[`br${i}`] = { type: 'box', xMin: bStart, xMax: i - 1, yMin: 151, yMax: 161, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.35)', label: { display: true, content: `~${dur}m`, color: '#fca5a5', font: { size: 9 }, position: { x: 'center', y: 'center' } } };
        bStart = null;
      }
    });
    const anomChartData: any = {
      labels: anomPts.map(p => p.time),
      datasets: [
        { label: 'Grid', data: anomPts.map(p => p.gridV), borderColor: '#3b82f6', borderWidth: 1.5, tension: 0.35, fill: false, pointRadius: anomPts.map(p => p.gridCls !== 'none' ? 4.5 : 2), pointBackgroundColor: anomPts.map(p => dotClr(p.gridCls)), pointBorderColor: anomPts.map(p => dotClr(p.gridCls)), pointBorderWidth: 1.2 },
        { label: 'Inverter', data: anomPts.map(p => p.invV), borderColor: '#ec4899', borderWidth: 1.5, tension: 0.35, fill: false, pointRadius: anomPts.map(p => p.invCls !== 'none' ? 4.5 : 2), pointBackgroundColor: anomPts.map(p => dotClr(p.invCls)), pointBorderColor: anomPts.map(p => dotClr(p.invCls)), pointBorderWidth: 1.2 },
      ],
    };
    const anomChartOpts: any = {
      responsive: true, maintainAspectRatio: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 8, cornerRadius: 8,
          callbacks: { label(ctx: any) {
            const v = ctx.parsed.y as number; const isG = ctx.datasetIndex === 0;
            const pt = anomPts[ctx.dataIndex];
            const cls = isG ? (pt?.gridCls ?? 'none') : (pt?.invCls ?? 'none');
            const src = isG ? 'Grid' : 'Inv';
            const out = [`${src}: ${v.toFixed(1)}V`];
            if (cls !== 'none') {
              const typeLabel = isG
                ? (pt?.gridType ?? anomType(v, G_CRIT_LO, G_CRIT_HI, G_WARN_LO, G_WARN_HI))
                : (pt?.invType  ?? anomType(v, G_CRIT_LO, G_CRIT_HI, G_WARN_LO, G_WARN_HI));
              out.push(`${cls.toUpperCase()}: ${typeLabel}`);
              const dv = deltaLbl(v, G_WARN_LO, G_WARN_HI);
              if (dv) out.push(dv);
            }
            return out;
          }}
        },
        annotation: { annotations: anomAnnotations },
      },
      scales: {
        x: { grid: { color: 'rgba(51,65,85,0.8)' }, ticks: { font: { size: 8 }, color: '#64748b', maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
        y: { min: 148, max: 280, grid: { color: 'rgba(51,65,85,0.6)' }, ticks: { font: { size: 8 }, color: '#64748b', callback: (v: any) => `${v}V` } },
      },
    };

    // Anomaly event pills
    const anomEvents: { time: string; src: string; cls: string; lbl: string; d: string | null }[] = [];
    anomPts.forEach(p => {
      if (p.gridCls !== 'none') anomEvents.push({ time: p.time, src: 'Grid', cls: p.gridCls, lbl: p.gridType, d: deltaLbl(p.gridV ?? 0, G_WARN_LO, G_WARN_HI) });
      if (p.invCls  !== 'none') anomEvents.push({ time: p.time, src: 'Inv',  cls: p.invCls,  lbl: p.invType,  d: deltaLbl(p.invV  ?? 0, G_WARN_LO, G_WARN_HI) });
    });
    const recentEvents = anomEvents.slice(-6);

    // AE engine result — single source of truth from Flask anomaly engine via context
    const liveGCls = (systemData.gridVoltageAnomaly?.severity ?? systemData.gridAnomaly ?? 'none') as string;
    const liveICls = (systemData.inverterVoltageAnomaly?.severity ?? systemData.inverterAnomaly ?? 'none') as string;
    const liveStatus = liveGCls === 'critical' || liveICls === 'critical' ? 'critical' : liveGCls === 'warning' || liveICls === 'warning' ? 'warning' : 'normal';
    const anomCritCount = anomPts.filter(p => p.gridCls === 'critical' || p.invCls === 'critical').length;
    const anomWarnCount = anomPts.filter(p => (p.gridCls === 'warning' || p.invCls === 'warning') && p.gridCls !== 'critical' && p.invCls !== 'critical').length;
    const anomMaxDelta  = Math.max(0, ...anomPts.map(p => {
      const gd = p.gridV > 0 ? Math.max(Math.abs(p.gridV - G_WARN_LO), Math.abs(p.gridV - G_WARN_HI)) : G_WARN_LO;
      return (p.gridCls !== 'none') ? gd : 0;
    }));

    return (
      <div
        className="relative h-full flex flex-col text-white overflow-hidden bg-slate-950"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Header — 3-column grid: Back | ←Title→ | dots */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid rgba(126,34,206,0.5)', flexShrink: 0 }}>
          {/* Left: Back */}
          <button onClick={() => navigateTo('main')} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#c4b5fd', justifySelf: 'start' }}>
            <ChevronLeft className="w-6 h-6"/><span style={{ fontSize: '1.5rem' }}>Back</span>
          </button>
          {/* Center: ← Title → */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setGraphSlide(s => Math.max(0, s - 1))}
              disabled={graphSlide === 0}
              style={{ width: 44, height: 36, borderRadius: 10, background: 'rgba(109,40,217,0.7)', border: '1px solid rgba(139,92,246,0.6)', color: '#ede9fe', fontSize: '1.5rem', fontWeight: 700, opacity: graphSlide === 0 ? 0.2 : 1, cursor: graphSlide === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}
            >←</button>
            <span style={{ fontSize: '1.15rem', color: '#c4b5fd', fontWeight: 600, width: 176, textAlign: 'center', whiteSpace: 'nowrap', userSelect: 'none' }}>
              {graphSlide === 0 ? 'High Voltage AC' : graphSlide === 1 ? 'Low Voltage DC' : graphSlide === 2 ? 'Voltage Trends' : graphSlide === 3 ? 'Current Trends' : 'Consumption'}
            </span>
            <button
              onClick={() => setGraphSlide(s => Math.min(TOTAL_SLIDES - 1, s + 1))}
              disabled={graphSlide === TOTAL_SLIDES - 1}
              style={{ width: 44, height: 36, borderRadius: 10, background: 'rgba(109,40,217,0.7)', border: '1px solid rgba(139,92,246,0.6)', color: '#ede9fe', fontSize: '1.5rem', fontWeight: 700, opacity: graphSlide === TOTAL_SLIDES - 1 ? 0.2 : 1, cursor: graphSlide === TOTAL_SLIDES - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}
            >→</button>
          </div>
          {/* Right: slide dots — horizontal, far right */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, justifySelf: 'end' }}>
            {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: i === graphSlide ? 10 : 6,
                  height: i === graphSlide ? 10 : 6,
                  borderRadius: '50%',
                  background: i === graphSlide ? '#a78bfa' : '#475569',
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-visible">
          {/* Slide 0 — High Voltage Anomaly Detection */}
          {graphSlide === 0 && (
            <div className="h-full flex flex-col p-2 pb-1 bg-slate-950 overflow-hidden">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 8, flexShrink: 0 }}>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: (systemData.gridAnomaly??'none')==='critical'?'rgba(127,29,29,0.55)':(systemData.gridAnomaly??'none')==='warning'?'rgba(113,63,18,0.55)':'rgba(23,37,84,0.55)', border: `1px solid ${(systemData.gridAnomaly??'none')==='critical'?'rgba(248,113,113,0.6)':(systemData.gridAnomaly??'none')==='warning'?'rgba(251,191,36,0.6)':'rgba(59,130,246,0.5)'}` }}>
                  <div style={{ fontSize: 10, color: (systemData.gridAnomaly??'none')!=='none'?'#f87171':'#93c5fd', marginBottom: 2 }}>Grid V{(systemData.gridAnomaly??'none')!=='none'?' ⚠':''}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: (systemData.gridAnomaly??'none')==='critical'?'#f87171':(systemData.gridAnomaly??'none')==='warning'?'#fde047':'#bfdbfe' }}>{gridVoltage.toFixed(0)}V</div>
                </div>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: (systemData.inverterAnomaly??'none')==='critical'?'rgba(127,29,29,0.55)':(systemData.inverterAnomaly??'none')==='warning'?'rgba(113,63,18,0.55)':'rgba(131,24,67,0.45)', border: `1px solid ${(systemData.inverterAnomaly??'none')==='critical'?'rgba(248,113,113,0.6)':(systemData.inverterAnomaly??'none')==='warning'?'rgba(251,191,36,0.6)':'rgba(236,72,153,0.5)'}` }}>
                  <div style={{ fontSize: 10, color: (systemData.inverterAnomaly??'none')!=='none'?'#f87171':'#f9a8d4', marginBottom: 2 }}>Inv V{(systemData.inverterAnomaly??'none')!=='none'?' ⚠':''}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: (systemData.inverterAnomaly??'none')==='critical'?'#f87171':(systemData.inverterAnomaly??'none')==='warning'?'#fde047':'#fbcfe8' }}>{acVoltage.toFixed(0)}V</div>
                </div>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(127,29,29,0.45)', border: '1px solid rgba(248,113,113,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#f87171', marginBottom: 2 }}>Critical</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fca5a5' }}>{historyData.filter((d:any)=>(d.gridVoltage>0&&d.gridVoltage<184)||(d.inverterVoltage>0&&d.inverterVoltage<176)).length}<span style={{ fontSize: 10, marginLeft: 2 }}>pts</span></div>
                </div>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(113,63,18,0.45)', border: '1px solid rgba(251,191,36,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#fbbf24', marginBottom: 2 }}>Max Δ</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fde68a' }}>{Math.max(0,...historyData.map((d:any)=>d.gridVoltage>0?Math.abs(d.gridVoltage-215):0)).toFixed(0)}<span style={{ fontSize: 10, marginLeft: 2 }}>V</span></div>
                </div>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 mb-1.5 flex-shrink-0">
                <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#3b82f6',display:'inline-block'}}/>Grid</span>
                <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#ec4899',display:'inline-block'}}/>Inv</span>
                <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Normal</span>
                <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#eab308',display:'inline-block'}}/>Warn</span>
                <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#ef4444',display:'inline-block'}}/>Crit</span>
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${(systemData.gridAnomaly??'none')==='critical'||(systemData.inverterAnomaly??'none')==='critical'?'bg-red-700/60 text-red-300':(systemData.gridAnomaly??'none')==='warning'||(systemData.inverterAnomaly??'none')==='warning'?'bg-yellow-700/60 text-yellow-300':'bg-green-700/60 text-green-300'}`}>
                  {(systemData.gridAnomaly??'none')==='critical'||(systemData.inverterAnomaly??'none')==='critical'?'● Critical':(systemData.gridAnomaly??'none')==='warning'||(systemData.inverterAnomaly??'none')==='warning'?'● Warning':'● Stable'}
                </span>
              </div>
              <div className="flex-1 min-h-0 relative" style={{minHeight:0}}>
                <div className="absolute inset-0">
                {historyData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-500 text-sm">Loading data…</div>
                ) : (
                  <CJSLine data={{
                    labels: historyData.map((p:any)=>p.time),
                    datasets: [
                      { label: 'Grid', data: historyData.map((p:any)=>p.gridVoltage), borderColor: '#3b82f6', borderWidth: 1.5, tension: 0.35, fill: false,
                        pointRadius: historyData.map((p:any)=>{
                          const lvl=(p.grid_anomaly_level??'').toLowerCase();
                          return p.gridVoltage>0&&(lvl==='warning'||lvl==='critical')?4.5:2;
                        }),
                        pointBackgroundColor: historyData.map((p:any)=>{
                          if(p.gridVoltage<=0)return'transparent';
                          const lvl=(p.grid_anomaly_level??'').toLowerCase();
                          return lvl==='critical'?'#ef4444':lvl==='warning'?'#eab308':'#22c55e';
                        }),
                        pointBorderColor: historyData.map((p:any)=>{
                          if(p.gridVoltage<=0)return'transparent';
                          const lvl=(p.grid_anomaly_level??'').toLowerCase();
                          return lvl==='critical'?'#ef4444':lvl==='warning'?'#eab308':'#22c55e';
                        }),
                        pointBorderWidth: 1.2 },
                      { label: 'Inverter', data: historyData.map((p:any)=>p.inverterVoltage), borderColor: '#ec4899', borderWidth: 1.5, tension: 0.35, fill: false,
                        pointRadius: historyData.map((p:any)=>{
                          const lvl=(p.inverter_anomaly_level??'').toLowerCase();
                          return p.inverterVoltage>0&&(lvl==='warning'||lvl==='critical')?4.5:2;
                        }),
                        pointBackgroundColor: historyData.map((p:any)=>{
                          if(p.inverterVoltage<=0)return'transparent';
                          const lvl=(p.inverter_anomaly_level??'').toLowerCase();
                          return lvl==='critical'?'#ef4444':lvl==='warning'?'#eab308':'#22c55e';
                        }),
                        pointBorderColor: historyData.map((p:any)=>{
                          if(p.inverterVoltage<=0)return'transparent';
                          const lvl=(p.inverter_anomaly_level??'').toLowerCase();
                          return lvl==='critical'?'#ef4444':lvl==='warning'?'#eab308':'#22c55e';
                        }),
                        pointBorderWidth: 1.2 },
                    ]
                  }} options={{
                    responsive: true, maintainAspectRatio: false, spanGaps: false,
                    interaction: { mode: 'index' as const, intersect: false },
                    plugins: {
                      legend: { display: false },
                      tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 8, cornerRadius: 8,
                        callbacks: { label(ctx:any) {
                          const v = ctx.parsed.y as number;
                          if (v == null) return '';
                          const isG = ctx.datasetIndex === 0;
                          const pt  = historyData[ctx.dataIndex] as any;
                          const lvl = isG ? (pt?.grid_anomaly_level??'') : (pt?.inverter_anomaly_level??'');
                          const typ = isG ? (pt?.grid_anomaly_type??'')  : (pt?.inv_anomaly_type??'');
                          const src = isG ? 'Grid' : 'Inverter';
                          const VN = isG ? 230 : 220;
                          const out = [`${src}: ${v.toFixed(2)}V (${(v/VN).toFixed(3)}pu)`];
                          if (lvl === 'warning' || lvl === 'critical') {
                            const clsLabel = lvl.charAt(0).toUpperCase() + lvl.slice(1);
                            // DB type from anomaly_engine; fallback derive for old rows
                            const derived = v<=0?'Dropout':v<184?'Dropout':v>265?'Spike High':v<207?'Drift Low':v>253?'Drift High':null;
                            const typLabel = (typ&&typ.toLowerCase()!=='normal')?typ:derived;
                            out.push(typLabel?`${clsLabel}: ${typLabel}`:`⚠ ${clsLabel}`);
                          }
                          return out;
                        }}
                      },
                      annotation: { annotations: {
                        wLo: { type: 'line' as const, yMin: 209, yMax: 209, borderColor: 'rgba(234,179,8,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: '209V', position: 'start' as const, backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: -8 } },
                        wHi: { type: 'line' as const, yMin: 253, yMax: 253, borderColor: 'rgba(234,179,8,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: '253V', position: 'start' as const, backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: 8 } },
                        cLo: { type: 'line' as const, yMin: 184, yMax: 184, borderColor: 'rgba(239,68,68,0.45)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: '184V', position: 'start' as const, backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: -8 } },
                        cHi: { type: 'line' as const, yMin: 265, yMax: 265, borderColor: 'rgba(239,68,68,0.45)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: '265V', position: 'start' as const, backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: 8 } },
                      }},
                    },
                    scales: {
                      x: { grid: { color: 'rgba(51,65,85,0.8)' }, ticks: { font: { size: 8 }, color: '#64748b', maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
                      y: { min: 148, max: 280, grid: { color: 'rgba(51,65,85,0.6)' }, ticks: { font: { size: 8 }, color: '#64748b', callback: (v:any)=>`${v}V` } },
                    },
                  }} />
                )}
                </div>
              </div>
              {/* AC Event pills — transition-only, DB level + derived type */}
              {(() => {
                const acEvents:{time:string;src:string;cls:string;lbl:string}[]=[];
                let prevG='none', prevI='none';
                historyData.forEach((p:any)=>{
                  const gV=p.gridVoltage??0;
                  const iV=p.inverterVoltage??0;
                  const gTyp=p.grid_anomaly_type??'';
                  const iTyp=p.inv_anomaly_type??'';
                  // DB level — fallback to voltage compute for old rows without stored level
                  const rawG=(p.grid_anomaly_level??'').toLowerCase();
                  const rawI=(p.inverter_anomaly_level??'').toLowerCase();
                  const gLvl=rawG==='warning'||rawG==='critical'?rawG
                    :gV<=0?'none':gV<184||gV>265?'critical':gV<207||gV>253?'warning':'none';
                  const iLvl=rawI==='warning'||rawI==='critical'?rawI
                    :iV<=0?'none':iV<180||iV>270?'critical':iV<207||iV>253?'warning':'none';
                  if((gLvl==='warning'||gLvl==='critical')&&gLvl!==prevG){
                    const derived=gV<=0?'Dropout':gV<184?'Dropout':gV>265?'Spike High':gV<207?'Drift Low':gV>253?'Drift High':'Out of Range';
                    const lbl=(gTyp&&gTyp.toLowerCase()!=='normal')?gTyp:derived;
                    acEvents.push({time:p.time,src:'Grid',cls:gLvl,lbl});
                  }
                  if((iLvl==='warning'||iLvl==='critical')&&iLvl!==prevI){
                    const derived=iV<=0?'Dropout':iV<180?'Dropout':iV>270?'Spike High':iV<207?'Drift Low':iV>253?'Drift High':'Out of Range';
                    const lbl=(iTyp&&iTyp.toLowerCase()!=='normal')?iTyp:derived;
                    acEvents.push({time:p.time,src:'Inv',cls:iLvl,lbl});
                  }
                  prevG=gLvl==='warning'||gLvl==='critical'?gLvl:'none';
                  prevI=iLvl==='warning'||iLvl==='critical'?iLvl:'none';
                });
                const recentAC=acEvents.slice(-6);
                if(!recentAC.length) return null;
                return (
                  <div className="flex flex-wrap gap-1 mt-1 flex-shrink-0">
                    {recentAC.map((e:any,i:number)=>(
                      <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${e.cls==='critical'?'bg-red-900/60 text-red-300 border border-red-700/50':'bg-yellow-900/60 text-yellow-300 border border-yellow-700/50'}`}>
                        {e.time} · {e.src} · {e.cls.toUpperCase()} · {e.lbl}
                      </span>
                    ))}
                  </div>
                );
              })()}
              <div className="text-xs text-slate-600 text-center pt-1 flex-shrink-0">PZEM-004T · Grid & Inverter AC · 24h</div>
            </div>
          )}

          {/* Slide 1 — Low Voltage Anomaly Detection */}
          {graphSlide === 1 && (
            <div className="h-full flex flex-col p-2 pb-1 bg-slate-950 overflow-hidden">
              {(() => {
                // ── DC Anomaly helpers ─────────────────────────────────────
                const BAT_VN=24.0, BAT_WARN=23.0, BAT_CRIT=21.6;
                const SOL_VN=88.86, SOL_WARN=53.3, SOL_CRIT=20.0;
                const dcType=(v:number,vn:number,wLo:number,cLo:number)=>
                  v<=0?'Dropout':v<cLo?'Dropout':v<wLo?'Low Voltage':v>vn*1.15?'Spike High':v>vn*1.05?'Drift High':'Normal';
                const dcDelta=(v:number,wLo:number,cLo:number=0)=>
                  v<=0?null:v<cLo?null:v<wLo?`−${(wLo-v).toFixed(1)}V below warn`:null;
                const dcDotClr=(v:number,wLo:number,cLo:number)=>
                  v<=0?'transparent':v<cLo?'#ef4444':v<wLo?'#eab308':'#22c55e';
                const solDotClr=(v:number)=>
                  v<=0?'transparent':v<SOL_CRIT?'#ef4444':v<SOL_WARN?'#eab308':'#f59e0b';

                const dcPts = historyData.map((d:any)=>{
                  const batV = d.batteryVoltage>0?d.batteryVoltage:null;
                  const solV = d.solarVoltage>0?d.solarVoltage:null;
                  // DB-only levels — no frontend fallback (matches anomaly engine)
                  const batCls = (d.dc_battery_anomaly_level??'none').toLowerCase();
                  const solCls = (d.dc_solar_anomaly_level  ??'none').toLowerCase();
                  // DB-stored anomaly type from dc_anomaly_engine
                  const batType = (d.dc_battery_anomaly_type??'').toLowerCase()!=='normal'
                    ? (d.dc_battery_anomaly_type??'') : null;
                  const solType = (d.dc_solar_anomaly_type??'').toLowerCase()!=='normal'
                    ? (d.dc_solar_anomaly_type??'') : null;
                  return { time:d.time, batV, solV, batCls, solCls, batType, solType };
                });

                const batA = systemData.batteryAnomaly??'none';
                const solA = systemData.solarAnomaly??'none';
                const liveStatus = batA==='critical'||solA==='critical'?'critical':batA==='warning'||solA==='warning'?'warning':'normal';
                const critPts = dcPts.filter((p:any)=>p.batCls==='critical'||p.solCls==='critical').length;
                const maxDelta = Math.max(0,...dcPts.map((p:any)=>{
                  const bd=p.batV?Math.abs(p.batV-BAT_VN):0;
                  const sd=p.solV?Math.abs(p.solV-SOL_VN):0;
                  return (p.batCls!=='none'||p.solCls!=='none')?Math.max(bd,sd):0;
                }));

                const dcAnnotations:Record<string,any> = {
                  batNormalBand:{ type:'box' as const, yMin:BAT_WARN, yMax:110, backgroundColor:'rgba(34,197,94,0.04)', borderWidth:0, drawTime:'beforeDatasetsDraw' as const, label:{display:true,content:'Normal',position:{x:'end',y:'center'},color:'rgba(34,197,94,0.3)',font:{size:8},backgroundColor:'transparent'} },
                  batWarnBand:  { type:'box' as const, yMin:BAT_CRIT, yMax:BAT_WARN, backgroundColor:'rgba(234,179,8,0.06)', borderWidth:0, drawTime:'beforeDatasetsDraw' as const, label:{display:true,content:'Warn',position:{x:'end',y:'center'},color:'rgba(161,98,7,0.4)',font:{size:8},backgroundColor:'transparent'} },
                  batCritBand:  { type:'box' as const, yMin:0, yMax:BAT_CRIT, backgroundColor:'rgba(239,68,68,0.05)', borderWidth:0, drawTime:'beforeDatasetsDraw' as const, label:{display:true,content:'Crit',position:{x:'end',y:'center'},color:'rgba(220,38,38,0.4)',font:{size:8},backgroundColor:'transparent'} },
                  batWarn: { type:'line' as const, yMin:BAT_WARN, yMax:BAT_WARN, borderColor:'rgba(234,179,8,0.6)', borderWidth:1.5, borderDash:[5,4], label:{display:true,content:`${BAT_WARN}V warn`,position:'start' as const,backgroundColor:'transparent',color:'#a16207',font:{size:9},yAdjust:-9} },
                  batCrit: { type:'line' as const, yMin:BAT_CRIT, yMax:BAT_CRIT, borderColor:'rgba(239,68,68,0.6)', borderWidth:1.5, borderDash:[5,4], label:{display:true,content:`${BAT_CRIT}V crit`,position:'start' as const,backgroundColor:'transparent',color:'#dc2626',font:{size:9},yAdjust:-9} },
                  solWarn: { type:'line' as const, yMin:SOL_WARN, yMax:SOL_WARN, borderColor:'rgba(234,179,8,0.4)', borderWidth:1, borderDash:[4,3], label:{display:true,content:`${SOL_WARN}V warn`,position:'end' as const,backgroundColor:'transparent',color:'#a16207',font:{size:8},yAdjust:8} },
                  solCrit: { type:'line' as const, yMin:SOL_CRIT, yMax:SOL_CRIT, borderColor:'rgba(239,68,68,0.35)', borderWidth:1, borderDash:[4,3], label:{display:true,content:`${SOL_CRIT}V crit`,position:'end' as const,backgroundColor:'transparent',color:'#dc2626',font:{size:8},yAdjust:8} },
                };

                const dcChartData:any = {
                  labels: dcPts.map((p:any)=>p.time),
                  datasets: [
                    { label:'Battery', data:dcPts.map((p:any)=>p.batV), borderColor:'#22c55e', borderWidth:1.5, tension:0.35, fill:false, spanGaps:true,
                      pointRadius:dcPts.map((p:any)=>p.batCls!=='none'?5:2.5),
                      pointBackgroundColor:dcPts.map((p:any)=>p.batCls==='critical'?'#ef4444':p.batCls==='warning'?'#eab308':'#22c55e'),
                      pointBorderColor:dcPts.map((p:any)=>p.batCls==='critical'?'#ef4444':p.batCls==='warning'?'#eab308':'#22c55e'),
                      pointBorderWidth:1.2 },
                    { label:'Solar', data:dcPts.map((p:any)=>p.solV), borderColor:'#f59e0b', borderWidth:1.5, tension:0.35, fill:false, spanGaps:true,
                      pointRadius:dcPts.map((p:any)=>p.solCls!=='none'?5:2),
                      pointBackgroundColor:dcPts.map((p:any)=>p.solCls==='critical'?'#ef4444':p.solCls==='warning'?'#eab308':'#f59e0b'),
                      pointBorderColor:dcPts.map((p:any)=>p.solCls==='critical'?'#ef4444':p.solCls==='warning'?'#eab308':'#f59e0b'),
                      pointBorderWidth:1.2 },
                  ],
                };
                const dcChartOpts:any = {
                  responsive:true, maintainAspectRatio:false, spanGaps:true,
                  interaction:{ mode:'index' as const, intersect:false },
                  plugins:{
                    legend:{display:false},
                    tooltip:{ backgroundColor:'#1e293b', borderColor:'#475569', borderWidth:1, titleColor:'#e2e8f0', bodyColor:'#94a3b8', padding:8, cornerRadius:8,
                      callbacks:{ label(ctx:any){
                        const v=ctx.parsed.y as number; const isBat=ctx.datasetIndex===0;
                        const vn=isBat?BAT_VN:SOL_VN; const wLo=isBat?BAT_WARN:SOL_WARN;
                        const src=isBat?'Battery':'Solar';
                        const pt=dcPts[ctx.dataIndex] as any;
                        const cls=isBat?(pt?.batCls??'none'):(pt?.solCls??'none');
                        const typ=isBat?(pt?.batType??null):(pt?.solType??null);
                        const out=[`${src}: ${v.toFixed(2)}V (${(v/vn).toFixed(3)}pu)`];
                        if(cls==='warning'||cls==='critical'){
                          const clsLabel=cls.charAt(0).toUpperCase()+cls.slice(1);
                          const cLo=isBat?BAT_CRIT:SOL_CRIT;
                          // Show type from DB; if no stored type, derive simply
                          const derivedType = v<=0||v<cLo?'Dropout':v<wLo?'Drift Low':null;
                          const typLabel = (typ&&typ.toLowerCase()!=='normal')?typ:derivedType;
                          out.push(typLabel?`${clsLabel}: ${typLabel}`:`⚠ ${clsLabel}`);
                        }
                        const cLo2=isBat?BAT_CRIT:SOL_CRIT;
                        const d=dcDelta(v,wLo,cLo2); if(d) out.push(d);
                        return out;
                      }}
                    },
                    annotation:{ annotations:dcAnnotations },
                  },
                  scales:{
                    x:{ grid:{color:'rgba(51,65,85,0.8)'}, ticks:{font:{size:8},color:'#64748b',maxRotation:0,autoSkip:true,maxTicksLimit:7} },
                    y:{ min:0, max:110, grid:{color:'rgba(51,65,85,0.6)'}, ticks:{font:{size:8},color:'#64748b',callback:(v:any)=>`${v}V`} },
                  },
                };

                // Event pills — transition-only, DB type
                const dcEvents:{time:string;src:string;cls:string;lbl:string;d:string|null}[]=[];
                let prevBatCls='none', prevSolCls='none';
                dcPts.forEach((p:any)=>{
                  if(p.batCls!=='none'&&p.batCls!==prevBatCls&&p.batV){
                    const bTyp=p.batType||(p.batV<BAT_CRIT?'Dropout':p.batV<BAT_WARN?'Drift Low':'Drift High');
                    dcEvents.push({time:p.time,src:'Bat',cls:p.batCls,lbl:bTyp});
                  }
                  if(p.solCls!=='none'&&p.solCls!==prevSolCls&&p.solV){
                    const sTyp=p.solType||(p.solV<SOL_CRIT?'Dropout':p.solV<SOL_WARN?'Drift Low':'Drift High');
                    dcEvents.push({time:p.time,src:'Sol',cls:p.solCls,lbl:sTyp});
                  }
                  prevBatCls=p.batCls; prevSolCls=p.solCls;
                });
                const recentDcEvents=dcEvents.slice(-6);

                return (<>
                  {/* Summary */}
                  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:8,flexShrink:0}}>
                    {[
                      {label:'Battery V',val:`${batteryVoltage.toFixed(2)}V`,anom:batA,defBg:'rgba(6,78,59,0.45)',defBorder:'rgba(34,197,94,0.5)',defColor:'#86efac'},
                      {label:'Solar V',val:`${solarVoltage.toFixed(1)}V`,anom:solA,defBg:'rgba(120,53,15,0.45)',defBorder:'rgba(251,191,36,0.5)',defColor:'#fcd34d'},
                      {label:'Critical',val:`${critPts} pts`,anom:critPts>0?'critical':'none',defBg:'rgba(127,29,29,0.45)',defBorder:'rgba(248,113,113,0.5)',defColor:'#fca5a5'},
                      {label:'Max Δ',val:`${maxDelta.toFixed(1)}V`,anom:'none',defBg:'rgba(113,63,18,0.45)',defBorder:'rgba(251,191,36,0.5)',defColor:'#fde68a'},
                    ].map(c2=>(
                      <div key={c2.label} style={{borderRadius:8,padding:'6px 8px',textAlign:'center',background:c2.anom==='critical'?'rgba(127,29,29,0.55)':c2.anom==='warning'?'rgba(113,63,18,0.55)':c2.defBg,border:`1px solid ${c2.anom==='critical'?'rgba(248,113,113,0.6)':c2.anom==='warning'?'rgba(251,191,36,0.6)':c2.defBorder}`}}>
                        <div style={{fontSize:10,color:c2.anom!=='none'?'#f87171':c2.defColor,marginBottom:2}}>{c2.label}{c2.anom!=='none'?' ⚠':''}</div>
                        <div style={{fontSize:18,fontWeight:700,color:c2.anom==='critical'?'#f87171':c2.anom==='warning'?'#fde047':c2.defColor}}>{c2.val}</div>
                      </div>
                    ))}
                  </div>
                  {/* Legend */}
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 mb-1.5 flex-shrink-0">
                    <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Battery</span>
                    <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#eab308',display:'inline-block'}}/>Solar</span>
                    <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Normal</span>
                    <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#eab308',display:'inline-block'}}/>Warn</span>
                    <span className="flex items-center gap-1"><span style={{width:8,height:8,borderRadius:'50%',background:'#ef4444',display:'inline-block'}}/>Crit</span>
                    <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${liveStatus==='critical'?'bg-red-700/60 text-red-300':liveStatus==='warning'?'bg-yellow-700/60 text-yellow-300':'bg-green-700/60 text-green-300'}`}>
                      {liveStatus==='critical'?'● Critical':liveStatus==='warning'?'● Warning':'● Stable'}
                    </span>
                  </div>
                  {/* Chart */}
                  <div className="flex-1 min-h-0 relative" style={{minHeight:0}}>
                    <div className="absolute inset-0">
                    {dcPts.length===0?(
                      <div className="h-full flex items-center justify-center text-slate-500 text-sm">Loading data…</div>
                    ):(
                      <CJSLine data={dcChartData} options={dcChartOpts}/>
                    )}
                    </div>
                  </div>
                  {/* Event pills */}
                  {recentDcEvents.length>0&&(
                    <div className="flex flex-wrap gap-1 mt-1.5 flex-shrink-0">
                      {recentDcEvents.map((e:any,i:number)=>(
                        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${e.cls==='critical'?'bg-red-900/60 text-red-300 border border-red-700/50':'bg-yellow-900/60 text-yellow-300 border border-yellow-700/50'}`}>
                          {e.time} · {e.src} · {e.cls.toUpperCase()} · {e.lbl}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-slate-600 text-center pt-1 flex-shrink-0">INA219 + WCS1500 · Battery & Solar DC · 24h</div>
                </>);
              })()}
            </div>
          )}
          {/* Slide 2 — Voltage Trends */}
          {graphSlide === 2 && (
            <div className="h-full flex flex-col p-2 pb-1 bg-slate-950 overflow-hidden">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 8, flexShrink: 0 }}>
                {[
                  { label: 'Grid V',     val: `${gridVoltage.toFixed(0)}V`,    anom: systemData.gridAnomaly??'none',     defBg: 'rgba(23,37,84,0.55)',  defBorder: 'rgba(59,130,246,0.5)',  defColor: '#93c5fd' },
                  { label: 'Inverter V', val: `${acVoltage.toFixed(0)}V`,      anom: systemData.inverterAnomaly??'none', defBg: 'rgba(131,24,67,0.45)', defBorder: 'rgba(236,72,153,0.5)',  defColor: '#f9a8d4' },
                  { label: 'Battery V',  val: `${batteryVoltage.toFixed(1)}V`, anom: systemData.batteryAnomaly??'none',  defBg: 'rgba(6,78,59,0.45)',   defBorder: 'rgba(34,197,94,0.5)',   defColor: '#86efac' },
                  { label: 'Solar V',    val: `${solarVoltage.toFixed(1)}V`,   anom: systemData.solarAnomaly??'none',    defBg: 'rgba(120,53,15,0.45)', defBorder: 'rgba(251,191,36,0.5)',  defColor: '#fcd34d' },
                ].map(c2=>(
                  <div key={c2.label} style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: c2.anom==='critical'?'rgba(127,29,29,0.55)':c2.anom==='warning'?'rgba(113,63,18,0.55)':c2.defBg, border: `1px solid ${c2.anom==='critical'?'rgba(248,113,113,0.6)':c2.anom==='warning'?'rgba(251,191,36,0.6)':c2.defBorder}` }}>
                    <div style={{ fontSize: 10, color: c2.anom!=='none'?'#f87171':c2.defColor, marginBottom: 2 }}>{c2.label}{c2.anom!=='none'?' ⚠':''}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: c2.anom==='critical'?'#f87171':c2.anom==='warning'?'#fde047':c2.defColor }}>{c2.val}</div>
                  </div>
                ))}
              </div>
              <div className="flex-1 min-h-0 relative" style={{minHeight:0}}>
                <div className="absolute inset-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historyData} margin={{ top: 12, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={9} angle={-45} textAnchor="end" height={40} tickFormatter={(v:string,idx:number)=>idx%4===0?v:''}/>
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,260]} width={28}/>
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '8px', fontSize: '10px' }} formatter={(v:unknown,n:string)=>[`${(v as number)?.toFixed(1)}V`,n]}/>
                    <Legend wrapperStyle={{ fontSize: '9px' }}/>
                    <Line type="monotone" dataKey="gridVoltage"     stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Grid V"     connectNulls/>
                    <Line type="monotone" dataKey="inverterVoltage" stroke="#ec4899" strokeWidth={1.5} dot={false} name="Inverter V" connectNulls/>
                    <Line type="monotone" dataKey="batteryVoltage"  stroke="#22c55e" strokeWidth={1.5} dot={false} name="Battery V"  connectNulls/>
                    <Line type="monotone" dataKey="solarVoltage"    stroke="#eab308" strokeWidth={1.5} dot={false} name="Solar V"    connectNulls/>
                  </LineChart>
                </ResponsiveContainer>
                </div>
              </div>
              <div className="text-xs text-slate-600 text-center pt-1 flex-shrink-0">PZEM-004T + INA219</div>
            </div>
          )}

          {/* Slide 3 — Current Trends */}
          {graphSlide === 3 && (
            <div className="h-full flex flex-col p-2 pb-1 bg-slate-950 overflow-hidden">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6, marginBottom: 8, flexShrink: 0 }}>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(23,37,84,0.55)', border: '1px solid rgba(59,130,246,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#93c5fd', marginBottom: 2 }}>Grid A</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#93c5fd' }}>{(historyData[historyData.length-1]?.gridCurrent??0).toFixed(2)}<span style={{ fontSize: 11, marginLeft: 3 }}>A</span></div>
                </div>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(131,24,67,0.45)', border: '1px solid rgba(236,72,153,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#f9a8d4', marginBottom: 2 }}>Inverter A</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#f9a8d4' }}>{(historyData[historyData.length-1]?.inverterCurrent??0).toFixed(2)}<span style={{ fontSize: 11, marginLeft: 3 }}>A</span></div>
                </div>
              </div>
              <div className="flex-1 min-h-0 relative" style={{minHeight:0}}>
                <div className="absolute inset-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historyData} margin={{ top: 12, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={9} angle={-45} textAnchor="end" height={40} tickFormatter={(v:string,idx:number)=>idx%4===0?v:''}/>
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,'auto']} width={32}/>
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '8px', fontSize: '10px' }} formatter={(v:unknown,n:string)=>[`${(v as number)?.toFixed(2)}A`,n]}/>
                    <Legend wrapperStyle={{ fontSize: '9px' }}/>
                    <Line type="monotone" dataKey="gridCurrent"     stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Grid A"     connectNulls/>
                    <Line type="monotone" dataKey="inverterCurrent" stroke="#ec4899" strokeWidth={1.5} dot={false} name="Inverter A" connectNulls/>
                  </LineChart>
                </ResponsiveContainer>
                </div>
              </div>
              <div className="text-xs text-slate-600 text-center pt-1 flex-shrink-0">PZEM-004T + INA219</div>
            </div>
          )}

          {/* Slide 4 — Consumption */}
          {graphSlide === 4 && (
            <div className="h-full flex flex-col p-2 pb-1 bg-slate-950 overflow-hidden">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6, marginBottom: 6, flexShrink: 0 }}>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(23,37,84,0.55)', border: '1px solid rgba(59,130,246,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#93c5fd', marginBottom: 2 }}>Grid</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#60a5fa' }}>{totals.grid.toFixed(1)}<span style={{ fontSize: 11, marginLeft: 3 }}>Wh</span></div>
                </div>
                <div style={{ borderRadius: 8, padding: '6px 8px', textAlign: 'center', background: 'rgba(131,24,67,0.45)', border: '1px solid rgba(236,72,153,0.5)' }}>
                  <div style={{ fontSize: 10, color: '#f9a8d4', marginBottom: 2 }}>Inverter</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#f9a8d4' }}>{(totals.inverter??0).toFixed(1)}<span style={{ fontSize: 11, marginLeft: 3 }}>Wh</span></div>
                </div>
              </div>
              <div className="flex-1 min-h-0 relative" style={{minHeight:0}}>
                <div className="absolute inset-0">
                {consumptionData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={consumptionData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={8} tickFormatter={(v:string,idx:number)=>idx%6===0?v:''} height={30}/>
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,'auto']} width={32}/>
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '6px', fontSize: '10px' }} formatter={(v:unknown,n:string)=>[`${(v as number)?.toFixed(1)}W`,n]}/>
                    <Legend wrapperStyle={{ fontSize: '9px' }}/>
                    <Line type="monotone" dataKey="Grid"     stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Grid (W)"     connectNulls/>
                    <Line type="monotone" dataKey="Inverter" stroke="#ec4899" strokeWidth={1.5} dot={false} name="Inverter (W)" connectNulls/>
                  </LineChart>
                </ResponsiveContainer>
                ) : <div className="h-full flex items-center justify-center text-slate-500 text-sm">Loading…</div>}
                </div>
              </div>
              <div className="text-xs text-slate-600 text-center pt-1 flex-shrink-0">PZEM-004T (24V 100Ah Lead Acid)</div>
            </div>
          )}
        </div>
      </div>
    );
  };

// ============================================================================
// SSR DETAIL
// [PATCH-OUTLETS] Outlet current/voltage now uses real sensor data from active source
//                 instead of hardcoded 1.2A / 0.8A values.
//                 activeSourceVoltage & activeSourceCurrent computed at top of component.
// ============================================================================
const renderSSRDetail = () => {
  const invV_ssr = systemData.inverterVoltage ?? 0;
  const gridAnom = systemData.gridAnomaly ?? "none";
  const invAnom = systemData.inverterAnomaly ?? "none";
  const isManual = controlAuthority === "manual";
  const isSafetyOverride = controlAuthority === "safety_override";
  const isAuto = controlAuthority === "auto";

  // [FIX-GAP-3] True when safety_override active but ALL critical faults cleared
  const faultsCleared =
    isSafetyOverride &&
    (systemData.gridAnomaly ?? "none") !== "critical" &&
    (systemData.inverterAnomaly ?? "none") !== "critical" &&
    (systemData.batteryAnomaly ?? "none") !== "critical" &&
    (systemData.tempAnomaly ?? "none") !== "critical";

  // [FIX-RPI-LOAD] solarReady — battery must NOT be low (aligned with EnergySystemContext)
  const batLowSSR =
    (systemData.batteryVoltage ?? 0) > 0 &&
    (systemData.batteryVoltage ?? 0) < BAT_WARNING_LOW;
  const solarReady =
    !batLowSSR && (systemData.inverterVoltage ?? 0) >= INV_CRITICAL_LOW;
  const gridReady =
    gridVoltage >= GRID_NORMAL_LOW && gridVoltage <= GRID_NORMAL_HIGH;

  // [v10.0 — ARDUINO v6.2 SYNC]
  const outlet1Energized = SSR4_Closed && K1_Solar && inverterPresent_kiosk && !bothDropped_kiosk;
  const outlet2Energized = SSR4_Closed && K2_Grid  && gridPresent_kiosk    && !bothDropped_kiosk;

  const ssrOutlets = [
    {
      id: 1,
      name: "Outlet 1",
      status: outlet1Energized,
      source: "Solar (K1)",
      hasAnomaly: invAnom !== "none" && K1_Solar,
      load: "Laptop",
      current: outlet1Energized ? acCurrent : 0,
      voltage: outlet1Energized ? acVoltage : 0,
    },
    {
      id: 2,
      name: "Outlet 2",
      status: outlet2Energized,
      source: "Grid (K2)",
      hasAnomaly: gridAnom !== "none" && K2_Grid,
      load: "Monitor",
      current: outlet2Energized ? gridCurrent : 0,
      voltage: outlet2Energized ? gridVoltage : 0,
    },
  ];

  return (
    <div className="relative h-full p-2 sm:p-3 flex flex-col text-white overflow-auto scroll-blue">
      {/* ── HEADER ── */}
      <div className="relative flex items-center justify-between pb-1.5 border-b border-cyan-700/50 flex-shrink-0">
        <button
          onClick={() => navigateTo("main")}
          className="flex items-center gap-1 text-cyan-300 hover:text-cyan-200 transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
          <span className="text-xl">Back</span>
        </button>
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-cyan-400" />
          <span className="text-xl">SSR Control</span>
        </div>
        <div
          className={`w-2.5 h-2.5 rounded-full ${isSafetyOverride ? "bg-red-500 animate-pulse" : isManual ? "bg-amber-400 animate-pulse" : !SSR4_Closed ? "bg-red-500" : "bg-green-500 animate-pulse"}`}
        />
      </div>

      <div className="flex-1 flex flex-col gap-2 py-1.5 min-h-0 overflow-y-auto scroll-blue">
        {/* K4 contactor */}
        <div
          className={`px-2 py-1.5 rounded-lg border flex items-center gap-2 ${SSR4_Closed ? "bg-green-900/30 border-green-600/40" : "bg-red-900/40 border-red-600/60"}`}
        >
          <Shield
            className={`w-4 h-4 ${SSR4_Closed ? "text-green-400" : "text-red-400"} flex-shrink-0`}
          />
          <div className="flex-1">
            <div
              className={`text-sm font-semibold ${SSR4_Closed ? "text-green-300" : "text-red-300"}`}
            >
              K4 Contactor —{" "}
              {SSR4_Closed
                ? "CLOSED (Normal)"
                : "OPEN (Shutdown / Safe Mode)"}
            </div>
            <div className="text-xs text-slate-400">
              {SSR4_Closed && noGrid && batDepleted
                ? `🔴 No Grid + Battery Depleted (${batteryVoltage.toFixed(1)}V) — Battery Sustaining Load`
                : SSR4_Closed && noGrid && batLow
                  ? `⚠️ No Grid + Battery Low (${batteryVoltage.toFixed(1)}V) — Battery Sustaining Load`
                  : SSR4_Closed && noGrid
                    ? `Grid Outage — Battery Sustaining Load (${batteryVoltage.toFixed(1)}V)`
                    : SSR4_Closed
                      ? "Battery connected — outlets energized via selected source"
                      : "Battery disconnected — all loads cut (Load Cut Off mode)"}
            </div>
          </div>
        </div>

        {/* Emergency Active Banner */}
        {eStateKiosk !== 'idle' && (
          <div className="px-2 py-1.5 rounded-lg bg-red-900/70 border-2 border-red-500 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-300 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-bold text-red-200">
                {eStateKiosk === 'recovering' ? '🟡 Recovery In Progress' : '🔴 Emergency Shutdown Active'}
              </div>
              <div className="text-xs text-red-300 mt-0.5">
                {eStateKiosk === 'recovering'
                  ? `Restoring in ${recoveryDisplayLeft_kiosk}s… Arduino running recovery.`
                  : 'K1 + K2 OFF · K4 OPEN. Click Recovery to restore.'}
              </div>
            </div>
            {eStateKiosk === 'recovering' && <span className="text-lg font-mono font-bold text-white">{recoveryDisplayLeft_kiosk}s</span>}
          </div>
        )}

        {/* Safety Override */}
        {isSafetyOverride && (
          <div className="px-2 py-1.5 rounded-lg bg-red-900/50 border border-red-500/60 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <div className="flex-1">
              {faultsCleared ? (
                <span className="text-xs text-green-300 font-semibold">✅ All faults cleared — safe to resume.</span>
              ) : (
                <span className="text-xs text-red-300">Safety Override Active — Manual control locked until all faults clear</span>
              )}
            </div>
            {faultsCleared && (
              <button onClick={() => systemData.exitManualMode()} className="ml-2 px-2 py-1 rounded-lg bg-green-900/80 border border-green-500/60 text-green-300 text-xs font-semibold active:scale-95 shrink-0">Clear Override</button>
            )}
          </div>
        )}

        {/* Full Dropout Banner */}
        {bothDropped_kiosk && (
          <div className="px-2 py-1.5 rounded-lg bg-red-900/60 border-2 border-red-500 flex items-center gap-2 animate-pulse">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <div>
              <div className="text-sm font-bold text-red-200">⚡ Full Power Dropout</div>
              <div className="text-xs text-red-300">Grid + Inverter both offline. K4 opened. Buttons disabled.</div>
            </div>
          </div>
        )}

        {/* Partial Dropout Banners */}
        {gridDropped_kiosk && inverterPresent_kiosk && (
          <div className="px-2 py-1.5 rounded-lg bg-orange-900/40 border border-orange-500/50 flex items-center gap-2">
            <AlertCircle className="w-3 h-3 text-orange-400 flex-shrink-0" />
            <span className="text-xs text-orange-300">
              ⚠ Grid offline — K2 cut. Outlet 1 (Solar) still live.
              {k2TimerRunning_kiosk ? ` Grid returned — K2 ON in ${k2DisplayLeft_kiosk}s` : ''}
            </span>
          </div>
        )}
        {inverterDropped_kiosk && gridPresent_kiosk && (
          <div className="px-2 py-1.5 rounded-lg bg-amber-900/40 border border-amber-500/50 flex items-center gap-2">
            <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0" />
            <span className="text-xs text-amber-300">
              ⚠ Inverter offline — K1 cut. Outlet 2 (Grid) still live.
              {k1TimerRunning_kiosk ? ` Inverter returned — K1 ON in ${k1DisplayLeft_kiosk}s` : ''}
            </span>
          </div>
        )}

        {/* Source control: K1 Solar + K2 Grid independent toggles */}
        <div className="p-2 rounded-lg bg-gradient-to-br from-indigo-900/40 to-purple-900/30 border border-indigo-600/40">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Shield className="w-3 h-3 text-indigo-400" />
              <span className="text-sm text-indigo-200">Source Control</span>
            </div>
            <div className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                !SSR4_Closed ? "bg-red-600 text-white"
                : K1_Solar && K2_Grid ? "bg-purple-500 text-white"
                : K1_Solar ? "bg-amber-600 text-white"
                : K2_Grid ? "bg-blue-600 text-white"
                : "bg-slate-600 text-white"}`}>
              {!SSR4_Closed ? "🔴 K4 Open — Cut Off"
                : K1_Solar && K2_Grid ? "☀️⚡ K1 + K2 BOTH ON"
                : K1_Solar ? "☀️ K1 ON — Solar"
                : K2_Grid ? "⚡ K2 ON — Grid"
                : "⏸ No Active Source"}
            </div>
          </div>

          {/* K1 Solar + K2 Grid side-by-side — same as UnifiedSSROutletCard */}
          <div className="grid grid-cols-2 gap-2 mb-2">
          {/* K1 — Solar */}
            <button
              onClick={handleToggleK1_ssr}
              disabled={k1Disabled_kiosk}
              style={k1Disabled_kiosk ? {cursor:'not-allowed'} : {}}
              className={`p-5 rounded-xl border-2 transition-all text-center relative overflow-hidden
                ${k1Disabled_kiosk ? 'bg-slate-800/40 border-amber-900/40'
                : k1TimerRunning_kiosk ? 'bg-amber-900/30 border-amber-600/60'
                : K1_Solar ? 'bg-amber-500 border-amber-600 shadow-lg'
                : 'bg-slate-800/60 border-slate-600 hover:border-amber-500'}
                ${!k1Disabled_kiosk ? 'cursor-pointer active:scale-95' : ''}`}
            >
              {/* ON/OFF/timer badge */}
              <span className={`absolute top-2 right-2 z-10 inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded-full border
                ${k1TimerRunning_kiosk ? 'bg-amber-900/60 text-amber-300 border-amber-500'
                : K1_Solar && !k1Disabled_kiosk ? 'bg-white/20 text-white border-white/30'
                : 'bg-slate-700 text-slate-400 border-slate-600'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${k1TimerRunning_kiosk ? 'bg-amber-400 animate-pulse' : K1_Solar && !k1Disabled_kiosk ? 'bg-white' : 'bg-slate-500'}`} />
                {k1TimerRunning_kiosk ? `${k1DisplayLeft_kiosk}s` : K1_Solar && !k1Disabled_kiosk ? 'ON' : 'OFF'}
              </span>
              <div className="flex flex-col items-center pt-4 gap-2">
                <Sun className={`w-10 h-10 ${k1Disabled_kiosk && !k1TimerRunning_kiosk ? 'text-slate-500' : k1TimerRunning_kiosk ? 'text-amber-400' : K1_Solar ? 'text-white' : 'text-amber-400'}`} />
                <div className={`text-lg font-extrabold ${k1Disabled_kiosk && !k1TimerRunning_kiosk ? 'text-slate-500' : k1TimerRunning_kiosk ? 'text-amber-300' : K1_Solar ? 'text-white' : 'text-slate-200'}`}>Solar</div>
                <div className={`text-sm font-medium ${k1Disabled_kiosk && !k1TimerRunning_kiosk ? 'text-slate-500' : k1TimerRunning_kiosk ? 'text-amber-400' : K1_Solar ? 'text-amber-100' : inverterDropped_kiosk ? 'text-red-400' : 'text-green-400'}`}>
                  {k1TimerRunning_kiosk ? `⏱ Hold-off: ${k1DisplayLeft_kiosk}s`
                    : k1Disabled_kiosk ? '⊘ Disabled'
                    : inverterDropped_kiosk ? '⚠ Inv offline'
                    : K1_Solar ? `${(systemData.inverterVoltage ?? 0).toFixed(1)}V · ${(systemData.inverterFrequency ?? 0).toFixed(1)}Hz`
                    : '✓ Ready'}
                </div>
              </div>
            </button>

            {/* K2 — Grid */}
            <button
              onClick={handleToggleK2_ssr}
              disabled={k2Disabled_kiosk}
              style={k2Disabled_kiosk ? {cursor:'not-allowed'} : {}}
              className={`p-5 rounded-xl border-2 transition-all text-center relative overflow-hidden
                ${k2Disabled_kiosk ? 'bg-slate-800/40 border-blue-900/40'
                : k2TimerRunning_kiosk ? 'bg-blue-900/30 border-blue-600/60'
                : K2_Grid ? 'bg-blue-500 border-blue-600 shadow-lg'
                : 'bg-slate-800/60 border-slate-600 hover:border-blue-500'}
                ${!k2Disabled_kiosk ? 'cursor-pointer active:scale-95' : ''}`}
            >
              {/* ON/OFF/timer badge */}
              <span className={`absolute top-2 right-2 z-10 inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded-full border
                ${k2TimerRunning_kiosk ? 'bg-blue-900/60 text-blue-300 border-blue-500'
                : K2_Grid && !k2Disabled_kiosk ? 'bg-white/20 text-white border-white/30'
                : 'bg-slate-700 text-slate-400 border-slate-600'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${k2TimerRunning_kiosk ? 'bg-blue-400 animate-pulse' : K2_Grid && !k2Disabled_kiosk ? 'bg-white' : 'bg-slate-500'}`} />
                {k2TimerRunning_kiosk ? `${k2DisplayLeft_kiosk}s` : K2_Grid && !k2Disabled_kiosk ? 'ON' : 'OFF'}
              </span>
              <div className="flex flex-col items-center pt-4 gap-2">
                <Zap className={`w-10 h-10 ${k2Disabled_kiosk && !k2TimerRunning_kiosk ? 'text-slate-500' : k2TimerRunning_kiosk ? 'text-blue-400' : K2_Grid ? 'text-white' : 'text-blue-400'}`} />
                <div className={`text-lg font-extrabold ${k2Disabled_kiosk && !k2TimerRunning_kiosk ? 'text-slate-500' : k2TimerRunning_kiosk ? 'text-blue-300' : K2_Grid ? 'text-white' : 'text-slate-200'}`}>Grid</div>
                <div className={`text-sm font-medium ${k2Disabled_kiosk && !k2TimerRunning_kiosk ? 'text-slate-500' : k2TimerRunning_kiosk ? 'text-blue-400' : K2_Grid ? 'text-blue-100' : gridDropped_kiosk ? 'text-red-400' : 'text-green-400'}`}>
                  {k2TimerRunning_kiosk ? `⏱ Hold-off: ${k2DisplayLeft_kiosk}s`
                    : k2Disabled_kiosk ? '⊘ Disabled'
                    : gridDropped_kiosk ? '⚠ Grid offline'
                    : K2_Grid ? `${gridVoltage.toFixed(1)}V · ${gridFrequency.toFixed(1)}Hz`
                    : '✓ Stable'}
                </div>
              </div>
            </button>
          </div>


          {/* Emergency / Recovery — 3-state machine */}
          {eStateKiosk === 'idle' ? (
            <button onClick={() => handleEmergency_ssr()}
              className="mt-2 w-full p-4 rounded-xl border-2 transition-all text-center bg-red-600 border-red-700 text-white shadow-lg hover:bg-red-700 cursor-pointer active:scale-95">
              <AlertTriangle className="w-5 h-5 mx-auto mb-1" />
              <div className="text-sm font-bold">Emergency Shutdown</div>
              <div className="text-xs mt-0.5 text-red-200">K1 + K2 OFF · K4 OPEN</div>
            </button>
          ) : eStateKiosk === 'recovering' ? (
            <button disabled className="mt-2 w-full p-4 rounded-xl border-2 text-center bg-amber-600 border-amber-700 text-white shadow-lg cursor-not-allowed opacity-90">
              <Clock className="w-5 h-5 mx-auto mb-1" />
              <div className="text-sm font-bold">⏱ Restoring in {recoveryDisplayLeft_kiosk}s…</div>
              <div className="text-xs mt-0.5 text-amber-200">Arduino running recovery — wait</div>
            </button>
          ) : (
            <button onClick={() => handleRecovery_ssr()}
              className="mt-2 w-full p-4 rounded-xl border-2 transition-all text-center bg-green-600 border-green-700 text-white shadow-lg hover:bg-green-700 cursor-pointer active:scale-95">
              <Activity className="w-5 h-5 mx-auto mb-1" />
              <div className="text-sm font-bold">⚡ Recovery — Restore Power</div>
              <div className="text-xs mt-0.5 text-green-200">Arduino restores K4 + K1/K2 after 15s</div>
            </button>
          )}
        </div>

        {/* Relay status grid */}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            {
              label: "K1",
              color: k1TimerRunning_kiosk ? "bg-amber-400 animate-pulse" : K1_Solar && inverterPresent_kiosk ? "bg-amber-500 animate-pulse" : "bg-slate-600",
              bg: k1TimerRunning_kiosk ? "bg-amber-900/40 border-amber-500" : K1_Solar && inverterPresent_kiosk ? "bg-amber-900/40 border-amber-500" : "bg-slate-800/40 border-slate-600",
              text: k1TimerRunning_kiosk ? `${k1DisplayLeft_kiosk}s` : K1_Solar && inverterPresent_kiosk ? "ON ✓" : "OFF",
              sub: k1TimerRunning_kiosk ? "Hold-off" : "Solar Path",
            },
            {
              label: "K2",
              color: k2TimerRunning_kiosk ? "bg-blue-400 animate-pulse" : K2_Grid && gridPresent_kiosk ? "bg-blue-500 animate-pulse" : "bg-slate-600",
              bg: k2TimerRunning_kiosk ? "bg-blue-900/40 border-blue-500" : K2_Grid && gridPresent_kiosk ? "bg-blue-900/40 border-blue-500" : "bg-slate-800/40 border-slate-600",
              text: k2TimerRunning_kiosk ? `${k2DisplayLeft_kiosk}s` : K2_Grid && gridPresent_kiosk ? "ON ✓" : "OFF",
              sub: k2TimerRunning_kiosk ? "Hold-off" : "Grid Path",
            },
            {
              label: "K4",
              color: eStateKiosk === 'recovering' ? "bg-amber-400 animate-pulse" : SSR4_Closed ? "bg-green-500 animate-pulse" : "bg-red-500 animate-pulse",
              bg: eStateKiosk === 'recovering' ? "bg-amber-900/40 border-amber-500" : SSR4_Closed ? "bg-green-900/30 border-green-600" : "bg-red-900/40 border-red-500",
              text: eStateKiosk === 'recovering' ? `${recoveryDisplayLeft_kiosk}s` : SSR4_Closed ? "CLOSED" : "OPEN",
              sub: eStateKiosk === 'recovering' ? "Restoring" : "DC Contactor",
            },
          ].map(({ label, color, bg, text, sub }) => (
            <div key={label} className={`p-2 rounded-xl border-2 ${bg}`}>
              <div className="text-center">
                <div className="text-sm text-slate-300 mb-1 font-bold tracking-wide">
                  {label}
                </div>
                <div className={`w-3 h-3 mx-auto rounded-full ${color}`} />
                <div className="text-base text-slate-200 mt-1 font-black">
                  {text}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Switch & Recovery Stats */}
        <div className="grid grid-cols-2 gap-2 flex-shrink-0">
          <div className="rounded-xl border border-indigo-600/40 bg-indigo-900/20 px-3 py-2.5 flex items-center gap-3">
            <ArrowLeftRight className="w-5 h-5 text-indigo-400 flex-shrink-0"/>
            <div>
              <div className="text-xs text-slate-400 leading-tight">Total Switches</div>
              <div className="text-2xl font-black text-indigo-300 leading-none tabular-nums">{totalSwitches}</div>
              <div className="text-xs text-slate-500 leading-tight mt-0.5">Last: {lastSwitchTime}</div>
            </div>
          </div>
          <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 ${totalRecoveries > 0 ? 'border-amber-500/50 bg-amber-900/20' : 'border-slate-600/40 bg-slate-800/30'}`}>
            <Shield className={`w-5 h-5 flex-shrink-0 ${totalRecoveries > 0 ? 'text-amber-400' : 'text-slate-500'}`}/>
            <div>
              <div className="text-xs text-slate-400 leading-tight">Recoveries</div>
              <div className={`text-2xl font-black leading-none tabular-nums ${totalRecoveries > 0 ? 'text-amber-300' : 'text-slate-500'}`}>{totalRecoveries}</div>
              <div className="text-xs text-slate-500 leading-tight mt-0.5">Emergency restores</div>
            </div>
          </div>
        </div>

        {/* Outlet Control Panel */}
        <div className="flex flex-col gap-2 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Power className="w-5 h-5 text-slate-300" />
            <span className="text-base font-bold text-slate-200">Outlet Control Panel</span>
            <span className={`ml-auto text-sm px-3 py-1 rounded-full font-bold border ${
                !SSR4_Closed ? "bg-red-900/50 text-red-400 border-red-600/50"
                : outlet1Energized || outlet2Energized ? "bg-green-900/50 text-green-300 border-green-600/50"
                : "bg-slate-700/60 text-slate-400 border-slate-500/50"}`}>
              {!SSR4_Closed ? "🔴 K4 OPEN" : outlet1Energized || outlet2Energized ? "⚡ LIVE" : "⚫ NO PATH"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {ssrOutlets.map((outlet) => {
              const isEnergized = outlet.status;
              const isSolar = outlet.source.includes("Solar");
              const isGrid  = outlet.source.includes("Grid");
              const srcAccent = isSolar
                ? { ring: "border-amber-500/80", bg: "bg-amber-900/40", text: "text-amber-300", dot: "bg-amber-400" }
                : isGrid
                ? { ring: "border-blue-500/80",  bg: "bg-blue-900/40",  text: "text-blue-300",  dot: "bg-blue-400"  }
                : { ring: "border-slate-500/40",  bg: "bg-slate-700/30", text: "text-slate-400", dot: "bg-slate-500" };

              return (
                <div key={outlet.id}
                  className={`rounded-xl border-2 overflow-hidden transition-all ${
                    isEnergized ? "border-green-500/70 bg-slate-800/80" : "border-slate-600/60 bg-slate-800/50"
                  }`}
                  style={isEnergized ? { boxShadow: "0 0 16px rgba(74,222,128,0.18)" } : {}}>

                  {/* ── Header ── */}
                  <div className={`flex items-center justify-between px-4 py-4 border-b ${
                    isEnergized ? "border-green-500/20 bg-green-900/20" : "border-slate-700/40 bg-slate-700/20"}`}>
                    <div className="flex items-center gap-3">
                      <div className={`p-2.5 rounded-xl ${isEnergized ? "bg-green-500" : "bg-slate-600"}`}>
                        <Power className="w-6 h-6 text-white" />
                      </div>
                      <div>
                        <div className="text-xl font-bold text-slate-100 leading-tight">{outlet.name}</div>
                        <div className="text-sm text-slate-400 leading-tight">{outlet.load}</div>
                      </div>
                    </div>
                    <span className={`text-base font-black px-4 py-1.5 rounded-full ${
                      isEnergized ? "bg-green-500 text-white" : "bg-slate-600 text-slate-400"}`}>
                      {isEnergized ? "ON" : "OFF"}
                    </span>
                  </div>

                  {/* ── Source badge ── */}
                  <div className={`mx-3 mt-3 px-3 py-2.5 rounded-xl border flex items-center gap-2 ${srcAccent.bg} ${srcAccent.ring}`}>
                    <span className={`w-3 h-3 rounded-full flex-shrink-0 ${srcAccent.dot} ${isEnergized ? 'animate-pulse' : ''}`}/>
                    <span className="text-base text-slate-400">Source</span>
                    <span className={`ml-auto text-base font-bold ${srcAccent.text}`}>{outlet.source}</span>
                  </div>

                  {/* ── Metrics ── */}
                  <div className="grid grid-cols-3 gap-2 px-3 py-3">
                    {[
                      { label: "Current", value: outlet.current.toFixed(2), unit: "A" },
                      { label: "Voltage", value: outlet.voltage.toFixed(1),  unit: "V" },
                      { label: "Power",   value: (outlet.current * outlet.voltage).toFixed(0), unit: "W" },
                    ].map(({ label, value, unit }) => (
                      <div key={label} className="text-center bg-slate-700/50 rounded-xl py-4 px-1">
                        <div className="text-sm text-slate-400 mb-1 font-medium">{label}</div>
                        <div className={`text-2xl font-black leading-none ${isEnergized ? "text-white" : "text-slate-500"}`}>{value}</div>
                        <div className={`text-sm font-semibold mt-1 ${isEnergized ? "text-slate-400" : "text-slate-600"}`}>{unit}</div>
                      </div>
                    ))}
                  </div>

                  {/* ── Anomaly ── */}
                  {outlet.hasAnomaly && isEnergized && (
                    <div className="mx-3 mb-3 px-3 py-2 rounded-xl bg-red-900/50 border border-red-500/50 flex items-center gap-2">
                      <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                      <span className="text-base text-red-300">Voltage anomaly on source</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// THEME SELECTOR
// ============================================================================
  const renderThemeSelector = () => (
  <div className="relative h-full p-3 sm:p-4 md:p-6 flex flex-col text-white overflow-auto">
    <div className="flex items-center justify-between pb-3 border-b border-purple-700/50">
      <button
        onClick={() => navigateTo("main")}
        className="flex items-center gap-1 text-purple-300 hover:text-purple-200 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
        <span className="text-xs sm:text-sm">Back</span>
      </button>
      <div className="flex items-center gap-2">
        <Palette className="w-5 h-5 text-purple-400" />
        <span className="text-sm sm:text-base">Display Theme</span>
      </div>
      <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
    </div>
    <div className="flex-1 flex flex-col justify-center py-4">
      <div className="text-center mb-6">
        <h3 className="text-lg sm:text-xl mb-2">Choose Display Theme</h3>
        <p className="text-xs sm:text-sm text-slate-400">
          Select a color theme for your LCD display
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => {
              setSelectedTheme(theme);
              navigateTo("main");
            }}
            className={`p-4 rounded-xl border-2 transition-all ${selectedTheme.id === theme.id ? "border-white shadow-2xl scale-105" : "border-slate-600 hover:border-slate-400"}`}
          >
            <div
              className={`h-24 sm:h-32 rounded-lg bg-gradient-to-br ${theme.gradient} mb-3 flex items-center justify-center`}
            >
              <div className={`text-2xl sm:text-3xl ${theme.textColor}`}>
                {theme.id === "default"
                  ? "Ocean"
                  : theme.id === "sunset"
                    ? "Sunset"
                    : theme.id === "forest"
                      ? "Forest"
                      : "Midnight"}
              </div>
            </div>
            <div className="text-sm sm:text-base mb-1">{theme.name}</div>
            {selectedTheme.id === theme.id && (
              <div className="text-xs text-green-400">Active</div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-6 p-3 rounded-lg bg-purple-900/30 border border-purple-600/40">
        <p className="text-xs text-center text-purple-200">
          Theme will be applied to the LCD display background
        </p>
      </div>
    </div>
    </div>
  );

// ============================================================================
// RENDER
// ============================================================================
  const renderView = () => {
    switch (currentView) {
      case "grid":    return renderGridDetail();
      case "solar":   return renderSolarDetail();
      case "battery": return renderBatteryDetail();
      case "panels":  return renderPanelsDetail();
      case "graph":   return renderGraphDetail();
      case "ssr":     return renderSSRDetail();
      case "theme":   return renderThemeSelector();
      default:        return renderMainMenu();
    }
  };

  return (
    <>
      <style>{slideUpStyle}</style>
      <div
        className={`w-full h-full bg-gradient-to-br ${selectedTheme.gradient} overflow-hidden relative`}
      >
        <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.05)_50%)] bg-[length:100%_4px] pointer-events-none z-10" />
        <div key={currentView} className={`absolute inset-0 z-20 ${animClass}`}>
          {renderView()}
        </div>
        {showScreensaver && (
          <div style={{position:"fixed",inset:0,zIndex:9998}}>
            <EnergyFlowScreensaver onWake={() => setShowScreensaver(false)} />
          </div>
        )}
      </div>
    </>
  );
}
