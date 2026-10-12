import { BatteryHealthCard } from './cards/BatteryHealthCard';
import { GridMonitoringCard } from './cards/GridMonitoringCard';
import { SolarMonitoringCard } from './cards/SolarMonitoringCard';
import { SystemStatusCard } from './cards/SystemStatusCard';
import { SystemRefreshIndicator } from './SystemRefreshIndicator';
import { EnergyFlowHub } from './cards/EnergyFlowHub';
import { useEnergySystem } from '../contexts/EnergySystemContext';
import { RefreshCw, Zap } from 'lucide-react';

export function DashboardView() {
  const {
    gridAnomaly, gridVoltage,
    inverterAnomaly, inverterVoltage,
    gridVoltageAnomaly,
    inverterVoltageAnomaly,
  } = useEnergySystem();

  const hasWarning  = gridAnomaly !== 'none' || inverterAnomaly !== 'none';
  const hasCritical = gridAnomaly === 'critical' || inverterAnomaly === 'critical';

  // Format: "Grid: Dropout · Critical" or "Inverter: Drift · Warning"
  const gridLabel = gridAnomaly !== 'none' && gridVoltageAnomaly?.severity !== 'none'
    ? `Grid: ${gridVoltageAnomaly?.label ?? gridAnomaly} · ${gridVoltageAnomaly?.severity === 'critical' ? 'Critical' : 'Warning'} (${(gridVoltage ?? 0).toFixed(1)}V)`
    : gridAnomaly !== 'none'
    ? `Grid: ${gridAnomaly === 'critical' ? 'Critical' : 'Warning'} (${(gridVoltage ?? 0).toFixed(1)}V)`
    : null;

  const inverterLabel = inverterAnomaly !== 'none' && inverterVoltageAnomaly?.severity !== 'none'
    ? `Inverter: ${inverterVoltageAnomaly?.label ?? inverterAnomaly} · ${inverterVoltageAnomaly?.severity === 'critical' ? 'Critical' : 'Warning'} (${(inverterVoltage ?? 0).toFixed(1)}V)`
    : inverterAnomaly !== 'none'
    ? `Inverter: ${inverterAnomaly === 'critical' ? 'Critical' : 'Warning'} (${(inverterVoltage ?? 0).toFixed(1)}V)`
    : null;

  return (
    <div className="p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="p-1.5 rounded-lg bg-sky-100">
              <Zap className="w-5 h-5 text-sky-600" />
            </div>
            <h1 className="text-xl sm:text-2xl lg:text-3xl text-slate-800">HelioGrid Dashboard</h1>
          </div>
          <p className="text-xs sm:text-sm text-slate-500">
            Real-time AC voltage monitoring · Grid &amp; Inverter · K relay control
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <RefreshCw className="w-3 h-3" />
            <span className="hidden sm:inline">Auto-refresh 2s</span>
          </div>
          <SystemRefreshIndicator />
        </div>
      </div>

      {/* ── Voltage Alert Banner ── */}
      {hasWarning && (
        <div className={`rounded-xl border-2 px-4 py-3 flex items-center gap-3 shadow-sm ${
          hasCritical
            ? 'bg-red-50 border-red-300 text-red-900'
            : 'bg-amber-50 border-amber-300 text-amber-900'
        }`}>
          <div className={`w-2 h-2 rounded-full shrink-0 ${hasCritical ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}`} />
          <div className="flex-1 min-w-0 text-sm">
            <span className="font-semibold mr-2">
              {hasCritical ? 'Critical Voltage Fault' : 'Voltage Warning'}
            </span>
            <span className="opacity-75 text-xs">
              {[gridLabel, inverterLabel].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      )}

      {/* ── Energy Flow Hub ── */}
      <EnergyFlowHub />

      {/* ── Summary Monitoring Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5">
        <GridMonitoringCard />
        <SolarMonitoringCard />
        <BatteryHealthCard />
        <SystemStatusCard />
      </div>
    </div>
  );
}
