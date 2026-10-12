// ============================================================================
// UnifiedSSROutletCard.tsx — v11.1  SYNCED TO ARDUINO v6.5
//
// ARDUINO v6.5 RULES:
//   K4 OFF : both sources zero (after both ever confirmed) → immediate
//   K4 ON  : 15s timer after either source returns
//   K1 ON  : 10s timer after i1, only if K4 ON
//   K2 ON  : 10s timer after g1, only if K4 ON
//   K1/K2 OFF : immediate on i0/g0
//   Emergency 'x' : K1+K2+K4 OFF, K3 untouched
//   Recovery  'r' : 15s countdown → restore K1/K2 + K4 ON
//
// UI SYNC:
//   Timer countdowns come from Arduino '?' response via EnergySystemContext:
//     arduinoK4LeftS, arduinoK1LeftS, arduinoK2LeftS, arduinoRecoveryLeftS
//   NO local setInterval timers — Arduino is the source of truth
//   ssrStates + k4Closed polled every 2s from /api/arduino/status
//
// v11.1 FIXES:
//   - Partial dropout banners now show K1/K2 reconnect timers correctly:
//     Timer banners persist as long as k1TimerRunning/k2TimerRunning is true,
//     independent of inverterPresent/gridPresent — source may have returned
//     but relay hasn't closed yet (10s hold-off).
//   - K1/K2 buttons: show timer countdown even when source is back online
//     (inverter/grid present but relay still in 10s hold-off).
//   - K1/K2 disabled during timer pending (prevent double-fire during hold-off).
// ============================================================================

import { useEffect, useState } from 'react';
import {
  Power, Zap, AlertCircle, ArrowLeftRight,
  Battery, AlertTriangle, Activity, Timer, Sun, ShieldOff, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  useEnergySystem,
  GRID_NORMAL_LOW, GRID_NORMAL_HIGH,
  INV_CRITICAL_LOW, INV_CRITICAL_HIGH,
} from '../../contexts/EnergySystemContext';

