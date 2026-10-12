import { Battery } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useEnergySystem } from '../../contexts/EnergySystemContext';

// ── JSL II VRLA Gel 12V 100Ah × 2 in SERIES → 24V pack ──────────────────────
//
// IMPORTANT — Two-voltage-scenario rule (v8.0):
//   CHARGING voltage  (solar/inverter active) → ≥27.0V → NOT a valid SOC reference.
//   RESTING  voltage  (no source, stable)     → use SOC_TABLE below for SOC lookup.
//
// SOC table is calibrated to RESTING open-circuit voltage of a 24V gel battery.
// During float/absorption charging the terminal voltage is always elevated (27–29V)
// and must NEVER be mapped to SOC — doing so gives a false 100% reading.
//
// References:
//   Fully charged (resting) : 25.4–25.6V → 100%
//   75%                     : ~25.0V
//   50%                     : ~24.5V  (recharge recommended)
//   25%                     : ~24.0V  (low — avoid deep discharge)
//   ~0%                     : ≤23.8V  (deep discharge — harmful to gel)
//   Inverter cut-off target : 24.0–24.2V (resting)
// ─────────────────────────────────────────────────────────────────────────────

// Charging voltage threshold — above this value the battery is being actively
// charged and resting-voltage SOC lookup is not reliable.
const CHARGING_VOLTAGE_THRESHOLD = 27.0; // V

// Resting-voltage SOC lookup table — gel VRLA 24V (2S × 12V 100Ah JSL II)
// Calibrated to open-circuit (resting) voltage. Do NOT use while charging.
const SOC_TABLE = [
  { v: 25.60, soc: 100 },
  { v: 25.40, soc: 98  },
  { v: 25.20, soc: 95  },
  { v: 25.00, soc: 90  },
  { v: 24.80, soc: 84  },
  { v: 24.60, soc: 78  },
  { v: 24.50, soc: 72  },
  { v: 24.30, soc: 62  },
  { v: 24.10, soc: 50  },
  { v: 24.00, soc: 43  },
  { v: 23.80, soc: 33  },
  { v: 23.60, soc: 23  },
  { v: 23.40, soc: 14  },
  { v: 23.20, soc: 7   },
  { v: 23.00, soc: 2   },
  { v: 22.50, soc: 0   },
];

const calcRestingSOC = (v: number): number => {
  if (v >= SOC_TABLE[0].v) return 100;
  if (v <= SOC_TABLE[SOC_TABLE.length - 1].v) return 0;
  for (let i = 0; i < SOC_TABLE.length - 1; i++) {
    const hi = SOC_TABLE[i], lo = SOC_TABLE[i + 1];
    if (v <= hi.v && v > lo.v) {
      const ratio = (v - lo.v) / (hi.v - lo.v);
      return lo.soc + ratio * (hi.soc - lo.soc);
    }
  }
  return 0;
};

// Charge state inference
// K1 active = inverter is supplying load from battery (discharging)
// isCharging = solar/grid is actively pushing current into the pack
const inferState = (
  v: number,
  k1: boolean,
  isCharging: boolean,
): 'charging' | 'float' | 'full' | 'idle' | 'discharging' | 'critical' => {
  if (v < 22.0) return 'critical';
  if (isCharging) {
    if (v >= 28.8) return 'charging';  // absorption phase
    return 'float';                    // float / finishing charge
  }
  if (k1) return 'discharging';
  if (v >= 25.4) return 'full';        // resting ≥ 25.4V = confirmed full
  return 'idle';
};

// Reference rows shown in the voltage strip (resting voltage scale only)
const SOC_REF = [
  { soc: 100, v: '25.4–25.6 V' },
  { soc: 90,  v: '~25.0 V'     },
  { soc: 72,  v: '~24.5 V'     },
  { soc: 43,  v: '~24.0 V'     },
  { soc: 23,  v: '~23.6 V'     },
  { soc: 0,   v: '≤ 22.5 V'   },
];

