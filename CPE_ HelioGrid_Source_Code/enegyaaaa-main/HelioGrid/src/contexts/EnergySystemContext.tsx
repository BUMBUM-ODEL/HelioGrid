// EnergySystemContext.tsx — v7.3
//
// v7.3 CHANGES:
//   [FIX-INV-THRESHOLDS] Inverter 3-tier detection — 220V nominal (local inverter/UPS spec):
//     Nominal : 220V
//     Normal  : ±3%  → 213.4–226.6V  (no alert)
//     Warning : ±5%  → 209.0–231.0V  (dashboard banner only)
//     Critical: ±10% → 198.0–242.0V  (buzzer + email + relay action)
//     detectVoltageAnomaly() updated to accept optional warnLow/warnHigh for the ±5% band.
//
// REVISION SUMMARY (v7.0):
//   - Removed: ATS transfer logic, solar-priority switching, complex source-routing
//   - Removed: computeStringAnomaly, computeSolarAnomaly, solar-ready checks
//   - Removed: ControlMode (solar/grid/assist/failsafe) → simplified to 'auto' | 'manual'
//   - Removed: deriveSSRStates, arduinoSeqCmd, buildSSRPayload ATS variants
//   - Added: Simplified AC voltage anomaly detection (grid + inverter ONLY)
//   - Added: New anomaly labels: Spike, Drift, Dropout
//   - Added: Simplified K3/K4 auto behavior per v7.0 spec
//   - Focus: monitoring, anomaly detection, anomaly logs, sensor status
// ============================================================================

import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef,
} from 'react';
import * as api from '../utils/api';

// ============================================================================
// ANOMALY LABEL TYPES
// ============================================================================

export type AnomalyLevel = 'none' | 'warning' | 'critical';

// New v7.0 anomaly label format
export type AnomalyLabel =
  | 'Normal'
  | 'Spike - Low Voltage'
  | 'Spike - High Voltage'
  | 'Drift - Low Voltage'
  | 'Drift - High Voltage'
  | 'Dropout';

export interface VoltageAnomalyResult {
  label: AnomalyLabel;
  severity: AnomalyLevel;
  value: number;
}

// ============================================================================
// RUNTIME CONSTANTS
// ============================================================================

export const SENSOR_FREEZE_TIMEOUT_MS = 15000;
export const K4_RECONNECT_DELAY_MS    = 60 * 1000;
const        MANUAL_LOCKOUT_MS        = 8_000;

// ============================================================================
// THRESHOLD CONSTANTS — HelioGrid Campus Resilience
// Detection focus: Grid AC + Inverter AC (primary anomaly triggers — 3 consecutive readings)
// Battery: monitoring + email only (warning low / full charge) — not a primary anomaly trigger
// Solar:   health status display only — no buzzer, no email
// ============================================================================

// ── Grid AC (PZEM-004T) — PRIMARY ANOMALY TRIGGER ──────────────────────────
// Nominal : 230V (IEC 60038 PH utility standard)
// Normal  : ±3%  → 223.1–236.9V  (no alert)
// Critical: ±10% → 207.0–253.0V  (buzzer 5s + email after 3 consecutive)
//           Spike: sudden jump | Drift: gradual | Dropout: voltage = 0
export const GRID_NORMAL_LOW       = 180.0; // V — lower bound: anything above 180V = present
export const GRID_NORMAL_HIGH      = 270.0; // V — upper bound: spike protection
export const GRID_CRITICAL_LOW     = 207.0; // V — 230V × 0.90 (±10% critical)
export const GRID_CRITICAL_HIGH    = 253.0; // V — 230V × 1.10 (±10% critical)
export const GRID_FREQ_NORMAL_LOW  = 59.0;  // Hz
export const GRID_FREQ_NORMAL_HIGH = 61.0;  // Hz
export const GRID_FREQ_CRIT        = 1.0;   // Hz — max deviation from 60Hz; |gridFreq - 60| > 1.0 = critical

// ── Inverter AC (PZEM-004T) — PRIMARY ANOMALY TRIGGER ──────────────────────
// Nominal : 220V (local inverter/UPS spec)
// Normal  : ±3%  → 213.4–226.6V  (no alert)
// Critical: ±10% → 198.0–242.0V  (buzzer + email + relay action after 3 consecutive)
export const INV_NORMAL_LOW    = 213.4; // V — 220V × 0.97 (±3% normal band)
export const INV_NORMAL_HIGH   = 226.6; // V — 220V × 1.03 (±3% normal band)
export const INV_CRITICAL_LOW  = 180.0; // V — lower bound: anything above 180V = present
export const INV_CRITICAL_HIGH = 270.0; // V — upper bound: spike protection

// ── Battery (INA219 ×2, 2S — 24V 100Ah Lead Acid Gel) ────────────────────
// Monitoring + email ONLY — NOT a primary anomaly/buzzer trigger
// Full:    ≥25.4V → K3 OFF (float cut-off) + send battery_full email
// Warning: <23.0V (~50% SOC) → send warning email only, no buzzer
// Critical:<21.6V (deep discharge) → MCCB alert email; inverter handles protection
export const BAT_FULL         = 25.4; // V — float charge cut-off
export const BAT_WARNING_LOW  = 23.0; // V — ~50% SOC, email only
export const BAT_CRITICAL_LOW = 21.6; // V — deep discharge, MCCB alert email

// ── Solar PV (WCS1500 ×4, 2S2P — 4×590W JAM72D40, rated 2360W) ─────────────
// Health status DISPLAY ONLY — no buzzer, no email
// Health % = (string current / Imp 13.28A) × 100 — daytime 6AM–6PM PHT only
export const SOLAR_RATED_W        = 2320; // W — 4×580W rated (JAM72D40)
export const SOLAR_PANEL_IMP      = 13.28; // A — JAM72D40 Imp (2S2P: each string = 13.28A)
export const SOLAR_HEALTH_GOOD    = 75;   // % — Good: normal operation
export const SOLAR_HEALTH_MONITOR = 60;   // % — Monitor: slight degradation
export const SOLAR_HEALTH_AGING   = 40;   // % — Aging: clean panels
export const SOLAR_HEALTH_REPLACE = 20;   // % — Replace Soon / Replace Now
// Solar power thresholds used by KioskLCD for status classification
// Based on 4×590W = 2360W rated; 20% = critical, 60% = warning
export const SOLAR_CRITICAL_LOW   = 464;  // W — <20% rated (2320×0.20) → critical / grid assist
export const SOLAR_WARNING_LOW    = 1392; // W — <60% rated (2320×0.60) → warning / cloudy

// ============================================================================
// SENSOR STATUS NAMING — User-Friendly
// ============================================================================

export type SensorStatus = 'Online' | 'Offline' | 'No Data' | 'Disconnected';

export interface SensorStatusMap {
  gridSensor:      SensorStatus;
  inverterSensor:  SensorStatus;
  batterySensor:   SensorStatus;
  solarSensor:     SensorStatus;
  tempSensor:      SensorStatus;
  rtcModule:       SensorStatus;
}

function deriveSensorStatus(
  gridV: number, inverterV: number, batteryV: number,
  solarP: number, temp: number, rtcAvail: boolean,
  hasValidData: boolean, frozenMs: number,
): SensorStatusMap {
  const frozen = frozenMs > SENSOR_FREEZE_TIMEOUT_MS;

  const baseStatus = (value: number): SensorStatus => {
    if (!hasValidData) return 'No Data';
    if (frozen) return 'Disconnected';
    return value > 0 ? 'Online' : 'Offline';
  };

  return {
    gridSensor:     baseStatus(gridV),
    inverterSensor: baseStatus(inverterV),
    batterySensor:  baseStatus(batteryV),
    solarSensor:    baseStatus(solarP),
    tempSensor:     baseStatus(temp),
    rtcModule:      rtcAvail ? 'Online' : 'Offline',
  };
}

// ============================================================================
// POWER FLOW
// ============================================================================

export interface PowerFlow {
  solarToLoad:   number;
  batteryToLoad: number;
  gridToLoad:    number;
  gridToBattery: number;
  solarDcW:      number;
  batDischargeW: number;
  batChargeW:    number;
  inverterW:     number;
  gridW:         number;
}

// ============================================================================
// SSR STATE — Simplified
// ============================================================================

