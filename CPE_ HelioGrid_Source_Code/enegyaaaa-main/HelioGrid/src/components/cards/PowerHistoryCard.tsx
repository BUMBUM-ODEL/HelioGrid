// PowerHistoryCard.tsx — v7.4
// 4 exports: PowerHistoryCard, CumulativeConsumptionCard, AnomalyHistoryCard, DCVoltageAnomalyCard
//
// AnomalyHistoryCard   — "High Voltage Anomaly Detection" — Chart.js + annotation plugin
//                        stat boxes, event pills, Stable/Warning/Critical badge
// DCVoltageAnomalyCard — "Low Voltage Anomaly Detection"  — 2 Recharts sub-charts
//                        Battery Pack DC + Solar PV DC with reference lines

import React, { useMemo } from 'react';
import { TrendingUp, BarChart2, AlertTriangle, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Title, Tooltip as CJSTooltip, Legend as CJSLegend,
} from 'chart.js';
import { Line as CJSLine } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';
import { useEnergySystem } from '../../contexts/EnergySystemContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Title, CJSTooltip, CJSLegend, annotationPlugin);

// ─── Thresholds (aligned with anomaly_engine.py) ──────────────────────────────
const G_WARN_LO = Math.round(0.91 * 230);  // 209V
const G_WARN_HI = Math.round(1.10 * 230);  // 253V
const G_CRIT_LO = Math.round(0.80 * 230);  // 184V
const G_CRIT_HI = Math.round(1.15 * 230);  // 265V
const BAT_FULL  = 25.4;
const BAT_WARN  = 23.0;
const BAT_CRIT  = 21.6;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtLabel(ts: string): string {
  try {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  } catch { return ts; }
}
function clsGrid(v: number): string {
  if (v <= 0) return 'none';
  if (v < G_CRIT_LO || v > G_CRIT_HI) return 'critical';
  if (v < G_WARN_LO || v > G_WARN_HI) return 'warning';
  return 'none';
}
function clsInv(v: number): string {
  if (v <= 0) return 'none';
  if (v < 180 || v > 270) return 'critical';
  if (v < G_WARN_LO || v > G_WARN_HI) return 'warning';
  return 'none';
}
function dotClr(cls: string): string {
  return cls === 'critical' ? '#ef4444' : cls === 'warning' ? '#eab308' : '#22c55e';
}
function anomType(v: number): string {
  if (v <= 0) return 'Dropout';
  if (v < G_CRIT_LO) return 'Dropout';
  if (v > G_CRIT_HI) return 'Spike High';
  if (v < G_WARN_LO) return 'Drift Low';
  if (v > G_WARN_HI) return 'Drift High';
  return 'Normal';
}
function deltaLbl(v: number): string | null {
  if (v <= 0) return `-${G_WARN_LO}V dropout`;
  if (v < G_WARN_LO) return `-${(G_WARN_LO - v).toFixed(0)}V below`;
  if (v > G_WARN_HI) return `+${(v - G_WARN_HI).toFixed(0)}V above`;
  return null;
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const bg  = status === 'critical' ? '#fef2f2' : status === 'warning' ? '#fffbeb' : '#f0fdf4';
  const clr = status === 'critical' ? '#dc2626' : status === 'warning' ? '#d97706' : '#16a34a';
  const bdr = status === 'critical' ? '#fca5a5' : status === 'warning' ? '#fcd34d' : '#86efac';
  const lbl = status === 'critical' ? '● Critical' : status === 'warning' ? '● Warning' : '● Stable';
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: bg, color: clr, border: `1px solid ${bdr}`, whiteSpace: 'nowrap' }}>
      {lbl}
    </span>
  );
}