export function BatteryHealthCard() {
  const {
    batteryVoltage,
    batterySOC,
    batteryAnomalyDetails,
    k1Active,
    solarPower,
  } = useEnergySystem();

  const packVoltage    = batteryVoltage > 0 ? batteryVoltage : 0;
  const hasBatteryData = packVoltage > 10.0;

  // ── Charging detection ────────────────────────────────────────────────────
  // Battery is "charging" when terminal voltage is in float/absorption range
  // AND a solar source is confirmed active (solarPower > 5W).
  const isCharging = hasBatteryData
    && packVoltage >= CHARGING_VOLTAGE_THRESHOLD
    && (solarPower ?? 0) > 5;

  // ── Voltage smoothing — rolling average of last 8 readings ───────────────
  const voltHistRef = useRef<number[]>([]);
  useEffect(() => {
    if (!hasBatteryData) return;
    voltHistRef.current = [...voltHistRef.current.slice(-7), packVoltage];
  }, [packVoltage, hasBatteryData]);
  const smoothedVoltage = voltHistRef.current.length > 0
    ? voltHistRef.current.reduce((a, b) => a + b, 0) / voltHistRef.current.length
    : packVoltage;

  // ── SOC calculation ───────────────────────────────────────────────────────
  // While charging: terminal voltage is not a valid SOC reference.
  // Fall back to backend-supplied batterySOC (coulomb-counted or last known),
  // or compute from smoothed voltage as a rough estimate only.
  // While resting/discharging: use corrected resting-voltage SOC table.
  const rawSOC = hasBatteryData
    ? isCharging
      ? (batterySOC > 0 ? batterySOC : calcRestingSOC(smoothedVoltage))
      : calcRestingSOC(smoothedVoltage)
    : 0;
  const packSOC = Math.round(rawSOC * 10) / 10;

  const state = hasBatteryData
    ? inferState(packVoltage, k1Active ?? false, isCharging)
    : 'idle';

  // ── SOC trend (last 20 resting readings) ─────────────────────────────────
  // Trend accumulation is paused during charging — voltage rise from charging
  // is not a real SOC change and would produce a misleading "Rising" label.
  const historyRef = useRef<number[]>([]);
  useEffect(() => {
    if (!hasBatteryData || isCharging) return;
    historyRef.current = [...historyRef.current.slice(-19), packSOC];
  }, [packSOC, hasBatteryData, isCharging]);
  const history = historyRef.current;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const smoothedFirst = history.length >= 3 ? avg(history.slice(0, 3)) : history[0] ?? 0;
  const smoothedLast  = history.length >= 3 ? avg(history.slice(-3))   : history[history.length - 1] ?? 0;
  const trendDelta = history.length >= 2 ? smoothedLast - smoothedFirst : 0;

  const trendLabel = !hasBatteryData ? '—'
    : isCharging                     ? '⚡ Charging'
    : trendDelta >  5                ? '↑ Rising'
    : trendDelta < -5                ? '↓ Falling'
    : '→ Stable';
  const trendColor = !hasBatteryData ? '#94a3b8'
    : isCharging                     ? '#16a34a'
    : trendDelta >  5                ? '#16a34a'
    : trendDelta < -5                ? '#2563eb'
    : '#64748b';

  // ── Color helpers ─────────────────────────────────────────────────────────
  const getHealthColor = (soc: number) => {
    if (!hasBatteryData) return 'text-slate-400';
    if (isCharging)      return 'text-green-500';
    if (soc >= 80)       return 'text-green-500';
    if (soc >= 50)       return 'text-yellow-500';
    if (soc >= 25)       return 'text-orange-500';
    return 'text-red-500';
  };
  const getHealthBg = (soc: number) => {
    if (!hasBatteryData) return 'from-slate-400 to-slate-500';
    if (isCharging)      return 'from-green-500 to-emerald-600';
    if (soc >= 80)       return 'from-green-500 to-emerald-600';
    if (soc >= 50)       return 'from-yellow-500 to-orange-600';
    if (soc >= 25)       return 'from-orange-500 to-red-600';
    return 'from-red-500 to-rose-600';
  };
  const getHealthStatus = (soc: number) => {
    if (!hasBatteryData) return 'No Data';
    if (isCharging)      return 'Charging';
    if (soc >= 80)       return 'Excellent';
    if (soc >= 50)       return 'Good';
    if (soc >= 25)       return 'Fair';
    return 'Critical';
  };
  const getVoltageStatus = (v: number) => {
    if (!hasBatteryData) return 'No Data';
    if (isCharging)      return 'Charging';
    if (v >= 25.4)       return 'Full';
    if (v >= 24.5)       return 'Normal';
    if (v >= 23.8)       return 'Fair';
    return 'Low';
  };
  const getVoltageStatusColor = (v: number) => {
    if (!hasBatteryData) return 'text-slate-400';
    if (isCharging)      return 'text-green-600';
    if (v >= 25.4)       return 'text-green-600';
    if (v >= 24.5)       return 'text-green-500';
    if (v >= 23.8)       return 'text-yellow-600';
    return 'text-red-600';
  };
  const socBarColor = (soc: number) =>
    !hasBatteryData ? 'bg-slate-400'
    : isCharging    ? 'bg-green-500'
    : soc >= 80     ? 'bg-green-500'
    : soc >= 50     ? 'bg-yellow-500'
    : soc >= 25     ? 'bg-orange-500'
    : 'bg-red-500';

  const stateConfig = {
    charging:    { label: '⚡ Charging',       cls: 'bg-green-100 text-green-700 border-green-300',   dot: 'bg-green-500 animate-pulse' },
    float:       { label: '〜 Float Charge',   cls: 'bg-teal-50 text-teal-700 border-teal-300',       dot: 'bg-teal-400 animate-pulse'  },
    full:        { label: '✦ Full (Resting)',  cls: 'bg-green-50 text-green-700 border-green-300',    dot: 'bg-green-500'               },
    idle:        { label: '◎ Idle (Resting)',  cls: 'bg-slate-100 text-slate-600 border-slate-300',   dot: 'bg-slate-400'               },
    discharging: { label: '▼ Discharging',     cls: 'bg-blue-50 text-blue-700 border-blue-300',       dot: 'bg-blue-500 animate-pulse'  },
    critical:    { label: '⚠ Critical',        cls: 'bg-red-50 text-red-700 border-red-300',          dot: 'bg-red-500 animate-pulse'   },
  };
  const sc = stateConfig[state];

  // Voltage bar — resting scale: 22.5V (0%) → 25.6V (100%)
  // During charging: clamp bar to full (voltage exceeds resting range)
  const voltPct = hasBatteryData
    ? isCharging
      ? 100
      : Math.max(0, Math.min(100, ((packVoltage - 22.5) / (25.6 - 22.5)) * 100))
    : 0;

  // Mini sparkline
  const sparkW = 120, sparkH = 28;
  const sparkPath = (() => {
    if (history.length < 2) return '';
    const min = Math.min(...history), max = Math.max(...history);
    const range = max - min || 1;
    return history.map((v, i) => {
      const x = (i / (history.length - 1)) * sparkW;
      const y = sparkH - ((v - min) / range) * sparkH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  })();

  return (
    <Card className="border-slate-200 shadow-lg hover:shadow-xl transition-all duration-300 h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm sm:text-base">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-green-100">
              <Battery className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" />
            </div>
            <span>Battery Health</span>
          </div>
          <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full ${hasBatteryData ? sc.dot : 'bg-slate-400'}`} />
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">

        {/* Pack SOC */}
        <div className="text-center">
          <div className={`text-4xl sm:text-5xl font-bold ${getHealthColor(packSOC)} mb-2`}>
            {hasBatteryData ? (packSOC >= 100 ? '100%' : `${packSOC.toFixed(1)}%`) : '—'}
          </div>
          {isCharging && (
            <div className="text-[10px] text-slate-500 mb-1">
              Last known resting SOC — charging voltage ({packVoltage.toFixed(2)} V) is not a SOC reference
            </div>
          )}
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r ${getHealthBg(packSOC)} shadow-md`}>
            <div className={`w-2 h-2 rounded-full bg-white ${hasBatteryData ? 'animate-pulse' : ''}`} />
            <span className="text-xs font-medium text-white">
              {getHealthStatus(packSOC)} · Pack SOC
            </span>
          </div>
        </div>

        {/* State pill */}
        {hasBatteryData && (
          <div className="flex justify-center">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${sc.cls}`}>
              {sc.label}
            </span>
          </div>
        )}

        {/* Charging notice banner */}
        {isCharging && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
            <span className="font-semibold">⚡ Solar charging active</span> — {packVoltage.toFixed(2)} V is a{' '}
            <span className="font-semibold">charging voltage</span>, not a resting SOC reference.
            Accurate SOC resumes ~30–60 min after solar stops and voltage stabilises.
          </div>
        )}

        {/* Pack Voltage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-slate-600 font-medium">
              Pack Voltage (JSL II 24V VRLA · Resting full ≈ 25.4–25.6 V)
            </span>
            <span className={`text-xs font-semibold ${getVoltageStatusColor(packVoltage)}`}>
              {getVoltageStatus(packVoltage)}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <div className={`text-2xl sm:text-3xl font-bold ${getHealthColor(packSOC)}`}>
              {hasBatteryData ? packVoltage.toFixed(2) : '—'}
            </div>
            <div className="text-sm text-slate-500 mb-1 font-medium">V · 100Ah</div>
            {isCharging && (
              <div className="text-xs text-green-600 mb-1 font-medium">(charging)</div>
            )}
          </div>
          {/* SOC bar — driven by packSOC (0–100%) */}
          <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${socBarColor(packSOC)}`}
              style={{ width: `${hasBatteryData ? (isCharging ? 100 : packSOC) : 0}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          {/* Voltage bar — driven by voltPct (resting voltage scale) */}
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${socBarColor(packSOC)} opacity-50`}
              style={{ width: `${voltPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span>22.5V (0%)</span>
            <span>24.0V (≈43%)</span>
            <span>25.6V (100%)</span>
          </div>
        </div>

        {/* SOC Trend + sparkline */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-600 font-medium">SOC Trend (resting only)</span>
            <span className="text-xs font-semibold" style={{ color: trendColor }}>{trendLabel}</span>
          </div>
          <div className="flex items-center gap-3">
            <svg width={sparkW} height={sparkH} style={{ flexShrink: 0 }}>
              {sparkPath && !isCharging ? (
                <>
                  <path d={sparkPath} fill="none" stroke={trendColor} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                  {history.length >= 2 && (() => {
                    const min = Math.min(...history), max = Math.max(...history);
                    const range = max - min || 1;
                    const lx = sparkW;
                    const ly = sparkH - ((history[history.length - 1] - min) / range) * sparkH;
                    return <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r={3} fill={trendColor} />;
                  })()}
                </>
              ) : (
                <line x1={0} y1={sparkH / 2} x2={sparkW} y2={sparkH / 2} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" />
              )}
            </svg>
            <div className="flex flex-col">
              <span className="text-xs text-slate-400">
                {isCharging ? 'Paused — solar charging' : `Δ last ${history.length} readings`}
              </span>
              <span className="text-sm font-semibold" style={{ color: trendColor }}>
                {!isCharging && hasBatteryData && history.length >= 2
                  ? `${trendDelta >= 0 ? '+' : ''}${trendDelta.toFixed(0)}%`
                  : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Voltage Reference Scale — resting-voltage SOC table */}
        <div>
          <div className="text-xs text-slate-500 font-medium mb-2">
            Voltage Reference — JSL II 24V Gel (resting OCV · no load, no solar)
          </div>
          <div className="space-y-1">
            {SOC_REF.map(({ soc, v }) => {
              const barColor =
                soc >= 80 ? '#34d399' : soc >= 50 ? '#facc15' : soc >= 25 ? '#fb923c' : '#f87171';
              const textColor =
                soc >= 80 ? '#16a34a' : soc >= 50 ? '#ca8a04' : soc >= 25 ? '#ea580c' : '#dc2626';
              const idx = SOC_REF.findIndex(r => r.soc === soc);
              const isActive = !isCharging && hasBatteryData
                && packSOC >= soc
                && (idx === 0 || packSOC < (SOC_REF[idx - 1]?.soc ?? 101));
              return (
                <div
                  key={soc}
                  className={`flex items-center gap-2 px-2 py-1 rounded transition-all ${isActive ? 'bg-slate-100 border border-slate-200' : ''}`}
                >
                  <div style={{ width: 28, textAlign: 'right', fontSize: 11, fontWeight: 600, color: textColor, flexShrink: 0 }}>
                    {soc}%
                  </div>
                  <div style={{ flex: 1, height: 4, borderRadius: 99, background: '#e2e8f0', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${soc}%`, background: barColor, borderRadius: 99 }} />
                  </div>
                  <div style={{ width: 72, fontSize: 10, color: '#94a3b8', textAlign: 'right', flexShrink: 0 }}>
                    {v}
                  </div>
                  {isActive && (
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: barColor, flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>
          {isCharging && (
            <div className="mt-1 text-[10px] text-green-700 italic">
              Active row paused — resting voltage reference only. Check SOC after solar stops.
            </div>
          )}
        </div>

        {/* Anomalies */}
        {batteryAnomalyDetails && batteryAnomalyDetails.length > 0 && (
          <div className="pt-2 border-t border-slate-200">
            <div className="rounded-lg p-2 bg-red-50 border border-red-200 space-y-1">
              <div className="text-[11px] font-semibold text-red-800">⚠ Battery Anomalies</div>
              {batteryAnomalyDetails.map((msg, i) => (
                <div key={i} className="text-[10px] text-red-700">{msg}</div>
              ))}
            </div>
          </div>
        )}

        {/* Sensor Info */}
        <div className="pt-2 border-t border-slate-200">
          <div className={`rounded-lg p-2 border flex items-center gap-2 ${hasBatteryData ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className={`w-2 h-2 rounded-full shrink-0 ${hasBatteryData ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}`} />
            <div className="text-xs">
              <span className={`font-semibold ${hasBatteryData ? 'text-blue-900' : 'text-amber-900'}`}>
                📡 INA219 × 1 · Voltage Divider · JSL II 2× 12V 100Ah Series
              </span>
              {!hasBatteryData && <span className="text-amber-800 font-semibold ml-2">⚠ No Data</span>}
              {isCharging && (
                <span className="text-green-700 font-semibold ml-2">· Charging — SOC est. from last resting V</span>
              )}
            </div>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
