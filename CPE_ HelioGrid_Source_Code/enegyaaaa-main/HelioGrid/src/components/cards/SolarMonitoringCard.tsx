import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Sun, Zap } from 'lucide-react';
import { useEnergySystem } from '../../contexts/EnergySystemContext';

const ARRAY_PMAX = 3000;
const ARRAY_VOC  = 104.74;
const ARRAY_VMP  = 88.86;
const ARRAY_IMP  = 26.56;

function SolarPowerGauge({ value, max }: { value: number; max: number }) {
  const RX = 6, RY = 6, RW = 308, RH = 92, RR = 46;
  const perimeter = 2 * (RW - 2 * RR) + 2 * (RH - 2 * RR) + 2 * Math.PI * RR;
  const pct    = Math.min(Math.max(value / max, 0), 1);
  const dashOff = perimeter * (1 - pct);
  const hasData = value > 0;
  const numVal  = value >= 1000 ? (value / 1000).toFixed(2) : value.toFixed(1);
  const unitVal = value >= 1000 ? ' kW' : ' W';
  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '32%' }}>
      <svg viewBox="-8 -8 336 116" preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible' }}>
        <defs>
          <linearGradient id="pillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#fefce8" stopOpacity={0} />
            <stop offset="10%"  stopColor="#fef08a" stopOpacity={0.55} />
            <stop offset="40%"  stopColor="#facc15" stopOpacity={1} />
            <stop offset="75%"  stopColor="#eab308" />
            <stop offset="100%" stopColor="#ca8a04" />
          </linearGradient>
          <filter id="pillGlow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect x={RX} y={RY} width={RW} height={RH} rx={RR} ry={RR} fill="white" stroke="#d1d5db" strokeWidth={14} />
        {hasData && (
          <rect x={RX} y={RY} width={RW} height={RH} rx={RR} ry={RR} fill="none"
            stroke="url(#pillGrad)" strokeWidth={12} strokeLinecap="round"
            strokeDasharray={perimeter} strokeDashoffset={dashOff} filter="url(#pillGlow)" />
        )}
        <text x={RX + RW / 2} y={RY + RH / 2} textAnchor="middle" dominantBaseline="central"
          fontFamily="ui-sans-serif, system-ui, sans-serif">
          <tspan fontSize="44" fontWeight="800" letterSpacing="-1" fill={hasData ? '#92400e' : '#9ca3af'}>{numVal}</tspan>
          <tspan fontSize="20" fontWeight="400" fill={hasData ? '#b45309' : '#9ca3af'} dy="3" dx="4">{unitVal}</tspan>
        </text>
      </svg>
    </div>
  );
}