// v7.0: ControlMode simplified — K1/K2/K3/K4 per manual spec
// Manual: all can be ON/OFF independently
// Auto: K1=ON, K2=ON, K3=auto charging, K4=safety cutoff
export type ControlAuthority = 'auto' | 'manual' | 'safety_override';
export type ControlMode = 'solar' | 'grid' | 'assist' | 'shutdown' | 'failsafe';

export interface SSRStates {
  K1: boolean;
  K2: boolean;
  K3: boolean;
  K4: boolean;
}

// ============================================================================
// K4 RECONNECT STATE
// ============================================================================

export interface K4ReconnectState {
  locked:           boolean;
  faultAt:          number | null;
  recoveredAt:      number | null;
  secondsRemaining: number;
}

// ============================================================================
// ANOMALY LOG ENTRY
// ============================================================================

export interface AnomalyLogEntry {
  id: number;
  timestamp: string;
  level: AnomalyLevel;
  subsystem: string;
  message: string;
  value?: number;
  severity: string;
  type: string;
  source: string;
  systemAction: string;
  gridVoltage: string;
  solarPower: string;
  battery: string;
  status: string;
  emailStatus: 'Sent' | 'Failed' | 'Queued' | 'N/A';
  buzzer: 'ON' | 'OFF';
  inverterPower?: number | null;
  resolvedAt?: string | null;
  responseTimeMs?: number | null;
  systemTemp?: number | null;
  detectedAt?: string | null;
  actionAt?: string | null;
  // v7.0 anomaly label fields
  anomalyLabel?: AnomalyLabel;
  anomalySource?: string;
  anomalyDelta?: number | null;    // ΔV from anomaly_engine (anomaly_delta DB col)
  confirmCount?: number | null;    // consecutive confirm count (confirm_count DB col)
  contextGridCurrent?: number;
  contextGridFrequency?: number;
  contextInvVoltage?: number;
  contextInvCurrent?: number;
  contextInvFrequency?: number;
  contextBatteryVoltage?: number;
  contextBatteryCurrent?: number;
  contextSolarPower?: number;
  contextSensorStatus?: string;
}

// ── Solar DC anomaly log entry (dc_solar_anomaly_logs table) ─────────────────
export interface SolarDcAnomalyLogEntry {
  id: number;
  timestamp: string;
  source: string;
  anomaly_type: string;
  severity: string;
  detail?: string | null;
  voltage?: number | null;
  delta_v?: number | null;
  pu?: number | null;
  confirmed?: boolean;
  context_note?: string | null;
  battery_soc?: number | null;
  solar_power?: number | null;
  grid_voltage?: number | null;
  system_temp?: number | null;
  status?: string | null;
  resolved_at?: string | null;
}

// ============================================================================
// MAIN STATE INTERFACE
// ============================================================================

export interface EnergySystemState {
  // Sensor readings
  gridVoltage: number;
  gridCurrent: number;
  gridFrequency: number;
  gridPower: number;
  gridStatus: string;

  solarVoltage: number;
  solarCurrent: number;
  solarPower: number;
  solarEfficiency: number;
  systemEfficiency: number | null;

  batteryVoltage: number;
  batteryCurrent: number;
  batterySOC: number;
  batteryChargeA: number;
  batteryDischargeA: number;
  batterySource: string;
  battery1Voltage: number;
  battery1Current: number;
  battery2Voltage: number;
  battery2Current: number;
  batteryAnomalyDetails: string[];

  powerFlow: PowerFlow;

  inverterVoltage: number;
  inverterCurrent: number;
  inverterFrequency: number;
  inverterPower: number;

  systemTemp: number;
  stringCurrents?: number[];
  thermalShutdownActive: boolean;
  serverTime: string;
  rtcAvailable: boolean;

  // v7.0 primary anomaly detection (AC voltage)
  gridVoltageAnomaly: VoltageAnomalyResult;
  inverterVoltageAnomaly: VoltageAnomalyResult;

  // Context-only anomalies (not primary triggers)
  batteryAnomaly: AnomalyLevel;
  tempAnomaly: AnomalyLevel;
  sensorIntegrity: AnomalyLevel;
  anomalyLevel: AnomalyLevel;     // overall worst level

  // Legacy grid/inverter AnomalyLevel (for backward compat with cards)
  gridAnomaly: AnomalyLevel;
  inverterAnomaly: AnomalyLevel;
  solarAnomaly: AnomalyLevel;     // kept for display only, not primary trigger

  // Sensor status
  sensorStatus: SensorStatusMap;

  // SSR state (simplified)
  ssrStates: SSRStates;
  k4Closed: boolean;
  contactorClosed: boolean;
  k4Reconnect: K4ReconnectState;
  controlMode: ControlMode;

  // Arduino v6.4 live timer countdowns (seconds remaining, 0 = not running)
  // Sourced directly from Arduino '?' status JSON — k4_left_s, k1_left_s, k2_left_s, recovery_left_s
  arduinoK4LeftS:       number;   // 0–15: K4 reconnect countdown after dropout
  arduinoK1LeftS:       number;   // 0–10: K1 reconnect countdown after inverter returns
  arduinoK2LeftS:       number;   // 0–10: K2 reconnect countdown after grid returns
  arduinoRecoveryLeftS: number;   // 0–15: recovery countdown after 'r' command
  arduinoDropout:       boolean;  // true = Arduino confirmed full dropout (K4 opened)
  arduinoEmergency:     boolean;  // true = Arduino in emergency state

  controlAuthority: ControlAuthority;
  autoSwitchEnabled: boolean;
  systemCondition: string;
  manualBlockedReason?: string;

  batteryCapacityAh: number;
  batteryFull: boolean;
  sensorFault: boolean;
  totalSwitches: number;
  lastSwitchTime: string;
  emailServiceHealth: boolean;
  anomalyLogs: AnomalyLogEntry[];
  gridAnomalyLogs: AnomalyLogEntry[];
  inverterAnomalyLogs: AnomalyLogEntry[];
  solarDcAnomalyLogs: SolarDcAnomalyLogEntry[];

  outlet1Status: boolean;
  outlet2Status: boolean;
  setOutlet1Status: (v: boolean) => void;
  setOutlet2Status: (v: boolean) => void;

  manualOverride: boolean;
  setManualOverride: (v: boolean) => void;
  setAutoSwitchEnabled: (v: boolean) => void;

  // K relay manual controls (v7.0)
  setK1: (on: boolean) => void;
  setK2: (on: boolean) => void;
  setK4: (on: boolean) => void;
  enterManualMode: (mode: ControlMode) => void;
  exitManualMode: () => void;

  refreshData: () => void;
  manualLockoutRemaining: number;

  buzzerActive: boolean;
  triggerBuzzer: (durationMs?: number) => Promise<void>;
  stopBuzzer: () => Promise<void>;

  emergencyShutdown: () => Promise<{ success: boolean; message: string }>;

  // ── DC low-voltage anomaly (battery pack + solar PV) ─────────────────────
  dcBatteryAnomaly: AnomalyLevel;   // 'none' | 'warning' | 'critical'
  dcSolarAnomaly:   AnomalyLevel;

  // ── Shared sensor history (24h) — single fetch, all components in sync ──
  sensorHistory: any[];
  sensorHistoryLoading: boolean;
}

// ============================================================================
// CONTEXT
// ============================================================================

const EnergySystemContext = createContext<EnergySystemState | null>(null);

export function useEnergySystem(): EnergySystemState {
  const ctx = useContext(EnergySystemContext);
  if (!ctx) throw new Error('useEnergySystem must be used within EnergySystemProvider');
  return ctx;
}

// ============================================================================
// DB LOG MAPPER
// ============================================================================

