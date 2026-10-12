import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Zap, TrendingUp, TrendingDown } from 'lucide-react';
import { useEnergySystem } from '../../contexts/EnergySystemContext';

// Circular gauge — 240° sweep, gap at bottom, blue gradient
function GridPowerGauge({ value, max }: { value: number; max: number }) {
  const cx = 95, cy = 95, r = 70;
  const startDeg = 150;
  const sweepDeg = 240;
  const pct = Math.min(Math.max(value / max, 0), 1);

  const toRad = (d: number) => d * Math.PI / 180;
  const sx = cx + r * Math.cos(toRad(startDeg));
  const sy = cy + r * Math.sin(toRad(startDeg));
  const endDeg = startDeg + pct * sweepDeg;
  const ex = cx + r * Math.cos(toRad(endDeg));
  const ey = cy + r * Math.sin(toRad(endDeg));
  const largeArc = pct * sweepDeg > 180 ? 1 : 0;

  // Track end point (full 240°)
  const tex = cx + r * Math.cos(toRad(startDeg + sweepDeg));
  const tey = cy + r * Math.sin(toRad(startDeg + sweepDeg));

  const hasData = value > 0;
  const numVal  = value >= 1000 ? (value / 1000).toFixed(1) : Math.round(value).toString();
  const unitVal = value >= 1000 ? 'kW' : 'W';

  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '34%' }}>
      <svg
        viewBox="0 5 190 108"
        preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="gridGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#bfdbfe" stopOpacity={0.3} />
            <stop offset="30%"  stopColor="#60a5fa" />
            <stop offset="70%"  stopColor="#2563eb" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
          <filter id="gridGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Track */}
        <path
          d={`M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 1 1 ${tex.toFixed(2)} ${tey.toFixed(2)}`}
          fill="none" stroke="#f1f5f9" strokeWidth={16} strokeLinecap="round"
        />

        {/* Progress arc */}
        {hasData && pct > 0.01 && (
          <path
            d={`M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`}
            fill="none" stroke="url(#gridGrad)" strokeWidth={16}
            strokeLinecap="round" filter="url(#gridGlow)"
          />
        )}

        {/* Tip dot */}
        {hasData && pct > 0.01 && (
          <circle cx={ex.toFixed(2)} cy={ey.toFixed(2)} r={6}
            fill="#60a5fa" filter="url(#gridGlow)" />
        )}

        {/* Number value */}
        <text
          x={cx} y={cy + 8}
          textAnchor="middle"
          fontSize="44" fontWeight="800"
          fill={hasData ? '#1e3a5f' : '#9ca3af'}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          letterSpacing="-2"
        >{numVal}</text>

        {/* Unit */}
        <text
          x={cx} y={cy + 26}
          textAnchor="middle"
          fontSize="15" fontWeight="400"
          fill="#64748b"
          fontFamily="ui-sans-serif, sans-serif"
        >{unitVal}</text>



      </svg>
    </div>
  );
}

