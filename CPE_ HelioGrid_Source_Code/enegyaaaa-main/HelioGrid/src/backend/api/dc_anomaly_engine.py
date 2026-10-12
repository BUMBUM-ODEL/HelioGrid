"""
dc_anomaly_engine.py  —  HelioGrid DC Low-Voltage Anomaly Detection
=====================================================================
Mirrors anomaly_engine.py (AC) but tuned for DC low-voltage sources:

  battery_engine = DCAnomalyEngine(vn=24.0)   # JSL II 24V VRLA pack
  solar_engine   = DCAnomalyEngine(vn=70.0)   # Solar PV string (JAM72D40-580 2S2P: Vmp~35V x2=70V)

Thresholds are per-unit (ratio of vn) so they auto-scale from vn.
Based on Arduino voltage_anomaly_ina219.ino detection logic,
upgraded to match anomaly_engine.py structure (stateful, context-aware).

Detection types:
  Dropout  — sustained voltage drop below normal band
  Spike    — sudden large ΔV (1–3 samples)
  Drift    — slow consistent deviation from baseline
  Normal   — voltage within normal operating range

Severity:
  Warning  — degraded but recoverable
  Critical — immediate attention required

Usage:
  from dc_anomaly_engine import detect_battery, detect_solar, DCSensorSample

  result = detect_battery(voltage=23.5)
  result = detect_solar(voltage=45.2, current=3.1, power=140.0)
  print(result.anomaly_type, result.severity, result.detail)
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Per-unit ratios — derived from Arduino ino, adapted for DC
# All thresholds computed from vn passed into DCAnomalyEngine.__init__()
# ─────────────────────────────────────────────────────────────────────────────

# Dropout per-unit thresholds
DC_DROP_IMMED_PU   = 0.17   # < 0.17 pu → immediate Critical (near-zero)
DC_DROP_CRIT_PU    = 0.37   # < 0.37 pu → Critical after ≥5 samples
DC_DROP_WARN_PU    = 0.67   # < 0.67 pu → Warning  after 2–4 samples
DC_DROP_WARN_MIN   = 2
DC_DROP_WARN_MAX   = 4
DC_DROP_CRIT_MIN   = 5
DC_DROP_CRIT_LONG  = 20

# Spike (fraction of Vn)
DC_SPIKE_WARN_PCT  = 0.10   # |ΔV| ≥ 10% Vn → Warning  (DC is noisier than AC)
DC_SPIKE_CRIT_PCT  = 0.20   # |ΔV| ≥ 20% Vn → Critical
DC_SPIKE_MAX_DUR   = 3

# Drift (fraction of Vn deviation from baseline)
DC_DRIFT_WARN_PCT  = 0.08   # ≥  8% Vn → Warning  (≥10 samples)
DC_DRIFT_CRIT_PCT  = 0.15   # ≥ 15% Vn → Critical (≥20 samples)
DC_DRIFT_WARN_SAMPLES = 10
DC_DRIFT_CRIT_SAMPLES = 20

# Normal band (±tolerance from Vn)
DC_NORMAL_TOL      = 0.33   # ±33% — wide band, lead acid varies a lot

# Baseline window
DC_BASELINE_WINDOW = 30     # samples

# Context check
DC_CTX_CURR_DELTA  = 1.0    # A — load switching suppression
DC_CTX_PWR_DELTA   = 5.0    # W
DC_CTX_SETTLE      = 3


# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class DCSensorSample:
    voltage   : float
    current   : float = 0.0
    power     : float = 0.0
    timestamp : float = field(default_factory=time.time)


@dataclass
class DCAnomalyResult:
    anomaly_type : str    # "Normal" | "Dropout" | "Spike" | "Drift"
    severity     : str    # "Normal" | "Warning" | "Critical"
    detail       : str
    voltage      : float
    delta_v      : float = 0.0
    pu           : float = 0.0
    confirmed    : bool  = True
    context_note : str   = ""
    source       : str   = ""   # "battery" | "solar"


# ─────────────────────────────────────────────────────────────────────────────
# Main engine
# ─────────────────────────────────────────────────────────────────────────────

class DCAnomalyEngine:
    """
    Stateful DC voltage anomaly engine — one instance per sensor source.

    Args:
        vn     : Nominal DC voltage (V)
        source : Label for logging — "battery" or "solar"

    Usage:
        bat_eng = DCAnomalyEngine(vn=24.0, source="battery")
        sol_eng = DCAnomalyEngine(vn=70.0, source="solar")
        result  = bat_eng.process(DCSensorSample(voltage=23.5))
    """

    def __init__(self, vn: float = 24.0, source: str = "dc") -> None:
        self.vn     = vn
        self.source = source

        # Computed thresholds
        self._immed_v      = DC_DROP_IMMED_PU  * vn
        self._drop_crit_v  = DC_DROP_CRIT_PU   * vn
        self._drop_warn_v  = DC_DROP_WARN_PU   * vn
        self._normal_low   = vn * (1.0 - DC_NORMAL_TOL)
        self._normal_high  = vn * (1.0 + DC_NORMAL_TOL)
        self._spike_warn_v = DC_SPIKE_WARN_PCT  * vn
        self._spike_crit_v = DC_SPIKE_CRIT_PCT  * vn
        self._spike_ret_v  = self._spike_warn_v * 0.5
        self._drift_warn_v = DC_DRIFT_WARN_PCT  * vn
        self._drift_crit_v = DC_DRIFT_CRIT_PCT  * vn

        # State
        self._v_history  : Deque[float] = deque(maxlen=max(DC_DRIFT_CRIT_SAMPLES + 5, DC_BASELINE_WINDOW))
        self._i_history  : Deque[float] = deque(maxlen=DC_CTX_SETTLE + 5)
        self._p_history  : Deque[float] = deque(maxlen=DC_CTX_SETTLE + 5)

        self._drop_counter   : int   = 0
        self._spike_active   : bool  = False
        self._spike_dur      : int   = 0
        self._spike_delta    : float = 0.0
        self._spike_ref_v    : float = vn
        self._drift_samples  : int   = 0
        self._drift_start_v  : Optional[float] = None
        self._stable_baseline: Optional[float] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def process(self, sample: DCSensorSample) -> DCAnomalyResult:
        v   = sample.voltage
        cur = sample.current
        pwr = sample.power
        pu  = v / self.vn if self.vn else 0.0
        dv  = self._delta_v(v)

        self._v_history.append(v)
        self._i_history.append(cur)
        self._p_history.append(pwr)

        def _r(anomaly_type, severity, detail, **kw) -> DCAnomalyResult:
            return DCAnomalyResult(
                anomaly_type=anomaly_type, severity=severity, detail=detail,
                voltage=v, pu=pu, delta_v=dv, source=self.source, **kw
            )

        # Step 1: Sensor missing / zero
        if v <= 0:
            self._drop_counter += 1
            return _r("Dropout", "Critical",
                      "DC voltage is 0V or missing — possible sensor disconnect or source off")

        # Step 2: Dropout
        result = self._check_dropout(v, pu, dv)
        if result:
            return self._ctx(result, dv, sample)

        was_dropping = self._drop_counter > 0
        self._drop_counter = 0

        # Reset spike state after dropout recovery
        if was_dropping:
            self._spike_active    = False
            self._spike_dur       = 0
            self._spike_delta     = 0.0
            self._spike_ref_v     = self.vn
            self._stable_baseline = None
            self._v_history.clear()

        # Step 3: Spike (skip if recovering from dropout or mid-drift)
        if not was_dropping and self._drift_samples == 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._ctx(result, dv, sample)

        # Step 4: Drift
        result = self._check_drift(v, pu, dv)
        if result:
            return self._ctx(result, dv, sample)

        # Deferred spike check (when drift was active)
        if not was_dropping and self._drift_samples != 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._ctx(result, dv, sample)

        # Step 5: Normal
        self._drift_samples   = 0
        self._drift_start_v   = None
        self._stable_baseline = self._baseline()
        return _r("Normal", "Normal", "DC voltage within normal operating range")

    # ── Dropout ───────────────────────────────────────────────────────────────

    def _check_dropout(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Dropout", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        # Immediate Critical — near-zero
        if pu < DC_DROP_IMMED_PU:
            self._drop_counter += 1
            return _r("Critical",
                      f"{v:.2f}V ({pu:.3f} pu) — near-zero, immediate Critical")

        # Critical band — < 0.37 pu
        if pu < DC_DROP_CRIT_PU:
            self._drop_counter += 1
            if self._drop_counter >= DC_DROP_CRIT_MIN:
                sev = "Critical"
                detail = f"{v:.2f}V ({pu:.3f} pu) — sustained drop ({self._drop_counter} samples)"
            elif self._drop_counter >= DC_DROP_WARN_MIN:
                sev = "Warning"
                detail = f"{v:.2f}V ({pu:.3f} pu) — severe drop ({self._drop_counter} samples, Critical if ≥{DC_DROP_CRIT_MIN})"
            else:
                sev = "Warning"
                detail = f"{v:.2f}V ({pu:.3f} pu) — below 0.37 pu threshold"
            return _r(sev, detail)

        # Warning band — < 0.67 pu
        if pu < DC_DROP_WARN_PU:
            self._drop_counter += 1
            if self._drop_counter >= DC_DROP_CRIT_LONG:
                return _r("Critical",
                          f"{v:.2f}V ({pu:.3f} pu) — prolonged undervoltage ({self._drop_counter} samples)")
            if self._drop_counter >= DC_DROP_CRIT_MIN:
                return _r("Critical",
                          f"{v:.2f}V ({pu:.3f} pu) — sustained undervoltage ({self._drop_counter} samples)")
            if self._drop_counter >= DC_DROP_WARN_MIN:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — undervoltage ({self._drop_counter} samples)")
            return None

        return None

    # ── Spike ─────────────────────────────────────────────────────────────────

    def _check_spike(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        abs_dv = abs(dv)

        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Spike", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        if self._spike_active:
            self._spike_dur += 1
            if abs(v - self._spike_ref_v) <= self._spike_ret_v:
                self._spike_active = False
                sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                return _r(sev, f"Spike confirmed — ΔV={self._spike_delta:+.2f}V, {self._spike_dur} samples, returned to baseline")
            if abs_dv >= self._spike_warn_v:
                if abs(dv) > abs(self._spike_delta):
                    self._spike_delta = dv
                sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                return _r(sev, f"Spike escalating — ΔV={dv:+.2f}V, peak ΔV={self._spike_delta:+.2f}V")
            if abs(v - self._spike_ref_v) > self._spike_ret_v:
                sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                tag = "Sustained spike" if self._spike_dur > DC_SPIKE_MAX_DUR else "Spike ongoing"
                return _r(sev, f"{tag} — ΔV={self._spike_delta:+.2f}V, {self._spike_dur} samples")
            return None

        if abs_dv >= self._spike_warn_v:
            self._spike_active = True
            self._spike_dur    = 1
            self._spike_delta  = dv
            self._spike_ref_v  = self._stable_baseline if self._stable_baseline is not None else self.vn
            sev = "Critical" if abs_dv >= self._spike_crit_v else "Warning"
            return _r(sev, f"Spike onset — ΔV={dv:+.2f}V ({abs(dv)/self.vn*100:.1f}% Vn)")

        if len(self._v_history) <= 2 and abs(v - self.vn) >= self._spike_warn_v:
            dev = v - self.vn
            self._spike_active = True
            self._spike_dur    = 1
            self._spike_delta  = dev
            self._spike_ref_v  = self.vn
            sev = "Critical" if abs(dev) >= self._spike_crit_v else "Warning"
            return _r(sev, f"Spike at boot — {v:.2f}V deviates {dev:+.2f}V ({abs(dev)/self.vn*100:.1f}% Vn)")

        return None

    # ── Drift ─────────────────────────────────────────────────────────────────

    def _check_drift(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        baseline = self._baseline()
        if baseline is None:
            return None

        ref = self._drift_start_v if self._drift_start_v is not None else (
            sum(list(self._v_history)[:max(1, len(self._v_history) // 2)]) /
            max(1, len(self._v_history) // 2)
        )

        deviation = abs(v - ref)

        if deviation < self._drift_warn_v:
            self._drift_samples = 0
            self._drift_start_v = None
            return None

        if self._drift_start_v is None:
            self._drift_start_v = ref

        self._drift_samples += 1

        if not self._is_consistent_drift():
            self._drift_samples = max(0, self._drift_samples - 1)
            return None

        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Drift", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        if deviation >= self._drift_crit_v and self._drift_samples >= DC_DRIFT_CRIT_SAMPLES:
            return _r("Critical",
                      f"Drift {deviation:.2f}V from baseline ({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")
        if deviation >= self._drift_warn_v and self._drift_samples >= DC_DRIFT_WARN_SAMPLES:
            return _r("Warning",
                      f"Drift {deviation:.2f}V from baseline ({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")
        return None

    # ── Context check (load-switching suppression) ────────────────────────────

    def _ctx(self, result: DCAnomalyResult, dv: float, sample: DCSensorSample) -> DCAnomalyResult:
        if len(self._i_history) < 2 or len(self._p_history) < 2:
            return result
        di = self._i_history[-1] - self._i_history[-2]
        dp = self._p_history[-1] - self._p_history[-2]
        load_event = False
        note = ""
        if dv < 0 and (di > DC_CTX_CURR_DELTA or dp > DC_CTX_PWR_DELTA):
            load_event = True
            note = f"V drop ({dv:+.2f}V) coincides with load increase (ΔI={di:+.2f}A, ΔP={dp:+.1f}W) — Load ON"
        elif dv > 0 and (di < -DC_CTX_CURR_DELTA or dp < -DC_CTX_PWR_DELTA):
            load_event = True
            note = f"V rise ({dv:+.2f}V) coincides with load decrease (ΔI={di:+.2f}A, ΔP={dp:+.1f}W) — Load OFF"
        if load_event:
            if self._settling_check():
                result.confirmed    = False
                result.context_note = note + " — suppressed after settling check"
                result.severity     = "Normal"
                result.anomaly_type = "Normal"
            else:
                result.context_note = note + " — voltage did not settle; anomaly retained"
        return result

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _delta_v(self, v: float) -> float:
        return v - self._v_history[-1] if self._v_history else 0.0

    def _baseline(self) -> Optional[float]:
        hist = list(self._v_history)
        if len(hist) < 2:
            return None
        window = hist[-DC_BASELINE_WINDOW:] if len(hist) >= DC_BASELINE_WINDOW else hist
        return sum(window) / len(window)

    def _is_consistent_drift(self) -> bool:
        hist = list(self._v_history)
        if len(hist) < 4:
            return True
        recent = hist[-min(10, len(hist)):]
        diffs  = [recent[i+1] - recent[i] for i in range(len(recent)-1)]
        pos    = sum(1 for d in diffs if d > 0)
        neg    = sum(1 for d in diffs if d < 0)
        total  = len(diffs)
        return (pos / total >= 0.70) or (neg / total >= 0.70)

    def _settling_check(self) -> bool:
        hist = list(self._v_history)
        if len(hist) < DC_CTX_SETTLE:
            return False
        recent   = hist[-DC_CTX_SETTLE:]
        baseline = self._baseline() or self.vn
        return all(abs(v - baseline) < self._drift_warn_v for v in recent)

    def reset(self) -> None:
        self._v_history.clear(); self._i_history.clear(); self._p_history.clear()
        self._drop_counter = 0; self._spike_active = False; self._spike_dur = 0
        self._spike_delta = 0.0; self._spike_ref_v = self.vn
        self._drift_samples = 0; self._drift_start_v = None; self._stable_baseline = None


# ─────────────────────────────────────────────────────────────────────────────
# Convenience wrappers
# ─────────────────────────────────────────────────────────────────────────────

_battery_engine : Optional[DCAnomalyEngine] = None
_solar_engine   : Optional[DCAnomalyEngine] = None


def detect_battery(voltage: float, current: float = 0.0, power: float = 0.0) -> DCAnomalyResult:
    """Stateful battery DC anomaly detection — Vn = 24.0V (JSL II 24V VRLA)."""
    global _battery_engine
    if _battery_engine is None:
        _battery_engine = DCAnomalyEngine(vn=24.0, source="battery")
    return _battery_engine.process(DCSensorSample(voltage=voltage, current=current, power=power))


def detect_solar(voltage: float, current: float = 0.0, power: float = 0.0) -> DCAnomalyResult:
    """Stateful solar PV DC anomaly detection — Vn = 70.0V (JAM72D40-580 2S2P: Vmp~35V x2=70V).
    Change vn below to match your actual panel string Vmp.
    """
    global _solar_engine
    if _solar_engine is None:
        _solar_engine = DCAnomalyEngine(vn=70.0, source="solar")
    return _solar_engine.process(DCSensorSample(voltage=voltage, current=current, power=power))


# ─────────────────────────────────────────────────────────────────────────────
# Self-test
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 80)
    print("BATTERY ENGINE  — Vn = 24.0V (JSL II 24V VRLA)")
    print("=" * 80)
    bat = DCAnomalyEngine(vn=24.0, source="battery")
    bat_cases = [
        ("Normal 24V",        24.0, 5.0, 120.0),
        ("Normal 25V",        25.0, 4.8, 120.0),
        ("Dropout warn",      15.0, 2.0,  30.0),
        ("Dropout warn",      15.0, 2.0,  30.0),
        ("Dropout warn",      15.0, 2.0,  30.0),
        ("Dropout crit",       8.0, 1.0,   8.0),
        ("Dropout crit",       8.0, 1.0,   8.0),
        ("Dropout crit",       8.0, 1.0,   8.0),
        ("Dropout crit",       8.0, 1.0,   8.0),
        ("Dropout crit",       8.0, 1.0,   8.0),
        ("Recovery",          24.0, 5.0, 120.0),
        ("Spike warn",        26.5, 5.2, 125.0),
        ("Return base",       24.1, 5.0, 120.0),
        ("Spike crit",        29.5, 5.5, 130.0),
        ("Return base",       24.0, 5.0, 120.0),
        ("Near-zero",          0.5, 0.0,   0.0),
        ("Load ON (ctx)",     22.5, 9.0, 200.0),
    ]
    print(f"{'Scenario':<22}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 80)
    for label, v, i, p in bat_cases:
        r = bat.process(DCSensorSample(voltage=v, current=i, power=p))
        flag = "" if r.confirmed else " [suppressed]"
        print(f"{label:<22}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.2f}  {r.delta_v:>+7.2f}  {r.detail[:45]}{flag}")

    print()
    print("=" * 80)
    print("SOLAR ENGINE  — Vn = 70.0V (JAM72D40-580 2S2P: Vmp~35V x2=70V)")
    print("=" * 80)
    sol = DCAnomalyEngine(vn=70.0, source="solar")
    sol_cases = [
        ("Normal 48V",        48.0, 3.0, 144.0),
        ("Normal 50V",        50.0, 3.2, 160.0),
        ("Dropout warn",      30.0, 1.5,  45.0),
        ("Dropout warn",      30.0, 1.5,  45.0),
        ("Dropout crit",      16.0, 0.5,   8.0),
        ("Dropout crit",      16.0, 0.5,   8.0),
        ("Dropout crit",      16.0, 0.5,   8.0),
        ("Dropout crit",      16.0, 0.5,   8.0),
        ("Dropout crit",      16.0, 0.5,   8.0),
        ("Recovery",          48.0, 3.0, 144.0),
        ("Spike warn",        53.0, 3.3, 155.0),
        ("Return base",       48.2, 3.0, 144.0),
        ("Near-zero (night)", 0.0,  0.0,   0.0),
    ]
    print(f"{'Scenario':<22}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 80)
    for label, v, i, p in sol_cases:
        r = sol.process(DCSensorSample(voltage=v, current=i, power=p))
        flag = "" if r.confirmed else " [suppressed]"
        print(f"{label:<22}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.2f}  {r.delta_v:>+7.2f}  {r.detail[:45]}{flag}")