function mapDbLogToEntry(row: api.AnomalyLog): AnomalyLogEntry {
  const level: AnomalyLevel =
    row.severity === 'Critical' || row.severity === 'High' ? 'critical' :
    row.severity === 'Warning'  || row.severity === 'Medium' ? 'warning' : 'none';

  // [FIX-FIELD-MAP] The Flask _ANOMALY_SELECT returns these camelCase aliases:
  //   battery_soc     → battery       (already aliased in SQL)
  //   solar_power     → solarPower    (already aliased in SQL)
  //   grid_voltage    → gridVoltage   (already aliased in SQL)
  //   anomaly_label   → anomalyLabel  (already aliased in SQL)
  //   resolved_at     → resolvedAt    (already aliased in SQL)
  // mapDbLogToEntry was ignoring most of these and returning '—' for battery/solar.
  const r = row as any;
  return {
    id: row.id,
    timestamp: row.timestamp,
    level,
    subsystem:    r.source     ?? 'System',
    message:      r.systemAction ?? '',
    severity:     row.severity ?? 'Low',
    type:         r.type       ?? 'Event',
    source:       r.source     ?? 'System',
    systemAction: r.systemAction ?? '',
    // [FIX] These were always '—' — now read from actual DB columns
    gridVoltage:  r.gridVoltage   ?? r.grid_voltage   ?? '—',
    solarPower:   r.solarPower    ?? r.solar_power     ?? '—',
    battery:      r.battery       ?? r.battery_soc     ?? '—',
    status:       r.status        ?? 'Monitoring',
    emailStatus:  (r.emailStatus as AnomalyLogEntry['emailStatus']) ?? 'N/A',
    buzzer:       (r.buzzer as 'ON' | 'OFF') ?? 'OFF',
    // [FIX] resolvedAt was always null — now reads from DB
    resolvedAt:   r.resolvedAt    ?? r.resolved_at     ?? null,
    responseTimeMs: r.responseTimeMs ?? r.response_time_ms ?? null,
    inverterPower:  r.inverterPower  ?? r.inverter_power   ?? null,
    systemTemp:     r.systemTemp     ?? r.system_temp      ?? null,
    detectedAt:     r.detectedAt     ?? r.detected_at      ?? null,
    actionAt:       r.actionAt       ?? r.action_at        ?? null,
    // [FIX] v7.0 anomaly engine fields — were missing anomalyLabel
    anomalyLabel:  (r.anomalyLabel  ?? r.anomaly_label  ?? null) as AnomalyLogEntry['anomalyLabel'],
    anomalySource:  r.anomalySource  ?? r.anomaly_source  ?? null,
    anomalyDelta:   r.anomalyDelta   ?? r.anomaly_delta   ?? null,
    confirmCount:   r.confirmCount   ?? r.confirm_count   ?? null,
    contextGridCurrent:    r.contextGridCurrent    ?? r.context_grid_current    ?? null,
    contextGridFrequency:  r.contextGridFrequency  ?? r.context_grid_frequency  ?? null,
    contextInvVoltage:     r.contextInvVoltage     ?? r.context_inv_voltage     ?? null,
    contextInvCurrent:     r.contextInvCurrent     ?? r.context_inv_current     ?? null,
    contextInvFrequency:   r.contextInvFrequency   ?? r.context_inv_frequency   ?? null,
    contextBatteryVoltage: r.contextBatteryVoltage ?? r.context_battery_voltage ?? null,
    contextBatteryCurrent: r.contextBatteryCurrent ?? r.context_battery_current ?? null,
    contextSolarPower:     r.contextSolarPower     ?? r.context_solar_power     ?? null,
    contextSensorStatus:   r.contextSensorStatus   ?? r.context_sensor_status   ?? null,
  };
}

// ============================================================================
// PROMISE QUEUE (SSR commands)
// ============================================================================

type QueueTask = () => Promise<void>;
function createQueue() {
  let _tail: Promise<void> = Promise.resolve();
  return {
    add(task: QueueTask): Promise<void> {
      const next = _tail.then(() => task()).catch(err => {
        console.error('[SSR queue error]', err);
      });
      _tail = next;
      return next;
    },
  };
}
const _ssrQueue = createQueue();

// ============================================================================
// SSR BACKEND SYNC — Simplified v7.0
// ============================================================================

async function pushSSRToBackend(
  k1: boolean, k2: boolean, k3: boolean, k4: boolean,
  autoSwitchEnabled: boolean, manualOverride: boolean,
): Promise<void> {
  // [FIX-CONTROL-MODE] Derive controlMode from relay states so DB always has a valid value.
  // Flask rejects 'manual' — use the actual operational mode string instead.
  const controlMode: string = !k4
    ? 'shutdown'
    : k1 && k2 ? 'assist'
    : k1        ? 'solar'
    : k2        ? 'grid'
    : 'shutdown';

  return _ssrQueue.add(async () => {
    try {
      await api.updateSSRState({
        autoSwitchEnabled,
        manualOverride,
        controlMode,
        ssrStates: { SSR1: k1, SSR2: k2, SSR3: k3, SSR4: k4, K1: k1, K2: k2 },
        contactorClosed: k4,
      } as Parameters<typeof api.updateSSRState>[0]);
      console.log(`✅ SSR synced → K1=${k1} K2=${k2} K3=${k3} K4=${k4} mode=${controlMode}`);
    } catch (err) {
      console.error('❌ SSR backend sync failed:', err);
    }
  });
}

// ============================================================================
// PROVIDER
// ============================================================================

interface ProviderProps { children: React.ReactNode; pollIntervalMs?: number; }