// ─── StatBox ──────────────────────────────────────────────────────────────────
function StatBox({ label, value, unit, anomaly = 'none', defBg = '#eff6ff', defBorder = '#bfdbfe', defColor = '#1d4ed8' }: {
  label: string; value: string; unit?: string; anomaly?: string;
  defBg?: string; defBorder?: string; defColor?: string;
}) {
  const bg  = anomaly === 'critical' ? '#fef2f2' : anomaly === 'warning' ? '#fffbeb' : defBg;
  const bdr = anomaly === 'critical' ? '#fca5a5' : anomaly === 'warning' ? '#fcd34d' : defBorder;
  const clr = anomaly === 'critical' ? '#dc2626' : anomaly === 'warning' ? '#d97706' : defColor;
  return (
    <div style={{ background: bg, border: `1px solid ${bdr}`, borderRadius: 8, padding: '8px 10px', textAlign: 'center', flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: clr, fontWeight: 500, marginBottom: 2 }}>{label}{anomaly !== 'none' ? ' ⚠' : ''}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: clr, lineHeight: 1 }}>
        {value}{unit && <span style={{ fontSize: 11, marginLeft: 2, fontWeight: 400 }}>{unit}</span>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. PowerHistoryCard — Voltage Trends + Current Trends (Grid + Inverter only)
// ══════════════════════════════════════════════════════════════════════════════

export function PowerHistoryCard() {
  const { sensorHistory, sensorHistoryLoading } = useEnergySystem();

  const data = useMemo(() => {
    if (!sensorHistory?.length) return [];
    return [...sensorHistory].reverse().map(r => ({
      time:  fmtLabel(r.timestamp),
      gridV: Number(r.grid_voltage     ?? 0) || null,
      invV:  Number(r.inverter_voltage ?? 0) || null,
      gridA: Number(r.grid_current     ?? 0) || null,
      invA:  Number(r.inverter_current ?? 0) || null,
    }));
  }, [sensorHistory]);

  const tick = Math.max(1, Math.floor((data.length || 1) / 8));
  const ph = 180;
  const ph2 = 180;

  return (
    <Card style={{ border: '1px solid #bfdbfe' }}>
      <CardHeader style={{ background: 'linear-gradient(135deg,#eff6ff,#e0f2fe)', borderBottom: '1px solid #bfdbfe', borderRadius: '12px 12px 0 0' }}>
        <CardTitle className="flex items-center gap-2" style={{ color: '#1d4ed8' }}>
          <TrendingUp className="w-5 h-5" style={{ color: '#2563eb' }} />
          Real-Time Monitoring
        </CardTitle>
        <p style={{ fontSize: 12, color: '#3b82f6', marginTop: 2 }}>
          Monitor solar power, grid, battery health · Voltage/Current Trends
        </p>
      </CardHeader>
      <CardContent>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>⬡ Voltage Trends (24 Hours)</div>
        {sensorHistoryLoading
          ? <div style={{ height: ph, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading history…</div>
          : !data.length
          ? <div style={{ height: ph, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No data available</div>
          : (
          <ResponsiveContainer width="100%" height={ph}>
            <LineChart data={data} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval={tick - 1} />
              <YAxis tick={{ fontSize: 10 }} unit="V" width={44} />
              <RechartTooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v: unknown, n: string) => [`${Number(v).toFixed(1)}V`, n]} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="gridV" name="Grid"     stroke="#3b82f6" dot={false} strokeWidth={1.5} connectNulls={false} />
              <Line type="monotone" dataKey="invV"  name="Inverter" stroke="#ec4899" dot={false} strokeWidth={1.5} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', margin: '16px 0 6px' }}>⬡ Current Trends (24 Hours)</div>
        {sensorHistoryLoading
          ? <div style={{ height: ph2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading history…</div>
          : !data.length
          ? <div style={{ height: ph2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No data available</div>
          : (
          <ResponsiveContainer width="100%" height={ph2}>
            <LineChart data={data} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval={tick - 1} />
              <YAxis tick={{ fontSize: 10 }} unit="A" width={40} />
              <RechartTooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v: unknown, n: string) => [`${Number(v).toFixed(2)}A`, n]} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="gridA" name="Grid"     stroke="#3b82f6" dot={false} strokeWidth={1.5} connectNulls={false} />
              <Line type="monotone" dataKey="invA"  name="Inverter" stroke="#ec4899" dot={false} strokeWidth={1.5} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, textAlign: 'right' }}>
          ⊟ PZEM-004T + INA219 × 1 · Voltage Divider (DC)
        </div>
      </CardContent>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. CumulativeConsumptionCard
// ══════════════════════════════════════════════════════════════════════════════

export function CumulativeConsumptionCard() {
  const { sensorHistory, sensorHistoryLoading } = useEnergySystem();

  const data = useMemo(() => {
    if (!sensorHistory?.length) return [];
    const sorted = [...sensorHistory].reverse();
    let cg = 0, ci = 0;
    return sorted.map((r, i) => {
      const dtH = i === 0 ? 1 / 60 : (() => {
        try {
          const dt = Math.abs(new Date(r.timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()) / 3_600_000;
          return dt < 2 ? dt : 1 / 60;
        } catch { return 1 / 60; }
      })();
      cg += Number(r.grid_power ?? 0) * dtH / 1000;
      ci += Number(r.inverter_power ?? 0) * dtH / 1000;
      return { time: fmtLabel(r.timestamp), cumGrid: parseFloat(cg.toFixed(3)), cumInv: parseFloat(ci.toFixed(3)) };
    });
  }, [sensorHistory]);

  const tick = Math.max(1, Math.floor((data.length || 1) / 8));

  return (
    <Card style={{ border: '1px solid #a7f3d0' }}>
      <CardHeader style={{ background: 'linear-gradient(135deg,#ecfdf5,#d1fae5)', borderBottom: '1px solid #a7f3d0', borderRadius: '12px 12px 0 0' }}>
        <CardTitle className="flex items-center gap-2" style={{ color: '#065f46' }}>
          <BarChart2 className="w-5 h-5" style={{ color: '#059669' }} />
          Cumulative Energy (24h)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sensorHistoryLoading
          ? <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading history…</div>
          : !data.length
          ? <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No data available</div>
          : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval={tick - 1} />
              <YAxis tick={{ fontSize: 10 }} unit="kWh" width={52} />
              <RechartTooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v: unknown, n: string) => [`${Number(v).toFixed(3)} kWh`, n]} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="cumGrid" name="Grid kWh"     stroke="#3b82f6" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="cumInv"  name="Inverter kWh" stroke="#ec4899" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. AnomalyHistoryCard — "High Voltage Anomaly Detection"
// ══════════════════════════════════════════════════════════════════════════════

export function AnomalyHistoryCard({ onNavigateToLogs }: { onNavigateToLogs?: () => void } = {}) {
  const { sensorHistory, sensorHistoryLoading, gridVoltage, inverterVoltage, gridVoltageAnomaly, inverterVoltageAnomaly } = useEnergySystem();

  const liveGCls = (gridVoltageAnomaly?.severity ?? 'none') as string;
  const liveICls = (inverterVoltageAnomaly?.severity ?? 'none') as string;
  const liveStatus = liveGCls === 'critical' || liveICls === 'critical' ? 'critical'
    : liveGCls === 'warning' || liveICls === 'warning' ? 'warning' : 'none';

  const { anomPts, chartData, chartOpts, critCount, maxDelta, pills } = useMemo(() => {
    if (!sensorHistory?.length) {
      return { anomPts: [], chartData: { labels: [], datasets: [] }, chartOpts: {}, critCount: 0, maxDelta: 0, pills: [] };
    }
    const pts = [...sensorHistory].reverse().map(r => {
      const gv = Number(r.grid_voltage      ?? 0) > 0 ? Number(r.grid_voltage)      : null;
      const iv = Number(r.inverter_voltage  ?? 0) > 0 ? Number(r.inverter_voltage)  : null;
      const gl = (r.grid_anomaly_level     ?? 'none').toLowerCase();
      const il = (r.inverter_anomaly_level ?? 'none').toLowerCase();
      // Use DB-stored anomaly type (from Flask AE engine) — exact match with anomaly logs
      const rawGType = (r.grid_anomaly_type     ?? '').toLowerCase();
      const rawIType = (r.inverter_anomaly_type ?? '').toLowerCase();
      // Fallback: compute from voltage if DB has no type or 'normal'
      const gTypeFallback = gv != null && gv > 0 ? (
        gv < G_CRIT_LO ? 'Dropout' : gv > G_CRIT_HI ? 'Spike High'
        : gv < G_WARN_LO ? 'Drift Low' : gv > G_WARN_HI ? 'Drift High' : null
      ) : (gv === 0 ? 'Dropout' : null);
      const iTypeFallback = iv != null && iv > 0 ? (
        iv < 180 ? 'Dropout' : iv > 270 ? 'Spike High'
        : iv < G_WARN_LO ? 'Drift Low' : iv > G_WARN_HI ? 'Drift High' : null
      ) : null;
      const gType = (rawGType && rawGType !== 'normal') ? r.grid_anomaly_type : gTypeFallback;
      const iType = (rawIType && rawIType !== 'normal') ? r.inverter_anomaly_type : iTypeFallback;
      // DB-only level (same as KioskLCD) — no frontend fallback to avoid mismatch
      return {
        time:     fmtLabel(r.timestamp),
        gridV:    gv,
        invV:     iv,
        gridCls:  gl,   // purely from DB grid_anomaly_level
        invCls:   il,   // purely from DB inverter_anomaly_level
        gridType: gType,
        invType:  iType,
      };
    });

    const crit = pts.filter(p => p.gridCls === 'critical' || p.invCls === 'critical').length;
    const maxD = pts.reduce((mx, p) => {
      const gd = p.gridV != null ? Math.abs(p.gridV - 230) : 0;
      const id = p.invV  != null ? Math.abs(p.invV  - 220) : 0;
      return Math.max(mx, gd, id);
    }, 0);

    const annotations: Record<string, any> = {
      normalBand: { type: 'box', yMin: G_WARN_LO, yMax: G_WARN_HI, backgroundColor: 'rgba(34,197,94,0.04)', borderWidth: 0, drawTime: 'beforeDatasetsDraw', label: { display: true, content: 'Normal zone', color: '#86efac', font: { size: 8 }, position: { x: 'end', y: 'center' } } },
      wLo: { type: 'line', yMin: G_WARN_LO, yMax: G_WARN_LO, borderColor: 'rgba(234,179,8,0.55)', borderWidth: 1, borderDash: [4, 3], label: { display: true, content: `${G_WARN_LO}V warn (0.91pu)`, position: 'end', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: -9 } },
      wHi: { type: 'line', yMin: G_WARN_HI, yMax: G_WARN_HI, borderColor: 'rgba(234,179,8,0.55)', borderWidth: 1, borderDash: [4, 3], label: { display: true, content: `${G_WARN_HI}V warn (1.10pu)`, position: 'end', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: 9 } },
      cLo: { type: 'line', yMin: G_CRIT_LO, yMax: G_CRIT_LO, borderColor: 'rgba(239,68,68,0.5)',  borderWidth: 1, borderDash: [4, 3], label: { display: true, content: `${G_CRIT_LO}V crit (0.80pu)`, position: 'end', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: -9 } },
      cHi: { type: 'line', yMin: G_CRIT_HI, yMax: G_CRIT_HI, borderColor: 'rgba(239,68,68,0.5)',  borderWidth: 1, borderDash: [4, 3], label: { display: true, content: `${G_CRIT_HI}V crit (1.15pu)`, position: 'end', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: 9 } },
      dropoutLine: { type: 'line', yMin: 148, yMax: 148, borderColor: 'rgba(239,68,68,0.3)', borderWidth: 1, borderDash: [2, 4], label: { display: true, content: 'Grid dropout', position: 'end', backgroundColor: 'transparent', color: '#ef4444', font: { size: 8 } } },
    };

    let bStart: number | null = null;
    pts.forEach((p, i) => {
      const bad = p.gridCls !== 'none' || p.invCls !== 'none';
      if (bad && bStart === null) bStart = i;
      if (!bad && bStart !== null) {
        const dur = Math.round((i - bStart) * 5);
        annotations[`br${i}`] = { type: 'box', xMin: bStart, xMax: i - 1, yMin: 148, yMax: 158, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.25)', label: { display: true, content: `~${dur}m`, color: '#ef4444', font: { size: 8 }, position: { x: 'center', y: 'center' } } };
        bStart = null;
      }
    });

    const cd = {
      labels: pts.map(p => p.time),
      datasets: [
        { label: 'Grid', data: pts.map(p => p.gridV), borderColor: '#3b82f6', borderWidth: 1.5, tension: 0.35, fill: false, spanGaps: false, pointRadius: pts.map(p => p.gridCls !== 'none' ? 4 : 1.5), pointBackgroundColor: pts.map(p => dotClr(p.gridCls)), pointBorderColor: pts.map(p => dotClr(p.gridCls)), pointBorderWidth: 1 },
        { label: 'Inverter', data: pts.map(p => p.invV), borderColor: '#ec4899', borderWidth: 1.5, tension: 0.35, fill: false, spanGaps: false, pointRadius: pts.map(p => p.invCls !== 'none' ? 4 : 1.5), pointBackgroundColor: pts.map(p => dotClr(p.invCls)), pointBorderColor: pts.map(p => dotClr(p.invCls)), pointBorderWidth: 1 },
      ],
    };

    const co: any = {
      responsive: true, maintainAspectRatio: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 8, cornerRadius: 8,
          callbacks: {
            label(ctx: any) {
              const v = ctx.parsed.y as number;
              if (v == null) return '';
              const isG = ctx.datasetIndex === 0;
              const pt   = pts[ctx.dataIndex];
              const cls  = isG ? (pt?.gridCls ?? 'none') : (pt?.invCls ?? 'none');
              const lbl  = isG ? (pt?.gridType ?? null)  : (pt?.invType ?? null);
              const src  = isG ? 'Grid' : 'Inv';
              const out  = [`${src}: ${v.toFixed(1)}V`];
              if (cls !== 'none') {
                // Use DB-stored type from anomaly_engine — exact match with Anomaly Logs
                // If no type yet (old rows pre-deploy14), show level only
                const typLbl = (lbl && lbl.toLowerCase() !== 'normal') ? lbl : null;
                const clsLabel = cls.charAt(0).toUpperCase() + cls.slice(1);
                out.push(typLbl ? `${clsLabel}: ${typLbl}` : `⚠ ${clsLabel}`);
                const d = deltaLbl(v); if (d) out.push(d);
              }
              return out;
            },
          },
        },
        annotation: { annotations },
      },
      scales: {
        x: { grid: { color: 'rgba(226,232,240,0.8)' }, ticks: { font: { size: 9 }, color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { min: 148, max: 280, grid: { color: 'rgba(226,232,240,0.6)' }, ticks: { font: { size: 9 }, color: '#94a3b8', callback: (v: any) => `${v}V` } },
      },
    };

    const evts: { time: string; cls: string; lbl: string; d: string | null }[] = [];
    let prevCls = 'none';
    pts.forEach(p => {
      // Only push on level transition (avoid pill per-point spam)
      if (p.gridCls !== 'none' && p.gridCls !== prevCls) {
        evts.push({ time: p.time, cls: p.gridCls, lbl: p.gridType ?? p.gridCls.toUpperCase(), d: deltaLbl(p.gridV ?? 0) });
      }
      prevCls = p.gridCls;
    });

    return { anomPts: pts, chartData: cd, chartOpts: co, critCount: crit, maxDelta: maxD, pills: evts.slice(-6) };
  }, [sensorHistory]);

  return (
    <Card style={{ border: '1px solid #fde68a' }}>
      <CardHeader style={{ background: 'linear-gradient(135deg,#fffbeb,#fef3c7)', borderBottom: '1px solid #fde68a', borderRadius: '12px 12px 0 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <CardTitle className="flex items-center gap-2" style={{ color: '#92400e' }}>
            <AlertTriangle className="w-5 h-5" style={{ color: '#d97706' }} />
            High Voltage Anomaly Detection
          </CardTitle>
          <StatusBadge status={liveStatus} />
        </div>
        <p style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>
          Grid &amp; inverter AC voltage — drift, spike, and dropout classification · 24 hours
        </p>
      </CardHeader>
      <CardContent>
        {/* Stat boxes */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <StatBox label="Grid V"     value={gridVoltage.toFixed(0)}     unit="v"   anomaly={liveGCls} defBg="#eff6ff" defBorder="#bfdbfe" defColor="#1d4ed8" />
          <StatBox label="Inverter V" value={inverterVoltage.toFixed(0)} unit="v"   anomaly={liveICls} defBg="#fdf4ff" defBorder="#e9d5ff" defColor="#7c3aed" />
          <StatBox label="Critical"   value={String(critCount)}          unit="pts" anomaly={critCount > 0 ? 'critical' : 'none'} defBg="#fef2f2" defBorder="#fca5a5" defColor="#dc2626" />
          <StatBox label="Max delta"  value={maxDelta.toFixed(0)}        unit="v"   anomaly={maxDelta > 20 ? 'warning' : 'none'} defBg="#fffbeb" defBorder="#fde68a" defColor="#92400e" />
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 11, color: '#64748b', marginBottom: 8 }}>
          {[['#3b82f6','Grid'],['#ec4899','Inverter'],['#22c55e','Normal'],['#eab308','Warning'],['#ef4444','Critical']].map(([c, l]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />{l}
            </span>
          ))}
        </div>

        {/* Chart */}
        {sensorHistoryLoading
          ? <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading data…</div>
          : anomPts.length === 0
          ? <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No AC voltage data</div>
          : <div style={{ height: 260 }}><CJSLine data={chartData} options={chartOpts} /></div>
        }

        {/* Event pills */}
        {pills.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {pills.map((e, i) => (
              <span key={i} onClick={onNavigateToLogs} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, background: e.cls === 'critical' ? '#fef2f2' : '#fffbeb', color: e.cls === 'critical' ? '#dc2626' : '#d97706', border: `1px solid ${e.cls === 'critical' ? '#fca5a5' : '#fcd34d'}`, cursor: onNavigateToLogs ? 'pointer' : 'default' }} title={onNavigateToLogs ? 'View in Anomaly Logs' : undefined}>
                Grid · {e.cls.toUpperCase()} · {e.lbl} · {e.time} {onNavigateToLogs ? '↗' : ''}
              </span>
            ))}
          </div>
        )}

        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, textAlign: 'right' }}>
          ⊡ PZEM-004T
        </div>
      </CardContent>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. DCVoltageAnomalyCard — "Low Voltage Anomaly Detection"
//    Chart.js + annotation plugin — same style as AnomalyHistoryCard
//    2 sub-charts: Battery Pack DC + Solar PV DC
// ══════════════════════════════════════════════════════════════════════════════

// DC thresholds
const SOL_NOM  = 88.86;
const SOL_WARN = 53;
const SOL_CRIT = 20;

function clsBat(v: number): string {
  if (v <= 0) return 'none';
  if (v < BAT_CRIT) return 'critical';
  if (v < BAT_WARN) return 'warning';
  return 'none';
}
function clsSol(v: number): string {
  if (v <= 0) return 'none';
  if (v < SOL_CRIT) return 'critical';
  if (v < SOL_WARN) return 'warning';
  return 'none';
}
function anomTypeDC(v: number, warnLo: number, critLo: number): string {
  if (v <= 0)       return 'Dropout';
  if (v < critLo)   return 'Dropout';
  if (v < warnLo)   return 'Drift Low';
  return 'Normal';
}

export function DCVoltageAnomalyCard({ onNavigateToLogs }: { onNavigateToLogs?: () => void } = {}) {
  const { sensorHistory, sensorHistoryLoading, batteryVoltage, solarVoltage, dcBatteryAnomaly, dcSolarAnomaly } = useEnergySystem();

  const liveBatCls = (dcBatteryAnomaly ?? 'none') as string;
  const liveSolCls = (dcSolarAnomaly   ?? 'none') as string;
  const liveStatus = liveBatCls === 'critical' || liveSolCls === 'critical' ? 'critical'
    : liveBatCls === 'warning' || liveSolCls === 'warning' ? 'warning' : 'none';

  const { batPts, solPts, batChartData, batChartOpts, solChartData, solChartOpts, critCount, batPills, solPills } = useMemo(() => {
    if (!sensorHistory?.length) {
      const empty = { labels: [], datasets: [] };
      return { batPts: [], solPts: [], batChartData: empty, batChartOpts: {}, solChartData: empty, solChartOpts: {}, critCount: 0, batPills: [], solPills: [] };
    }

    const sorted = [...sensorHistory].reverse();

    const bPts = sorted.map(r => {
      const bv  = Number(r.battery_pack_voltage ?? 0) > 0 ? Number(r.battery_pack_voltage) : null;
      const bl  = (r.dc_battery_anomaly_level ?? 'none').toLowerCase();
      // Only use DB type if it's a real anomaly type (not 'Normal' which means no anomaly)
      const rawBt = r.dc_battery_anomaly_type ?? '';
      const bt  = bl !== 'none' && rawBt && rawBt.toLowerCase() !== 'normal'
        ? rawBt
        : bl !== 'none' ? anomTypeDC(bv ?? 0, BAT_WARN, BAT_CRIT) : null;
      return { time: fmtLabel(r.timestamp), v: bv, cls: bl !== 'none' ? bl : 'none', type: bt };
    });

    const sPts = sorted.map(r => {
      const sv  = Number(r.solar_dc_voltage ?? 0) > 0 ? Number(r.solar_dc_voltage) : null;
      const sl  = (r.dc_solar_anomaly_level ?? 'none').toLowerCase();
      const rawSt = r.dc_solar_anomaly_type ?? '';
      const st  = sl !== 'none' && rawSt && rawSt.toLowerCase() !== 'normal'
        ? rawSt
        : sl !== 'none' ? anomTypeDC(sv ?? 0, SOL_WARN, SOL_CRIT) : null;
      return { time: fmtLabel(r.timestamp), v: sv, cls: sl !== 'none' ? sl : 'none', type: st };
    });

    const crit = [...bPts, ...sPts].filter(p => p.cls === 'critical').length;

    // ── Battery Chart.js config ──────────────────────────────────────────
    const batAnnotations: Record<string, any> = {
      normalBand: { type: 'box', yMin: BAT_WARN, yMax: BAT_FULL, backgroundColor: 'rgba(34,197,94,0.04)', borderWidth: 0, drawTime: 'beforeDatasetsDraw', label: { display: true, content: 'Normal zone', color: '#86efac', font: { size: 8 }, position: { x: 'end', y: 'center' } } },
      full: { type: 'line', yMin: BAT_FULL, yMax: BAT_FULL, borderColor: 'rgba(34,197,94,0.7)',  borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${BAT_FULL}V full`, position: 'end', backgroundColor: 'transparent', color: '#15803d', font: { size: 9 }, yAdjust: -8 } },
      nominal: { type: 'line', yMin: 24, yMax: 24, borderColor: 'rgba(148,163,184,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: '24V Vn', position: 'end', backgroundColor: 'transparent', color: '#94a3b8', font: { size: 9 }, yAdjust: 8 } },
      warn: { type: 'line', yMin: BAT_WARN, yMax: BAT_WARN, borderColor: 'rgba(234,179,8,0.55)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${BAT_WARN}V warn`, position: 'end', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: -8 } },
      crit: { type: 'line', yMin: BAT_CRIT, yMax: BAT_CRIT, borderColor: 'rgba(239,68,68,0.5)',  borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${BAT_CRIT}V crit`, position: 'end', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: 8 } },
    };

    const batCD = {
      labels: bPts.map(p => p.time),
      datasets: [{
        label: 'Battery V', data: bPts.map(p => p.v),
        borderColor: '#22c55e', borderWidth: 1.5, tension: 0.3, fill: false, spanGaps: false,
        pointRadius: bPts.map(p => p.cls !== 'none' ? 4.5 : 1.5),
        pointBackgroundColor: bPts.map(p => dotClr(p.cls)),
        pointBorderColor:     bPts.map(p => dotClr(p.cls)),
        pointBorderWidth: 1.2,
      }],
    };

    const batCO: any = {
      responsive: true, maintainAspectRatio: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 8, cornerRadius: 8,
          callbacks: {
            label(ctx: any) {
              const v   = ctx.parsed.y as number;
              if (v == null) return '';
              const pt  = bPts[ctx.dataIndex];
              const cls = pt?.cls ?? 'none';
              // Only show type when there is an actual anomaly (not Normal)
              const typ = (pt?.type && pt.type.toLowerCase() !== 'normal') ? pt.type : null;
              const out = [`Battery: ${v.toFixed(2)}V`];
              if (cls !== 'none') {
                // DB-stored type from dc_anomaly_engine — exact match with Anomaly Logs
                const typLbl = (typ && typ.toLowerCase() !== 'normal') ? typ : null;
                const clsLabel = cls.charAt(0).toUpperCase() + cls.slice(1);
                out.push(typLbl ? `${clsLabel}: ${typLbl}` : `⚠ ${clsLabel}`);
                if (v > 0 && v < BAT_WARN) out.push(`-${(BAT_WARN-v).toFixed(2)}V below warn`);
                else if (v > BAT_FULL) out.push(`+${(v-BAT_FULL).toFixed(2)}V above full`);
              }
              return out;
            },
          },
        },
        annotation: { annotations: batAnnotations },
      },
      scales: {
        x: { grid: { color: 'rgba(226,232,240,0.8)' }, ticks: { font: { size: 9 }, color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { min: 0, max: 35, grid: { color: 'rgba(226,232,240,0.6)' }, ticks: { font: { size: 9 }, color: '#94a3b8', callback: (v: any) => `${v}V` } },
      },
    };

    // ── Solar Chart.js config ────────────────────────────────────────────
    const solAnnotations: Record<string, any> = {
      normalBand: { type: 'box', yMin: SOL_WARN, yMax: SOL_NOM + 10, backgroundColor: 'rgba(34,197,94,0.04)', borderWidth: 0, drawTime: 'beforeDatasetsDraw', label: { display: true, content: 'Normal zone', color: '#86efac', font: { size: 8 }, position: { x: 'end', y: 'center' } } },
      nom:  { type: 'line', yMin: SOL_NOM,  yMax: SOL_NOM,  borderColor: 'rgba(148,163,184,0.5)', borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${SOL_NOM}V Vn`, position: 'end', backgroundColor: 'transparent', color: '#94a3b8', font: { size: 9 }, yAdjust: -8 } },
      warn: { type: 'line', yMin: SOL_WARN, yMax: SOL_WARN, borderColor: 'rgba(234,179,8,0.55)',  borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${SOL_WARN}V warn`, position: 'end', backgroundColor: 'transparent', color: '#a16207', font: { size: 9 }, yAdjust: -8 } },
      crit: { type: 'line', yMin: SOL_CRIT, yMax: SOL_CRIT, borderColor: 'rgba(239,68,68,0.5)',   borderWidth: 1, borderDash: [4,3], label: { display: true, content: `${SOL_CRIT}V crit`, position: 'end', backgroundColor: 'transparent', color: '#dc2626', font: { size: 9 }, yAdjust: 8 } },
    };

    const solCD = {
      labels: sPts.map(p => p.time),
      datasets: [{
        label: 'Solar V', data: sPts.map(p => p.v),
        borderColor: '#f59e0b', borderWidth: 1.5, tension: 0.3, fill: false, spanGaps: false,
        pointRadius: sPts.map(p => p.cls !== 'none' ? 4.5 : 1.5),
        pointBackgroundColor: sPts.map(p => dotClr(p.cls)),
        pointBorderColor:     sPts.map(p => dotClr(p.cls)),
        pointBorderWidth: 1.2,
      }],
    };

    const solCO: any = {
      responsive: true, maintainAspectRatio: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 8, cornerRadius: 8,
          callbacks: {
            label(ctx: any) {
              const v   = ctx.parsed.y as number;
              if (v == null) return '';
              const pt  = sPts[ctx.dataIndex];
              const cls = pt?.cls ?? 'none';
              const typ = (pt?.type && pt.type.toLowerCase() !== 'normal') ? pt.type : null;
              const out = [`Solar: ${v.toFixed(1)}V`];
              if (cls !== 'none') {
                // DB-stored type from dc_anomaly_engine — exact match with Anomaly Logs
                const typLbl = (typ && typ.toLowerCase() !== 'normal') ? typ : null;
                const clsLabel = cls.charAt(0).toUpperCase() + cls.slice(1);
                out.push(typLbl ? `${clsLabel}: ${typLbl}` : `⚠ ${clsLabel}`);
                if (v > 0 && v < SOL_WARN) out.push(`-${(SOL_WARN-v).toFixed(1)}V below warn`);
              }
              return out;
            },
          },
        },
        annotation: { annotations: solAnnotations },
      },
      scales: {
        x: { grid: { color: 'rgba(226,232,240,0.8)' }, ticks: { font: { size: 9 }, color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { min: 0, max: 105, grid: { color: 'rgba(226,232,240,0.6)' }, ticks: { font: { size: 9 }, color: '#94a3b8', callback: (v: any) => `${v}V` } },
      },
    };

    // Pills
    const bPills: { time: string; cls: string; lbl: string }[] = [];
    const sPills: { time: string; cls: string; lbl: string }[] = [];
    let prevB = 'none', prevS = 'none';
    bPts.forEach(p => {
      if (p.cls !== 'none' && p.cls !== prevB) {
        const v = p.v ?? 0;
        const computedLbl = v > 0 && v < BAT_CRIT ? 'Dropout' : v > 0 && v < BAT_WARN ? 'Drift Low' : 'Low Voltage';
        const lbl = (p.type && p.type.toLowerCase() !== 'normal') ? p.type : computedLbl;
        bPills.push({ time: p.time, cls: p.cls, lbl });
      }
      prevB = p.cls;
    });
    sPts.forEach(p => {
      if (p.cls !== 'none' && p.cls !== prevS) {
        const v = p.v ?? 0;
        const computedLbl = v <= 0 || v < SOL_CRIT ? 'Dropout' : v < SOL_WARN ? 'Drift Low' : 'Low Voltage';
        const lbl = (p.type && p.type.toLowerCase() !== 'normal') ? p.type : computedLbl;
        sPills.push({ time: p.time, cls: p.cls, lbl });
      }
      prevS = p.cls;
    });

    return { batPts: bPts, solPts: sPts, batChartData: batCD, batChartOpts: batCO, solChartData: solCD, solChartOpts: solCO, critCount: crit, batPills: bPills.slice(-4), solPills: sPills.slice(-4) };
  }, [sensorHistory]);

  return (
    <Card style={{ border: '1px solid #ddd6fe' }}>
      <CardHeader style={{ background: 'linear-gradient(135deg,#f5f3ff,#ede9fe)', borderBottom: '1px solid #ddd6fe', borderRadius: '12px 12px 0 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <CardTitle className="flex items-center gap-2" style={{ color: '#5b21b6' }}>
            <Zap className="w-5 h-5" style={{ color: '#7c3aed' }} />
            Low Voltage Anomaly Detection
          </CardTitle>
          <StatusBadge status={liveStatus} />
        </div>
        <p style={{ fontSize: 12, color: '#7c3aed', marginTop: 4 }}>
          Battery pack DC &amp; Solar PV DC — dropout, spike, and drift classification · 24 hours
        </p>
      </CardHeader>
      <CardContent>
        {/* Stat boxes */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <StatBox label="Battery V" value={batteryVoltage.toFixed(2)} unit="v"   anomaly={liveBatCls} defBg="#f0fdf4" defBorder="#86efac" defColor="#15803d" />
          <StatBox label="Solar V"   value={solarVoltage.toFixed(1)}   unit="v"   anomaly={liveSolCls} defBg="#fffbeb" defBorder="#fde68a" defColor="#92400e" />
          <StatBox label="Critical"  value={String(critCount)}         unit="pts" anomaly={critCount > 0 ? 'critical' : 'none'} defBg="#fef2f2" defBorder="#fca5a5" defColor="#dc2626" />
          <StatBox label="Status"    value={liveStatus === 'none' ? 'Stable' : 'Alert'} anomaly={liveStatus} defBg="#f0fdf4" defBorder="#86efac" defColor="#15803d" />
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 11, color: '#64748b', marginBottom: 8 }}>
          {([['#22c55e','Battery'],['#f59e0b','Solar'],['#22c55e','Normal'],['#eab308','Warning'],['#ef4444','Critical']] as [string,string][]).map(([clr,lbl]) => (
            <span key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: clr, display: 'inline-block' }} />{lbl}
            </span>
          ))}
        </div>

        {sensorHistoryLoading
          ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading data…</div>
          : (
          <>
            {/* Battery sub-chart */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#475569' }}>Battery Pack DC — JSL II 24V VRLA · Vn = 24V</span>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>0 – 35V</span>
              </div>
              {batPts.length === 0
                ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No battery data</div>
                : <div style={{ height: 200 }}><CJSLine data={batChartData} options={batChartOpts} /></div>
              }
              {batPills.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {batPills.map((p, i) => (
                    <span key={i} onClick={onNavigateToLogs} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, background: p.cls === 'critical' ? '#fef2f2' : '#fffbeb', color: p.cls === 'critical' ? '#dc2626' : '#d97706', border: `1px solid ${p.cls === 'critical' ? '#fca5a5' : '#fcd34d'}`, cursor: onNavigateToLogs ? 'pointer' : 'default' }} title={onNavigateToLogs ? 'View in Anomaly Logs' : undefined}>
                      Battery · {p.cls.toUpperCase()} · {p.lbl} · {p.time} {onNavigateToLogs ? '↗' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Solar sub-chart */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#475569' }}>Solar PV DC — JAM72D40-580 2S2P · Vn = 88.86V</span>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>0 – 105V</span>
              </div>
              {solPts.length === 0
                ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>No solar data</div>
                : <div style={{ height: 200 }}><CJSLine data={solChartData} options={solChartOpts} /></div>
              }
              {solPills.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {solPills.map((p, i) => (
                    <span key={i} onClick={onNavigateToLogs} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, background: p.cls === 'critical' ? '#fef2f2' : '#fffbeb', color: p.cls === 'critical' ? '#dc2626' : '#d97706', border: `1px solid ${p.cls === 'critical' ? '#fca5a5' : '#fcd34d'}`, cursor: onNavigateToLogs ? 'pointer' : 'default' }} title={onNavigateToLogs ? 'View in Anomaly Logs' : undefined}>
                      Solar DC · {p.cls.toUpperCase()} · {p.lbl} · {p.time} {onNavigateToLogs ? '↗' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, textAlign: 'right' }}>
          ⊡ INA219 × 1 · WCS1500 × 4 · JSL II 24V / JAM72D40 2S2P
        </div>
      </CardContent>
    </Card>
  );
}
