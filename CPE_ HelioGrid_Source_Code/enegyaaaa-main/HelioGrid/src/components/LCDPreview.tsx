import { Monitor, Battery, Sun, Zap, Activity, Clock, AlertTriangle, Thermometer, Wifi, Shield, ChevronLeft, TrendingUp, TrendingDown, ArrowLeftRight, Palette } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useEnergySystem } from '../contexts/EnergySystemContext';
import { EnergyFlowScreensaver } from './cards/Energyflowscreensaver';
import * as api from '../utils/api';
import solarImg from '../assets/44.jpg';

type ViewType = 'main' | 'grid' | 'solar' | 'battery' | 'panels' | 'graph' | 'ssr' | 'theme' | 'screensaver';
type ControlModeType = 'solar' | 'grid' | 'shutdown' | 'failsafe';

interface Theme {
  id: string;
  name: string;
  gradient: string;
  borderColor: string;
  textColor: string;
}

const themes: Theme[] = [
  { id: 'default',  name: 'Ocean Blue',      gradient: 'from-slate-950 via-blue-950 to-slate-950',   borderColor: 'border-blue-700',   textColor: 'text-blue-400' },
  { id: 'sunset',   name: 'Sunset Orange',   gradient: 'from-slate-950 via-orange-950 to-slate-950', borderColor: 'border-orange-700', textColor: 'text-orange-400' },
  { id: 'forest',   name: 'Forest Green',    gradient: 'from-slate-950 via-green-950 to-slate-950',  borderColor: 'border-green-700',  textColor: 'text-green-400' },
  { id: 'midnight', name: 'Midnight Purple', gradient: 'from-slate-950 via-purple-950 to-slate-950', borderColor: 'border-purple-700', textColor: 'text-purple-400' },
];

const SCREENSAVER_IDLE_MS = 30_000;