export function GridMonitoringCard() {
  const systemData = useEnergySystem();

  const gridVoltage   = systemData.gridVoltage   ?? 0;
  const gridFrequency = systemData.gridFrequency ?? 60;
  const gridStatus    = systemData.gridStatus    ?? 'Unknown';
  const gridPower     = systemData.gridPower     ?? 0;
  const gridCurrent   = systemData.gridCurrent   ?? 0;

  const hasGridData = gridVoltage > 0;

  const voltageStatus   = !hasGridData ? 'offline' : (systemData.gridAnomaly === 'none' ? 'normal' : 'warning');
  const currentStatus   = !hasGridData ? 'offline' : (gridCurrent <= 5 ? 'normal' : 'warning');
  const frequencyStatus = !hasGridData ? 'offline' : (gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'stable' : 'unstable');

  const getVoltageStatusText = () => {
    if (!hasGridData) return 'No Data';
    if (systemData.gridAnomaly === 'critical') return 'Critical';
    if (systemData.gridAnomaly === 'warning')  return 'Warning';
    return gridStatus;
  };

  const getCurrentStatusText = () => {
    if (!hasGridData) return 'No Data';
    return currentStatus === 'normal' ? 'Normal' : 'High';
  };

  const getFrequencyStatusText = () => {
    if (!hasGridData) return 'No Data';
    return frequencyStatus === 'stable' ? 'Stable' : 'Unstable';
  };

  return (
    <Card className="border-slate-200 shadow-lg hover:shadow-xl transition-shadow">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm sm:text-base">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-100">
              <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600" />
            </div>
            <span>Grid Monitoring</span>
          </div>
          <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full ${
            !hasGridData
              ? 'bg-slate-400'
              : voltageStatus === 'normal' && currentStatus === 'normal'
                ? 'bg-green-500 animate-pulse'
                : 'bg-yellow-500 animate-pulse'
          }`} />
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">

        {/* ── Circular Power Gauge ── */}
        <GridPowerGauge value={gridPower} max={4600} />

        {/* ── Voltage ── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-slate-600">Voltage</span>
            <div className="flex items-center gap-1">
              {hasGridData && gridVoltage > 230 ? (
                <TrendingUp className="w-3 h-3 text-green-600" />
              ) : hasGridData && gridVoltage < 230 ? (
                <TrendingDown className="w-3 h-3 text-red-600" />
              ) : null}
              <span className={`text-xs ${
                !hasGridData ? 'text-slate-400' :
                systemData.gridAnomaly === 'none'    ? 'text-green-600'  :
                systemData.gridAnomaly === 'warning' ? 'text-yellow-600' : 'text-red-600'
              }`}>{getVoltageStatusText()}</span>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className={`text-2xl sm:text-3xl lg:text-4xl ${!hasGridData ? 'text-slate-400' : ''}`}>
              {gridVoltage.toFixed(1)}
            </div>
            <div className="text-sm sm:text-base text-slate-500 mb-1">V</div>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className={`h-full ${
                !hasGridData ? 'bg-slate-400' :
                systemData.gridAnomaly === 'none'    ? 'bg-blue-500'   :
                systemData.gridAnomaly === 'warning' ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${hasGridData && gridVoltage > 0 ? Math.max(3, Math.min((gridVoltage / 250) * 100, 100)) : 0}%` }}
            />
          </div>
        </div>

        {/* ── Current ── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-slate-600">Current</span>
            <span className={`text-xs ${
              !hasGridData ? 'text-slate-400' :
              currentStatus === 'normal' ? 'text-green-600' : 'text-yellow-600'
            }`}>{getCurrentStatusText()}</span>
          </div>
          <div className="flex items-end gap-2">
            <div className={`text-2xl sm:text-3xl lg:text-4xl ${!hasGridData ? 'text-slate-400' : ''}`}>
              {gridCurrent.toFixed(2)}
            </div>
            <div className="text-sm sm:text-base text-slate-500 mb-1">A</div>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className={`h-full ${
                !hasGridData ? 'bg-slate-400' :
                currentStatus === 'normal' ? 'bg-purple-500' : 'bg-yellow-500'
              }`}
              style={{ width: `${hasGridData && gridCurrent > 0 ? Math.max(3, Math.min((gridCurrent / 10) * 100, 100)) : 0}%` }}
            />
          </div>
        </div>

        {/* ── Frequency ── */}
        <div className="pt-3 border-t border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-slate-600">Frequency</span>
            <span className={`text-xs ${
              !hasGridData ? 'text-slate-400' :
              gridFrequency >= 59.5 && gridFrequency <= 60.5 ? 'text-green-600' : 'text-yellow-600'
            }`}>{getFrequencyStatusText()}</span>
          </div>
          <div className="flex items-end gap-2 mt-2">
            <div className={`text-2xl sm:text-3xl ${!hasGridData ? 'text-slate-400' : 'text-indigo-700'}`}>
              {gridFrequency.toFixed(1)}
            </div>
            <div className="text-sm sm:text-base text-slate-500 mb-1">Hz</div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="pt-2 text-xs text-slate-500 flex items-center justify-between">
          <span>📡 PZEM-004T · {gridVoltage.toFixed(1)}V · {gridFrequency.toFixed(1)}Hz</span>
          {!hasGridData && (
            <span className="text-amber-600 font-semibold">⚠ No sensor data</span>
          )}
          {hasGridData && systemData.gridAnomaly !== 'none' && (
            <span className="text-amber-600 font-semibold">⚠ {systemData.gridAnomaly}</span>
          )}
        </div>

      </CardContent>
    </Card>
  );
}
