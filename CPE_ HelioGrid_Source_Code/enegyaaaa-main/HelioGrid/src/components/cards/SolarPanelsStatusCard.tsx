import { Sun, CheckCircle, XCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useEnergySystem } from '../../contexts/EnergySystemContext';
import { useMemo } from 'react';

const solarImg = '/4panels.jpg';  // [FIX] public path

// 2S2P Array: 4× JAM72D40-580/MR panels
//   String 1: PV-01 + PV-02 in series  → Vstring = Vmp×2 ≈ 84.74V, Istring = Imp
//   String 2: PV-03 + PV-04 in series  → Vstring = Vmp×2 ≈ 84.74V, Istring = Imp
//   Array   : String1 ∥ String2        → Varray  = Vmp×2, Iarray = Imp×2
//
// WCS1500 per-panel sensors are unreliable (Arduino 1.33A noise floor).
// Proxy: use inverter AC current as solar array output estimate.
//   perPanelCurrent = inverterCurrent / 2
//     → 2S2P has 2 parallel strings; each string carries half the array current.
//     → Each panel in a series string carries the full string current.
//     → So per-panel current = per-string current = inverterCurrent / 2.
//   panelVoltage = solarVoltage / 2
//     → Two panels in series per string, so each panel sees half the string voltage.
const PANEL_IMP   = 13.28;  // JAM72D40-580 Imp (A) — datasheet

const getManilaHour = (): number => {
  const manila = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })
  );
  return manila.getHours();
};
const isSolarHarvestTime = (): boolean => {
  const h = getManilaHour();
  return h >= 6 && h < 18;
};

// Health thresholds — per-panel current = inverterCurrent / 2 (per-string in 2S2P)
const PANEL_THRESH_GOOD    = 2.0;   // A/panel → good  (≥4A inverter total)
const PANEL_THRESH_WARNING = 0.5;   // A/panel → warning

const getPVHealth = (current: number, isDay: boolean): number | null => {
  if (!isDay) return null;
  return Math.min(100, Math.round((current / PANEL_IMP) * 100));
};

type PanelStatus = 'good' | 'warning' | 'critical' | 'nodata';

interface DerivedPanel {
  id: number;
  name: string;
  string: 1 | 2;
  voltage: number;
  current: number;
  power: number;
  health: number | null;
  status: PanelStatus;
  faultReason?: string;
  isNight: boolean;
  isNoData: boolean;
}

function derivePanels(
  solarVoltage: number,
  solarAnomaly: 'none' | 'warning' | 'critical',
  inverterCurrent: number,
): DerivedPanel[] {
  // voltageOffsets removed — 2S2P panels in same string share identical voltage
  const isDay = isSolarHarvestTime();

  const hasLiveSensorData = solarVoltage > 0 || inverterCurrent > 0;

  if (!hasLiveSensorData) {
    return [0, 1, 2, 3].map((i) => ({
      id: i + 1, name: `PV-0${i + 1}`, string: (i < 2 ? 1 : 2) as 1 | 2,
      voltage: 0, current: 0, power: 0,
      health: null, status: 'nodata' as PanelStatus,
      isNight: false, isNoData: true,
    }));
  }

  // 2S2P current math:
  //   inverterCurrent / 2 = per-string current = per-panel current (series string)
  //   solarVoltage / 2    = per-panel voltage   (two panels in series per string)
  const perPanelCurrent = Math.max(0, parseFloat((inverterCurrent / 2).toFixed(2)));
  const panelBaseV      = solarVoltage > 0 ? solarVoltage / 2 : 0;

  return [0, 1, 2, 3].map((i) => {
    // All panels in same string share the same voltage — no artificial offset needed
    const voltage = Math.max(0, parseFloat(panelBaseV.toFixed(1)));
    const power   = parseFloat((voltage * perPanelCurrent).toFixed(1));
    const health  = getPVHealth(perPanelCurrent, isDay);

    if (!isDay) {
      return {
        id: i + 1, name: `PV-0${i + 1}`, string: (i < 2 ? 1 : 2) as 1 | 2,
        voltage, current: perPanelCurrent, power,
        health: null, status: 'good' as PanelStatus,
        isNight: true, isNoData: false,
      };
    }

    let status: PanelStatus = 'good';
    let faultReason: string | undefined;

    if (solarAnomaly === 'critical') {
      status = 'critical';
      faultReason = 'Array critical — low output';
    } else if (solarAnomaly === 'warning' || perPanelCurrent < PANEL_THRESH_WARNING) {
      status = 'warning';
      if (perPanelCurrent < PANEL_THRESH_WARNING)
        faultReason = `Low output ${perPanelCurrent.toFixed(2)}A (cloud/low load)`;
    } else if (perPanelCurrent < PANEL_THRESH_GOOD) {
      status = 'warning';
    }

    return {
      id: i + 1, name: `PV-0${i + 1}`, string: (i < 2 ? 1 : 2) as 1 | 2,
      voltage, current: perPanelCurrent, power,
      health, status, faultReason, isNight: false, isNoData: false,
    };
  });
}