// ── Upward slide transition styles ─────────────────────────────────────────
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
`;

export function LCDPreview() {
  const systemData = useEnergySystem();

  const [currentView, setCurrentView]               = useState<ViewType>('main');
  const [animClass, setAnimClass]                   = useState('animate-slide-up');
  const [selectedTheme, setSelectedTheme]           = useState<Theme>(themes[0]);
  const [isDataLoaded, setIsDataLoaded]             = useState(false);
  const [localOutlet1Status, setLocalOutlet1Status] = useState(false);
  const [localOutlet2Status, setLocalOutlet2Status] = useState(false);
  const [localControlMode, setLocalControlMode]     = useState<ControlModeType>('solar');
  const [localAutoSwitchEnabled, setLocalAutoSwitchEnabled] = useState(true);
  const [graphSlide, setGraphSlide]                 = useState(0);
  const [balanceData, setBalanceData]               = useState<any[]>([]);
  const [consumptionData, setConsumptionData]       = useState<any[]>([]);
  const [totals, setTotals]                         = useState({ solar: 0, grid: 0, battery: 0 });
  const [touchStartX, setTouchStartX]               = useState<number | null>(null);

  const resetIdleTimer = useCallback(() => {}, []);

  // ── Navigate with upward slide (forward) or downward (back to main) ───────
  const navigateTo = (view: ViewType) => {
    const goingBack = view === 'main';
    setAnimClass(goingBack ? 'animate-slide-down' : 'animate-slide-up');
    setCurrentView(view);
  };

  useEffect(() => {
    if (currentView === 'screensaver') return;
    const id = setTimeout(() => {
      setAnimClass('animate-slide-up');
      setCurrentView('screensaver');
    }, SCREENSAVER_IDLE_MS);
    return () => clearTimeout(id);
  }, [currentView]);

  const wakeFromScreensaver = () => {
    setAnimClass('animate-slide-down');
    setCurrentView('main');
  };

  useEffect(() => {
    if (systemData.gridVoltage !== undefined && systemData.gridVoltage !== 0) setIsDataLoaded(true);
  }, [systemData.gridVoltage]);

  useEffect(() => {
    if (!isDataLoaded) return;
    setLocalOutlet1Status(systemData.outlet1Status);
    setLocalOutlet2Status(systemData.outlet2Status);
    const safeMode = (['solar', 'grid', 'shutdown', 'failsafe'] as const)
      .includes(systemData.controlMode as ControlModeType)
        ? (systemData.controlMode as ControlModeType) : 'grid';
    setLocalControlMode(safeMode);
    setLocalAutoSwitchEnabled(systemData.autoSwitchEnabled);
  }, [isDataLoaded, systemData.outlet1Status, systemData.outlet2Status, systemData.controlMode, systemData.autoSwitchEnabled]);

  const acVoltage_raw   = systemData.inverterVoltage ?? 0;
  const acCurrent_raw   = systemData.inverterCurrent ?? 0;
  const solarPower_raw  = systemData.solarPower      ?? 0;
  const battCurrent_raw = Math.abs(systemData.batteryCurrent ?? 0);
  const battVoltage_raw = systemData.batteryVoltage  ?? 0;

  useEffect(() => {
    const fetch1 = async () => {
      try {
        const history = await api.getSensorHistory(24);
        if (history && history.length > 0) {
          const data = (history as any[]).map((raw: any) => {
            const time      = new Date(raw.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const solarPwr  = raw.solar?.power     ?? 0;
            const gridPwr   = raw.grid?.power      ?? 0;
            const invV      = raw.inverter?.voltage ?? 0;
            const invI      = raw.inverter?.current ?? 0;
            const totalLoad = invV * invI;
            const totalSup  = solarPwr + gridPwr;
            return {
              time,
              solarSupply: parseFloat(solarPwr.toFixed(1)),
              gridSupply:  parseFloat(gridPwr.toFixed(1)),
              totalSupply: parseFloat(totalSup.toFixed(1)),
              totalLoad:   parseFloat(totalLoad.toFixed(1)),
            };
          }).reverse();
          setBalanceData(data);
        } else {
          const invPwr = acVoltage_raw * acCurrent_raw;
          setBalanceData([{ time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), solarSupply: parseFloat(solarPower_raw.toFixed(1)), gridSupply: 0, totalSupply: parseFloat(solarPower_raw.toFixed(1)), totalLoad: parseFloat(invPwr.toFixed(1)) }]);
        }
      } catch { setBalanceData([]); }
    };
    fetch1();
    const iv = setInterval(fetch1, 30000);
    return () => clearInterval(iv);
  }, [acVoltage_raw, acCurrent_raw, solarPower_raw]);

  useEffect(() => {
    const fetch2 = async () => {
      try {
        const history = await api.getSensorHistory(24);
        if (history && history.length > 0) {
          const data = (history as any[]).map((raw: any) => {
            const time    = new Date(raw.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const solPwr  = raw.solar?.power    ?? 0;
            const gridPwr = raw.grid?.power     ?? 0;
            const batV    = raw.battery?.voltage ?? 0;
            const batI    = raw.battery?.current ?? 0;
            const batDis  = batI < 0 ? Math.abs(batI) * batV : 0;
            return { time, Solar: parseFloat(solPwr.toFixed(1)), Grid: parseFloat(gridPwr.toFixed(1)), Battery: parseFloat(batDis.toFixed(1)) };
          }).reverse();
          setConsumptionData(data);
          const ih = 5 / 3600;
          setTotals({
            solar:   parseFloat(data.reduce((s: number, d: any) => s + d.Solar   * ih, 0).toFixed(2)),
            grid:    parseFloat(data.reduce((s: number, d: any) => s + d.Grid    * ih, 0).toFixed(2)),
            battery: parseFloat(data.reduce((s: number, d: any) => s + d.Battery * ih, 0).toFixed(2)),
          });
        } else {
          const batDis = battCurrent_raw < 0 ? Math.abs(battCurrent_raw) * battVoltage_raw : 0;
          setConsumptionData([{ time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), Solar: parseFloat(solarPower_raw.toFixed(1)), Grid: 0, Battery: parseFloat(batDis.toFixed(1)) }]);
        }
      } catch { setConsumptionData([]); }
    };
    fetch2();
    const iv = setInterval(fetch2, 30000);
    return () => clearInterval(iv);
  }, [battCurrent_raw, battVoltage_raw, solarPower_raw]);

  // ── Derived values ────────────────────────────────────────────────────────
  const gridVoltage       = systemData.gridVoltage       ?? 0;
  const gridCurrent       = systemData.inverterCurrent   ?? 0;
  const gridFrequency     = systemData.gridFrequency     ?? 60;
  const solarVoltage      = systemData.solarVoltage      ?? 0;
  const solarCurrent      = systemData.solarCurrent      ?? 0;
  const acVoltage         = systemData.inverterVoltage   ?? 0;
  const acCurrent         = systemData.inverterCurrent   ?? 0;
  const inverterFrequency = systemData.inverterFrequency ?? 60;
  const batteryHealth     = systemData.batterySOC        ?? 0;
  const batteryVoltage    = systemData.batteryVoltage    ?? 0;
  const batteryCurrent    = Math.abs(systemData.batteryCurrent ?? 0);
  const systemTemp        = systemData.systemTemp        ?? 25;
  const solarPower        = systemData.solarPower        ?? 0;
  const contactorClosed   = systemData.contactorClosed   ?? true;
  const gridAssistActive  = systemData.k3Active         ?? false;
  const tempAnomaly       = systemData.tempAnomaly       ?? 'none';
  const batteryAnomaly    = systemData.batteryAnomaly    ?? 'none';
  const solarAnomaly      = systemData.solarAnomaly      ?? 'none';

  const K1_Solar        = localControlMode === 'solar';
  const K2_Grid         = localControlMode === 'grid' || localControlMode === 'failsafe';
  const K3_GridAssist   = gridAssistActive;
  const outletEnergized = contactorClosed && (K1_Solar || K2_Grid);

  const getTempStatus = (t: number) => {
    if (t >= 60) return { color: 'text-red-500',   bg: 'bg-red-500/30' };
    if (t >= 50) return { color: 'text-amber-400', bg: 'bg-amber-500/30' };
    return               { color: 'text-green-400', bg: 'bg-green-500/30' };
  };

  const gridPower    = (gridVoltage * gridCurrent).toFixed(1);
  const acPower      = (acVoltage * acCurrent).toFixed(1);
  const batteryPower = (batteryVoltage * batteryCurrent).toFixed(1);

  const gridStatus       = gridVoltage >= 200 && gridVoltage <= 240 ? 'Stable' : gridVoltage > 0 ? 'Unstable' : 'No Power';
  const solarDCStatus    = solarVoltage >= 16 ? 'Good' : solarVoltage > 0 ? 'Low' : 'No Output';
  const inverterACStatus = acVoltage >= 200 && acVoltage <= 240 && inverterFrequency >= 59 && inverterFrequency <= 61 ? 'Stable' : acVoltage > 0 ? 'Unstable' : 'Off';
  const batteryStatus    = batteryHealth >= 80 ? 'Excellent' : batteryHealth >= 60 ? 'Good' : batteryHealth >= 40 ? 'Fair' : batteryHealth >= 20 ? 'Low' : 'Critical';

  const outlets = [
    { id: 1, name: 'Outlet 1', status: outletEnergized && localOutlet1Status, source: K1_Solar ? 'Solar Inverter' : K2_Grid ? 'Grid' : 'OFF', load: 'Laptop',  current: 1.2, voltage: K1_Solar ? acVoltage : gridVoltage },
    { id: 2, name: 'Outlet 2', status: outletEnergized && localOutlet2Status, source: K1_Solar ? 'Solar Inverter' : K2_Grid ? 'Grid' : 'OFF', load: 'Monitor', current: 0.8, voltage: K1_Solar ? acVoltage : gridVoltage },
  ];

  const handleModeChange = (mode: 'solar' | 'grid' | 'shutdown') => {
    if (localAutoSwitchEnabled) return;
    if ((tempAnomaly === 'critical' || batteryAnomaly === 'critical') && mode !== 'shutdown') return;
    setLocalControlMode(mode);
  };

  const TOTAL_SLIDES = 3;
  const handleTouchStart = (e: React.TouchEvent) => setTouchStartX(e.touches[0].clientX);
  const handleTouchEnd   = (e: React.TouchEvent) => {
    if (touchStartX === null) return;
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 40) {
      if (diff > 0 && graphSlide < TOTAL_SLIDES - 1) setGraphSlide(s => s + 1);
      if (diff < 0 && graphSlide > 0)               setGraphSlide(s => s - 1);
    }
    setTouchStartX(null);
  };

  // ========== MAIN MENU ==========
  const renderMainMenu = () => (
    <div className="relative h-full p-3 sm:p-4 md:p-6 flex flex-col text-white">
      <div className="flex items-center justify-between pb-2 sm:pb-3 border-b border-blue-700/50">
        <div className="flex items-center gap-2">
          <div className="h-6 sm:h-8 md:h-10 w-6 sm:w-8 md:w-10 bg-blue-500 rounded-full flex items-center justify-center">
            <Zap className="w-3 sm:w-4 md:w-5 h-3 sm:h-4 md:h-5 text-white" />
          </div>
          <span className="text-xs sm:text-sm text-slate-200">HelioGrid</span>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <div className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border ${getTempStatus(systemTemp).bg} ${systemTemp >= 60 ? 'border-red-500/40' : systemTemp >= 50 ? 'border-orange-500/40' : 'border-green-500/40'}`}>
            <Thermometer className={`w-2.5 h-2.5 sm:w-3 sm:h-3 ${getTempStatus(systemTemp).color}`} />
            <span className={`text-xs ${getTempStatus(systemTemp).color}`}>{systemTemp.toFixed(1)}°C</span>
          </div>
          <button onClick={() => navigateTo('theme')} className="p-1.5 sm:p-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 transition-all active:scale-95">
            <Palette className="w-3 h-3 sm:w-4 sm:h-4 text-purple-300" />
          </button>
          <Wifi className="w-3 h-3 sm:w-4 sm:h-4 text-green-400" />
          <div className="flex items-center gap-1 text-xs">
            <Clock className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="hidden sm:inline">{new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      </div>
      <div className="flex-1 grid grid-cols-2 gap-2 sm:gap-3 md:gap-4 py-3">
        <button onClick={() => navigateTo('grid')} className="bg-gradient-to-br from-blue-900/60 to-cyan-800/30 hover:from-blue-800/70 hover:to-cyan-700/40 backdrop-blur-sm rounded-lg border border-blue-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
          <div className="flex items-center gap-1 sm:gap-2 mb-2"><Zap className="w-4 h-4 sm:w-5 sm:h-5 text-blue-400 flex-shrink-0" /><span className="text-xs sm:text-sm text-blue-200">Grid Monitoring</span></div>
          <div className="flex-1 flex items-center justify-center"><div className="text-center"><div className="text-2xl sm:text-3xl md:text-4xl text-blue-400 leading-none mb-1">{gridVoltage.toFixed(0)}V</div><div className="text-xs text-blue-300/80">{gridStatus}</div></div></div>
        </button>
        <button onClick={() => navigateTo('solar')} className="bg-gradient-to-br from-amber-900/60 to-yellow-800/30 hover:from-amber-800/70 hover:to-yellow-700/40 backdrop-blur-sm rounded-lg border border-yellow-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
          <div className="flex items-center gap-1 sm:gap-2 mb-2"><Sun className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400 flex-shrink-0" /><span className="text-xs sm:text-sm text-yellow-200">Solar Monitoring</span></div>
          <div className="flex-1 flex items-center justify-center"><div className="text-center"><div className="text-2xl sm:text-3xl md:text-4xl text-yellow-400 leading-none mb-1">{solarVoltage.toFixed(1)}V</div><div className="text-xl sm:text-2xl">☀️</div></div></div>
        </button>
        <button onClick={() => navigateTo('battery')} className="bg-gradient-to-br from-green-900/60 to-emerald-800/30 hover:from-green-800/70 hover:to-emerald-700/40 backdrop-blur-sm rounded-lg border border-green-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
          <div className="flex items-center gap-1 sm:gap-2 mb-2"><Battery className="w-4 h-4 sm:w-5 sm:h-5 text-green-400 flex-shrink-0" /><span className="text-xs sm:text-sm text-green-200">Battery Health</span></div>
          <div className="flex-1 flex items-center justify-center"><div className="text-center"><div className="text-2xl sm:text-3xl md:text-4xl text-green-400 leading-none mb-1">{batteryHealth.toFixed(0)}%</div><div className="text-xs text-green-300/80">{batteryStatus}</div></div></div>
        </button>
        <button onClick={() => navigateTo('panels')} className="bg-gradient-to-br from-orange-900/60 to-red-800/30 hover:from-orange-800/70 hover:to-red-700/40 backdrop-blur-sm rounded-lg border border-orange-700/40 p-3 sm:p-4 flex flex-col shadow-lg transition-all active:scale-95 cursor-pointer">
          <div className="flex items-center gap-1 sm:gap-2 mb-2"><Sun className="w-4 h-4 sm:w-5 sm:h-5 text-orange-400 flex-shrink-0" /><span className="text-xs sm:text-sm text-orange-200">Solar Panels</span></div>
          <div className="flex-1 flex items-center justify-center"><div className="text-center"><div className="text-xl sm:text-2xl md:text-3xl text-orange-400 leading-none mb-1">4 Panels</div><div className="text-xs text-orange-300/80">4P · 41V · 2.2kW</div></div></div>
        </button>
      </div>
      <button onClick={() => navigateTo('graph')} className="mb-2 bg-gradient-to-br from-purple-900/60 to-pink-800/30 hover:from-purple-800/70 hover:to-pink-700/40 backdrop-blur-sm rounded-lg border border-purple-700/40 p-3 flex items-center justify-between shadow-lg transition-all active:scale-95 cursor-pointer">
        <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-purple-400" /><span className="text-sm text-purple-200">Real-time Graph</span></div>
        <div className="text-xs text-purple-300">Tap to view →</div>
      </button>
      <button onClick={() => navigateTo('ssr')} className="mb-2 bg-gradient-to-br from-cyan-900/60 to-indigo-800/30 hover:from-cyan-800/70 hover:to-indigo-700/40 backdrop-blur-sm rounded-lg border border-cyan-700/40 p-3 flex items-center justify-between shadow-lg transition-all active:scale-95 cursor-pointer">
        <div className="flex items-center gap-2"><ArrowLeftRight className="w-5 h-5 text-cyan-400" /><span className="text-sm text-cyan-200">SSR Control</span></div>
        <div className="text-xs text-cyan-300">Manage outlets →</div>
      </button>
      <div className="bg-blue-900/30 backdrop-blur-sm rounded-lg px-2 sm:px-3 py-1.5 flex items-center justify-between border border-blue-700/20">
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${contactorClosed ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <span className={`text-xs ${contactorClosed ? 'text-green-300' : 'text-red-300'}`}>{contactorClosed ? 'System Active' : '⚠ Safe Mode'}</span>
        </div>
        <div className="text-xs text-blue-400">v2.1.4</div>
      </div>
    </div>
  );

  // ========== GRID DETAIL ==========
  const renderGridDetail = () => {
    const gridPowerBarPct = Math.min(100, (parseFloat(gridPower) / 500) * 100);
    const voltageBarPct   = Math.min(100, (gridVoltage / 250) * 100);
    const currentBarPct   = Math.min(100, (gridCurrent / 10) * 100);
    const freqBarPct      = Math.min(100, ((gridFrequency - 55) / 10) * 100);
    return (
      <div className="relative h-full p-3 sm:p-4 flex flex-col text-white overflow-hidden">
        <div className="flex items-center justify-between pb-3 border-b border-blue-600/60 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-blue-300 hover:text-blue-200 transition-colors">
            <ChevronLeft className="w-4 h-4" /><span className="text-sm">Back</span>
          </button>
          <div className="flex items-center gap-2"><Zap className="w-5 h-5 text-blue-400" /><span className="text-base">Grid Monitoring</span></div>
          <div className={`w-3 h-3 rounded-full ${gridStatus === 'Stable' ? 'bg-green-500' : gridStatus === 'Unstable' ? 'bg-yellow-500' : 'bg-red-500'} animate-pulse`} />
        </div>
        <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 pt-3 min-h-0">
          {/* CARD 1 — Voltage */}
          <div style={{ border: '2px solid #60a5fa', boxShadow: '0 0 12px rgba(96,165,250,0.5)' }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Zap className="w-5 h-5 text-blue-400" /><span className="text-base text-slate-200 font-semibold">Voltage</span></div>
              <span className={`text-base font-semibold ${gridStatus === 'Stable' ? 'text-green-400' : gridStatus === 'Unstable' ? 'text-yellow-400' : 'text-red-400'}`}>{gridStatus}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-4xl text-blue-400 leading-none drop-shadow-[0_0_8px_rgba(96,165,250,0.6)]">{gridVoltage.toFixed(0)}</span>
              <span className="text-sm text-blue-300 mb-1">V</span>
              <div className="ml-auto">{gridVoltage > 220 ? <TrendingUp className="w-5 h-5 text-green-400" /> : gridVoltage < 220 ? <TrendingDown className="w-5 h-5 text-red-400" /> : null}</div>
            </div>
            <div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div className={`h-full rounded-full transition-all duration-700 ${gridStatus === 'Stable' ? 'bg-gradient-to-r from-blue-700 to-blue-400' : gridStatus === 'Unstable' ? 'bg-gradient-to-r from-yellow-700 to-yellow-400' : 'bg-gradient-to-r from-red-700 to-red-400'}`} style={{ width: `${voltageBarPct}%` }} />
              </div>
              <div className="flex justify-between text-sm text-slate-500"><span>0V</span><span>200V</span><span>250V max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-blue-700/40 pt-3">
              <span className="text-base text-slate-400">Nom. Range</span><span className="text-lg text-blue-300">200 – 240V</span>
            </div>
          </div>
          {/* CARD 2 — Current */}
          <div style={{ border: '2px solid #c084fc', boxShadow: '0 0 12px rgba(192,132,252,0.5)' }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-purple-400" /><span className="text-base text-slate-200 font-semibold">Current</span></div>
              <span className="text-base font-semibold text-green-400">Normal</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-4xl text-purple-400 leading-none">{gridCurrent.toFixed(1)}</span>
              <span className="text-sm text-purple-300 mb-1">A</span>
            </div>
            <div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div className="h-full bg-gradient-to-r from-purple-700 to-purple-400 rounded-full transition-all duration-700" style={{ width: `${currentBarPct}%` }} />
              </div>
              <div className="flex justify-between text-sm text-slate-500"><span>0A</span><span>5A</span><span>10A max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-purple-700/40 pt-3">
              <span className="text-base text-slate-400">Max Load</span><span className="text-lg text-purple-300">10A</span>
            </div>
          </div>
          {/* CARD 3 — Power Draw */}
          <div style={{ border: '2px solid #22d3ee', boxShadow: '0 0 12px rgba(34,211,238,0.5)' }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Zap className="w-5 h-5 text-cyan-400" /><span className="text-base text-slate-200 font-semibold">Power Draw</span></div>
              <span className={`text-base font-semibold ${parseFloat(gridPower) > 0 ? 'text-green-400' : 'text-slate-400'}`}>{parseFloat(gridPower) > 0 ? 'Active' : 'Idle'}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-4xl text-white leading-none drop-shadow-[0_0_10px_rgba(34,211,238,0.6)]">{gridPower}</span>
              <span className="text-sm text-cyan-300 mb-1">W</span>
            </div>
            <div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div className="h-full bg-gradient-to-r from-cyan-700 to-cyan-400 rounded-full transition-all duration-700" style={{ width: `${gridPowerBarPct}%` }} />
              </div>
              <div className="flex justify-between text-sm text-slate-500"><span>0W</span><span>250W</span><span>~500W max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-cyan-700/40 pt-3">
              <span className="text-base text-slate-400">PZEM-004T</span><span className="text-lg text-cyan-300">{(parseFloat(gridPower) / 1000).toFixed(3)} kW</span>
            </div>
          </div>
          {/* CARD 4 — Frequency */}
          <div style={{ border: '2px solid #818cf8', boxShadow: '0 0 12px rgba(129,140,248,0.5)' }} className="rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-indigo-400" /><span className="text-base text-slate-200 font-semibold">Frequency</span></div>
              <span className={`text-base font-semibold ${gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'text-green-400' : 'text-yellow-400'}`}>{gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'Stable' : 'Unstable'}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-4xl text-indigo-400 leading-none">{gridFrequency.toFixed(1)}</span>
              <span className="text-sm text-indigo-300 mb-1">Hz</span>
            </div>
            <div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div className={`h-full rounded-full transition-all duration-700 ${gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'bg-gradient-to-r from-indigo-700 to-indigo-400' : 'bg-gradient-to-r from-yellow-700 to-yellow-400'}`} style={{ width: `${freqBarPct}%` }} />
              </div>
              <div className="flex justify-between text-sm text-slate-500"><span>55Hz</span><span>60Hz</span><span>65Hz</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-indigo-700/40 pt-3">
              <span className="text-base text-slate-400">Nom. Freq</span><span className="text-lg text-indigo-300">60.0 Hz</span>
            </div>
          </div>
        </div>
        <div className="text-xs text-slate-500 text-center pt-2 mt-1 border-t border-slate-700/40 flex-shrink-0">PZEM-004T Sensor</div>
      </div>
    );
  };

  // ========== SOLAR DETAIL ==========
  const renderSolarDetail = () => {
    const acPowerNum     = parseFloat(acPower);
    const dcPowerBarPct  = Math.min(100, (solarPower / 60) * 100);
    const acPowerBarPct  = Math.min(100, (acPowerNum / 300) * 100);
    const mpptEfficiency = solarPower > 0 ? Math.min(100, ((acPowerNum / solarPower) * 100)).toFixed(0) : '0';
    const acEfficiency   = acVoltage > 0  ? Math.min(100, ((acPowerNum / (acVoltage * acCurrent + 0.001)) * 100)).toFixed(0) : '0';
    return (
      <div className="relative h-full p-3 sm:p-4 flex flex-col text-white overflow-hidden">
        <div className="flex items-center justify-between pb-3 border-b border-yellow-600/60 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-yellow-300 hover:text-yellow-200 transition-colors">
            <ChevronLeft className="w-4 h-4" /><span className="text-sm">Back</span>
          </button>
          <div className="flex items-center gap-2"><Sun className="w-5 h-5 text-yellow-400" /><span className="text-base">Solar Monitoring</span></div>
          <div className={`w-3 h-3 rounded-full ${solarDCStatus === 'Good' ? 'bg-green-500' : solarDCStatus === 'Low' ? 'bg-yellow-500' : 'bg-red-500'} animate-pulse`} />
        </div>
        <div className="flex-1 flex gap-3 pt-3 min-h-0">
          {/* LEFT — DC Output */}
          <div style={{ border: '2px solid #fbbf24', boxShadow: '0 0 12px rgba(251,191,36,0.4)' }} className="flex-1 rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Sun className="w-5 h-5 text-amber-400" /><span className="text-base text-slate-200 font-semibold">DC Output</span></div>
              <span className={`text-base font-semibold ${solarDCStatus === 'Good' ? 'text-green-400' : solarDCStatus === 'Low' ? 'text-yellow-400' : 'text-red-400'}`}>{solarDCStatus === 'Good' ? 'Good' : solarDCStatus === 'Low' ? 'Low' : 'No Data'}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-base text-slate-400 mb-1">Voltage</div>
                <div className="flex items-end gap-1"><span className="text-4xl text-amber-400 leading-none">{solarVoltage.toFixed(1)}</span><span className="text-lg text-amber-300 mb-1">V</span></div>
                <div className="text-sm text-slate-500 mt-1">Vmp 41V · Voc 49.5V</div>
              </div>
              <div>
                <div className="text-base text-slate-400 mb-1">Current</div>
                <div className="flex items-end gap-1"><span className="text-4xl text-amber-400 leading-none">{solarCurrent.toFixed(2)}</span><span className="text-lg text-amber-300 mb-1">A</span></div>
                <div className="text-sm text-slate-500 mt-1">4P · Isc 56.8A max</div>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-base text-slate-400">DC Power</span>
                <div className="flex items-end gap-1"><span className="text-3xl text-amber-400">{solarPower.toFixed(1)}</span><span className="text-base text-amber-300 mb-0.5">W</span></div>
              </div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full bg-gradient-to-r from-amber-700 to-amber-400 rounded-full transition-all duration-700" style={{ width: `${dcPowerBarPct}%` }} /></div>
              <div className="flex justify-between text-sm text-slate-500"><span>0W</span><span>1100W</span><span>~2200W max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-amber-700/40 pt-3">
              <span className="text-base text-slate-400">MPPT Efficiency</span><span className="text-2xl text-amber-300">{mpptEfficiency} %</span>
            </div>
          </div>
          {/* RIGHT — Inverter AC Output */}
          <div style={{ border: '2px solid #60a5fa', boxShadow: '0 0 12px rgba(96,165,250,0.4)' }} className="flex-1 rounded-xl bg-slate-800/70 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><Zap className="w-5 h-5 text-blue-400" /><span className="text-base text-slate-200 font-semibold">Inverter AC Output</span></div>
              <span className={`text-base font-semibold ${inverterACStatus === 'Stable' ? 'text-green-400' : inverterACStatus === 'Unstable' ? 'text-yellow-400' : 'text-red-400'}`}>{inverterACStatus === 'Stable' ? 'Stable' : inverterACStatus === 'Unstable' ? 'Unstable' : 'Off'}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-base text-slate-400 mb-1">Voltage</div>
                <div className="flex items-end gap-1"><span className="text-4xl text-white leading-none">{acVoltage.toFixed(0)}</span><span className="text-lg text-blue-200 mb-1">V</span></div>
                <div className="text-sm text-slate-500 mt-1">Nom 220V · Max 240V</div>
              </div>
              <div>
                <div className="text-base text-slate-400 mb-1">Current</div>
                <div className="flex items-end gap-1"><span className="text-4xl text-white leading-none">{acCurrent.toFixed(1)}</span><span className="text-lg text-blue-200 mb-1">A</span></div>
                <div className="text-sm text-slate-500 mt-1">Max ~1.36A @ 220V</div>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-base text-slate-400">AC Power</span>
                <div className="flex items-end gap-1"><span className="text-3xl text-white">{acPower}</span><span className="text-base text-blue-200 mb-0.5">W</span></div>
              </div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden mb-2"><div className="h-full bg-gradient-to-r from-blue-700 to-blue-400 rounded-full transition-all duration-700" style={{ width: `${acPowerBarPct}%` }} /></div>
              <div className="flex justify-between text-sm text-slate-500"><span>0W</span><span>150W</span><span>~300W max</span></div>
            </div>
            <div className="flex items-center justify-between border-t border-blue-700/40 pt-3">
              <div><div className="text-base text-slate-400 mb-0.5">Frequency</div><div className="flex items-end gap-1"><span className="text-2xl text-purple-300">{inverterFrequency.toFixed(1)}</span><span className="text-base text-slate-400 mb-0.5">Hz</span></div></div>
              <div className="text-right"><div className="text-base text-slate-400 mb-0.5">AC Efficiency</div><div className="text-2xl text-blue-300">{acEfficiency} %</div></div>
            </div>
          </div>
        </div>
        <div className="pt-2 mt-2 border-t border-yellow-700/40 flex-shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Total Solar Output</span>
            <div className="flex items-center gap-1"><span className="text-2xl text-amber-400 font-bold">{(solarPower + parseFloat(acPower)).toFixed(1)}</span><span className="text-sm text-amber-300">W</span><span className="text-xl">☀️</span></div>
          </div>
        </div>
        <div className="text-xs text-slate-500 text-center pt-1.5 border-t border-slate-700/40 flex-shrink-0">WCS1500 (array) + PZEM-004T (inverter)</div>
      </div>
    );
  };

  // ========== BATTERY DETAIL ==========
  const renderBatteryDetail = () => (
    <div className="relative h-full p-3 sm:p-4 md:p-6 flex flex-col text-white overflow-auto">
      <div className="flex items-center justify-between pb-3 border-b border-green-700/50">
        <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-green-300 hover:text-green-200 transition-colors"><ChevronLeft className="w-4 h-4" /><span className="text-xs sm:text-sm">Back</span></button>
        <div className="flex items-center gap-2"><Battery className="w-5 h-5 text-green-400" /><span className="text-sm sm:text-base">Battery Health</span></div>
        <div className={`w-3 h-3 rounded-full ${batteryHealth >= 80 ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`} />
      </div>
      <div className="flex-1 flex flex-col justify-center py-3 space-y-3">
        <div className="text-center p-3 rounded-lg bg-green-900/30 border border-green-700/40">
          <div className="text-xs text-green-300 mb-1">Pack SOC</div>
          <div className="text-4xl sm:text-5xl text-green-400 drop-shadow-[0_0_10px_rgba(34,197,94,0.6)] mb-1">{batteryHealth.toFixed(0)}%</div>
          <div className="text-xs text-green-300">{batteryStatus}</div>
        </div>
        {gridAssistActive && (
          <div className="px-3 py-2 rounded-lg bg-blue-900/40 border border-blue-600/50 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-xs text-blue-300">🔋 K3 Grid Assist CHARGING — SSR3 ON ({batteryVoltage.toFixed(1)}V → 26.4V)</span>
          </div>
        )}
        <div className="space-y-2">
          <div className="text-xs text-slate-300">Individual Cells (8S Series)</div>
          <div className="grid grid-cols-4 gap-1">
            {['C1','C2','C3','C4'].map((cell) => (
              <div key={cell} className="p-1.5 rounded bg-slate-800/60 border border-green-700/40 text-center">
                <div className="text-xs text-slate-400">{cell}</div>
                <div className="text-xs text-green-400">{(batteryVoltage / 4).toFixed(2)}V</div>
                <div className="text-xs text-slate-500">3.2V</div>
                <div className="text-xs text-slate-600">100Ah</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-slate-500 text-center">Voltages add · Same current · Total 100Ah</div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-300">Pack Voltage (24V LiFePO4)</span>
            <span className={`text-xs ${batteryVoltage >= 25.6 ? 'text-green-400' : batteryVoltage >= 24.0 ? 'text-yellow-400' : 'text-red-400'}`}>{batteryVoltage >= 25.6 ? 'Normal' : batteryVoltage >= 24.0 ? 'Fair' : 'Low'}</span>
          </div>
          <div className="flex items-end gap-1"><div className="text-3xl sm:text-4xl text-blue-400">{batteryVoltage.toFixed(1)}</div><div className="text-sm text-slate-400 mb-1">V</div></div>
          <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden"><div className={`h-full ${batteryVoltage >= 25.6 ? 'bg-green-500' : batteryVoltage >= 24.0 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, ((batteryVoltage - 21.0) / (29.2 - 21.0)) * 100)}%` }} /></div>
          <div className="flex justify-between text-xs text-slate-500"><span>21V (0%)</span><span>25.6V (50%)</span><span>29.2V (100%)</span></div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-300">Pack Current</span>
            <span className="text-xs text-blue-400">{batteryCurrent > 0 ? '⚡ Charging' : '🔋 Discharging'}</span>
          </div>
          <div className="flex items-end gap-1"><div className={`text-2xl sm:text-3xl ${batteryCurrent > 0 ? 'text-green-400' : 'text-purple-400'}`}>{batteryCurrent.toFixed(1)}</div><div className="text-sm text-slate-400 mb-0.5">A</div></div>
          <div className="text-xs text-slate-500">Same current through all cells (series)</div>
        </div>
        <div className="pt-2 border-t border-green-700/30 grid grid-cols-2 gap-2 text-xs">
          <div><div className="text-slate-400">Capacity</div><div className="text-white text-sm">100 Ah</div></div>
          <div><div className="text-slate-400">Power</div><div className="text-white text-sm">{batteryPower}W</div></div>
        </div>
      </div>
      <div className="text-xs text-slate-400 text-center py-2 border-t border-green-700/30">PZEM-017 · 24V 100Ah Lead Acid (2S Series)</div>
    </div>
  );

  // ========== PANELS DETAIL ==========
  const renderPanelsDetail = () => {
    const PANEL_VMP_LCD = 18.0;
    const PANEL_VOC_LCD = 21.6;
    const positions = [{ x: '36%', y: '18%' }, { x: '77%', y: '33%' }, { x: '23%', y: '55%' }, { x: '63%', y: '71%' }];
    const voltageOffsets = [-0.1, +0.2, -0.2, +0.1];
    const currentOffsets = [+0.02, -0.03, +0.01, 0.00];
    const dynamicPanels = [1, 2, 3, 4].map((id, i) => {
      const voltage = Math.max(0, parseFloat((solarVoltage + voltageOffsets[i]).toFixed(1)));
      const current = Math.max(0, parseFloat((solarCurrent / 4 + currentOffsets[i]).toFixed(2)));
      const health  = voltage === 0 ? 0 : Math.min(100, Math.round((voltage / PANEL_VMP_LCD) * 100));
      let status: 'good' | 'warning' | 'critical';
      if (solarAnomaly === 'critical' || voltage < 12.0) { status = 'critical'; }
      else if (solarAnomaly === 'warning' || voltage < 16.0) { status = 'warning'; }
      else { status = 'good'; }
      if (voltage < 0.5) status = 'critical';
      return { id, name: `Panel ${id}`, voltage, current, health, status };
    });
    const goodCount     = dynamicPanels.filter(p => p.status === 'good').length;
    const warningCount  = dynamicPanels.filter(p => p.status === 'warning').length;
    const criticalCount = dynamicPanels.filter(p => p.status === 'critical').length;
    const headerDotColor = solarAnomaly === 'critical' ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : solarAnomaly === 'warning' ? 'bg-amber-500 shadow-[0_0_10px_#f59e0b]' : 'bg-green-500 shadow-[0_0_10px_#22c55e]';
    return (
      <div className="relative h-full w-full overflow-hidden bg-slate-950 font-sans text-white select-none flex flex-col">
        <div className="absolute inset-0 z-0 pointer-events-none opacity-20"><img src={solarImg} alt="Solar View" className="w-full h-full object-cover" /></div>
        <div className="relative z-20 p-4 flex items-center justify-between border-b border-blue-500/30" style={{ background: 'linear-gradient(to bottom, #1e293b 0%, #0a0f2e 100%)' }}>
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-orange-400"><ChevronLeft className="w-4 h-4" /><span className="text-xs font-bold uppercase tracking-tight">Back</span></button>
          <div className="flex items-center gap-2"><Sun className="w-5 h-5 text-orange-500" /><span className="text-sm font-black uppercase tracking-widest text-blue-100">Solar Panels</span></div>
          <div className={`w-3 h-3 rounded-full animate-pulse ${headerDotColor}`} />
        </div>
        <div className="relative flex-1 z-10">
          {dynamicPanels.map((panel, index) => {
            const currentPos = positions[index] || { x: '50%', y: '50%' };
            const isGood    = panel.status === 'good';
            const isWarning = panel.status === 'warning';
            const boxBg     = isGood ? 'rgba(49,207,10,0.75)' : isWarning ? 'rgba(120,53,15,0.8)' : 'rgba(153,27,27,0.8)';
            const accentCol = isGood ? 'text-emerald-400' : isWarning ? 'text-amber-400' : 'text-red-400';
            const barCol    = isGood ? 'bg-emerald-500' : isWarning ? 'bg-amber-500' : 'bg-red-600';
            const statusText = isGood ? 'Optimal' : isWarning ? 'Warning' : 'Critical';
            const voltagePercentage = Math.min(100, (panel.voltage / PANEL_VOC_LCD) * 100);
            return (
              <div key={panel.id} className="absolute w-[280px] h-[110px] flex flex-col p-3 transition-all duration-700 shadow-2xl z-30 rounded-xl border border-white/10 backdrop-blur-md" style={{ left: currentPos.x, top: currentPos.y, transform: 'translate(-50%,-50%)', backgroundColor: boxBg }}>
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-1.5"><div className={`w-1.5 h-1.5 rounded-full ${barCol} animate-pulse`} /><span className="text-[10px] font-black text-white/90 uppercase tracking-tighter italic">{panel.name}</span></div>
                  <span className={`text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-black/40 border border-white/5 ${accentCol}`}>{statusText}</span>
                </div>
                <div className="flex justify-between items-end my-1">
                  <div className="text-3xl font-black text-white italic tracking-tighter leading-none">{panel.voltage.toFixed(1)}<span className={`text-[12px] ml-0.5 font-normal opacity-80 ${accentCol}`}>V</span></div>
                  <div className="text-right"><div className="text-sm font-bold text-white leading-none">{panel.current.toFixed(2)}<span className={`text-[9px] ml-0.5 ${accentCol}`}>A</span></div><div className="text-[7px] text-white/40 uppercase font-black tracking-widest">Current Draw</div></div>
                </div>
                <div className="mt-auto space-y-1.5">
                  <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5"><div className={`h-full ${barCol} transition-all duration-1000`} style={{ width: `${voltagePercentage}%` }} /></div>
                  <div className="flex justify-between items-center px-0.5">
                    <div className="flex items-center gap-2"><span className="text-[7px] text-white/40 font-black uppercase tracking-widest">PV Health</span><div className="w-20 h-[2px] bg-white/5 rounded-full overflow-hidden"><div className={`h-full ${barCol} opacity-40`} style={{ width: `${panel.health}%` }} /></div></div>
                    <span className={`text-[9px] font-black ${accentCol}`}>{panel.health}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="relative z-20 pt-2 pb-5 border-t border-blue-500/30" style={{ background: 'linear-gradient(to top, #020617 0%, #0a0f2e 100%)' }}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="border-r border-white/10"><div className="text-green-500 text-xl font-normal leading-none">{goodCount}</div><div className="text-[10px] text-green-500 font-normal uppercase tracking-[0.2em] mt-1">Optimal</div></div>
            <div className="border-r border-white/10"><div className="text-amber-400 text-xl font-normal leading-none">{warningCount}</div><div className="text-[10px] text-amber-400 font-normal uppercase tracking-[0.2em] mt-1">Warning</div></div>
            <div><div className="text-red-500 text-xl font-normal leading-none">{criticalCount}</div><div className="text-[10px] text-red-500 font-normal uppercase tracking-[0.2em] mt-1">Critical</div></div>
          </div>
        </div>
      </div>
    );
  };

  // ========== GRAPH DETAIL ==========
  const renderGraphDetail = () => {
    const voltageGraphData = Array.from({ length: 24 }, (_, i) => ({ time: `${23-i}h`, battery: batteryVoltage||0, grid: gridVoltage||0, inverter: acVoltage||0, solar: solarVoltage||0 })).reverse();
    const slideLabels = ['⚡ Voltage Trends', 'Energy Balance', 'Consumption'];
    return (
      <div className="relative h-full flex flex-col text-white overflow-hidden">
        <div className="flex items-center justify-between p-3 pb-2 border-b border-purple-700/50 flex-shrink-0">
          <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-purple-300 hover:text-purple-200 transition-colors"><ChevronLeft className="w-4 h-4" /><span className="text-xs">Back</span></button>
          <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-purple-400" /><span className="text-xs sm:text-sm font-semibold">{slideLabels[graphSlide]}</span></div>
          <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
        </div>
        <div className="flex items-center justify-center gap-3 py-1.5 flex-shrink-0">
          <button onClick={() => setGraphSlide(s => Math.max(0, s-1))} disabled={graphSlide===0} className="text-purple-400 disabled:opacity-20 px-1 text-lg leading-none">‹</button>
          <div className="flex gap-1.5">
            {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
              <button key={i} onClick={() => setGraphSlide(i)} className={`rounded-full transition-all duration-300 ${i===graphSlide ? 'w-5 h-2 bg-purple-400' : 'w-2 h-2 bg-slate-600 hover:bg-slate-400'}`} />
            ))}
          </div>
          <button onClick={() => setGraphSlide(s => Math.min(TOTAL_SLIDES-1, s+1))} disabled={graphSlide===TOTAL_SLIDES-1} className="text-purple-400 disabled:opacity-20 px-1 text-lg leading-none">›</button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          {graphSlide === 0 && (
            <div className="h-full flex flex-col p-2 pb-1">
              <div className="flex-shrink-0 flex items-center justify-center gap-2 py-1 border-b border-purple-700/30 mb-1"><AlertTriangle className="w-3 h-3 text-red-500" /><span className="text-xs text-slate-300">Red dots = Anomaly detected</span></div>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={voltageGraphData} barGap={0} barCategoryGap="15%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={9} angle={-45} textAnchor="end" height={40} tickFormatter={(v,idx) => idx%3===0?v:''} />
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,250]} width={28} />
                    <Tooltip contentStyle={{ backgroundColor:'#1e293b', border:'1px solid #475569', borderRadius:'8px', fontSize:'10px' }} />
                    <Legend wrapperStyle={{ fontSize:'9px' }} />
                    <Bar dataKey="battery" fill="#22c55e" radius={[2,2,0,0]} name="Battery (V)" />
                    <Bar dataKey="grid"    fill="#3b82f6" radius={[2,2,0,0]} name="Grid (V)"    />
                    <Bar dataKey="inverter" fill="#a855f7" radius={[2,2,0,0]} name="Inverter (V)" />
                    <Bar dataKey="solar"   fill="#eab308" radius={[2,2,0,0]} name="Solar (V)"   />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {graphSlide === 1 && (
            <div className="h-full flex flex-col p-2 pb-1 overflow-y-auto">
              <div className="grid grid-cols-3 gap-1.5 mb-2 flex-shrink-0">
                <div className="rounded-lg p-2 text-center" style={{ background:'rgba(120,53,15,0.45)', border:'1px solid rgba(217,119,6,0.5)', backdropFilter:'blur(4px)' }}><div className="text-xs text-amber-300 mb-0.5">Solar</div><div className="text-base text-amber-400 font-bold">{(balanceData[balanceData.length-1]?.solarSupply??0).toFixed(1)}<span className="text-xs ml-0.5">W</span></div></div>
                <div className="rounded-lg p-2 text-center" style={{ background:'rgba(23,37,84,0.45)', border:'1px solid rgba(59,130,246,0.5)', backdropFilter:'blur(4px)' }}><div className="text-xs text-blue-300 mb-0.5">Grid</div><div className="text-base text-blue-400 font-bold">{(balanceData[balanceData.length-1]?.gridSupply??0).toFixed(1)}<span className="text-xs ml-0.5">W</span></div></div>
                <div className="rounded-lg p-2 text-center" style={{ background:'rgba(131,24,67,0.45)', border:'1px solid rgba(236,72,153,0.5)', backdropFilter:'blur(4px)' }}><div className="text-xs text-pink-300 mb-0.5">Load</div><div className="text-base text-pink-400 font-bold">{(balanceData[balanceData.length-1]?.totalLoad??0).toFixed(1)}<span className="text-xs ml-0.5">W</span></div></div>
              </div>
              <div className="flex-1 min-h-0" style={{ minHeight:120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={balanceData} margin={{ top:4, right:4, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={8} tickFormatter={(v,idx)=>idx%4===0?v:''} height={30} />
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,'auto']} width={28} />
                    <Tooltip contentStyle={{ backgroundColor:'#1e293b', border:'1px solid #475569', borderRadius:'6px', fontSize:'10px' }} formatter={(v:number,n:string)=>[`${v.toFixed(1)}W`,n]} />
                    <Legend wrapperStyle={{ fontSize:'9px' }} />
                    <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="solarSupply" stroke="#fbbf24" strokeWidth={1.5} dot={false} name="Solar" />
                    <Line type="monotone" dataKey="gridSupply"  stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Grid" />
                    <Line type="monotone" dataKey="totalSupply" stroke="#10b981" strokeWidth={2}   dot={false} name="Total Supply" strokeDasharray="5 3" />
                    <Line type="monotone" dataKey="totalLoad"   stroke="#ec4899" strokeWidth={2}   dot={false} name="Total Load"   strokeDasharray="3 3" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {graphSlide === 2 && (
            <div className="h-full flex flex-col p-2 pb-1 overflow-y-auto">
              <div className="grid grid-cols-3 gap-1.5 mb-2 flex-shrink-0">
                <div className="bg-amber-900/40 border border-amber-700/50 rounded-lg p-2 text-center"><div className="text-xs text-amber-300 mb-0.5">Solar</div><div className="text-sm text-amber-400 font-bold">{totals.solar.toFixed(1)}<span className="text-xs ml-0.5">Wh</span></div></div>
                <div className="bg-blue-900/40 border border-blue-700/50 rounded-lg p-2 text-center"><div className="text-xs text-blue-300 mb-0.5">Grid</div><div className="text-sm text-blue-400 font-bold">{totals.grid.toFixed(1)}<span className="text-xs ml-0.5">Wh</span></div></div>
                <div className="bg-green-900/40 border border-green-700/50 rounded-lg p-2 text-center"><div className="text-xs text-green-300 mb-0.5">Battery</div><div className="text-sm text-green-400 font-bold">{totals.battery.toFixed(1)}<span className="text-xs ml-0.5">Wh</span></div></div>
              </div>
              <div className="flex-1 min-h-0" style={{ minHeight:120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={consumptionData} margin={{ top:4, right:4, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={8} tickFormatter={(v,idx)=>idx%4===0?v:''} height={30} />
                    <YAxis stroke="#94a3b8" fontSize={9} domain={[0,'auto']} width={28} />
                    <Tooltip contentStyle={{ backgroundColor:'#1e293b', border:'1px solid #475569', borderRadius:'6px', fontSize:'10px' }} formatter={(v:number,n:string)=>[`${v.toFixed(1)}W`,n]} />
                    <Legend wrapperStyle={{ fontSize:'9px' }} />
                    <Bar dataKey="Battery" stackId="a" fill="#10b981" name="Battery" />
                    <Bar dataKey="Grid"    stackId="a" fill="#3b82f6" name="Grid" />
                    <Bar dataKey="Solar"   stackId="a" fill="#fbbf24" radius={[2,2,0,0]} name="Solar" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
        <div className="flex-shrink-0 text-xs text-slate-500 text-center py-1.5 border-t border-purple-700/30">Slide {graphSlide+1}/{TOTAL_SLIDES} · Swipe or tap arrows to navigate</div>
      </div>
    );
  };

  // ========== SSR DETAIL ==========
  const renderSSRDetail = () => (
    <div className="relative h-full p-2 sm:p-3 md:p-4 flex flex-col text-white overflow-auto">
      <div className="flex items-center justify-between pb-2 border-b border-cyan-700/50 flex-shrink-0">
        <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-cyan-300 hover:text-cyan-200 transition-colors"><ChevronLeft className="w-3 h-3 sm:w-4 sm:h-4" /><span className="text-xs">Back</span></button>
        <div className="flex items-center gap-1 sm:gap-2"><ArrowLeftRight className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" /><span className="text-xs sm:text-sm">SSR Control</span></div>
        <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full ${contactorClosed ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
      </div>
      <div className="flex-1 space-y-2 sm:space-y-3 py-2 overflow-y-auto">
        <div className={`px-3 py-2 rounded-lg border flex items-center gap-2 ${contactorClosed ? 'bg-green-900/30 border-green-600/40' : 'bg-red-900/40 border-red-600/60'}`}>
          <Shield className={`w-4 h-4 ${contactorClosed ? 'text-green-400' : 'text-red-400'}`} />
          <div className="flex-1">
            <div className={`text-xs font-semibold ${contactorClosed ? 'text-green-300' : 'text-red-300'}`}>K1 Contactor — {contactorClosed ? 'CLOSED (Normal)' : 'OPEN (Safe Mode)'}</div>
            <div className="text-xs text-slate-400">{contactorClosed ? 'Outlets energized via selected source' : 'All outlets disconnected — critical lock active'}</div>
          </div>
        </div>
        {!localAutoSwitchEnabled && (
          <div className="px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-600/50 flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
            <span className="text-xs text-amber-300">Manual Mode — for testing/maintenance/demo only</span>
          </div>
        )}
        <div className="p-2 sm:p-3 rounded-lg bg-gradient-to-br from-indigo-900/40 to-purple-900/30 border border-indigo-600/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-indigo-200">Power Mode</span>
            <div className={`px-2 py-0.5 rounded-full text-xs font-semibold ${localControlMode==='solar'?'bg-amber-600 text-white':localControlMode==='grid'?'bg-blue-600 text-white':localControlMode==='failsafe'?'bg-orange-600 text-white':'bg-red-600 text-white'}`}>
              {localControlMode==='solar'?'☀ Solar (K2)':localControlMode==='grid'?'⚡ Grid (K3)':localControlMode==='failsafe'?'⚠ Failsafe (K3)':'🔴 Shutdown'}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {([
              { mode:'solar' as const,    label:'Solar',    relay:'K1/SSR1', icon:<Sun className="w-3 h-3 sm:w-4 sm:h-4" />,           active:'bg-amber-500 border-amber-600', hover:'hover:border-amber-300', disabled:localAutoSwitchEnabled||!contactorClosed },
              { mode:'grid' as const,     label:'Grid',     relay:'K2/SSR2', icon:<Zap className="w-3 h-3 sm:w-4 sm:h-4" />,           active:'bg-blue-500 border-blue-600',   hover:'hover:border-blue-300',  disabled:localAutoSwitchEnabled||!contactorClosed },
              { mode:'shutdown' as const, label:'Shutdown', relay:'ALL OFF', icon:<AlertTriangle className="w-3 h-3 sm:w-4 sm:h-4" />, active:'bg-red-500 border-red-600',     hover:'hover:border-red-300',   disabled:localAutoSwitchEnabled },
            ] as const).map(({ mode, label, relay, icon, active, hover, disabled }) => (
              <button key={mode} onClick={() => handleModeChange(mode)} disabled={disabled}
                className={`p-2 sm:p-3 rounded-lg border-2 transition-all ${localControlMode===mode?`${active} text-white shadow-lg`:`bg-slate-800/60 border-slate-600 text-slate-300 ${hover}`} ${disabled?'opacity-50 cursor-not-allowed':'cursor-pointer active:scale-95'}`}>
                <div className="flex items-center gap-1 mb-1 justify-center">{icon}<div className="text-xs">{label}</div></div>
                <div className="text-xs sm:text-sm text-center font-bold">{relay}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
          {([
            { label:'K1', color:contactorClosed?'bg-green-500':'bg-red-500 animate-pulse',    bg:contactorClosed?'bg-green-900/30 border-green-600':'bg-red-900/40 border-red-500',     text:contactorClosed?'CLOSED':'OPEN' },
            { label:'K1', color:K1_Solar?'bg-amber-500 animate-pulse':'bg-slate-600',          bg:K1_Solar?'bg-amber-900/40 border-amber-500':'bg-slate-800/40 border-slate-600',          text:K1_Solar?'SOLAR':'OFF' },
            { label:'K2', color:K2_Grid?'bg-blue-500 animate-pulse':'bg-slate-600',            bg:K2_Grid?'bg-blue-900/40 border-blue-500':'bg-slate-800/40 border-slate-600',              text:K2_Grid?'GRID':'OFF' },
            { label:'K3', color:K3_GridAssist?'bg-purple-500 animate-pulse':'bg-slate-600',   bg:K3_GridAssist?'bg-purple-900/40 border-purple-500':'bg-slate-800/40 border-slate-600',   text:K3_GridAssist?'CHG':'STBY' },
          ]).map(({ label, color, bg, text }) => (
            <div key={label} className={`p-2 rounded-lg border-2 ${bg}`}><div className="text-center"><div className="text-xs text-slate-300 mb-1">{label}</div><div className={`w-3 h-3 sm:w-4 sm:h-4 mx-auto rounded-full ${color}`} /><div className="text-xs text-slate-400 mt-1">{text}</div></div></div>
          ))}
        </div>
        <div className={`px-3 py-2 rounded-lg border flex items-center gap-2 ${K3_GridAssist?'bg-purple-900/30 border-purple-600/50':'bg-slate-800/30 border-slate-600/40'}`}>
          <Battery className={`w-3 h-3 flex-shrink-0 ${K3_GridAssist?'text-purple-400':'text-slate-500'}`} />
          <span className={`text-xs ${K3_GridAssist?'text-purple-300':'text-slate-500'}`}>{K3_GridAssist?`K3 Grid Assist CHARGING — ${batteryVoltage.toFixed(1)}V < 26.4V. Auto-off at ≥26.4V.`:'K3 Grid Assist STANDBY — Auto-activates when battery < 26.4V'}</span>
        </div>
        <div className="p-3 rounded-xl bg-gradient-to-br from-green-900/40 to-emerald-800/30 border-2 border-green-600/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-green-700/50"><Activity className="w-4 h-4 text-green-300" /></div>
              <div>
                <div className="text-xs sm:text-sm font-semibold text-green-200">Auto-Switching</div>
                <p className="text-xs text-green-300 mt-0.5">{localAutoSwitchEnabled?'System monitors conditions automatically':'Manual control enabled — testing/demo only'}</p>
              </div>
            </div>
            <button onClick={() => setLocalAutoSwitchEnabled(p => !p)} className={`relative w-12 h-6 sm:w-16 sm:h-8 rounded-full transition-all duration-300 ${localAutoSwitchEnabled?'bg-green-500 shadow-lg':'bg-gray-600'}`}>
              <div className={`absolute top-0.5 sm:top-1 w-5 h-5 sm:w-6 sm:h-6 bg-white rounded-full shadow-md transition-transform duration-300 ${localAutoSwitchEnabled?'translate-x-6 sm:translate-x-9':'translate-x-0.5 sm:translate-x-1'}`} />
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-slate-300">Outlet Status</div>
          <div className="grid grid-cols-2 gap-2">
            {outlets.map((outlet) => (
              <div key={outlet.id} className={`p-2 sm:p-3 rounded-lg border-2 transition-all ${outlet.status?'bg-gradient-to-br from-green-900/60 to-emerald-800/40 border-green-600':'bg-slate-800/60 border-slate-600'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div><div className="text-xs text-slate-200">{outlet.name}</div><div className="text-xs text-slate-400">{outlet.load}</div></div>
                  <div className={`w-3 h-3 sm:w-4 sm:h-4 rounded-full ${outlet.status?'bg-green-500 animate-pulse':'bg-slate-600'}`} />
                </div>
                <div className={`px-2 py-1 rounded text-center text-xs ${outlet.source==='Grid'?'bg-blue-900/60 text-blue-200':outlet.source==='Solar Inverter'?'bg-amber-900/60 text-amber-200':'bg-slate-700 text-slate-400'}`}>{outlet.source}</div>
                {outlet.status && <div className="mt-2 text-xs"><div className="flex justify-between"><span className="text-slate-400">Power:</span><span className="text-slate-200">{(outlet.current*outlet.voltage).toFixed(0)}W</span></div></div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // ========== THEME SELECTOR ==========
  const renderThemeSelector = () => (
    <div className="relative h-full p-3 sm:p-4 md:p-6 flex flex-col text-white overflow-auto">
      <div className="flex items-center justify-between pb-3 border-b border-purple-700/50">
        <button onClick={() => navigateTo('main')} className="flex items-center gap-1 text-purple-300 hover:text-purple-200 transition-colors"><ChevronLeft className="w-4 h-4" /><span className="text-xs sm:text-sm">Back</span></button>
        <div className="flex items-center gap-2"><Palette className="w-5 h-5 text-purple-400" /><span className="text-sm sm:text-base">Display Theme</span></div>
        <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
      </div>
      <div className="flex-1 flex flex-col justify-center py-4">
        <div className="text-center mb-6"><h3 className="text-lg sm:text-xl mb-2">Choose Display Theme</h3><p className="text-xs sm:text-sm text-slate-400">Select a color theme for your LCD display</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {themes.map((theme) => (
            <button key={theme.id} onClick={() => { setSelectedTheme(theme); navigateTo('main'); }} className={`p-4 rounded-xl border-2 transition-all ${selectedTheme.id===theme.id?'border-white shadow-2xl scale-105':'border-slate-600 hover:border-slate-400'}`}>
              <div className={`h-24 sm:h-32 rounded-lg bg-gradient-to-br ${theme.gradient} mb-3 flex items-center justify-center`}>
                <div className={`text-2xl sm:text-3xl ${theme.textColor}`}>{theme.id==='default'&&'🌊'}{theme.id==='sunset'&&'🌅'}{theme.id==='forest'&&'🌲'}{theme.id==='midnight'&&'🌙'}</div>
              </div>
              <div className="text-sm sm:text-base mb-1">{theme.name}</div>
              {selectedTheme.id===theme.id && <div className="text-xs text-green-400">✓ Active</div>}
            </button>
          ))}
        </div>
        <div className="mt-6 p-3 rounded-lg bg-purple-900/30 border border-purple-600/40"><p className="text-xs text-center text-purple-200">Theme will be applied to the LCD display background</p></div>
      </div>
    </div>
  );

  // ── renderView ────────────────────────────────────────────────────────────
  const renderView = () => {
    switch (currentView) {
      case 'screensaver': return <EnergyFlowScreensaver onWake={wakeFromScreensaver} />;
      case 'grid':        return renderGridDetail();
      case 'solar':       return renderSolarDetail();
      case 'battery':     return renderBatteryDetail();
      case 'panels':      return renderPanelsDetail();
      case 'graph':       return renderGraphDetail();
      case 'ssr':         return renderSSRDetail();
      case 'theme':       return renderThemeSelector();
      default:            return renderMainMenu();
    }
  };

  return (
    <div className="min-h-screen p-2 sm:p-3 md:p-4 lg:p-8 space-y-3 sm:space-y-4 lg:space-y-6">
      {/* Inject keyframe styles */}
      <style>{slideUpStyle}</style>

      <div className="space-y-1 sm:space-y-2">
        <h1 className="text-lg sm:text-xl md:text-2xl lg:text-3xl">LCD Touchscreen 7" Display</h1>
        <p className="text-xs sm:text-sm md:text-base text-slate-600">Interactive hardware display preview (800×480 resolution)</p>
      </div>
      <div className="flex justify-center w-full">
        <div className="w-full max-w-6xl">
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-2 sm:p-3 md:p-4 lg:p-6 xl:p-8 rounded-xl sm:rounded-2xl shadow-2xl">
            <div className="bg-black p-1 sm:p-2 md:p-3 rounded-lg sm:rounded-xl shadow-inner">
              <div className={`w-full aspect-[5/3] bg-gradient-to-br ${selectedTheme.gradient} rounded-md sm:rounded-lg overflow-hidden relative`}>
                <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.05)_50%)] bg-[length:100%_4px] pointer-events-none z-10" />
                {/* Animated view wrapper */}
                <div key={currentView} className={`absolute inset-0 ${animClass}`}>
                  {renderView()}
                </div>
              </div>
            </div>
            <div className="mt-3 sm:mt-4 flex items-center justify-center gap-2 text-xs sm:text-sm text-slate-400">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span>Raspberry Pi 4B Connected - Touchscreen Active</span>
            </div>
          </div>
        </div>
      </div>
      <Card className="border-slate-200 shadow-lg hover:shadow-xl transition-shadow">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg"><Monitor className="w-4 h-4 sm:w-5 sm:h-5 text-sky-600" />LCD Display Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <div className="text-xs text-slate-900 mb-3">Specifications</div>
              <div className="space-y-1.5 text-xs text-slate-600">
                <div className="flex justify-between"><span>Resolution:</span><span className="text-slate-900">800×480 px</span></div>
                <div className="flex justify-between"><span>Size:</span><span className="text-slate-900">7 inches</span></div>
                <div className="flex justify-between"><span>Touch:</span><span className="text-slate-900">Capacitive</span></div>
                <div className="flex justify-between"><span>Refresh:</span><span className="text-slate-900">2 seconds</span></div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs text-slate-900 mb-3">Features</div>
              <ul className="space-y-1.5 text-xs text-slate-600">
                <li className="flex items-start gap-1.5"><span className="text-green-600 mt-0.5 flex-shrink-0">✓</span><span>Touch navigation</span></li>
                <li className="flex items-start gap-1.5"><span className="text-green-600 mt-0.5 flex-shrink-0">✓</span><span>Real-time monitoring</span></li>
                <li className="flex items-start gap-1.5"><span className="text-green-600 mt-0.5 flex-shrink-0">✓</span><span>SSR control (3 modes)</span></li>
                <li className="flex items-start gap-1.5"><span className="text-green-600 mt-0.5 flex-shrink-0">✓</span><span>Screensaver (30s idle)</span></li>
              </ul>
            </div>
            <div className="space-y-2">
              <div className="text-xs text-slate-900 mb-3">Data Source</div>
              <ul className="space-y-1.5 text-xs text-slate-600">
                <li className="flex items-start gap-1.5"><span className="text-blue-600 mt-0.5 flex-shrink-0">🔌</span><span>Connected to Dashboard</span></li>
                <li className="flex items-start gap-1.5"><span className="text-blue-600 mt-0.5 flex-shrink-0">📡</span><span>Real sensor data</span></li>
                <li className="flex items-start gap-1.5"><span className="text-blue-600 mt-0.5 flex-shrink-0">🔄</span><span>Live updates</span></li>
              </ul>
            </div>
            <div className="space-y-2">
              <div className="text-xs text-slate-900 mb-3">Navigation</div>
              <div className="space-y-1.5 text-xs text-slate-600">
                <div><div className="text-slate-900">Main Menu</div><div>Tap cards to view details</div></div>
                <div><div className="text-slate-900">SSR Control</div><div>Solar (K2) / Grid (K3) / Shutdown</div></div>
                <div><div className="text-slate-900">Screensaver</div><div>Auto after 30s · Tap to wake</div></div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}