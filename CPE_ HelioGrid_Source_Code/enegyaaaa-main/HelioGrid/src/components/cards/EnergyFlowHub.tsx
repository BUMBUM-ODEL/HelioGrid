import { useEffect } from 'react';
import { Activity, Workflow } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useEnergySystem } from '../../contexts/EnergySystemContext';

type AnomalyLevel = 'none' | 'warning' | 'critical';

// ═══════════════════════════════════════════════════════════
// ICONS
// ═══════════════════════════════════════════════════════════
function SolarIcon({ active, size = 48 }: { active: boolean; size?: number }) {
  const c = active ? '#f59e0b' : '#d1d5db';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      {active && [0,45,90,135,180,225,270,315].map((a, i) => (
        <line key={i}
          x1={40 + Math.cos(a * Math.PI / 180) * 11} y1={13 + Math.sin(a * Math.PI / 180) * 11}
          x2={40 + Math.cos(a * Math.PI / 180) * 16} y2={13 + Math.sin(a * Math.PI / 180) * 16}
          stroke="#fbbf24" strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
      ))}
      <circle cx="40" cy="13" r="7" fill={active ? '#fde68a' : '#e5e7eb'}
        style={active ? { filter: 'drop-shadow(0 0 5px #fbbf24)' } : undefined} />
      <rect x="8" y="27" width="64" height="40" rx="3"
        fill={active ? '#fffbeb' : '#f9fafb'} stroke={c} strokeWidth="2" />
      {[0,1,2].map(col => [0,1].map(row => (
        <rect key={`${col}${row}`} x={11 + col * 20} y={30 + row * 17} width={17} height={14} rx="2"
          fill={active ? '#fef3c7' : '#f3f4f6'} stroke={c} strokeWidth="0.9" strokeOpacity="0.7" />
      )))}
      <line x1="22" y1="67" x2="17" y2="74" stroke={c} strokeWidth="2" strokeLinecap="round" />
      <line x1="58" y1="67" x2="63" y2="74" stroke={c} strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="74" x2="67" y2="74" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function InverterIcon({ active, size = 48 }: { active: boolean; size?: number }) {
  const c = active ? '#8b5cf6' : '#d1d5db';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <rect x="8" y="6" width="64" height="62" rx="5"
        fill={active ? '#f5f3ff' : '#f9fafb'} stroke={c} strokeWidth="2"
        style={active ? { filter: `drop-shadow(0 0 6px ${c}30)` } : undefined} />
      <rect x="13" y="11" width="38" height="22" rx="2"
        fill={active ? '#ede9fe' : '#f3f4f6'} stroke={c} strokeWidth="1" strokeOpacity="0.6" />
      {active && <polyline points="15,29 20,20 26,26 32,17 38,23 44,18 48,21"
        stroke="#8b5cf6" strokeWidth="1.8" fill="none" strokeLinecap="round" />}
      <circle cx="60" cy="15" r="5" fill={active ? '#10b981' : '#e5e7eb'}
        style={active ? { filter: 'drop-shadow(0 0 3px #10b981)' } : undefined} />
      <circle cx="60" cy="28" r="5" fill={active ? '#8b5cf6' : '#e5e7eb'}>
        {active && <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />}
      </circle>
      <text x="22" y="73" fill={active ? '#f59e0b' : '#9ca3af'} fontSize="9" fontFamily="monospace" fontWeight="900">DC</text>
      <text x="34" y="73" fill="#9ca3af" fontSize="9" fontFamily="monospace">→</text>
      <text x="44" y="73" fill={active ? c : '#9ca3af'} fontSize="9" fontFamily="monospace" fontWeight="900">AC</text>
    </svg>
  );
}

function BatteryIcon({
  active, soc, charging, discharging, full, size = 48,
}: {
  active: boolean; soc: number; charging: boolean; discharging: boolean; full: boolean; size?: number;
}) {
  const fillColor = soc > 50 ? '#10b981' : soc > 20 ? '#f59e0b' : '#ef4444';
  const c = active ? fillColor : '#d1d5db';
  const fillW = Math.round(52 * (soc / 100));
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <rect x="5" y="20" width="62" height="40" rx="4"
        fill={active ? '#f0fdf4' : '#f9fafb'} stroke={c} strokeWidth="2"
        style={active ? { filter: `drop-shadow(0 0 5px ${fillColor}30)` } : undefined} />
      <rect x="67" y="30" width="8" height="20" rx="2" fill={active ? c : '#e5e7eb'} />
      <rect x="8" y="23" width={fillW} height="34" rx="2" fill={active ? fillColor : '#e5e7eb'} />
      {[1,2].map(i => (
        <line key={i} x1={8 + i * 18} y1="23" x2={8 + i * 18} y2="57" stroke="white" strokeWidth="1.5" />
      ))}
      <text x="36" y="43" textAnchor="middle" fill={active ? 'white' : '#9ca3af'}
        fontSize="12" fontFamily="monospace" fontWeight="900">{soc}%</text>
      {full     && active && <text x="36" y="55" textAnchor="middle" fill="#10b981" fontSize="8" fontFamily="monospace">✦FULL</text>}
      {charging && active && !full && <text x="36" y="55" textAnchor="middle" fill="white" fontSize="8" fontFamily="monospace">⚡CHG</text>}
      {discharging && active && <text x="36" y="55" textAnchor="middle" fill="#fbbf24" fontSize="8" fontFamily="monospace">DSCH</text>}
    </svg>
  );
}