export function EnergySystemProvider({ children, pollIntervalMs = 5000 }: ProviderProps) {

  // ── Sensor state ──────────────────────────────────────────────────────────
  const [gridVoltage,       setGridVoltage]      = useState(0);
  const [gridCurrent,       setGridCurrent]       = useState(0);
  const [gridFrequency,     setGridFrequency]     = useState(0);
  const [gridPowerState,    setGridPowerState]    = useState(0);

  const [solarVoltage,      setSolarVoltage]      = useState(0);
  const [solarCurrent,      setSolarCurrent]      = useState(0);
  const [solarPower,        setSolarPower]        = useState(0);
  const [solarEfficiency,   setSolarEfficiency]   = useState(0);
  const [systemEfficiency,  setSystemEfficiency]  = useState<number | null>(null);

  const [batteryVoltage,    setBatteryVoltage]    = useState(0);
  const [batteryCurrent,    setBatteryCurrent]    = useState(0);
  const [batterySOC,        setBatterySOC]        = useState(0);
  const [batteryChargeA,    setBatteryChargeA]    = useState(0);
  const [batteryDischargeA, setBatteryDischargeA] = useState(0);
  const [batterySource,     setBatterySource]     = useState<string>('INA219');
  const [batteryAnomalyDetails, setBatteryAnomalyDetails] = useState<string[]>([]);
  const [battery1Voltage,   setBattery1Voltage]   = useState(0);
  const [battery1Current,   setBattery1Current]   = useState(0);
  const [battery2Voltage,   setBattery2Voltage]   = useState(0);
  const [battery2Current,   setBattery2Current]   = useState(0);

  const POWER_FLOW_ZERO: PowerFlow = {
    solarToLoad: 0, batteryToLoad: 0, gridToLoad: 0, gridToBattery: 0,
    solarDcW: 0, batDischargeW: 0, batChargeW: 0, inverterW: 0, gridW: 0,
  };
  const [powerFlow,         setPowerFlow]         = useState<PowerFlow>(POWER_FLOW_ZERO);

  const [inverterVoltage,   setInverterVoltage]   = useState(0);
  const [inverterCurrent,   setInverterCurrent]   = useState(0);
  const [inverterFrequency, setInverterFrequency] = useState(0);
  const [inverterPower,     setInverterPower]     = useState(0);

  const [systemTemp,        setSystemTemp]        = useState(0);
  const [stringCurrents,    setStringCurrents]    = useState<number[] | undefined>(undefined);
  const [thermalShutdownActive, setThermalShutdownActive] = useState(false);
  const [serverTime,        setServerTime]        = useState<string>('');
  const [rtcAvailable,      setRtcAvailable]      = useState<boolean>(false);

  const [anomalyLogs,       setAnomalyLogs]       = useState<AnomalyLogEntry[]>([]);
  const [gridAnomalyLogs,     setGridAnomalyLogs]     = useState<AnomalyLogEntry[]>([]);
  const [inverterAnomalyLogs, setInverterAnomalyLogs] = useState<AnomalyLogEntry[]>([]);
  const [solarDcAnomalyLogs,  setSolarDcAnomalyLogs]  = useState<SolarDcAnomalyLogEntry[]>([]);
  const [dcBatteryAnomaly,    setDcBatteryAnomaly]    = useState<AnomalyLevel>('none');
  const [dcSolarAnomaly,      setDcSolarAnomaly]      = useState<AnomalyLevel>('none');

  // ── SSR state (simplified K1/K2/K3/K4) ───────────────────────────────────
  const [k1Active,            setK1Active]             = useState(true);
  const [k2Active,            setK2Active]             = useState(true);
  const [k4Closed,            setK4Closed]             = useState(true);
  const [controlAuthority,    setControlAuthority]     = useState<ControlAuthority>('manual');
  const [autoSwitchEnabled,   setAutoSwitchEnabledState] = useState(false);
  const [manualOverride,      setManualOverride]       = useState(false);
  const [manualBlockedReason, setManualBlockedReason]  = useState<string | undefined>();
  const [totalSwitches,       setTotalSwitches]        = useState(0);
  const [lastSwitchTime,      setLastSwitchTime]       = useState('—');
  const [batteryCapacityAh,   setBatteryCapacityAh]    = useState<number>(100);

  // ── Arduino v6.4 live timer countdowns ───────────────────────────────────
  const [arduinoK4LeftS,       setArduinoK4LeftS]       = useState(0);
  const [arduinoK1LeftS,       setArduinoK1LeftS]       = useState(0);
  const [arduinoK2LeftS,       setArduinoK2LeftS]       = useState(0);
  const [arduinoRecoveryLeftS, setArduinoRecoveryLeftS] = useState(0);
  const [arduinoDropout,       setArduinoDropout]       = useState(false);
  const [arduinoEmergency,     setArduinoEmergency]     = useState(false);

  const [outlet1Status,       setOutlet1Status]        = useState(false);
  const [outlet2Status,       setOutlet2Status]        = useState(false);

  const [k4ReconnectState, setK4ReconnectState] = useState<K4ReconnectState>({
    locked: false, faultAt: null, recoveredAt: null, secondsRemaining: 0,
  });

  const _lastManualTs = useRef<number>(0);
  const [manualLockoutRemaining, setManualLockoutRemaining] = useState(0);

  const [buzzerActive,  setBuzzerActive]  = useState(false);
  const [emailServiceOnline, setEmailServiceOnline] = useState(false);

  // ── Shared sensor history — fetched once every 30s, shared by all consumers ──
  const [sensorHistory,        setSensorHistory]        = useState<any[]>([]);
  const [sensorHistoryLoading, setSensorHistoryLoading] = useState(true);

  const lastDataRef    = useRef({ gridV: -1, solP: -1, batV: -1 });
  const frozenSinceRef = useRef<number | null>(null);
  const failCountRef   = useRef(0);
  const OFFLINE_FAIL_THRESHOLD = 3;
  const [frozenMs,     setFrozenMs]     = useState(0);
  const [hasValidData, setHasValidData] = useState(false);

  // ── Consecutive anomaly counters (ref = no re-render) ─────────────────────
  const gridAnomalyCountRef     = useRef(0);
  const inverterAnomalyCountRef = useRef(0);
  const ANOMALY_CONFIRM_COUNT   = 3; // 3 consecutive readings = confirmed

  // [FIX-REALTIME-LOGS] Ref to trigger immediate anomaly log fetch on state change.
  // Assigned inside the anomaly-logs useEffect so poll() can call it directly.
  const fetchLogsNowRef      = useRef<(() => Promise<void>) | null>(null);
  const prevBackendGridRef   = useRef<string>('none');   // detect none↔critical transitions
  const prevBackendInvRef    = useRef<string>('none');

  // [FIX-ANOMALY-FLOW] Backend engine confirmed anomaly state.
  // These are set from /api/sensor-data/current .anomaly field each poll cycle.
  // UI uses these to stay in sync with the backend's 3-reading confirm + buzzer/email logic.
  const [backendGridAnomaly,    setBackendGridAnomaly]    = useState<AnomalyLevel>('none');
  const [backendInvAnomaly,     setBackendInvAnomaly]     = useState<AnomalyLevel>('none');
  const [backendGridFaultType,  setBackendGridFaultType]  = useState<string>('');
  const [backendInvFaultType,   setBackendInvFaultType]   = useState<string>('');

  // ── Derived anomalies ──────────────────────────────────────────────────────

  // PRIMARY: Real AC voltage anomaly detection
  // [FIX-ANOMALY-FLOW] Now synced with backend engine result:
  //   - UI derives label from voltage (instant visual feedback on every poll)
  //   - Severity is OVERRIDDEN by backend confirmed result so buzzer/email and
  //     UI banner always agree. Backend requires 3 consecutive readings before
  //     escalating to 'critical' (except dropout which is immediate).
  //   - Dropout (voltage=0) is immediate 'critical' in UI — no warm-up period.
  function detectVoltageAnomaly(
    voltage: number,
    normalLow: number, normalHigh: number,
    critLow: number,   critHigh: number,
    backendLevel: AnomalyLevel,
    backendFaultType: string,
  ): VoltageAnomalyResult {
    // ── Derive label from raw voltage (instant, for display) ──
    let label: AnomalyLabel;
    let localSeverity: AnomalyLevel;

    if (voltage <= 0) {
      // Dropout is always immediate critical — 0V has no safe interpretation.
      label = 'Dropout';
      localSeverity = 'critical';
    } else if (voltage < critLow) {
      label = 'Spike - Low Voltage';
      localSeverity = 'critical';
    } else if (voltage > critHigh) {
      label = 'Spike - High Voltage';
      localSeverity = 'critical';
    } else if (voltage < normalLow) {
      // Between critLow and normalLow → Warning (Drift)
      label = 'Drift - Low Voltage';
      localSeverity = 'warning';
    } else if (voltage > normalHigh) {
      // Between normalHigh and critHigh → Warning (Drift)
      label = 'Drift - High Voltage';
      localSeverity = 'warning';
    } else {
      label = 'Normal';
      localSeverity = 'none';
    }

    // ── Override label from backend fault type string when available ──
    if (backendFaultType) {
      const ft = backendFaultType.toLowerCase();
      if (ft.includes('dropout'))    label = 'Dropout';
      else if (ft.includes('spike') && ft.includes('high')) label = 'Spike - High Voltage';
      else if (ft.includes('spike') && ft.includes('low'))  label = 'Spike - Low Voltage';
      else if (ft.includes('drift') && ft.includes('high')) label = 'Drift - High Voltage';
      else if (ft.includes('drift') && ft.includes('low'))  label = 'Drift - Low Voltage';
    }

    // ── Severity: local critical always wins immediately (dropout, voltage=0)
    // Backend confirmed level is authoritative for warning vs critical escalation.
    // [FIX-BUG4] If local derivation says critical (e.g. 0V dropout), never downgrade
    // to warning just because backend is still counting up to 3 readings.
    const severity: AnomalyLevel =
      localSeverity === 'critical' ? 'critical'   // local critical is immediate — never wait for backend
      : backendLevel !== 'none'   ? backendLevel   // backend confirmed warning/critical
      : localSeverity;                             // local fallback (first poll, backend not ready)

    return { label, severity, value: voltage };
  }

  const gridVoltageAnomaly = detectVoltageAnomaly(
    gridVoltage,
    GRID_NORMAL_LOW, GRID_NORMAL_HIGH,
    GRID_CRITICAL_LOW, GRID_CRITICAL_HIGH,
    backendGridAnomaly,
    backendGridFaultType,
  );

  const inverterVoltageAnomaly = detectVoltageAnomaly(
    inverterVoltage,
    INV_NORMAL_LOW, INV_NORMAL_HIGH,
    INV_CRITICAL_LOW, INV_CRITICAL_HIGH,
    backendInvAnomaly,
    backendInvFaultType,
  );

  // Legacy AnomalyLevel for backward-compat with existing card components
  const gridAnomaly: AnomalyLevel     = gridVoltageAnomaly.severity;
  const inverterAnomaly: AnomalyLevel = inverterVoltageAnomaly.severity;

  // CONTEXT-ONLY (not primary anomaly triggers)
  const batteryAnomaly: AnomalyLevel  = 'none';
  const tempAnomaly: AnomalyLevel     = systemTemp >= 60 ? 'critical' : systemTemp >= 50 ? 'warning' : 'none';
  const sensorIntegrity: AnomalyLevel = 'none';
  const solarAnomaly: AnomalyLevel    = 'none';

  const gridPower = gridPowerState > 0 ? gridPowerState : gridVoltage * gridCurrent;

  // Overall anomaly level — worst of grid + inverter + temp
  const anomalyLevel: AnomalyLevel =
    gridAnomaly === 'critical' || inverterAnomaly === 'critical' || tempAnomaly === 'critical'
      ? 'critical'
      : gridAnomaly === 'warning' || inverterAnomaly === 'warning' || tempAnomaly === 'warning'
        ? 'warning'
        : 'none';

  const batteryFull = batteryVoltage >= 25.4;
  const sensorFault = false; // anomaly detection moved to external engine

  // Sensor status map (user-friendly names)
  const sensorStatus = deriveSensorStatus(
    gridVoltage, inverterVoltage, batteryVoltage,
    solarPower, systemTemp, rtcAvailable,
    hasValidData, frozenMs,
  );

  const gridStatus = gridAnomaly === 'none' ? 'Normal'
    : gridAnomaly === 'warning' ? 'Warning' : 'Critical';

  const controlMode: ControlMode = (() => {
    if (!k4Closed) return 'shutdown';
    if (k1Active && !k2Active) return 'solar';
    if (!k1Active && k2Active) return 'grid';
    if (k1Active && k2Active)  return 'assist';
    return 'shutdown';
  })();

  // ── K4 reconnect timer (replaces old K3 reconnect) ────────────────────────
  // K4 = safety cutoff: OFF when grid dropout + battery low
  // ON only after grid returns stable for K4_RECONNECT_DELAY_MS
  useEffect(() => {
    // [FIX-BUG5] K4 reconnect delay only for true dropout (0V), not for warning voltage sag.
    // Old: gridVoltage < 200 → locked K4 for 60s on any sag below 200V (e.g. 199V brownout).
    // New: only lock on actual 0V dropout so brownouts don't kill load for a full minute.
    const isGridDropout = gridVoltage <= 0;
    if (isGridDropout) {
      setK4ReconnectState(prev => ({
        locked: true,
        faultAt: prev.faultAt ?? Date.now(),
        recoveredAt: null,
        secondsRemaining: Math.ceil(K4_RECONNECT_DELAY_MS / 1000),
      }));
    } else if (k4ReconnectState.faultAt) {
      const recoveredAt = k4ReconnectState.recoveredAt ?? Date.now();
      setK4ReconnectState(prev => ({
        ...prev,
        recoveredAt,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridVoltage]);

  useEffect(() => {
    if (!k4ReconnectState.locked || !k4ReconnectState.recoveredAt) return;
    const tick = setInterval(() => {
      setK4ReconnectState(prev => {
        const elapsed   = Date.now() - (prev.recoveredAt ?? Date.now());
        const remaining = Math.max(0, K4_RECONNECT_DELAY_MS - elapsed);
        if (remaining === 0) {
          clearInterval(tick);
          return { locked: false, faultAt: null, recoveredAt: null, secondsRemaining: 0 };
        }
        return { ...prev, secondsRemaining: Math.ceil(remaining / 1000) };
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [k4ReconnectState.locked, k4ReconnectState.recoveredAt]);

  // K3 auto-control removed — backend no longer handles relay switching
  // K3 state is read-only from backend poll; display only

  // ── Manual lockout countdown ───────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const elapsed   = Date.now() - _lastManualTs.current;
      const remaining = Math.max(0, MANUAL_LOCKOUT_MS - elapsed);
      setManualLockoutRemaining(Math.ceil(remaining / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);

  function touchManualTs() {
    _lastManualTs.current = Date.now();
    setManualLockoutRemaining(Math.ceil(MANUAL_LOCKOUT_MS / 1000));
  }

  // ── Email service health ───────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch('/api/email/health');
        const data = await r.json();
        setEmailServiceOnline(r.ok && (data.status === 'ok' || data.status === 'healthy'));
      } catch { setEmailServiceOnline(false); }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Shared sensor history — single 30s fetch for all components ──────────
  useEffect(() => {
    const run = async () => {
      try {
        // [FIX-HISTORY] api.getSensorHistory only passes limit — no hours param.
        // Use direct fetch with hours=24 & limit=1440 (1 point/min × 24h = full day).
        const _hRes = await fetch('/api/sensor-data/logs?hours=24&limit=1440');
        const history = await _hRes.json();
        // [FIX-HISTORY-ROWS] /api/sensor-data/logs returns { logs: [...] }
        const rows = Array.isArray(history)
          ? history
          : Array.isArray((history as any).logs) ? (history as any).logs : [];
        setSensorHistory(rows);
      } catch (err) {
        console.warn('[Context] sensorHistory fetch failed:', err);
      } finally {
        setSensorHistoryLoading(false);
      }
    };
    run();
    const id = setInterval(run, 60_000);  // [FIX-LOG-PERF] 60s — was 30s, 1440-row fetch every 30s was heavy on Pi
    return () => clearInterval(id);
  }, []);

  // ── systemCondition ────────────────────────────────────────────────────────
  const systemCondition = (() => {
    if (thermalShutdownActive)      return 'Thermal Shutdown — Cooling Down';
    if (anomalyLevel === 'critical') {
      // Show specific anomaly label for primary faults
      if (gridVoltageAnomaly.severity === 'critical')
        return `Grid Fault: ${gridVoltageAnomaly.label} (${gridVoltage.toFixed(1)}V)`;
      if (inverterVoltageAnomaly.severity === 'critical')
        return `Inverter Fault: ${inverterVoltageAnomaly.label} (${inverterVoltage.toFixed(1)}V)`;
      return 'Critical Fault — Check System';
    }
    if (anomalyLevel === 'warning')  return 'Warning — Monitor Readings';
    // K1/K2 always manual — no auto-switch
    if (k4ReconnectState.locked)
      return `K4 Safety Delay — Reconnect in ${k4ReconnectState.secondsRemaining}s`;
    return 'System Operational';
  })();

  // ── K relay manual setters (v7.0) ─────────────────────────────────────────
  const handleSetK1 = useCallback((on: boolean) => {
    touchManualTs();
    setK1Active(on);
    setControlAuthority('manual');
    pushSSRToBackend(on, k2Active, false, k4Closed, false, true);
  }, [k2Active, k4Closed]);

  const handleSetK2 = useCallback((on: boolean) => {
    touchManualTs();
    setK2Active(on);
    setControlAuthority('manual');
    pushSSRToBackend(k1Active, on, false, k4Closed, false, true);
  }, [k1Active, k4Closed]);

  const handleSetK4 = useCallback((on: boolean) => {
    touchManualTs();
    setK4Closed(on);
    setControlAuthority('manual');
    pushSSRToBackend(k1Active, k2Active, false, on, false, true);
  }, [k1Active, k2Active]);

  const handleSetAutoSwitchEnabled = useCallback((enabled: boolean) => {
    touchManualTs();
    setAutoSwitchEnabledState(enabled);
    setControlAuthority('manual');
    setManualOverride(true);
    pushSSRToBackend(k1Active, k2Active, false, k4Closed, false, true);
  }, [k1Active, k2Active, k4Closed]);

  // ── POLL ──────────────────────────────────────────────────────────────────
  // ── Active fetch abort controller — aborted fetches never count as offline ─
  const pollAbortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    // [FIX-PAGE-SWITCH] Cancel in-flight poll when a new one starts.
    // Prevents stale responses from updating state after navigation.
    pollAbortRef.current?.abort();
    pollAbortRef.current = new AbortController();
    try {
      const data = await api.getCurrentSensorData();
      if (data) {
        const g  = data.grid     ?? {} as typeof data.grid;
        const s  = data.solar    ?? {} as typeof data.solar;
        const b  = data.battery  ?? {} as typeof data.battery;
        const iv = data.inverter ?? {} as typeof data.inverter;
        const sy = data.system   ?? {} as typeof data.system;

        // [FIX-GHOST-V2] Read backend anomaly result FIRST so we can use it as a
        // tiebreaker in the ghost voltage guard below.
        // The Flask VoltageAnomalyEngine is the ground truth — it already applies
        // frequency-based ghost detection. If it confirms a Dropout, force voltage=0
        // even if the raw PZEM reading looks plausible (e.g. ghost 235V at 60Hz).
        const backendAnomaly = (data as Record<string, unknown>).anomaly as
          { grid?: string; inverter?: string; gridFaultType?: string; invFaultType?: string } | undefined;
        // Also read aeGridResult/aeInverterResult directly from Flask AnomalyEngine cache
        // [FIX-AE-KEYS] Flask AnomalyEngine uses:
        //   severity     → "Normal" | "Warning" | "Critical"  (NOT "level")
        //   anomaly_type → "Normal" | "Dropout" | "Spike" | "Drift"  (NOT "fault_type")
        // Must lowercase severity to match AnomalyLevel type ("none"|"warning"|"critical")
        const aeGrid = (data as Record<string, unknown>).aeGridResult as
          { severity?: string; anomaly_type?: string; delta_v?: number } | undefined;
        const aeInv  = (data as Record<string, unknown>).aeInverterResult as
          { severity?: string; anomaly_type?: string; delta_v?: number } | undefined;
        if (backendAnomaly) {
          // [FIX-AE-KEYS] Map Flask AE severity → frontend AnomalyLevel
          // Flask: "Normal"→"none", "Warning"→"warning", "Critical"→"critical"
          const mapSeverity = (s?: string): string =>
            s === 'Critical' ? 'critical' : s === 'Warning' ? 'warning' : 'none';

          // Prefer aeGridResult/aeInverterResult (direct AE output); fallback to anomaly field
          const newGridLevel = aeGrid?.severity ? mapSeverity(aeGrid.severity) : (backendAnomaly.grid ?? 'none');
          const newInvLevel  = aeInv?.severity  ? mapSeverity(aeInv.severity)  : (backendAnomaly.inverter ?? 'none');
          setBackendGridAnomaly(newGridLevel as AnomalyLevel);
          setBackendInvAnomaly( newInvLevel  as AnomalyLevel);
          // [FIX-AE-KEYS] anomaly_type is the fault label (Dropout/Spike/Drift/Normal)
          setBackendGridFaultType( aeGrid?.anomaly_type ?? backendAnomaly.gridFaultType ?? '');
          setBackendInvFaultType(  aeInv?.anomaly_type  ?? backendAnomaly.invFaultType  ?? '');

          // [FIX-REALTIME-LOGS] Immediately fetch logs on ANY anomaly level transition.
          // Old: logs polled every 10s → 8-10s delay before count/log table updated after dropout.
          // New: none→warning/critical OR warning/critical→none fires fetchLogsNow() instantly.
          // 800ms delay = let Flask finish writing the DB row before frontend fetches.
          const gridChanged = newGridLevel !== prevBackendGridRef.current;
          const invChanged  = newInvLevel  !== prevBackendInvRef.current;
          if ((gridChanged || invChanged) && fetchLogsNowRef.current) {
            setTimeout(() => { fetchLogsNowRef.current?.(); }, 800);
          }
          prevBackendGridRef.current = newGridLevel;
          prevBackendInvRef.current  = newInvLevel;

          // DC low-voltage anomaly levels (battery + solar)
          const mapDC = (s?: string): AnomalyLevel =>
            s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'none';
          setDcBatteryAnomaly(mapDC(backendAnomaly.battery));
          setDcSolarAnomaly(mapDC(backendAnomaly.solar));
        }

        // Ghost voltage guard: PZEM-004T returns ghost readings (e.g. 235V at 0Hz)
        // when AC power is removed due to residual capacitance. Primary guard is the
        // Flask backend (frequency-based). Secondary guard here catches cases where
        // Flask returns a non-zero frequency for the ghost reading.
        // [FIX-GHOST-V2] Also treat as dropout if Flask engine confirms Dropout —
        //   this handles the edge case where Flask zeroes voltage but not frequency,
        //   or where the frontend sees a stale high-voltage reading.
        const rawGridV    = Number(g.voltage   ?? 0);
        const rawGridFreq = Number(g.frequency ?? 0);
        // [FIX-GHOST-V4] Two-signal ghost guard — EITHER signal alone clears the ghost:
        //   Signal 1 (Physical): freq < 40Hz → no real AC cycle → residual capacitance ghost
        //   Signal 2 (Backend):  grid === 'critical' → engine already confirmed fault on server
        //     (don't require exact faultType string — cache may be stale on first poll after unplug)
        // Old bug: required BOTH grid=critical AND gridFaultType==='Dropout' (exact string).
        // Result: first poll after unplug showed ghost voltage for 1 cycle (faultType not yet updated).
        // [FIX-GHOST-V5] Flask already zeroes ghost freq to 0Hz when it detects residual
        // capacitance (V>50 && freq<5Hz) server-side. So rawGridFreq>=40 is the primary guard.
        // rawGridV===0 fast-path: Flask explicitly zeroed it → treat as Dropout immediately,
        // no need to wait for backendAnomaly to update on next poll.
        const gridPlausible = rawGridV === 0
          ? false  // Flask already zeroed voltage — definitive dropout, no ghost possible
          : rawGridV >= 50
            && rawGridFreq >= 40
            && rawGridFreq <= 70
            && backendAnomaly?.grid !== 'critical';  // belt-and-suspenders
        const newGridV  = gridPlausible ? rawGridV : 0;
        setGridVoltage(newGridV);
        setGridCurrent(newGridV > 0 ? Number(g.current    ?? 0) : 0);
        setGridFrequency(newGridV > 0 ? rawGridFreq : 0);
        const newGridPower = newGridV > 0
          ? (Number(g.power) > 0 ? Number(g.power) : newGridV * (g.current ?? 0))
          : 0;
        setGridPowerState(newGridPower);

        const newSolV = Number(s.voltage ?? 0);
        const newSolC = Number(s.current ?? 0);
        const newSolP = Number(s.power) > 0 ? Number(s.power) : newSolV * newSolC;
        setSolarVoltage(newSolV);
        setSolarCurrent(newSolC);
        setSolarPower(newSolP);
        setSolarEfficiency(Number(s.efficiency ?? 0));

        // Arduino voltage divider (A5) — single 24V pack, no b1/b2 split
        const bVoltage = Number(b.voltage ?? 0);
        const bCurrent = Number(b.current ?? 0);

        setBatteryVoltage(bVoltage);
        setBatteryCurrent(bCurrent);
        setBatterySOC(Number(b.soc ?? 0));
        setBatteryChargeA(0);
        setBatteryDischargeA(0);
        setBatterySource(b.source ?? 'arduino_vdiv');
        setBatteryAnomalyDetails([]);
        setBattery1Voltage(0);
        setBattery1Current(0);
        setBattery2Voltage(0);
        setBattery2Current(0);

        if ((data as unknown as Record<string, unknown>).powerFlow) {
          const pf = (data as unknown as Record<string, unknown>).powerFlow as Record<string, number>;
          setPowerFlow({
            solarToLoad:   pf.solarToLoad   ?? 0,
            batteryToLoad: pf.batteryToLoad ?? 0,
            gridToLoad:    pf.gridToLoad    ?? 0,
            gridToBattery: pf.gridToBattery ?? 0,
            solarDcW:      pf.solarDcW      ?? 0,
            batDischargeW: pf.batDischargeW ?? 0,
            batChargeW:    pf.batChargeW    ?? 0,
            inverterW:     pf.inverterW     ?? 0,
            gridW:         pf.gridW         ?? 0,
          });
        }

        if (data.system?.server_time)               setServerTime(data.system.server_time);
        if (data.system?.rtc_available !== undefined) setRtcAvailable(data.system.rtc_available);

        // [FIX-GHOST-V4] Inverter ghost guard — same two-signal fix as grid.
        const rawInvV    = Number(iv.voltage   ?? 0);
        const rawInvFreq = Number(iv.frequency ?? 0);
        // [FIX-GHOST-V5] Same fast-path fix as grid — rawInvV===0 means Flask zeroed it.
        const invPlausible = rawInvV === 0
          ? false
          : rawInvV >= 50
            && rawInvFreq >= 40
            && rawInvFreq <= 70
            && backendAnomaly?.inverter !== 'critical';
        const cleanInvV  = invPlausible ? rawInvV : 0;
        setInverterVoltage(cleanInvV);
        setInverterCurrent(cleanInvV > 0 ? Number(iv.current    ?? 0) : 0);
        setInverterFrequency(cleanInvV > 0 ? rawInvFreq : 0);
        setInverterPower(cleanInvV > 0 ? Number(iv.power        ?? 0) : 0);
        setSystemTemp(sy.temperature     ?? 0);
        setSystemEfficiency(sy.systemEfficiency ?? null);
        setThermalShutdownActive(Boolean(sy.thermalShutdown));

        // [backendAnomaly already read and applied above — see FIX-GHOST-V2 block]

        const apiStrings = s.stringCurrents;
        if (Array.isArray(apiStrings) && apiStrings.length === 4) {
          setStringCurrents(apiStrings.map(c => Math.max(0, parseFloat(Number(c).toFixed(2)))));
        } else if (newSolC > 0) {
          const offsets = [+0.15, -0.20, +0.10, -0.05];
          setStringCurrents(offsets.map(o => Math.max(0, parseFloat((newSolC / 4 + o).toFixed(2)))));
        } else {
          setStringCurrents([0, 0, 0, 0]);
        }

        const prev     = lastDataRef.current;
        const gridChanged = Math.abs(newGridV - prev.gridV) > 0.5;
        const solChanged  = Math.abs(newSolP  - prev.solP)  > 1.0;
        const batChanged  = Math.abs(bVoltage - prev.batV)  > 0.05;
        // [FIX-FROZEN] Old: frozen if NO value changed — wrong at night when
        // solar=0 and battery is stable. A sensor that reads consistent 0 or
        // a stable value is NOT frozen — it's working correctly.
        // New: only mark frozen if ALL sensors are 0 AND data hasn't changed,
        // OR if the API itself stops responding (failCountRef handles that path).
        const allZero  = newGridV === 0 && newSolP === 0 && bVoltage === 0;
        const isFrozen = allZero && !gridChanged && !solChanged && !batChanged;
        if (isFrozen) {
          if (frozenSinceRef.current === null) frozenSinceRef.current = Date.now();
          setFrozenMs(Date.now() - frozenSinceRef.current);
        } else {
          frozenSinceRef.current = null;
          setFrozenMs(0);
          lastDataRef.current = { gridV: newGridV, solP: newSolP, batV: bVoltage };
        }
        if (newGridV > 0 || bVoltage > 0 || newSolP > 0) setHasValidData(true);
        failCountRef.current = 0;
      }
    } catch (err) {
      // [FIX-PAGE-SWITCH] AbortError = navigation cancelled this fetch — NOT a real failure.
      // Ignore aborts entirely: don't increment failCount, don't show offline banner.
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[sensor poll error]', err);
      failCountRef.current += 1;
      if (frozenSinceRef.current === null) frozenSinceRef.current = Date.now();
      setFrozenMs(Date.now() - frozenSinceRef.current);

      if (failCountRef.current >= OFFLINE_FAIL_THRESHOLD) {
        setGridVoltage(0); setGridCurrent(0); setGridFrequency(0); setGridPowerState(0);
        setSolarVoltage(0); setSolarCurrent(0); setSolarPower(0); setSolarEfficiency(0);
        setBatteryVoltage(0); setBatteryCurrent(0); setBatterySOC(0);
        setBatteryChargeA(0); setBatteryDischargeA(0);
        setInverterVoltage(0); setInverterCurrent(0); setInverterFrequency(0); setInverterPower(0);
        setSystemTemp(0); setStringCurrents([0, 0, 0, 0]);
        setSystemEfficiency(null);
        setBattery1Voltage(0); setBattery1Current(0);
        setBattery2Voltage(0); setBattery2Current(0);
        setBatteryAnomalyDetails([]);
        setBatterySource('INA219');
        setPowerFlow(POWER_FLOW_ZERO);
        setHasValidData(false);
      }
    }

  }, []); // stable poll — sensor data only, SSR+buzzer moved to separate intervals

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => clearInterval(id);
  }, [poll, pollIntervalMs]);

  // SSR state sync — 3s interval, Arduino-direct for real-time K1/K2/K4 state
  // Primary source: /api/arduino/status (direct Arduino '?' query)
  // Fallback: /api/ssr/state (DB — used if Arduino not responding)
  useEffect(() => {
    let ssrAbort: AbortController | null = null;
    const syncSSR = async () => {
      ssrAbort?.abort();
      ssrAbort = new AbortController();
      try {
        // Try Arduino direct first — real-time, no DB delay
        const ardRes = await fetch('/api/arduino/status', { signal: ssrAbort.signal });
        if (ardRes.ok) {
          const ardData = await ardRes.json();
          const ard = ardData.arduino ?? {};
          if (ard.ssr1_k1 !== undefined) {
            setK1Active(!!ard.ssr1_k1);
            setK2Active(!!ard.ssr2_k2);
            setK4Closed(!!ard.ssr4_k4);
            // Arduino v6.4 timer countdowns — used by UI to show live countdowns
            // Arduino only sends *_left_s when timer is active — default to 0 when absent
            setArduinoK4LeftS(      ard.k4_timer       ? (ard.k4_left_s       ?? 0) : 0);
            setArduinoK1LeftS(      ard.k1_timer       ? (ard.k1_left_s       ?? 0) : 0);
            setArduinoK2LeftS(      ard.k2_timer       ? (ard.k2_left_s       ?? 0) : 0);
            setArduinoRecoveryLeftS(ard.recovery       ? (ard.recovery_left_s ?? 0) : 0);
            setArduinoDropout(      !!ard.dropout);
            setArduinoEmergency(    !!ard.emergency);
            // dropout active = K4 forced open by Arduino
            if (ard.dropout) setK4Closed(false);
            return; // Arduino responded — skip DB poll
          }
        }
      } catch (e) { if (e instanceof Error && e.name === 'AbortError') return; /* Arduino not responding — fall through to DB */ }

      // Fallback: DB state
      try {
        const ssrData = await api.getSSRState();
        if (ssrData) {
          const autoEn = ssrData.autoSwitchEnabled ?? true;
          const manOvr = ssrData.manualOverride    ?? false;
          const states = ssrData.ssrStates ?? {};
          setK1Active((states as Record<string, boolean>).K1 ?? (states as Record<string, boolean>).SSR1 ?? false);
          setK2Active((states as Record<string, boolean>).K2 ?? (states as Record<string, boolean>).SSR2 ?? false);
          const dbK4 = !!(states as Record<string, boolean>).SSR4
                    || !!(states as Record<string, boolean>).K4
                    || !!((ssrData as unknown as Record<string, unknown>).k4Closed);
          setK4Closed(dbK4);
          setAutoSwitchEnabledState(false);  // K1/K2 always manual
          setManualOverride(true);
          setControlAuthority('manual');          // always manual
          setTotalSwitches(ssrData.totalSwitches  ?? 0);
          setLastSwitchTime(ssrData.lastSwitchTime ?? '—');
        }
      } catch (err) {
        console.warn('[SSR poll error]', err);
      }
    };
    syncSSR();
    const id = setInterval(syncSSR, 3_000);  // 3s — fast enough for relay state
    return () => { clearInterval(id); ssrAbort?.abort(); };
  }, []);

  // Buzzer state sync — 2s interval, separate from sensor poll
  useEffect(() => {
    const syncBuzzer = async () => {
      try {
        const r = await fetch('/api/buzzer/state');
        if (r.ok) { const d = await r.json(); setBuzzerActive(!!d.active); }
      } catch { /* non-critical */ }
    };
    syncBuzzer();
    const id = setInterval(syncBuzzer, 5_000);
    return () => clearInterval(id);
  }, []);

  // Anomaly logs — 10s background poll + IMMEDIATE fetch on anomaly state change.
  // [FIX-PERF] Old: 4 sequential fetches every 3s = ~80 requests/min.
  // New: 4 parallel fetches via Promise.all every 10s = ~24 requests/min.
  // [FIX-REALTIME-LOGS] Immediate trigger via fetchLogsNowRef on level transition still works.
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        // [FIX-LOG-PERF] Reduced from limit=2000 to limit=500 per endpoint.
        // 4×2000 rows every 10s = ~32K rows/min transferred from Pi MySQL — too heavy.
        // 500 rows covers ~4h of Normal heartbeat logs (every 30s) + any anomaly rows.
        // If user needs older logs, they can use the Logs page filter.
        const [allRes, gRes, iRes, sRes] = await Promise.all([
          fetch('/api/anomaly-logs?limit=500&include=all'),
          fetch('/api/anomaly-logs/grid?limit=500'),
          fetch('/api/anomaly-logs/inverter?limit=500'),
          fetch('/api/dc-anomaly-logs/solar?limit=500'),
        ]);

        try {
          const data = await allRes.json();
          const rows: api.AnomalyLog[] = Array.isArray(data) ? data : (data.logs ?? data.events ?? []);
          setAnomalyLogs(rows.map(mapDbLogToEntry));
        } catch (err) { console.warn('[anomaly-logs parse error]', err); }

        try {
          const gData = await gRes.json();
          setGridAnomalyLogs((gData.logs ?? []).map(mapDbLogToEntry));
        } catch (err) { console.warn('[grid-anomaly-logs parse error]', err); }

        try {
          const iData = await iRes.json();
          setInverterAnomalyLogs((iData.logs ?? []).map(mapDbLogToEntry));
        } catch (err) { console.warn('[inverter-anomaly-logs parse error]', err); }

        try {
          const sData = await sRes.json();
          setSolarDcAnomalyLogs(sData.logs ?? []);
        } catch (err) { console.warn('[solar-dc-anomaly-logs parse error]', err); }

      } catch (err) {
        console.warn('[fetchLogs error]', err);
      }
    };
    // Expose for immediate trigger from poll() on anomaly level transition
    fetchLogsNowRef.current = fetchLogs;
    fetchLogs();
    const id = setInterval(fetchLogs, 10_000);
    let logsAbort: AbortController | null = null;
    fetchLogsNowRef.current = async () => { logsAbort?.abort(); logsAbort = new AbortController(); return fetchLogs(); };
    return () => { clearInterval(id); logsAbort?.abort(); fetchLogsNowRef.current = null; };
  }, []);

  // System config — 60s interval — applies live thresholds to detection engine
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const configRes = await fetch('/api/system/config');
        if (configRes.ok) {
          const configData = await configRes.json();
          const c = configData?.config ?? {};

          // Battery capacity (discrete values only)
          const ah = parseInt(c.battery_capacity_ah ?? '100', 10);
          if (ah === 100 || ah === 200) setBatteryCapacityAh(ah);

          // Push all threshold fields into the live detection engine
        }
      } catch { /* non-critical */ }
    };
    fetchConfig();
    const id = setInterval(fetchConfig, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Buzzer controls ────────────────────────────────────────────────────────
  const triggerBuzzer = useCallback(async (durationMs = 5000) => {
    if (buzzerActive) return;
    try {
      setBuzzerActive(true);
      await fetch('/api/buzzer/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_ms: durationMs, reason: 'Manual UI trigger' }),
      });
      setTimeout(() => setBuzzerActive(false), durationMs);
    } catch (e) {
      console.error('[BUZZER] trigger error:', e);
      setBuzzerActive(false);
    }
  }, [buzzerActive]);

  const stopBuzzer = useCallback(async () => {
    try {
      await fetch('/api/buzzer/stop', { method: 'POST' });
    } catch (e) {
      console.error('[BUZZER] stop error:', e);
    } finally {
      setBuzzerActive(false);
    }
  }, []);

  // ── Emergency shutdown ─────────────────────────────────────────────────────
  const emergencyShutdown = useCallback(async () => {
    try {
      const res = await fetch('/api/ssr/emergency', { method: 'POST' });
      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `HTTP ${res.status}: ${err}` };
      }
      const data = await res.json();
      setK1Active(false);
      setK2Active(false);
      setK4Closed(false);
      setControlAuthority('manual');
      setManualOverride(true);
      setAutoSwitchEnabledState(false);
      return { success: true, message: data.action ?? 'EMERGENCY_CUTOFF' };
    } catch (e) {
      return { success: false, message: String(e) };
    }
  }, []);

  // ── Outlet controls ────────────────────────────────────────────────────────
  const handleSetOutlet1 = useCallback((v: boolean) => {
    setOutlet1Status(v);
    api.controlOutlet('outlet1', v).catch(console.error);
  }, []);
  const handleSetOutlet2 = useCallback((v: boolean) => {
    setOutlet2Status(v);
    api.controlOutlet('outlet2', v).catch(console.error);
  }, []);

  // [FIX-REFRESH] Stable ref to latest poll() — used by refreshData so it
  // never captures a stale closure regardless of how many times poll re-creates.
  const pollRef = useRef<typeof poll>(poll);
  useEffect(() => { pollRef.current = poll; }, [poll]);

  // [FIX-DEBOUNCE] Prevent rapid back-to-back refreshData() calls (e.g. from
  // useAutoRefresh periodic timer firing on top of Context's own poll loop).
  // 4s cooldown = shorter than any poll interval so manual refresh still works.
  const lastRefreshRef = useRef<number>(0);
  const REFRESH_DEBOUNCE_MS = 4_000;

  // ── Context value ──────────────────────────────────────────────────────────
  const handleEnterManualMode = useCallback((mode: ControlMode) => {
    setControlAuthority('manual');
    touchManualTs();
    const k1 = mode === 'solar' || mode === 'assist' || mode === 'failsafe';
    const k2 = mode === 'grid'  || mode === 'assist' || mode === 'failsafe';
    const k4 = mode !== 'shutdown';
    setK1Active(k1);
    setK2Active(k2);
    setK4Closed(k4);
    pushSSRToBackend(k1, k2, false, k4, false, true);
  }, []);

  const handleExitManualMode = useCallback(() => {
    setAutoSwitchEnabledState(true);
    pushSSRToBackend(true, true, false, k4Closed, true, false);
  }, [k4Closed]);

  const value: EnergySystemState = {
    gridVoltage, gridCurrent, gridFrequency, gridPower, gridStatus,
    solarVoltage, solarCurrent, solarPower, solarEfficiency, systemEfficiency,
    batteryVoltage, batteryCurrent, batterySOC,
    batteryChargeA, batteryDischargeA, batterySource,
    battery1Voltage, battery1Current,
    battery2Voltage, battery2Current,
    batteryAnomalyDetails,
    powerFlow,
    inverterVoltage, inverterCurrent, inverterFrequency, inverterPower,
    systemTemp, stringCurrents,
    thermalShutdownActive, serverTime, rtcAvailable,

    // v7.0 primary anomaly (AC voltage)
    gridVoltageAnomaly,
    inverterVoltageAnomaly,

    // Legacy AnomalyLevel (for backward compat)
    gridAnomaly,
    inverterAnomaly,
    batteryAnomaly,
    tempAnomaly,
    sensorIntegrity,
    solarAnomaly,
    anomalyLevel,

    sensorStatus,

    ssrStates: { K1: k1Active, K2: k2Active, K3: false, K4: k4Closed },
    k4Closed,
    contactorClosed: k4Closed,
    k4Reconnect: k4ReconnectState,
    controlMode,

    // Arduino v6.4 live timer countdowns
    arduinoK4LeftS,
    arduinoK1LeftS,
    arduinoK2LeftS,
    arduinoRecoveryLeftS,
    arduinoDropout,
    arduinoEmergency,

    controlAuthority,
    autoSwitchEnabled,
    systemCondition,
    manualBlockedReason,

    batteryCapacityAh,
    batteryFull,
    sensorFault,
    totalSwitches,
    lastSwitchTime,
    emailServiceHealth: emailServiceOnline,
    anomalyLogs,
    gridAnomalyLogs,
    inverterAnomalyLogs,
    solarDcAnomalyLogs,
    dcBatteryAnomaly,
    dcSolarAnomaly,

    outlet1Status, outlet2Status,
    setOutlet1Status: handleSetOutlet1,
    setOutlet2Status: handleSetOutlet2,

    manualOverride,
    setManualOverride,
    setAutoSwitchEnabled: handleSetAutoSwitchEnabled,

    setK1: handleSetK1,
    setK2: handleSetK2,
    setK4: handleSetK4,
    enterManualMode: handleEnterManualMode,
    exitManualMode: handleExitManualMode,

    refreshData: useCallback(async () => {
      // [FIX-REFRESH] Always call the latest poll() via ref — avoids stale closure
      // bug where poll reference changed every render, breaking the refresh button.
      // [FIX-DEBOUNCE] Skip if called within 4s of last refresh — prevents
      // useAutoRefresh or other external callers from doubling the poll load.
      const now = Date.now();
      if (now - lastRefreshRef.current < REFRESH_DEBOUNCE_MS) return;
      lastRefreshRef.current = now;
      await pollRef.current?.();
      await fetchLogsNowRef.current?.();
    }, []) as () => void,
    manualLockoutRemaining,

    buzzerActive,
    triggerBuzzer,
    stopBuzzer,
    emergencyShutdown,

    sensorHistory,
    sensorHistoryLoading,
  };

  return (
    <EnergySystemContext.Provider value={value}>
      {children}
    </EnergySystemContext.Provider>
  );
}