export function UnifiedSSROutletCard() {
  const {
    controlAuthority, enterManualMode,
    outlet1Status, outlet2Status, setOutlet1Status, setOutlet2Status,
    gridVoltage, gridFrequency, gridAnomaly, gridVoltageAnomaly,
    gridCurrent,
    inverterVoltage, inverterFrequency, inverterAnomaly, inverterVoltageAnomaly,
    inverterCurrent,
    batteryVoltage, batterySOC, batteryFull,
    ssrStates, k4Closed,
    solarPower, systemCondition,
    manualLockoutRemaining,
    setK1, setK2,
    arduinoK4LeftS, arduinoK1LeftS, arduinoK2LeftS,
    arduinoRecoveryLeftS, arduinoDropout, arduinoEmergency,
    totalSwitches, totalRecoveries,
    emergencyShutdown, triggerRecovery,
  } = useEnergySystem();

  const K1_Inv    = ssrStates.K1 ?? false;
  const K2_Grid   = ssrStates.K2 ?? false;
  const K4_Closed = k4Closed;
  const K4_Open   = !K4_Closed;

  // ── Source presence ───────────────────────────────────────────────────────
  const inverterPresent = inverterVoltage > 50;
  const gridPresent     = gridVoltage > 50;
  const bothDropped     = arduinoDropout || (!inverterPresent && !gridPresent);

  // ── Timer countdowns — direct from Arduino (no local setInterval) ─────────
  const k4DisplayLeft       = arduinoK4LeftS       ?? 0;
  const k1DisplayLeft       = arduinoK1LeftS       ?? 0;
  const k2DisplayLeft       = arduinoK2LeftS       ?? 0;
  const recoveryDisplayLeft = arduinoRecoveryLeftS ?? 0;

  const k4TimerRunning  = k4DisplayLeft > 0;
  const k1TimerRunning  = k1DisplayLeft > 0;
  const k2TimerRunning  = k2DisplayLeft > 0;
  const recoveryRunning = recoveryDisplayLeft > 0;

  // ── Emergency state ───────────────────────────────────────────────────────
  // ── Button disable logic ───────────────────────────────────────────────────

  // [FIX-EMERGENCY-STUCK] Emergency is truly active only when K4 is still open.
  // If K4 closed again (recovery complete), stop showing emergency banner.
  const emergencyActive = arduinoEmergency && K4_Open && !recoveryRunning;
  const recoveryActive  = recoveryRunning;

  // ── Optimistic UI state — instant feedback before API responds ───────────
  const [optimisticEmergency, setOptimisticEmergency] = useState<boolean | null>(null);
  const [optimisticRecovery,  setOptimisticRecovery]  = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);

  // Derive effective eState — optimistic overrides real state during API call
  const effectiveEmergency = optimisticEmergency !== null ? optimisticEmergency : emergencyActive;
  const effectiveRecovery  = optimisticRecovery  !== null ? optimisticRecovery  : recoveryActive;
  const eState = effectiveEmergency ? 'emergency' : effectiveRecovery ? 'recovering' : 'idle';

  // Clear optimistic state once real state catches up
  useEffect(() => {
    if (optimisticEmergency !== null && arduinoEmergency === optimisticEmergency) {
      setOptimisticEmergency(null);
    }
  }, [arduinoEmergency, optimisticEmergency]);
  useEffect(() => {
    if (optimisticRecovery !== null && recoveryRunning === optimisticRecovery) {
      setOptimisticRecovery(null);
    }
  }, [recoveryRunning, optimisticRecovery]);
  // K1/K2 disabled during: emergency/recovery OR their own timer (hold-off)
  // Reason: pressing K1 during 10s hold-off would be ignored by Arduino anyway
  const k1Disabled = eState !== 'idle' || k1TimerRunning || k4TimerRunning;
  const k2Disabled = eState !== 'idle' || k2TimerRunning || k4TimerRunning;

  // ── Outlet energized ──────────────────────────────────────────────────────
  const outlet1Energized = K4_Closed && K1_Inv && inverterPresent && !bothDropped;
  const outlet2Energized = K4_Closed && K2_Grid && gridPresent    && !bothDropped;

  // ── Load ──────────────────────────────────────────────────────────────────
  const totalCurrent = (outlet1Energized ? (inverterCurrent ?? 0) : 0)
                     + (outlet2Energized ? (gridCurrent    ?? 0) : 0);
  const totalPower   = (outlet1Energized ? (inverterCurrent ?? 0) * inverterVoltage : 0)
                     + (outlet2Energized ? (gridCurrent    ?? 0) * gridVoltage      : 0);

  // ── Partial dropout detection ─────────────────────────────────────────────
  // Show inverter-offline banner when: inverter absent OR K1 timer running (source just returned)
  // Show grid-offline banner when: grid absent OR K2 timer running (source just returned)
  // This ensures the "Source returned — relay ON in Xs" message is always visible
  // during the 10s hold-off, even after voltage comes back.
  const showInvOfflineBanner = (!inverterPresent || k1TimerRunning) && gridPresent && !bothDropped;
  const showGridOfflineBanner = (!gridPresent || k2TimerRunning) && inverterPresent && !bothDropped;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleToggleK1 = () => {
    if (k1Disabled) return;
    // [FIX-RACE] Use context setK1 — updates UI instantly + queued POST, no double-fetch
    setK1(!K1_Inv);
  };
  const handleToggleK2 = () => {
    if (k2Disabled) return;
    setK2(!K2_Grid);
  };

  const handleEmergency = async () => {
    if (sending) return;
    setSending(true);
    setOptimisticEmergency(true);   // instant UI update — show red banner immediately
    setOptimisticRecovery(false);
    try {
      // [FIX-FORCE-SYNC] emergencyShutdown() updates UI instantly + calls forceSyncSSR internally
      await emergencyShutdown();
    }
    catch (e) { console.error('Emergency send failed', e); setOptimisticEmergency(null); }
    finally { setSending(false); }
  };

  const handleRecovery = async () => {
    if (sending) return;
    setSending(true);
    setOptimisticRecovery(true);    // instant UI update — show amber recovery banner immediately
    setOptimisticEmergency(false);
    try {
      // [FIX-FORCE-SYNC] triggerRecovery() shows 15s countdown instantly + syncs at 300ms/1s/16s
      await triggerRecovery();
    }
    catch (e) { console.error('Recovery send failed', e); setOptimisticRecovery(null); }
    finally { setSending(false); }
  };

  const overrideFaultLabel = (() => {
    if (inverterAnomaly === 'critical' && gridAnomaly === 'critical')
      return 'Double Fault — Inverter + Grid voltage anomaly.';
    if (inverterAnomaly === 'critical')
      return `Inverter ${inverterVoltage.toFixed(1)}V out of safe range.`;
    if (gridAnomaly === 'critical')
      return `Grid ${gridVoltage.toFixed(1)}V out of safe range.`;
    return 'Critical voltage fault active.';
  })();

  const outlets = [
    {
      id: 1, name: 'Outlet 1', load: 'Solar Source (K1)',
      energized: outlet1Energized,
      voltage: outlet1Energized ? inverterVoltage : 0,
      current: outlet1Energized ? (inverterCurrent ?? 0) : 0,
      hasAnomaly: outlet1Energized && inverterAnomaly !== 'none',
      badge: 'bg-amber-100 border border-amber-300', textColor: 'text-amber-900',
    },
    {
      id: 2, name: 'Outlet 2', load: 'Grid Source (K2)',
      energized: outlet2Energized,
      voltage: outlet2Energized ? gridVoltage : 0,
      current: outlet2Energized ? (gridCurrent ?? 0) : 0,
      hasAnomaly: outlet2Energized && gridAnomaly !== 'none',
      badge: 'bg-blue-100 border border-blue-300', textColor: 'text-blue-900',
    },
  ];

  return (
    <Card className="border-slate-200 shadow-lg hover:shadow-xl transition-shadow">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm sm:text-base">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg" style={{background:'linear-gradient(to bottom right, #f3e8ff, #cffafe)'}}>
              <ArrowLeftRight className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600" />
            </div>
            <span>Power &amp; Load Control</span>
          </div>
          <div className="flex items-center gap-2">
            <div title={K4_Open ? 'K4 OPEN' : 'K4 CLOSED'}
              className={`w-2.5 h-2.5 rounded-full ${k4TimerRunning ? 'bg-amber-400 animate-pulse' : K4_Open ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`} />
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">

        {/* Emergency Banner */}
        {(emergencyActive || recoveryActive) && (
          <div className={`p-3 rounded-lg border-2 flex items-center gap-3 ${recoveryActive ? 'bg-amber-600 border-amber-700' : 'bg-red-600 border-red-700'}`}>
            <AlertTriangle className="w-5 h-5 text-white shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-bold text-white">
                {recoveryActive ? '⏱ Recovery in Progress' : '🔴 Emergency Shutdown Active'}
              </div>
              <div className="text-xs text-white/80 mt-0.5">
                {recoveryActive
                  ? `K4 restoring in ${recoveryDisplayLeft}s… Arduino running recovery.`
                  : 'K1 + K2 OFF · K4 OPEN. Click Recovery to restore.'}
              </div>
            </div>
            {recoveryActive && recoveryDisplayLeft > 0 && (
              <div className="text-2xl font-mono font-bold text-white">{recoveryDisplayLeft}s</div>
            )}
          </div>
        )}

        {/* Full Dropout */}
        {bothDropped && (
          <div className="p-3 rounded-lg bg-red-50 border-2 border-red-500 flex items-center gap-3 animate-pulse">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
            <div>
              <div className="text-sm font-bold text-red-800">⚡ Full Power Dropout</div>
              <div className="text-xs text-red-700 mt-0.5">
                {k4TimerRunning
                  ? `Both sources offline. K4 re-closing in ${k4DisplayLeft}s…`
                  : 'Both sources offline. K4 opened by Arduino.'}
              </div>
            </div>
            {k4TimerRunning && <div className="ml-auto text-xl font-mono font-bold text-red-600">{k4DisplayLeft}s</div>}
          </div>
        )}

        {/* ── Partial Dropout: Inverter offline OR K1 in hold-off ── */}
        {showInvOfflineBanner && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="flex-1 text-xs text-amber-700">
              {k1TimerRunning && inverterPresent
                ? <>⚡ Inverter returned — <span className="font-bold">K1 ON in {k1DisplayLeft}s</span> (hold-off)</>
                : <>⚠ Inverter offline — K1 cut. Outlet 2 (Grid) still live.</>
              }
            </div>
            {k1TimerRunning && (
              <div className="text-lg font-mono font-bold text-amber-600 shrink-0">{k1DisplayLeft}s</div>
            )}
          </div>
        )}

        {/* ── Partial Dropout: Grid offline OR K2 in hold-off ── */}
        {showGridOfflineBanner && (
          <div className="p-3 rounded-lg bg-orange-50 border border-orange-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-orange-500 shrink-0" />
            <div className="flex-1 text-xs text-orange-700">
              {k2TimerRunning && gridPresent
                ? <>⚡ Grid returned — <span className="font-bold">K2 ON in {k2DisplayLeft}s</span> (hold-off)</>
                : <>⚠ Grid offline — K2 cut. Outlet 1 (Solar) still live.</>
              }
            </div>
            {k2TimerRunning && (
              <div className="text-lg font-mono font-bold text-orange-600 shrink-0">{k2DisplayLeft}s</div>
            )}
          </div>
        )}

        {/* Source Control */}
        <div className="p-4 rounded-xl border-2 border-indigo-300 shadow-md" style={{background:'linear-gradient(to bottom right, #eef2ff, #faf5ff)'}}>
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-5 h-5 text-indigo-600" />
            <span className="text-sm sm:text-base font-semibold text-indigo-900">Source Control</span>
            <div className={`ml-auto px-3 py-1 rounded-full text-xs font-semibold
              ${K4_Open ? 'bg-red-600 text-white'
              : k4TimerRunning ? 'bg-amber-500 text-white'
              : K1_Inv && K2_Grid ? 'bg-purple-500 text-white'
              : K1_Inv ? 'bg-amber-500 text-white'
              : K2_Grid ? 'bg-blue-500 text-white'
              : 'bg-slate-500 text-white'}`}>
              {K4_Open && k4TimerRunning ? `K4 closing in ${k4DisplayLeft}s`
               : K4_Open ? 'K4 OPEN — Cut Off'
               : K1_Inv && K2_Grid ? 'K1 + K2 BOTH ON'
               : K1_Inv ? 'K1 ON — Solar'
               : K2_Grid ? 'K2 ON — Grid'
               : 'No Source'}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">

            {/* ── K1 Solar ── */}
            <button onClick={handleToggleK1} disabled={k1Disabled}
              style={k1Disabled ? {cursor:'not-allowed'} : {}}
              className={`p-4 rounded-xl border-2 transition-all text-center relative overflow-hidden
                ${k1Disabled
                  ? k1TimerRunning
                    ? 'bg-amber-50 border-amber-300'
                    : 'bg-slate-100 border-slate-300'
                  : K1_Inv
                    ? 'bg-amber-500 border-amber-600 shadow-lg'
                    : 'bg-white border-slate-200 hover:border-amber-300'}
                ${!k1Disabled ? 'cursor-pointer active:scale-95' : ''}`}>

              {/* Badge — top right */}
              <span className={`absolute top-2 right-2 z-10 inline-flex items-center gap-1 text-[0.6rem] font-black px-2 py-0.5 rounded-full border
                ${k1TimerRunning
                  ? 'bg-amber-100 text-amber-700 border-amber-300'
                  : K1_Inv && !k1Disabled
                    ? 'bg-white text-amber-600 border-amber-200'
                    : 'bg-slate-100 text-slate-400 border-slate-300'}`}>
                <span className={`w-1.5 h-1.5 rounded-full
                  ${k1TimerRunning ? 'bg-amber-400 animate-pulse'
                  : K1_Inv && !k1Disabled ? 'bg-amber-500'
                  : 'bg-slate-400'}`} />
                {k1TimerRunning ? `${k1DisplayLeft}s` : K1_Inv && !k1Disabled ? 'ON' : 'OFF'}
              </span>

              <div className="flex flex-col items-center pt-4">
                <div className={`p-2 rounded-lg mb-2
                  ${k1TimerRunning ? 'bg-amber-100'
                  : K1_Inv && !k1Disabled ? 'bg-white/20'
                  : 'bg-amber-100'}`}>
                  <Sun className={`w-6 h-6
                    ${k1TimerRunning ? 'text-amber-500'
                    : k1Disabled ? 'text-slate-400'
                    : K1_Inv ? 'text-white'
                    : 'text-amber-500'}`} />
                </div>
                <div className={`text-base font-extrabold tracking-tight mb-1
                  ${k1TimerRunning ? 'text-amber-700'
                  : k1Disabled ? 'text-slate-400'
                  : K1_Inv ? 'text-white'
                  : 'text-slate-800'}`}>
                  Solar
                </div>
                <div className={`text-xs
                  ${k1TimerRunning ? 'text-amber-600 font-semibold'
                  : k1Disabled ? 'text-slate-400'
                  : K1_Inv ? 'text-amber-100'
                  : !inverterPresent ? 'text-red-500'
                  : 'text-green-600'}`}>
                  {k1TimerRunning
                    ? `⏱ K1 ON in ${k1DisplayLeft}s`
                    : k1Disabled ? '⊘ Disabled'
                    : !inverterPresent ? '⚠ Inverter offline'
                    : K1_Inv ? `${inverterVoltage.toFixed(1)} V · ${inverterFrequency.toFixed(1)} Hz`
                    : '✓ Ready'}
                </div>
              </div>
            </button>

            {/* ── K2 Grid ── */}
            <button onClick={handleToggleK2} disabled={k2Disabled}
              style={k2Disabled ? {cursor:'not-allowed'} : {}}
              className={`p-4 rounded-xl border-2 transition-all text-center relative overflow-hidden
                ${k2Disabled
                  ? k2TimerRunning
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-slate-100 border-slate-300'
                  : K2_Grid
                    ? 'bg-blue-500 border-blue-600 shadow-lg'
                    : 'bg-white border-slate-200 hover:border-blue-300'}
                ${!k2Disabled ? 'cursor-pointer active:scale-95' : ''}`}>

              {/* Badge — top right */}
              <span className={`absolute top-2 right-2 z-10 inline-flex items-center gap-1 text-[0.6rem] font-black px-2 py-0.5 rounded-full border
                ${k2TimerRunning
                  ? 'bg-blue-100 text-blue-700 border-blue-300'
                  : K2_Grid && !k2Disabled
                    ? 'bg-white text-blue-600 border-blue-200'
                    : 'bg-slate-100 text-slate-400 border-slate-300'}`}>
                <span className={`w-1.5 h-1.5 rounded-full
                  ${k2TimerRunning ? 'bg-blue-400 animate-pulse'
                  : K2_Grid && !k2Disabled ? 'bg-blue-500'
                  : 'bg-slate-400'}`} />
                {k2TimerRunning ? `${k2DisplayLeft}s` : K2_Grid && !k2Disabled ? 'ON' : 'OFF'}
              </span>

              <div className="flex flex-col items-center pt-4">
                <div className={`p-2 rounded-lg mb-2
                  ${k2TimerRunning ? 'bg-blue-100'
                  : K2_Grid && !k2Disabled ? 'bg-white/20'
                  : 'bg-blue-100'}`}>
                  <Zap className={`w-6 h-6
                    ${k2TimerRunning ? 'text-blue-500'
                    : k2Disabled ? 'text-slate-400'
                    : K2_Grid ? 'text-white'
                    : 'text-blue-500'}`} />
                </div>
                <div className={`text-base font-extrabold tracking-tight mb-1
                  ${k2TimerRunning ? 'text-blue-700'
                  : k2Disabled ? 'text-slate-400'
                  : K2_Grid ? 'text-white'
                  : 'text-slate-800'}`}>
                  Grid
                </div>
                <div className={`text-xs
                  ${k2TimerRunning ? 'text-blue-600 font-semibold'
                  : k2Disabled ? 'text-slate-400'
                  : K2_Grid ? 'text-blue-100'
                  : !gridPresent ? 'text-red-500'
                  : 'text-green-600'}`}>
                  {k2TimerRunning
                    ? `⏱ K2 ON in ${k2DisplayLeft}s`
                    : k2Disabled ? '⊘ Disabled'
                    : !gridPresent ? '⚠ Grid offline'
                    : K2_Grid ? `${gridVoltage.toFixed(1)} V · ${gridFrequency.toFixed(1)} Hz`
                    : '✓ Stable'}
                </div>
              </div>
            </button>
          </div>

          {/* K3 */}
          <div className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-2 mb-3
            ${k4TimerRunning ? 'bg-amber-50 border-amber-300 text-amber-700'
            : K4_Open ? 'bg-red-50 border-red-300 text-red-700'
            : 'bg-green-50 border-green-300 text-green-800'}`}>
            <Power className="w-3 h-3 shrink-0" />
            <span className="font-semibold">K4 Contactor (auto): </span>
            {k4TimerRunning
              ? `⏱ Re-closing in ${k4DisplayLeft}s…`
              : K4_Open ? 'OPEN — Outlets disconnected'
              : 'CLOSED — Outlets live'}
            <span className="ml-auto text-[0.6rem] font-semibold uppercase opacity-60">AUTO</span>
          </div>

          {/* Emergency / Recovery */}
          {eState === 'idle' ? (
            <button onClick={handleEmergency} disabled={sending}
              className={`w-full p-3 rounded-lg border-2 text-center shadow-lg transition-all active:scale-95 ${sending ? 'bg-red-400 border-red-500 cursor-wait' : 'bg-red-600 border-red-700 hover:bg-red-700 cursor-pointer'} text-white`}>
              <AlertTriangle className={`w-4 h-4 mx-auto mb-1 ${sending ? 'animate-pulse' : ''}`} />
              <div className="text-xs font-bold">{sending ? 'Sending…' : 'Emergency Shutdown'}</div>
              <div className="text-[0.6rem] mt-0.5 text-red-200">K1 + K2 OFF · K4 OPEN</div>
            </button>
          ) : eState === 'recovering' ? (
            <button disabled className="w-full p-3 rounded-lg border-2 text-center bg-amber-600 border-amber-700 text-white shadow-lg cursor-not-allowed opacity-90">
              <Timer className="w-4 h-4 mx-auto mb-1" />
              <div className="text-xs font-bold">⏱ Restoring Power in {recoveryDisplayLeft}s…</div>
              <div className="text-[0.6rem] mt-0.5 text-amber-200">Arduino running recovery sequence</div>
            </button>
          ) : (
            <button onClick={handleRecovery} disabled={sending}
              className={`w-full p-3 rounded-lg border-2 text-center shadow-lg transition-all active:scale-95 ${sending ? 'bg-green-400 border-green-500 cursor-wait' : 'bg-green-600 border-green-700 hover:bg-green-700 cursor-pointer'} text-white`}>
              <CheckCircle2 className={`w-4 h-4 mx-auto mb-1 ${sending ? 'animate-pulse' : ''}`} />
              <div className="text-xs font-bold">{sending ? 'Sending…' : '⚡ Recovery — Restore Power'}</div>
              <div className="text-[0.6rem] mt-0.5 text-green-200">Arduino restores K4 + K1/K2 after 15s</div>
            </button>
          )}
        </div>

        {/* Relay Status tiles */}
        <div className="grid grid-cols-3 gap-2">
          {[
            {
              label: 'K1 (Solar)',
              color: k1TimerRunning
                ? 'bg-amber-400 animate-pulse'
                : K1_Inv && inverterPresent ? 'bg-amber-500 animate-pulse'
                : 'bg-slate-400',
              bg: k1TimerRunning
                ? 'bg-amber-50 border-amber-300'
                : K1_Inv && inverterPresent ? 'bg-amber-100 border-amber-400'
                : 'bg-slate-100 border-slate-300',
              status: k1TimerRunning
                ? `${k1DisplayLeft}s`
                : K1_Inv && inverterPresent ? 'ON' : 'OFF',
              sub: k1TimerRunning
                ? `ON in ${k1DisplayLeft}s`
                : K1_Inv && inverterPresent ? `${inverterVoltage.toFixed(1)}V`
                : !inverterPresent ? 'No source' : 'Standby',
              auto: false,
            },
            {
              label: 'K2 (Grid)',
              color: k2TimerRunning
                ? 'bg-blue-400 animate-pulse'
                : K2_Grid && gridPresent ? 'bg-blue-500 animate-pulse'
                : 'bg-slate-400',
              bg: k2TimerRunning
                ? 'bg-blue-50 border-blue-300'
                : K2_Grid && gridPresent ? 'bg-blue-100 border-blue-400'
                : 'bg-slate-100 border-slate-300',
              status: k2TimerRunning
                ? `${k2DisplayLeft}s`
                : K2_Grid && gridPresent ? 'ON' : 'OFF',
              sub: k2TimerRunning
                ? `ON in ${k2DisplayLeft}s`
                : K2_Grid && gridPresent ? `${gridVoltage.toFixed(1)}V`
                : !gridPresent ? 'No source' : 'Standby',
              auto: false,
            },
            {
              label: 'K4 (Contactor)',
              color: k4TimerRunning ? 'bg-amber-400 animate-pulse' : K4_Open ? 'bg-red-500 animate-pulse' : 'bg-green-500',
              bg: k4TimerRunning ? 'bg-amber-50 border-amber-300' : K4_Open ? 'bg-red-100 border-red-400' : 'bg-green-50 border-green-300',
              status: k4TimerRunning ? `${k4DisplayLeft}s` : K4_Open ? 'OPEN' : 'CLOSED',
              sub: k4TimerRunning ? 'Re-closing…' : K4_Open ? 'Outlets cut' : 'Outlets live',
              auto: true,
            },
          ].map((r, i) => (
            <div key={i} className={`p-1.5 rounded-lg border-2 ${r.bg}`}>
              <div className="text-center">
                <div className="text-[0.6rem] text-slate-600 mb-0.5 font-medium leading-tight">{r.label}</div>
                <div className={`w-2 h-2 mx-auto rounded-full ${r.color}`} />
                <div className="text-[0.6rem] text-slate-600 mt-0.5 font-semibold">{r.status}</div>
                <div className="text-[0.55rem] text-slate-500">{r.sub}</div>
                {r.auto && <div className="text-[0.5rem] text-slate-400 uppercase tracking-wide">auto</div>}
              </div>
            </div>
          ))}
        </div>

        {/* Switch & Recovery Stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-indigo-500/40 bg-indigo-900/10 px-3 py-2.5 flex items-center gap-3">
            <Activity className="w-4 h-4 text-indigo-400 flex-shrink-0" />
            <div>
              <div className="text-[0.65rem] text-slate-400 leading-tight">Total Switches</div>
              <div className="text-2xl font-black text-indigo-300 leading-none tabular-nums">{totalSwitches ?? 0}</div>
            </div>
          </div>
          <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 ${(totalRecoveries ?? 0) > 0 ? 'border-amber-500/50 bg-amber-900/20' : 'border-slate-600/40 bg-slate-800/30'}`}>
            <ShieldOff className={`w-4 h-4 flex-shrink-0 ${(totalRecoveries ?? 0) > 0 ? 'text-amber-400' : 'text-slate-500'}`} />
            <div>
              <div className="text-[0.65rem] text-slate-400 leading-tight">Recoveries</div>
              <div className={`text-2xl font-black leading-none tabular-nums ${(totalRecoveries ?? 0) > 0 ? 'text-amber-300' : 'text-slate-500'}`}>{totalRecoveries ?? 0}</div>
            </div>
          </div>
        </div>

        {/* Outlets */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Power className="w-5 h-5 text-slate-700" />
            <h3 className="text-sm sm:text-base font-semibold text-slate-900">Outlet Status</h3>
            <span className={`ml-auto text-[0.65rem] px-2 py-0.5 rounded-full font-bold border ${K4_Open ? 'bg-red-100 text-red-700 border-red-300' : 'bg-slate-100 text-slate-700 border-slate-300'}`}>
              {K4_Open ? '🔴 K4 OPEN' : (outlet1Energized || outlet2Energized) ? '⚡ LIVE' : '⚫ NO PATH'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {outlets.map(outlet => (
              <div key={outlet.id} className={`p-3 sm:p-4 rounded-lg border-2 transition-all ${outlet.energized ? 'border-green-300' : 'bg-slate-50 border-slate-300'}`}
                style={outlet.energized ? {background:'linear-gradient(to bottom right, #f0fdf4, #ecfdf5)'} : {}}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-lg ${outlet.energized ? 'bg-green-500' : 'bg-slate-400'}`}>
                      <Power className="w-3 h-3 sm:w-4 sm:h-4 text-white" />
                    </div>
                    <div>
                      <div className="text-xs sm:text-sm text-slate-900">{outlet.name}</div>
                      <div className="text-[0.6rem] sm:text-xs text-slate-500">{outlet.load}</div>
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded text-[0.65rem] border font-semibold ${outlet.energized ? 'bg-green-100 text-green-700 border-green-300' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                    {outlet.energized ? 'ON' : 'OFF'}
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">Voltage:</span><span className="text-slate-900">{outlet.voltage.toFixed(1)} V</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Current:</span><span className="text-slate-900">{outlet.current.toFixed(2)} A</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Power:</span><span className="text-slate-900 font-semibold">{(outlet.current * outlet.voltage).toFixed(0)} W</span></div>
                </div>
                {outlet.hasAnomaly && outlet.energized && (
                  <div className="mt-2 p-2 rounded bg-red-100 border border-red-300 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 text-red-600 shrink-0" />
                    <span className="text-[0.65rem] text-red-700">Voltage anomaly on source</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="p-3 rounded-lg border border-indigo-200" style={{background:'linear-gradient(to right, #eef2ff, #faf5ff)'}}>
            <div className="flex items-center justify-between">
              <span className="text-xs sm:text-sm text-slate-700">Total Load:</span>
              <div className="flex items-center gap-2">
                <span className="text-lg sm:text-xl font-bold text-indigo-900">{totalCurrent.toFixed(2)} A</span>
                <span className="text-xs text-slate-500">({totalPower.toFixed(0)} W)</span>
              </div>
            </div>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