function GridIcon({ active, size = 48 }: { active: boolean; size?: number }) {
  const c = active ? '#3b82f6' : '#d1d5db';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      {active && <polygon points="43,2 36,14 41,14 33,26 44,12 39,12"
        fill="#3b82f6" style={{ filter: 'drop-shadow(0 0 4px #3b82f6)' }} />}
      <line x1="40" y1="4" x2="40" y2="72" stroke={c} strokeWidth="2.5" />
      <line x1="12" y1="18" x2="68" y2="18" stroke={c} strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="32" x2="64" y2="32" stroke={c} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="22" y1="46" x2="58" y2="46" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="40" y1="18" x2="12" y2="50" stroke={c} strokeWidth="1" strokeOpacity="0.5" />
      <line x1="40" y1="18" x2="68" y2="50" stroke={c} strokeWidth="1" strokeOpacity="0.5" />
      <line x1="40" y1="72" x2="28" y2="76" stroke={c} strokeWidth="2" strokeLinecap="round" />
      <line x1="40" y1="72" x2="52" y2="76" stroke={c} strokeWidth="2" strokeLinecap="round" />
      {[[12,18],[68,18],[16,32],[64,32]].map(([x,y], i) => (
        <circle key={i} cx={x} cy={y} r="3" fill={active ? c : '#e5e7eb'}
          style={active ? { filter: `drop-shadow(0 0 3px ${c})` } : undefined} />
      ))}
    </svg>
  );
}