export function SolarMonitoringCard() {
  const systemData = useEnergySystem();
  const solarVoltage: number    = Number(systemData.solarVoltage    ?? 0);
  const solarCurrent: number    = Number(systemData.solarCurrent    ?? 0);
  const inverterVoltage: number   = Number(systemData.inverterVoltage   ?? 0);
  const inverterCurrent: number   = Number(systemData.inverterCurrent   ?? 0);
  const inverterFrequency: number = Number(systemData.inverterFrequency ?? 0);
  const inverterPower: number     = Number(systemData.inverterPower     ?? 0);
  const _rawSolarP = Number(systemData.solarPower ?? 0);
  const dcPower: number = _rawSolarP > 0 ? _rawSolarP
    : (solarVoltage > 0 && solarCurrent > 0) ? parseFloat((solarVoltage * solarCurrent).toFixed(2)) : 0;
  const acPower: number = inverterPower > 0 ? inverterPower : (inverterVoltage * inverterCurrent);
  const hasSolarData    = solarVoltage > 0 || solarCurrent > 0;
  const hasInverterData = inverterVoltage > 0 || inverterCurrent > 0;
  const solarAnomaly    = systemData.solarAnomaly   ?? 'none';
  const inverterAnomaly = systemData.inverterAnomaly ?? 'none';

  const getDCStatusText = () => {
    if (!hasSolarData) return 'No Data';
    if (solarAnomaly === 'critical') return 'Critical';
    if (solarAnomaly === 'warning')  return 'Warning';
    if (solarVoltage < 20)               return 'Low';
    if (solarVoltage < ARRAY_VMP * 0.60) return 'Fair';
    return 'Normal';
  };
  const getACStatusText = () => {
    if (!hasInverterData) return 'No Data';
    if (inverterAnomaly === 'critical') return 'Critical';
    if (inverterAnomaly === 'warning')  return 'Warning';
    return 'Stable';
  };
  const invFreqStable = inverterFrequency >= 59.5 && inverterFrequency <= 60.5;

  return (
    <Card className="border-slate-200 shadow-lg hover:shadow-xl transition-shadow">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm sm:text-base">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-100">
              <Sun className="w-4 h-4 sm:w-5 sm:h-5 text-amber-600" />
            </div>
            <span>Solar Monitoring</span>
          </div>
          <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full ${
            !hasSolarData && !hasInverterData ? 'bg-slate-400'
              : solarAnomaly === 'none' && inverterAnomaly === 'none' ? 'bg-green-500 animate-pulse'
              : (solarAnomaly === 'critical' || inverterAnomaly === 'critical') ? 'bg-red-500 animate-pulse'
              : 'bg-yellow-500 animate-pulse'
          }`} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <SolarPowerGauge value={acPower} max={ARRAY_PMAX} />

        {/* Array Voltage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-slate-600">Array Voltage</span>
            <span className={`text-xs ${
              !hasSolarData ? 'text-slate-400' : solarAnomaly === 'critical' ? 'text-red-600' :
              solarAnomaly === 'warning' ? 'text-yellow-600' : solarVoltage < 20 ? 'text-red-500' :
              solarVoltage < ARRAY_VMP * 0.60 ? 'text-yellow-500' : 'text-green-600'
            }`}>{getDCStatusText()}</span>
          </div>
          <div className="flex items-end gap-2">
            <div className={`text-2xl sm:text-3xl lg:text-4xl ${!hasSolarData ? 'text-slate-400' : ''}`}>
              {solarVoltage.toFixed(1)}
            </div>
            <div className="text-sm sm:text-base text-slate-500 mb-1">V</div>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700" style={{
              width: `${hasSolarData ? Math.max(2, Math.min((solarVoltage / ARRAY_VOC) * 100, 100)) : 0}%`,
              background: !hasSolarData ? '#94a3b8' : solarAnomaly === 'none' ? '#f59e0b' : solarAnomaly === 'warning' ? '#eab308' : '#ef4444'
            }} />
          </div>
        </div>

        {/* Inverter AC Output */}
        <div className="pt-3 border-t border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap className={`w-4 h-4 ${!hasInverterData ? 'text-slate-400' : 'text-blue-500'}`} />
              <span className="text-xs sm:text-sm text-slate-600">Inverter AC Output</span>
            </div>
            <span className={`text-xs ${
              !hasInverterData ? 'text-slate-400' : inverterAnomaly === 'none' ? 'text-green-600' :
              inverterAnomaly === 'warning' ? 'text-yellow-600' : 'text-red-600'
            }`}>{getACStatusText()}</span>
          </div>
          <div className="space-y-2">
            <span className="text-xs sm:text-sm text-slate-600">Voltage</span>
            <div className="flex items-end gap-2">
              <div className={`text-2xl sm:text-3xl lg:text-4xl ${!hasInverterData ? 'text-slate-400' : ''}`}>
                {inverterVoltage.toFixed(1)}
              </div>
              <div className="text-sm sm:text-base text-slate-500 mb-1">V</div>
            </div>
            <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{
                width: `${hasInverterData && inverterVoltage > 0 ? Math.max(3, Math.min((inverterVoltage / 231) * 100, 100)) : 0}%`,
                background: !hasInverterData ? '#94a3b8' : inverterAnomaly === 'none' ? '#06b6d4' : inverterAnomaly === 'warning' ? '#eab308' : '#ef4444'
              }} />
            </div>
          </div>
          <div className="space-y-2 mt-3">
            <span className="text-xs sm:text-sm text-slate-600">Current</span>
            <div className="flex items-end gap-2">
              <div className={`text-2xl sm:text-3xl lg:text-4xl ${!hasInverterData ? 'text-slate-400' : ''}`}>
                {inverterCurrent.toFixed(2)}
              </div>
              <div className="text-sm sm:text-base text-slate-500 mb-1">A</div>
            </div>
            <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{
                width: `${hasInverterData ? Math.min((inverterCurrent / 13.8) * 100, 100) : 0}%`,
                background: !hasInverterData ? '#94a3b8' : '#0891b2'
              }} />
            </div>
          </div>
          <div className="pt-3 border-t border-slate-200 mt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs sm:text-sm text-slate-600">Frequency</span>
              <span className={`text-xs ${!hasInverterData ? 'text-slate-400' : invFreqStable ? 'text-green-600' : 'text-yellow-600'}`}>
                {!hasInverterData ? 'No Data' : invFreqStable ? 'Stable' : 'Unstable'}
              </span>
            </div>
            <div className="flex items-end gap-2 mt-1">
              <div className={`text-2xl sm:text-3xl ${!hasInverterData ? 'text-slate-400' : 'text-indigo-700'}`}>
                {inverterFrequency.toFixed(1)}
              </div>
              <div className="text-sm sm:text-base text-slate-500 mb-1">Hz</div>
            </div>
            <div className="h-2 bg-slate-200 rounded-full overflow-hidden mt-1">
              <div className="h-full rounded-full transition-all duration-700" style={{
                width: `${hasInverterData ? Math.min(100, ((inverterFrequency - 55) / 10) * 100) : 0}%`,
                background: !hasInverterData ? '#94a3b8' : invFreqStable ? '#6366f1' : '#eab308'
              }} />
            </div>
          </div>
        </div>

        <div className="pt-2 text-xs text-slate-500 flex items-center justify-between">
          <span>📡 Resistor Divider (V) + PZEM-004T (AC) · 4× 590W 2S2P (2.36kW) · TG-30224M60 3kW Inverter</span>
          {!hasSolarData && !hasInverterData && (
            <span className="text-amber-600 font-semibold">⚠ No sensor data</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
