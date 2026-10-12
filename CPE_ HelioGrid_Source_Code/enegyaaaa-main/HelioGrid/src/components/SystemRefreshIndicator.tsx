import { RefreshCw } from "lucide-react";
import { useEnergySystem } from "../contexts/EnergySystemContext";

export function SystemRefreshIndicator() {
  const { lastSwitchTime } = useEnergySystem();

  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <RefreshCw className="w-3 h-3" />
      <span>Last switch: {lastSwitchTime}</span>
    </div>
  );
}
// NOTE: EnergySystemState interface removed — single source of truth is EnergySystemContext.tsx