function LoadIcon({ active, size = 48 }: { active: boolean; size?: number }) {
  const c = active ? '#0ea5e9' : '#d1d5db';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <rect x="10" y="14" width="60" height="52" rx="8"
        fill={active ? '#f0f9ff' : '#f9fafb'} stroke={c} strokeWidth="2"
        style={active ? { filter: `drop-shadow(0 0 6px ${c}40)` } : undefined} />
      <rect x="25" y="28" width="8" height="14" rx="2"
        fill={active ? '#bae6fd' : '#e5e7eb'} stroke={c} strokeWidth="1.2" />
      <rect x="47" y="28" width="8" height="14" rx="2"
        fill={active ? '#bae6fd' : '#e5e7eb'} stroke={c} strokeWidth="1.2" />
      <circle cx="40" cy="53" r="5"
        fill={active ? '#bae6fd' : '#e5e7eb'} stroke={c} strokeWidth="1.2" />
      {active && (
        <circle cx="40" cy="15" r="3" fill="#0ea5e9"
          style={{ filter: 'drop-shadow(0 0 4px #0ea5e9)' }}>
          <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// FLOW LINE
// ═══════════════════════════════════════════════════════════
function FlowLine({
  pathId, x1, y1, x2, y2, color, colorDot, active, speed = 1.6, delay = 0, thickness = 2.5, label,
}: {
  pathId: string;
  x1: number; y1: number; x2: number; y2: number;
  color: string; colorDot?: string;
  active: boolean; speed?: number; delay?: number; thickness?: number;
  label?: string;
}) {
  const cd  = colorDot ?? color;
  const len  = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
  const beam = len * 0.22;
  const mx   = (x1+x2)/2;
  const my   = (y1+y2)/2;

  if (!active) return (
    <line x1={x1} y1={y1} x2={x2} y2={y2}
      stroke="#cbd5e1" strokeWidth={thickness} strokeLinecap="round"
      strokeDasharray="5 5" strokeOpacity="0.6" />
  );

  return (
    <g>
      <defs><path id={pathId} d={`M${x1},${y1} L${x2},${y2}`} /></defs>
      {/* Glow layers */}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={thickness*6}  strokeOpacity="0.04" strokeLinecap="round" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={thickness*3}  strokeOpacity="0.08" strokeLinecap="round" />
      {/* Solid base line — always visible, no gaps */}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={thickness*0.5} strokeOpacity="0.35" strokeLinecap="round" />
      {/* Animated beam on top */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={cd} strokeWidth={thickness*1.5} strokeLinecap="round"
        strokeDasharray={`${beam} ${len}`}
        style={{ filter: `drop-shadow(0 0 5px ${color}) drop-shadow(0 0 12px ${color}90)` }}>
        <animate attributeName="stroke-dashoffset"
          from={len+beam} to={-(len+beam)}
          dur={`${speed}s`} begin={`${delay}s`} repeatCount="indefinite" />
      </line>
      <circle r={thickness*2.2} fill={cd}
        style={{ filter: `drop-shadow(0 0 8px ${color}) drop-shadow(0 0 16px ${color})` }}>
        <animateMotion dur={`${speed}s`} begin={`${delay}s`} repeatCount="indefinite">
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </circle>
      {label && (
        <text x={mx} y={my - 8} textAnchor="middle" fontSize="8"
          fontFamily="monospace" fontWeight="700" fill={cd} opacity="0.9"
          style={{ filter: `drop-shadow(0 0 3px ${color})` }}>
          {label}
        </text>
      )}
    </g>
  );
}

// ── Manila harvest time helper ───────────────────────────────────────────────
const getManilaHour = (): number => {
  const manila = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  return manila.getHours();
};
const isSolarHarvestTime = (): boolean => { const h = getManilaHour(); return h >= 6 && h < 18; };

// ── Solar node label ─────────────────────────────────────────────────────────
function getSolarLabel(solV: number, isHarvest: boolean): string {
  if (!isHarvest) return 'NIGHT';
  if (solV >= 30)  return 'ACTIVE';
  return 'NO OUTPUT';
}

// ═══════════════════════════════════════════════════════════
// VOLTAGE → SOC LOOKUP — RESTING open-circuit voltage only
// Calibrated to JSL II VRLA Gel 24V (2S × 12V 100Ah)
// DO NOT use while solar/inverter is actively charging the pack.
// Charging voltage (≥27.0V) is NOT a valid SOC reference.
// ═══════════════════════════════════════════════════════════
const SOC_TABLE = [
  { v: 25.60, s: 100 }, { v: 25.40, s: 98  },
  { v: 25.20, s: 95  }, { v: 25.00, s: 90  },
  { v: 24.80, s: 84  }, { v: 24.60, s: 78  },
  { v: 24.50, s: 72  }, { v: 24.30, s: 62  },
  { v: 24.10, s: 50  }, { v: 24.00, s: 43  },
  { v: 23.80, s: 33  }, { v: 23.60, s: 23  },
  { v: 23.40, s: 14  }, { v: 23.20, s: 7   },
  { v: 23.00, s: 2   }, { v: 22.50, s: 0   },
];

const CHARGING_V_THRESHOLD = 27.0; // V — above this = charging, not a resting SOC reference

function voltToSoc(v: number): number {
  if (v <= 0) return 0;
  if (v >= SOC_TABLE[0].v) return 100;
  if (v <= SOC_TABLE[SOC_TABLE.length - 1].v) return 0;
  for (let i = 0; i < SOC_TABLE.length - 1; i++) {
    const hi = SOC_TABLE[i], lo = SOC_TABLE[i + 1];
    if (v <= hi.v && v >= lo.v) {
      return lo.s + ((v - lo.v) / (hi.v - lo.v)) * (hi.s - lo.s);
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export function EnergyFlowHub() {
  const {
    contactorClosed, controlMode, systemCondition,
    gridVoltage, gridFrequency, gridPower, gridCurrent,
    inverterPower, inverterCurrent, inverterVoltage, inverterFrequency,
    solarPower, solarVoltage,
    batteryVoltage, batteryCurrent, batteryFull,
    solarAnomaly, gridAnomaly, gridVoltageAnomaly, inverterVoltageAnomaly,
    dcBatteryAnomaly, dcSolarAnomaly,
  } = useEnergySystem();

  useEffect(() => {
    const t = setInterval(() => {}, 1000);
    return () => clearInterval(t);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // FLOW LOGIC — voltage & current only, no SSR dependency
  // ════════════════════════════════════════════════════════════════════════

  const solV  = solarVoltage  ?? 0;
  const batV  = batteryVoltage ?? 0;
  const gridV = gridVoltage   ?? 0;
  const invV  = inverterVoltage ?? 0;
  const invI  = inverterCurrent ?? 0;
  const gridI = gridCurrent   ?? 0;
  const batI  = batteryCurrent ?? 0;

  const isHarvest = isSolarHarvestTime();

  // ── Battery SOC from voltage (matches BatteryHealthCard) ─────────────
  const isChargingHub = (solarPower ?? 0) > 5 && batV >= CHARGING_V_THRESHOLD;
  // While charging, clamp displayed SOC to last-known resting value rather than
  // mapping the inflated charging voltage (27+ V) → a false 100%.
  const batSocRaw   = isChargingHub ? Math.min(voltToSoc(25.6), voltToSoc(Math.min(batV, 25.6))) : voltToSoc(batV);
  const batSoc      = Math.min(100, Math.max(0, Math.round(batSocRaw * 10) / 10));
  const batSocInt   = Math.round(batSoc);
  const batFullGlow = !isChargingHub && batV >= 25.4;  // resting full threshold (≥25.4V OCV)
  const batCritical = batV > 0 && batV < 22.5;

  // ── Solar ─────────────────────────────────────────────────────────────
  const solarActive   = solV >= 30;
  const solarCharging = solarActive;   // any solar ≥30V can charge battery
  const solarNodeActive = solarActive;

  // Solar label for display
  const solarLabel = getSolarLabel(solV, isHarvest);

  // ── Grid charging detection ───────────────────────────────────────────
  // Grid charges when: grid has AC voltage + battery needs charge (≤23.5V) + no solar
  const gridHasVoltage = gridV >= 200 && gridV <= 260;
  const batNeedsCharge = batV > 0 && batV <= 23.5;
  const gridCharging   = gridHasVoltage && batNeedsCharge && !solarCharging;

  // ── Flow: Solar → Inverter ────────────────────────────────────────────
  // ON: solar ≥30V + inverter has voltage
  const flowSolarToInv = solarActive && invV > 10;

  // ── Flow: Inverter → Battery ──────────────────────────────────────────
  // ON: (solar ≥30V OR grid charging) + not full yet (voltage-based, matches BHC)
  const flowInvToBat = !batCritical && (solarCharging || gridCharging) && !batFullGlow;

  // ── Flow: Battery → Inverter ──────────────────────────────────────────
  // ON: solar < 30V + NOT grid charging + batSocInt > 5% + inverter has voltage
  const flowBatToInv = !batCritical && solV < 30 && !gridCharging && batSocInt > 5 && invV > 10;

  // ── Flow: Grid → Inverter ─────────────────────────────────────────────
  // ON: grid charging condition (see above)
  const flowGridToInv = gridCharging;

  // ── Flow: Inverter → Load ─────────────────────────────────────────────
  // ON: inverter has current (PZEM data, > 0.05A)
  const invHasCurrent  = invI > 0.05;
  const flowInvToLoad  = invV > 10 && invHasCurrent;

  // ── Flow: Grid → Load (bypass) ────────────────────────────────────────
  // ON: grid has current (> 0.05A) — direct bypass
  const gridHasCurrent = gridI > 0.05;
  const flowGridToLoad = gridHasVoltage && gridHasCurrent && !gridCharging;

  // ── Derived node states ───────────────────────────────────────────────
  const inverterActive = invV > 10;
  const loadActive     = flowInvToLoad || flowGridToLoad;
  const gridHasReading = gridV > 10;
  const gridVoltageOK  = !gridHasReading || (gridV >= 200 && gridV <= 245);

  // ── Power display ─────────────────────────────────────────────────────
  const gridPowerCalc = (gridPower && gridPower > 0) ? gridPower : (gridV * gridI);
  const gridLoadW = flowGridToLoad ? gridPowerCalc : 0;
  const invLoadW  = flowInvToLoad  ? (inverterPower ?? 0) : 0;

  // ── Animation speeds (faster = more watts) ────────────────────────────
  const spd = (w: number, max: number) => Math.max(0.5, 2.5 - (w / max) * 1.5);
  const speedSolar   = spd(solarPower ?? 0, 2360);
  const speedInvLoad = spd(inverterPower ?? 0, 3000);
  const speedGrid    = spd(gridPower ?? 0, 2500);
  const speedBatChg  = spd(Math.abs(batI) * batV, 1500);

  // ── Mode / condition display ──────────────────────────────────────────
  const modeLabel =
    controlMode === 'solar'    ? 'Solar Priority' :
    controlMode === 'grid'     ? 'Grid Fallback'  :
    controlMode === 'shutdown' ? 'Shutdown'        : 'Auto';

  const modeColor =
    controlMode === 'solar'    ? '#d97706' :
    controlMode === 'grid'     ? '#2563eb' :
    controlMode === 'shutdown' ? '#dc2626' : '#16a34a';

  const condBg =
    systemCondition?.includes('Load Cut Off') || systemCondition?.includes('Shutdown') || systemCondition?.includes('Critical')
    ? 'bg-red-50 border-red-200 text-red-700'
    : systemCondition?.includes('Warning') || systemCondition?.includes('Grid')
    ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
    : 'bg-green-50 border-green-200 text-green-700';

  const condDot =
    systemCondition?.includes('Load Cut Off') || systemCondition?.includes('Shutdown') || systemCondition?.includes('Critical')
    ? 'bg-red-500'
    : systemCondition?.includes('Warning') || systemCondition?.includes('Grid')
    ? 'bg-yellow-500'
    : 'bg-green-500';

  // ── Battery badge text ────────────────────────────────────────────────
  const batBadge =
    batCritical    ? '⚠ CRITICAL' :
    batFullGlow    ? 'FULL' :
    gridCharging   ? '⚡ CHG GRID' :
    flowInvToBat   ? '☀ CHG SOLAR' :
    flowBatToInv   ? 'DISCHARGING' : 'STANDBY';

  // ── Solar badge colors ────────────────────────────────────────────────
  const solarBadgeBg    = solarActive ? '#fefce8' : '#f1f5f9';
  const solarBadgeText  = solarActive ? '#92400e' : '#64748b';
  const solarBadgeBdr   = solarActive ? '#fde047' : '#cbd5e1';

  // ── Contactor state for legacy SHUTDOWN badge ─────────────────────────
  const systemShutdown = controlMode === 'shutdown' || !contactorClosed;

  // ── Layout ────────────────────────────────────────────────────────────
  const W = 780, H = 420, CX = 390;
  const solar    = { x: CX,       y: 40  };
  const inverter = { x: CX,       y: 180 };
  const battery  = { x: CX - 250, y: 210 };
  const grid     = { x: CX + 250, y: 210 };
  const load     = { x: CX,       y: 330 };

  const VAL_SIZE  = '24px';
  const UNIT_SIZE = '16px';
  const LBL_SIZE  = '10px';

  const nodeStyle = (active: boolean, bg: string, border: string): React.CSSProperties => ({
    width: '80px', height: '80px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: active ? bg : 'white',
    border: `1.5px solid ${active ? border : '#e2e8f0'}`,
    borderRadius: '12px',
    boxShadow: active ? `0 2px 10px ${border}60` : '0 1px 4px rgba(0,0,0,0.06)',
    transition: 'all 0.5s ease',
  });

  const labelStyle = (active: boolean, color: string): React.CSSProperties => ({
    fontSize: '8px', fontFamily: "'JetBrains Mono',monospace",
    fontWeight: '700', letterSpacing: '0.1em', textTransform: 'uppercase' as const,
    color: active ? color : '#94a3b8',
  });

  const badgeStyle = (active: boolean, bg: string, text: string, border: string): React.CSSProperties => ({
    fontSize: '7px', fontWeight: '700', fontFamily: "'JetBrains Mono',monospace",
    padding: '2px 7px', borderRadius: '10px', lineHeight: '14px',
    display: 'inline-block', whiteSpace: 'nowrap',
    background: active ? bg : '#f3f4f6',
    color: active ? text : '#6b7280',
    border: `1px solid ${active ? border : '#e5e7eb'}`,
    boxSizing: 'border-box' as const,
  });

  return (
    <Card className="border-slate-200 shadow-lg bg-white">
      {/* HEADER */}
      <CardHeader className="py-2 px-4">
        <CardTitle className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div style={{
              width: '40px', height: '40px', borderRadius: '8px', background: '#f0fdf4',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Workflow size={20} color="#16a34a" strokeWidth={2} />
            </div>
            <span className="text-lg font-medium text-slate-800 truncate">Energy Flow Hub</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className={`hidden sm:flex items-center gap-2 px-4 py-1 rounded-full text-xs font-medium border ${condBg}`}
              style={{ lineHeight: '1.5', whiteSpace: 'nowrap', minWidth: '110px', justifyContent: 'center' }}>
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0 ${condDot}`} />
              {systemCondition}
            </div>
            <div className="hidden sm:flex items-center gap-2 px-4 py-1 rounded-full text-xs font-medium bg-slate-100 border border-slate-200"
              style={{ lineHeight: '1.5', whiteSpace: 'nowrap', minWidth: '120px', justifyContent: 'center' }}>
              <Activity size={11} color="#64748b" strokeWidth={2} className="flex-shrink-0" />
              <span style={{ color: modeColor }}>{modeLabel}</span>
            </div>
            <div className={`flex sm:hidden items-center gap-1.5 px-2 py-1 rounded-full text-[0.6rem] font-medium border ${condBg}`}>
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0 ${condDot}`} />
              <span style={{ color: 'inherit' }}>{modeLabel}</span>
            </div>
          </div>
        </CardTitle>
      </CardHeader>

      {/* CANVAS */}
      <CardContent className="p-0">
        <div className="relative rounded-b-xl overflow-x-auto bg-white">
          <style>{`
            @keyframes hubBatFull {
              0%,100% { box-shadow: 0 0 8px #10b981, 0 0 18px #10b98150; border-color: #10b981; }
              50%      { box-shadow: 0 0 16px #10b981, 0 0 30px #10b98180; border-color: #34d399; }
            }
          `}</style>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`}
            style={{ display: 'block', overflow: 'visible' }}>

            {/* ── FLOW LINES ── */}

            {/* Solar → Inverter: amber, on when solar ≥30V + inverter has voltage */}
            <FlowLine pathId="si" x1={solar.x} y1={solar.y+40} x2={inverter.x} y2={inverter.y-40}
              color="#f59e0b" active={flowSolarToInv} speed={speedSolar} />

            {/* Inverter → Battery: green (solar chg) or cyan (grid chg) */}
            <FlowLine pathId="ib" x1={inverter.x-40} y1={inverter.y} x2={battery.x+40} y2={battery.y}
              color={gridCharging ? '#06b6d4' : '#10b981'}
              active={flowInvToBat} speed={speedBatChg} label={gridCharging ? 'GRID CHG' : 'CHG'} />

            {/* Battery → Inverter: blue, stops when grid charging */}
            <FlowLine pathId="bi" x1={battery.x+40} y1={battery.y} x2={inverter.x-40} y2={inverter.y}
              color="#60a5fa" active={flowBatToInv} speed={speedBatChg} delay={0.3} />

            {/* Inverter → Load: violet, on when inverter current > 0.05A */}
            <FlowLine pathId="il" x1={inverter.x} y1={inverter.y+40} x2={load.x} y2={load.y-40}
              color="#8b5cf6" active={flowInvToLoad} speed={speedInvLoad} delay={0.1} />

            {/* Grid → Load BYPASS: blue */}
            <FlowLine pathId="gl" x1={grid.x} y1={grid.y+40} x2={load.x+40} y2={load.y}
              color="#3b82f6" active={flowGridToLoad} speed={speedGrid} delay={0.1} label="BYPASS" />

            {/* Grid → Inverter: cyan, grid charging battery */}
            <FlowLine pathId="gi" x1={grid.x-40} y1={grid.y} x2={inverter.x+40} y2={inverter.y}
              color="#06b6d4" active={flowGridToInv} speed={speedGrid} delay={0.2} label="CHG" />

            {/* ── SOLAR ── */}
            <foreignObject x={solar.x-40} y={solar.y-40} width={80} height={120} overflow="visible">
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', overflow:'visible' }}>
                <div style={nodeStyle(solarNodeActive, '#fffbeb', '#fde68a')}>
                  <SolarIcon active={solarNodeActive} size={48} />
                </div>
                <span style={labelStyle(solarNodeActive, '#f59e0b')}>Solar</span>
                <div style={badgeStyle(solarActive, solarBadgeBg, solarBadgeText, solarBadgeBdr)}>
                  {solarLabel}
                </div>
              </div>
            </foreignObject>
            {/* Solar data — LEFT side */}
            <foreignObject x={solar.x-40-150} y={solar.y-28} width={148} height={100}>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Solar</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px', justifyContent:'flex-end' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: solarActive ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {solV.toFixed(1)}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#f59e0b' }}>V</span>
                </div>
              {dcSolarAnomaly && dcSolarAnomaly !== 'none' && (
                <div style={{ fontSize:'8px', fontFamily:'monospace', fontWeight:'700', marginTop:'2px', textAlign:'right',
                  color: dcSolarAnomaly === 'critical' ? '#ef4444' : '#f59e0b' }}>
                  ⚠ Solar: {dcSolarAnomaly === 'critical' ? 'Critical' : 'Warning'}
                </div>
              )}
              </div>
            </foreignObject>

            {/* ── BATTERY ── */}
            <foreignObject x={battery.x-40} y={battery.y-40} width={80} height={130} overflow="visible">
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', overflow:'visible', position:'relative' }}>
                <div style={{
                  ...nodeStyle(flowInvToBat || flowBatToInv || batFullGlow, '#f0fdf4', '#bbf7d0'),
                  ...(batFullGlow ? { animation: 'hubBatFull 2s ease-in-out infinite' } : {}),
                  ...(batCritical ? { borderColor: '#fca5a5', background: '#fff1f2' } : {}),
                }}>
                  <BatteryIcon
                    active={flowInvToBat || flowBatToInv || batFullGlow || batV > 0}
                    soc={batSocInt}
                    charging={flowInvToBat}
                    discharging={flowBatToInv}
                    full={batFullGlow}
                    size={48} />
                </div>
                <span style={labelStyle(flowInvToBat || flowBatToInv || batFullGlow, batCritical ? '#ef4444' : '#10b981')}>Battery</span>
                <div style={badgeStyle(
                  batCritical || batFullGlow || flowInvToBat || flowBatToInv,
                  batCritical  ? '#fee2e2' :
                  batFullGlow  ? '#dcfce7' :
                  flowInvToBat ? '#dcfce7' :
                  flowBatToInv ? '#fef9c3' : '#f3f4f6',
                  batCritical  ? '#b91c1c' :
                  batFullGlow  ? '#15803d' :
                  flowInvToBat ? '#15803d' :
                  flowBatToInv ? '#a16207' : '#6b7280',
                  batCritical  ? '#fca5a5' :
                  batFullGlow  ? '#86efac' :
                  flowInvToBat ? '#86efac' :
                  flowBatToInv ? '#fde047' : '#e5e7eb',
                )}>
                  {batBadge}
                </div>
              </div>
            </foreignObject>
            {/* Battery data — left side */}
            <foreignObject x={battery.x-40-130} y={battery.y-24} width={122} height={100}>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Battery · 24V 100Ah</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px', justifyContent:'flex-end' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: batV > 0 ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {batV.toFixed(1)}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#10b981' }}>V</span>
                </div>
                <div style={{ fontSize:'9px', color:'#94a3b8', fontFamily:'monospace', marginTop:'2px' }}>{batFullGlow ? '100' : batSoc.toFixed(1)}% SOC</div>
                <div style={{ fontSize:'9px', fontFamily:'monospace', marginTop:'2px',
                  color: batI > 0.05 ? '#10b981' : batI < -0.05 ? '#60a5fa' : '#94a3b8' }}>
                  {batI > 0.05
                    ? `+${batI.toFixed(2)}A ↓`
                    : batI < -0.05
                    ? `${batI.toFixed(2)}A ↑`
                    : '0.00A'}
                </div>
                {dcBatteryAnomaly && dcBatteryAnomaly !== 'none' && (
                  <div style={{ fontSize:'8px', fontFamily:'monospace', fontWeight:'700', marginTop:'2px', textAlign:'right',
                    color: dcBatteryAnomaly === 'critical' ? '#ef4444' : '#f59e0b' }}>
                    ⚠ Battery: {dcBatteryAnomaly === 'critical' ? 'Critical' : 'Warning'}
                  </div>
                )}
              </div>
            </foreignObject>

            {/* ── INVERTER ── */}
            <foreignObject x={inverter.x-40} y={inverter.y-40} width={80} height={120} overflow="visible">
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', overflow:'visible' }}>
                <div style={nodeStyle(inverterActive, '#f5f3ff', '#ddd6fe')}>
                  <InverterIcon active={inverterActive} size={48} />
                </div>
                <span style={labelStyle(inverterActive, '#8b5cf6')}>Inverter</span>
                <div style={badgeStyle(inverterActive, '#ede9fe', '#6d28d9', '#c4b5fd')}>
                  {flowGridToLoad ? 'BYPASSED' : invV > 10 ? 'ON' : systemShutdown ? 'SHUTDOWN' : 'OFF'}
                </div>
              </div>
            </foreignObject>
            {/* Inverter data panel — RIGHT side */}
            <foreignObject x={inverter.x+46} y={inverter.y-36} width={165} height={95}>
              <div>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Inverter</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: inverterActive ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {(inverterVoltage ?? 0).toFixed(0)}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#8b5cf6' }}>V</span>
                </div>
                <div style={{ fontSize:'9px', color:'#94a3b8', fontFamily:'monospace', marginTop:'2px' }}>
                  {(inverterFrequency ?? 0).toFixed(1)} Hz
                </div>
                {inverterVoltageAnomaly && inverterVoltageAnomaly.severity !== 'none' && (
                  <div style={{ fontSize:'8px', fontFamily:'monospace', fontWeight:'700', marginTop:'2px',
                    color: inverterVoltageAnomaly.severity === 'critical' ? '#ef4444' : '#f59e0b', lineHeight:'1.5' }}>
                    <div>⚠ Inverter: {inverterVoltageAnomaly.label}</div>
                    <div style={{ paddingLeft:'10px' }}>· {inverterVoltageAnomaly.severity === 'critical' ? 'Critical' : 'Warning'}</div>
                  </div>
                )}
              </div>
            </foreignObject>

            {/* ── GRID ── */}
            <foreignObject x={grid.x-40} y={grid.y-40} width={80} height={120} overflow="visible">
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', overflow:'visible' }}>
                <div style={nodeStyle(gridHasVoltage && gridVoltageOK, '#eff6ff', '#bfdbfe')}>
                  <GridIcon active={gridHasVoltage && gridVoltageOK} size={48} />
                </div>
                <span style={labelStyle(gridHasVoltage && gridVoltageOK, '#3b82f6')}>Grid AC</span>
                <div style={badgeStyle(gridHasVoltage && gridVoltageOK, '#dbeafe', '#1d4ed8', '#93c5fd')}>
                  {flowGridToLoad ? 'BYPASS ON' : gridCharging ? 'CHG MODE' : gridHasVoltage ? 'STANDBY' : 'NO GRID'}
                </div>
              </div>
            </foreignObject>
            {/* Grid data — LEFT side */}
            <foreignObject x={grid.x+46} y={grid.y-28} width={160} height={100}>
              <div>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Grid</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: gridHasReading ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {(gridVoltage ?? 0).toFixed(0)}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#3b82f6' }}>V</span>
                </div>
                <div style={{ fontSize:'9px', color:'#94a3b8', fontFamily:'monospace', marginTop:'2px' }}>
                  {(gridFrequency ?? 0).toFixed(1)}Hz
                </div>
                {gridVoltageAnomaly && gridVoltageAnomaly.severity !== 'none' && (
                  <div style={{ fontSize:'8px', fontFamily:'monospace', fontWeight:'700', marginTop:'2px',
                    color: gridVoltageAnomaly.severity === 'critical' ? '#ef4444' : '#f59e0b', lineHeight:'1.5' }}>
                    <div>⚠ Grid: {gridVoltageAnomaly.label}</div>
                    <div style={{ paddingLeft:'10px' }}>· {gridVoltageAnomaly.severity === 'critical' ? 'Critical' : 'Warning'}</div>
                  </div>
                )}
              </div>
            </foreignObject>

            {/* ── LOAD ── */}
            <foreignObject x={load.x-40} y={load.y-40} width={80} height={120} overflow="visible">
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', overflow:'visible' }}>
                <div style={nodeStyle(loadActive, '#f0f9ff', loadActive ? '#bae6fd' : '#e2e8f0')}>
                  <LoadIcon active={loadActive} size={48} />
                </div>
                <span style={labelStyle(loadActive, '#0ea5e9')}>Load</span>
                <div style={badgeStyle(loadActive,
                  systemShutdown ? '#fee2e2' : '#e0f2fe',
                  systemShutdown ? '#b91c1c' : '#0369a1',
                  systemShutdown ? '#fca5a5' : '#7dd3fc')}>
                  {systemShutdown ? 'SHUTDOWN' : flowGridToLoad ? 'via BYPASS' : flowInvToLoad ? 'via INVERTER' : 'OFFLINE'}
                </div>
              </div>
            </foreignObject>
            {/* Load data — RIGHT side: grid bypass power (cyan) */}
            <foreignObject x={load.x+46} y={load.y-24} width={140} height={80}>
              <div>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Grid Load</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: flowGridToLoad ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {flowGridToLoad ? gridLoadW.toFixed(0) : '0'}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#0ea5e9' }}>W</span>
                </div>
                {flowGridToLoad && (
                  <div style={{ fontSize:'9px', color:'#0ea5e9', fontFamily:'monospace', marginTop:'2px' }}>via BYPASS (K2)</div>
                )}
              </div>
            </foreignObject>
            {/* Load data — LEFT side: inverter power (violet) */}
            <foreignObject x={load.x-40-130} y={load.y-24} width={122} height={80}>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:LBL_SIZE, color:'#94a3b8', letterSpacing:'0.08em', textTransform:'uppercase', fontFamily:'monospace', marginBottom:'2px' }}>Inverter Load</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:'3px', justifyContent:'flex-end' }}>
                  <span style={{ fontSize:VAL_SIZE, fontWeight:'400', color: flowInvToLoad ? '#0f172a' : '#cbd5e1', lineHeight:1 }}>
                    {flowInvToLoad ? invLoadW.toFixed(0) : '0'}
                  </span>
                  <span style={{ fontSize:UNIT_SIZE, fontWeight:'500', color:'#7c3aed' }}>W</span>
                </div>
                {flowInvToLoad && (
                  <div style={{ fontSize:'9px', color:'#7c3aed', fontFamily:'monospace', marginTop:'2px' }}>via INVERTER (K1)</div>
                )}
              </div>
            </foreignObject>

          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