function getColors(status: PanelStatus) {
  switch (status) {
    case 'good':
      return {
        boxBg:      'rgba(49, 207, 10, 0.75)',
        accentCol:  'text-emerald-400',
        barCol:     'bg-emerald-500',
        dotCol:     'bg-emerald-500',
        statusText: 'Optimal',
      };
    case 'warning':
      return {
        boxBg:      'rgba(120, 53, 15, 0.8)',
        accentCol:  'text-amber-400',
        barCol:     'bg-amber-500',
        dotCol:     'bg-amber-500',
        statusText: 'Warning',
      };
    case 'critical':
      return {
        boxBg:      'rgba(153, 27, 27, 0.8)',
        accentCol:  'text-red-400',
        barCol:     'bg-red-600',
        dotCol:     'bg-red-500',
        statusText: 'Critical',
      };
    case 'nodata':
    default:
      return {
        boxBg:      'rgba(30, 41, 59, 0.90)',
        accentCol:  'text-slate-400',
        barCol:     'bg-slate-600',
        dotCol:     'bg-slate-500',
        statusText: 'No Data',
      };
  }
}

const POSITIONS = [
  { x: '26%', y: '30%' },
  { x: '42%', y: '30%' },
  { x: '58%', y: '30%' },
  { x: '74%', y: '30%' },
];

const REPLACEMENT_REFS = [
  { range: '75–100%', label: 'Good',        desc: 'Normal operation',                     dotColor: '#10b981', textColor: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200' },
  { range: '60–74%',  label: 'Monitor',     desc: 'Slight degradation, observe',          dotColor: '#60a5fa', textColor: 'text-blue-700',    bgColor: 'bg-blue-50 border-blue-200'       },
  { range: '40–59%',  label: 'Aging',       desc: 'Clean panels, check connections',      dotColor: '#facc15', textColor: 'text-yellow-700',  bgColor: 'bg-yellow-50 border-yellow-200'   },
  { range: '20–39%',  label: 'Replace Soon',desc: 'Consistent low output after cleaning', dotColor: '#f97316', textColor: 'text-orange-700',  bgColor: 'bg-orange-50 border-orange-200'   },
  { range: '<20%',    label: 'Replace Now', desc: 'Panel no longer viable',               dotColor: '#ef4444', textColor: 'text-red-700',     bgColor: 'bg-red-50 border-red-200'         },
  { range: 'Night',   label: 'Night Mode',  desc: '0A expected, no anomaly',              dotColor: '#94a3b8', textColor: 'text-slate-600',   bgColor: 'bg-slate-50 border-slate-200'     },
];

export function SolarPanelsStatusCard() {
  const {
    solarVoltage,
    solarCurrent,
    solarPower,
    solarAnomaly,
    controlMode,
    contactorClosed,
    inverterCurrent,
    inverterPower,
  } = useEnergySystem();

  const hasLiveSensorData = solarVoltage > 0 || solarCurrent > 0 || inverterCurrent > 0;
  // All 4 panels show same estimated current (inverterCurrent / 4)
  const hasRealStringData = false; // WCS1500 not used — inverter current basis

  const panels = useMemo(
    () => derivePanels(solarVoltage, solarAnomaly, inverterCurrent),
    [solarVoltage, solarAnomaly, inverterCurrent],
  );

  const goodCount     = panels.filter(p => p.status === 'good'     && !p.isNoData).length;
  const warningCount  = panels.filter(p => p.status === 'warning'  && !p.isNoData).length;
  const criticalCount = panels.filter(p => p.status === 'critical' && !p.isNoData).length;
  const combinedPower = parseFloat(solarPower.toFixed(1));

  const dayPanels = panels.filter(p => p.health !== null);
  const avgHealth = dayPanels.length > 0
    ? dayPanels.reduce((sum, p) => sum + (p.health ?? 0), 0) / dayPanels.length
    : null;

  const isNight = !isSolarHarvestTime();

  const systemOnline =
    controlMode !== 'shutdown' &&
    contactorClosed &&
    solarAnomaly !== 'critical';

  const systemLabel = !hasLiveSensorData
    ? 'No Sensor'
    : !contactorClosed
    ? 'Safe Mode'
    : solarAnomaly === 'critical'
    ? 'Array Fault'
    : solarAnomaly === 'warning'
    ? 'Low Output'
    : controlMode === 'shutdown'
    ? 'Shutdown'
    : isNight
    ? 'Night Mode'
    : 'Array Online';

  const SystemIcon      = systemOnline ? CheckCircle : solarAnomaly === 'critical' ? XCircle : Activity;

  const systemIconColor = !hasLiveSensorData ? 'text-slate-400'    : systemOnline ? 'text-emerald-400' : solarAnomaly === 'critical' ? 'text-red-400' : 'text-amber-400';
  const systemBgColor   = !hasLiveSensorData ? 'bg-slate-500/20 border-slate-500/30' : systemOnline ? 'bg-emerald-500/20 border-emerald-500/30' : solarAnomaly === 'critical' ? 'bg-red-500/20 border-red-500/30' : 'bg-amber-500/20 border-amber-500/30';
  const systemTextColor = !hasLiveSensorData ? 'text-slate-400'    : systemOnline ? 'text-emerald-400' : solarAnomaly === 'critical' ? 'text-red-400' : 'text-amber-300';
  const combinedPowerColor = solarAnomaly === 'critical' ? 'text-red-400' : 'text-amber-400';

  const indicatorDotColor = !hasLiveSensorData
    ? 'bg-slate-400'
    : criticalCount > 0 ? 'bg-red-500'
    : warningCount  > 0 ? 'bg-yellow-500'
    : 'bg-green-500';

  return (
    <Card className="w-full border-slate-200 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden flex flex-col bg-white">

      {/* ── HEADER ── */}
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base sm:text-lg">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-100">
              <Sun className="w-4 h-4 sm:w-5 sm:h-5 text-amber-600" />
            </div>
            <span>Solar Panels Status</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-600">4 Panels</span>
            <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full ${indicatorDotColor} animate-pulse`} />
          </div>
        </CardTitle>
        <p className="text-xs text-slate-600 mt-1">
          Real-time monitoring of individual solar panel health and performance
        </p>
      </CardHeader>

      {/* ── SUMMARY STATS ── */}
      <CardContent className="pb-0 px-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200">
            <div className="text-xs text-green-600 mb-1">Good</div>
            <div className="text-2xl text-green-900">{hasLiveSensorData ? goodCount : '—'}</div>
          </div>
          <div className="p-3 rounded-lg bg-gradient-to-br from-yellow-50 to-amber-50 border border-yellow-200">
            <div className="text-xs text-yellow-600 mb-1">Warning</div>
            <div className="text-2xl text-yellow-900">{hasLiveSensorData ? warningCount : '—'}</div>
          </div>
          <div className="p-3 rounded-lg bg-gradient-to-br from-red-50 to-rose-50 border border-red-200">
            <div className="text-xs text-red-600 mb-1">Critical</div>
            <div className="text-2xl text-red-900">{hasLiveSensorData ? criticalCount : '—'}</div>
          </div>
          <div className="p-3 rounded-lg bg-gradient-to-br from-blue-50 to-cyan-50 border border-blue-200">
            <div className="text-xs text-blue-600 mb-1">Avg Health</div>
            <div className="text-2xl text-blue-900">
              {!hasLiveSensorData ? '—' : isNight ? 'Night' : avgHealth !== null ? `${avgHealth.toFixed(0)}%` : '—'}
            </div>
          </div>
        </div>

        {!hasLiveSensorData && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-slate-100 border border-slate-300 text-center">
            <span className="text-xs text-slate-500">No sensor data — connect WCS1500 / voltage divider</span>
          </div>
        )}
      </CardContent>

      {/* ── MAP AREA ── */}
      <CardContent className="p-0 relative w-full overflow-hidden" style={{ height: '650px' }}>
        <div className="absolute inset-0 z-0">
          <img
            src={solarImg}
            alt="Solar Installation"
            className="w-full h-full object-cover"
            onError={(e) => {
              e.currentTarget.src =
                '4panels.jpg'; // Fallback to local image if public path fails (for Vite)
            }}
          />
        </div>

        <div className={`absolute inset-0 z-1 transition-all duration-700 ${
          !hasLiveSensorData
            ? 'bg-slate-950/50'
            : isNight
            ? 'bg-slate-950/50'
            : solarAnomaly === 'critical' ? 'bg-red-950/30'
            : solarAnomaly === 'warning'  ? 'bg-amber-950/20'
            : 'bg-slate-950/10'
        }`} />

        <div className="relative z-10 w-full h-full">
          {panels.map((panel, index) => {
            const pos    = POSITIONS[index];
            const colors = getColors(panel.status);

            // ── NO DATA CARD (current only, no V/W) ──
            if (panel.isNoData) {
              return (
                <div
                  key={panel.id}
                  className="absolute w-[180px] sm:w-[200px] max-w-[90vw] flex flex-col p-3 shadow-2xl z-30 rounded-xl border border-white/10 backdrop-blur-md"
                  style={{
                    left: pos.x,
                    top: pos.y,
                    transform: 'translate(-50%, -50%)',
                    backgroundColor: 'rgba(30, 41, 59, 0.90)',
                    minHeight: '90px',
                  }}
                >
                  {/* Header row */}
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                      <span className="text-[10px] font-black text-white/90 uppercase tracking-tighter italic">
                        {panel.name}
                      </span>
                    </div>
                    <span className="text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-black/40 border border-white/5 text-slate-400">
                      No Data
                    </span>
                  </div>

                  {/* Current only — big display */}
                  <div className="flex items-end gap-2 mb-2">
                    <div className="text-5xl font-black italic tracking-tighter leading-none text-slate-500">
                      —
                    </div>
                    <span className="text-2xl font-bold text-slate-500 mb-1">A</span>
                  </div>

                  {/* Health bar */}
                  <div className="space-y-1 mb-2">
                    <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                      <div className="h-full bg-slate-600 w-0" />
                    </div>
                    <div className="flex justify-between items-center px-0.5">
                      <span className="text-[7px] text-white/30 font-black uppercase tracking-widest">PV Health</span>
                      <span className="text-[9px] font-black text-slate-500">—</span>
                    </div>
                  </div>

                  {/* Reason — bottom */}
                  <div className="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">
                    <span className="text-[7px] font-bold text-slate-400">No sensor connected</span>
                  </div>
                </div>
              );
            }

            // ── NORMAL CARD (current only, no V/W shown) ──
            return (
              <div
                key={panel.id}
                className="absolute w-[200px] flex flex-col p-3 transition-all duration-700 shadow-2xl z-30 rounded-xl border border-white/10 backdrop-blur-md"
                style={{
                  left: pos.x,
                  top: pos.y,
                  transform: 'translate(-50%, -50%)',
                  backgroundColor: panel.isNight ? 'rgba(30, 41, 59, 0.85)' : colors.boxBg,
                  minHeight: panel.faultReason ? '115px' : '90px',
                }}
              >
                {/* Header row */}
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      panel.isNight ? 'bg-slate-400' : colors.dotCol
                    } ${panel.isNight ? '' : 'animate-pulse'}`} />
                    <span className="text-[10px] font-black text-white/90 uppercase tracking-tighter italic">
                      {panel.name}
                    </span>
                    <span className="text-[8px] text-white/40 font-mono ml-1">
                      S{panel.string}
                    </span>
                  </div>
                  <span className={`text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-black/40 border border-white/5 ${
                    panel.isNight ? 'text-slate-300' : colors.accentCol
                  }`}>
                    {panel.isNight ? 'Night Mode' : colors.statusText}
                  </span>
                </div>

                {/* Current — big display only */}
                <div className="flex items-end gap-2 mb-2">
                  <div className={`text-5xl font-black italic tracking-tighter leading-none ${
                    panel.isNight ? 'text-slate-300' : 'text-white'
                  }`}>
                    {panel.current.toFixed(2)}
                  </div>
                  <span className={`text-2xl font-bold mb-1 ${
                    panel.isNight ? 'text-slate-400' : colors.accentCol
                  }`}>A</span>
                </div>

                {/* Est. label — always shown since inverter-based */}
                {!panel.isNight && (
                  <div className="mb-2 px-1.5 py-0.5 rounded bg-black/50 border border-white/10">
                    <span className="text-[7px] font-bold text-white/40">Est. · Inv÷2 (2S2P string)</span>
                  </div>
                )}

                {/* Fault reason */}
                {panel.faultReason && (
                  <div className="mb-2 px-1.5 py-0.5 rounded bg-black/50 border border-white/10">
                    <span className={`text-[7px] font-bold ${colors.accentCol}`}>
                      {panel.faultReason}
                    </span>
                  </div>
                )}

                {/* Health bar */}
                <div className="mt-auto space-y-1">
                  <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <div
                      className={`h-full ${panel.isNight ? 'bg-slate-500' : colors.barCol} transition-all duration-1000`}
                      style={{
                        width: panel.isNight
                          ? '0%'
                          : `${Math.min(100, (panel.current / PANEL_IMP) * 100)}%`
                      }}
                    />
                  </div>
                  <div className="flex justify-between items-center px-0.5">
                    <span className="text-[7px] text-white/40 font-black uppercase tracking-widest">
                      PV Health
                    </span>
                    <span className={`text-[9px] font-black ${panel.isNight ? 'text-slate-400' : colors.accentCol}`}>
                      {panel.isNight ? 'Night' : `${panel.health ?? 0}%`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── HUD OVERLAY ── */}
        <div className="absolute bottom-6 left-6 right-6 z-20 flex justify-between items-center p-5 rounded-3xl bg-slate-900/85 backdrop-blur-md border border-white/10 shadow-2xl">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-2xl border ${systemBgColor}`}>
              <SystemIcon className={`w-6 h-6 ${systemIconColor}`} />
            </div>
            <div>
              <span className={`text-[10px] font-black uppercase italic tracking-[0.2em] block ${systemTextColor}`}>
                System Status
              </span>
              <span className={`font-bold text-lg uppercase ${systemTextColor}`}>
                {systemLabel}
              </span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-white/40 font-black uppercase block tracking-widest mb-1">
              Array Output
            </span>
            <div className={`text-5xl font-black italic leading-none tracking-tighter ${combinedPowerColor}`}>
              {hasLiveSensorData ? combinedPower : '—'}
              <span className="text-xl font-normal ml-2 text-white/70">W</span>
            </div>
            <div className="text-[9px] text-white/30 tracking-widest mt-0.5">
              {hasLiveSensorData
                ? `${solarVoltage.toFixed(1)}V · ${solarCurrent.toFixed(2)}A · 2S2P 4x550W 2.2kW${(inverterPower ?? 0) > 5 ? ' · ⚡ est.' : ''}`
                : 'No sensor connected · 2S2P 4x550W 2.2kW'}
            </div>
          </div>
        </div>
      </CardContent>

      {/* ── FOOTER — Two cards: Voltage (blue left) + Power (amber right) ── */}
      <div className="px-6 pt-4 pb-4 border-t border-slate-100">
        <div className="grid grid-cols-2 gap-3">

          {/* LEFT — Total Voltage (blue) */}
          <div className="p-4 rounded-lg bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sun className="w-5 h-5 text-blue-500" />
                <span className="text-sm text-blue-900">Total Voltage</span>
              </div>
              <div className="flex items-end gap-1">
                <span className="text-2xl sm:text-3xl text-blue-900">
                  {hasLiveSensorData ? solarVoltage.toFixed(1) : '—'}
                </span>
                <span className="text-sm text-blue-500 mb-1">V</span>
              </div>
            </div>
          </div>

          {/* RIGHT — Total Power (amber) */}
          <div className="p-4 rounded-lg bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sun className="w-5 h-5 text-amber-600" />
                <span className="text-sm text-amber-900">Total Power</span>
              </div>
              <div className="flex items-end gap-1">
                <span className="text-2xl sm:text-3xl text-amber-900">
                  {hasLiveSensorData ? combinedPower.toFixed(1) : '—'}
                </span>
                <span className="text-sm text-amber-600 mb-1">W</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* ── REFERENCE CARD ── */}
      <div className="px-6 pb-6 pt-3">
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700">Panel Health Reference</span>
            <span className="text-[10px] text-slate-400">Based on JAM72D40-580 Imp = 13.28A</span>
          </div>
          <div className="divide-y divide-slate-100">
            {REPLACEMENT_REFS.map((ref) => (
              <div key={ref.range} className={`flex items-center gap-3 px-4 py-2.5 ${ref.bgColor} border-l-0`}>
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: ref.dotColor }}
                />
                <span className="text-[11px] font-bold text-slate-600 w-16 flex-shrink-0">{ref.range}</span>
                <span className={`text-[11px] font-semibold w-24 flex-shrink-0 ${ref.textColor}`}>{ref.label}</span>
                <span className="text-[10px] text-slate-500 leading-tight">{ref.desc}</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 bg-slate-50 border-t border-slate-200">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Health % is daytime only (6AM–6PM PHT). Clean panels first before deciding replacement.
              If health stays below 40% for 14+ consecutive clear days after cleaning, panel replacement is recommended.
              K3 Grid Assist activates at &lt;24.0V · Stops at ≥28.4V · Contactor opens at &lt;21.0V (deep discharge).
            </p>
          </div>
        </div>
      </div>

    </Card>
  );
}
