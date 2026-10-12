"""
anomaly_engine.py  —  HelioGrid AC Voltage Anomaly Detection
=============================================================
Detects voltage anomalies for AC sources (Grid and Inverter).
Based on voltage_anomaly_ina219.ino approved detection logic,
adapted for AC with proper per-unit thresholds.

Detection Types:
  Dropout  — voltage drops below normal band (sustained or instant)
  Spike    — sudden large ΔV (1–3 samples), returns to baseline
  Drift    — slow consistent deviation from baseline over time
  Normal   — voltage within normal operating band

Severity Levels:
  Normal   — no anomaly
  Warning  — degraded but operating
  Critical — immediate action required

Sources:
  Grid     — Vn=230V, ±10% tolerance  (IEC 60038 PH standard)
             Normal band : 207V – 253V
             Dropout warn: < 207V (0.90 pu), 2–4 samples
             Dropout crit: < 184V (0.80 pu), ≥5 samples
             Instant crit: < 23V  (0.10 pu)
             Spike warn  : |ΔV| ≥ 11.5V (5% Vn)
             Spike crit  : |ΔV| ≥ 23.0V (10% Vn)
             Drift warn  : ≥6.9V from baseline (3% Vn), ≥5 samples
             Drift crit  : ≥11.5V from baseline (5% Vn), ≥10 samples

  Inverter — Vn=220V, ±5% tolerance   (local inverter/UPS spec)
             Normal band : 209V – 231V
             Dropout warn: < 209V (0.95 pu), 2–4 samples
             Dropout crit: < 176V (0.80 pu), ≥5 samples
             Instant crit: < 22V  (0.10 pu)
             Spike warn  : |ΔV| ≥ 11.0V (5% Vn)
             Spike crit  : |ΔV| ≥ 22.0V (10% Vn)
             Drift warn  : ≥11.0V from baseline (5% Vn), ≥5 samples
             Drift crit  : ≥22.0V from baseline (10% Vn), ≥10 samples

Context check: suppresses false anomalies caused by normal load-switching
(ΔI/ΔP correlation with voltage change).

Usage:
    from anomaly_engine import AnomalyEngine, SensorSample

    _ae_grid     = AnomalyEngine(vn=230.0, drop_warn_pu=0.90, source="grid")
    _ae_inverter = AnomalyEngine(vn=220.0, drop_warn_pu=0.95, source="inverter")  # 209V normal low

    result = _ae_grid.process(SensorSample(voltage=v, current=i, power=p))
    print(result.anomaly_type, result.severity, result.detail)
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Per-unit thresholds — based on approved ino detection logic
# All voltage thresholds derived from vn passed into AnomalyEngine.__init__()
# ─────────────────────────────────────────────────────────────────────────────

# Dropout
DROP_INSTANT_PU      = 0.10   # < 0.10 pu → instant Critical  (23V / 22V)
DROP_CRIT_PU         = 0.80   # < 0.80 pu → Critical after ≥5 samples (184V / 176V)
DROP_WARN_MIN        = 2      # samples before Warning fires
DROP_WARN_MAX        = 4
DROP_CRIT_MIN        = 5      # samples before Critical fires
DROP_CRIT_LONG       = 20     # prolonged dropout

# Spike — fraction of Vn (same for Grid and Inverter)
SPIKE_WARN_PCT       = 0.05   # |ΔV| ≥ 5%  Vn → Warning  (11.5V / 11.0V)
SPIKE_CRIT_PCT       = 0.10   # |ΔV| ≥ 10% Vn → Critical (23.0V / 22.0V)
SPIKE_MAX_DUR        = 3      # max samples before spike expires → transitions to Drift

# Drift — fraction of Vn deviation from locked baseline
DRIFT_WARN_PCT_GRID  = 0.03   # 3%  Vn → Warning  (6.9V for 230V)  — utility is stable
DRIFT_CRIT_PCT_GRID  = 0.05   # 5%  Vn → Critical (11.5V for 230V)
DRIFT_WARN_PCT_INV   = 0.03   # 3%  Vn → Warning  (6.6V for 220V)  — match tables
DRIFT_CRIT_PCT_INV   = 0.05   # 5%  Vn → Critical (11.0V for 220V) — match tables
DRIFT_WARN_SAMPLES   = 20     # ≥20 consecutive samples → Warning  (per tables)
DRIFT_CRIT_SAMPLES   = 40     # ≥40 consecutive samples → Critical (per tables)

# Context check (load-switching suppression)
CTX_CURR_DELTA_A     = 0.5    # |ΔI| > 0.5A  → likely load event
CTX_PWR_DELTA_W      = 10.0   # |ΔP| > 10W   → likely load event
CTX_SETTLE_SAMPLES   = 3

# Baseline rolling window
BASELINE_WINDOW      = 60     # ~9s at 0.15s/sample (PZEM-004T poll rate)


# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SensorSample:
    voltage   : float
    current   : float = 0.0
    power     : float = 0.0
    timestamp : float = field(default_factory=time.time)


@dataclass
class AnomalyResult:
    anomaly_type : str    # "Normal" | "Dropout" | "Spike" | "Drift"
    severity     : str    # "Normal" | "Warning" | "Critical"
    detail       : str    # human-readable message
    voltage      : float
    delta_v      : float = 0.0
    pu           : float = 0.0
    confirmed    : bool  = True   # False if context-check suppresses it
    context_note : str   = ""
    source       : str   = ""     # "grid" | "inverter"


# ─────────────────────────────────────────────────────────────────────────────
# Main engine
# ─────────────────────────────────────────────────────────────────────────────

class AnomalyEngine:
    """
    Stateful AC voltage anomaly engine — one instance per source.

    Args:
        vn           : Nominal voltage (V)
                       Grid     → 230.0  (IEC 60038 PH)
                       Inverter → 220.0  (local inverter/UPS spec)
        drop_warn_pu : Per-unit dropout warning threshold
                       Grid     → 0.90  (warn < 207V)
                       Inverter → 0.95  (warn < 209V)
        source       : "grid" or "inverter" (for logging/labeling)
    """

    def __init__(
        self,
        vn           : float = 230.0,
        drop_warn_pu : float = 0.90,
        source       : str   = "ac",
    ) -> None:
        self.vn     = vn
        self.source = source

        # ── Computed thresholds (all derived from vn) ─────────────────────
        self._drop_instant_v = DROP_INSTANT_PU   * vn    # 23.0V / 22.0V
        self._drop_crit_v    = DROP_CRIT_PU      * vn    # 184.0V / 176.0V
        self._drop_warn_v    = drop_warn_pu      * vn    # 207.0V / 209.0V

        self._spike_warn_v   = SPIKE_WARN_PCT    * vn    # 11.5V / 11.0V
        self._spike_crit_v   = SPIKE_CRIT_PCT    * vn    # 23.0V / 22.0V
        self._spike_ret_v    = self._spike_warn_v * 0.5  # return-to-baseline threshold

        # Grid uses tighter drift band (utility is more stable)
        _is_inverter         = (vn <= 220.0)
        self._drift_warn_v   = (DRIFT_WARN_PCT_INV  if _is_inverter else DRIFT_WARN_PCT_GRID) * vn
        self._drift_crit_v   = (DRIFT_CRIT_PCT_INV  if _is_inverter else DRIFT_CRIT_PCT_GRID) * vn

        # Normal band — spike only fires if voltage exits this band
        # Grid: 207V–253V  |  Inverter: 209V–231V
        self._normal_low     = self._drop_warn_v          # same as dropout warn floor
        self._normal_high    = vn * (1.10 if not _is_inverter else 1.05)

        # ── State ─────────────────────────────────────────────────────────
        self._v_history      : Deque[float] = deque(maxlen=max(DRIFT_CRIT_SAMPLES + 5, BASELINE_WINDOW))
        self._i_history      : Deque[float] = deque(maxlen=CTX_SETTLE_SAMPLES + 5)
        self._p_history      : Deque[float] = deque(maxlen=CTX_SETTLE_SAMPLES + 5)

        self._drop_counter   : int           = 0
        self._spike_active   : bool          = False
        self._spike_dur      : int           = 0
        self._spike_delta    : float         = 0.0
        self._spike_ref_v    : float         = vn
        self._drift_samples  : int           = 0
        self._drift_start_v  : Optional[float] = None
        self._stable_baseline: Optional[float] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def process(self, sample: SensorSample) -> AnomalyResult:
        v   = sample.voltage
        cur = sample.current
        pwr = sample.power
        pu  = v / self.vn if self.vn else 0.0
        dv  = self._delta_v(v)

        self._v_history.append(v)
        self._i_history.append(cur)
        self._p_history.append(pwr)

        def _r(atype, sev, detail, **kw) -> AnomalyResult:
            return AnomalyResult(
                anomaly_type=atype, severity=sev, detail=detail,
                voltage=v, pu=pu, delta_v=dv, source=self.source, **kw
            )

        # ── Step 1: 0V or missing — instant Dropout Critical ─────────────
        if v <= 0:
            self._drop_counter += 1
            return _r("Dropout", "Critical",
                      f"AC voltage is 0V — source offline or sensor disconnect "
                      f"[{self.source.upper()}] (sample {self._drop_counter})")

        # ── Step 2: Dropout detection ─────────────────────────────────────
        result = self._check_dropout(v, pu, dv)
        if result:
            return self._context_check(result, dv, sample)

        was_dropping = self._drop_counter > 0
        self._drop_counter = 0

        # After dropout recovery — reset all detection state
        if was_dropping:
            self._spike_active    = False
            self._spike_dur       = 0
            self._spike_delta     = 0.0
            self._spike_ref_v     = self.vn
            self._drift_samples   = 0
            self._drift_start_v   = None
            self._stable_baseline = None
            self._v_history.clear()

        # ── Step 3: Spike detection ───────────────────────────────────────
        # Skip if recovering from dropout or currently in a drift
        if not was_dropping and self._drift_samples == 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._context_check(result, dv, sample)

        # ── Step 4: Drift detection ───────────────────────────────────────
        result = self._check_drift(v, pu, dv)
        if result:
            return self._context_check(result, dv, sample)

        # Deferred spike check (when drift was active)
        if not was_dropping and self._drift_samples != 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._context_check(result, dv, sample)

        # ── Step 5: Normal ────────────────────────────────────────────────
        # Note: drift state (_drift_samples, _drift_start_v) is managed by
        # _check_drift() — do NOT reset here, or accumulating drift resets every cycle.
        if self._drift_samples == 0:
            self._drift_start_v = None
            bl = self._baseline()
            if bl is not None:                    # only update if we have enough history
                self._stable_baseline = bl
            # else keep existing value (seeded on dropout recovery or spike resolution)
        return _r("Normal", "Normal",
                  f"AC voltage {v:.1f}V ({pu:.3f} pu) — within normal operating band")

    # ── Dropout ───────────────────────────────────────────────────────────────

    def _check_dropout(self, v: float, pu: float, dv: float) -> Optional[AnomalyResult]:
        def _r(sev, detail):
            return AnomalyResult(anomaly_type="Dropout", severity=sev, detail=detail,
                                 voltage=v, pu=pu, delta_v=dv, source=self.source)

        # Zone 1: Instant Critical — < 0.10 pu (< 23V / 22V)
        if pu < DROP_INSTANT_PU:
            self._drop_counter += 1
            return _r("Critical",
                      f"{v:.1f}V ({pu:.3f} pu) — near-zero, interruption-level dropout "
                      f"[sample {self._drop_counter}]")

        # Zone 2: Critical band — < 0.80 pu (< 184V / 176V)
        if v < self._drop_crit_v:
            self._drop_counter += 1
            if self._drop_counter >= DROP_CRIT_MIN:
                return _r("Critical",
                          f"{v:.1f}V ({pu:.3f} pu) — sustained undervoltage "
                          f"[{self._drop_counter} samples, ≥{DROP_CRIT_MIN} → Critical]")
            elif self._drop_counter >= DROP_WARN_MIN:
                return _r("Warning",
                          f"{v:.1f}V ({pu:.3f} pu) — severe undervoltage "
                          f"[{self._drop_counter} samples, Critical if ≥{DROP_CRIT_MIN}]")
            else:
                return _r("Warning",
                          f"{v:.1f}V ({pu:.3f} pu) — below 0.80 pu threshold "
                          f"[{self._drop_counter} sample]")

        # Zone 3: Warning band — < drop_warn_v (< 207V / 209V)
        if v < self._drop_warn_v:
            self._drop_counter += 1
            if self._drop_counter < DROP_WARN_MIN:
                return _r("Warning",
                          f"{v:.1f}V ({pu:.3f} pu) — undervoltage onset "
                          f"[{self._drop_counter} sample]")
            elif self._drop_counter <= DROP_WARN_MAX:
                return _r("Warning",
                          f"{v:.1f}V ({pu:.3f} pu) — undervoltage "
                          f"[{self._drop_counter} samples]")
            else:
                return _r("Warning",
                          f"{v:.1f}V ({pu:.3f} pu) — prolonged undervoltage "
                          f"[{self._drop_counter} samples]")

        return None

    # ── Spike ─────────────────────────────────────────────────────────────────

    def _check_spike(self, v: float, pu: float, dv: float) -> Optional[AnomalyResult]:
        abs_dv = abs(dv)

        def _r(sev, detail):
            return AnomalyResult(anomaly_type="Spike", severity=sev, detail=detail,
                                 voltage=v, pu=pu, delta_v=dv, source=self.source)

        if self._spike_active:
            self._spike_dur += 1

            # Returned to baseline? — resolve if close to ref OR back in normal band
            in_band  = self._normal_low <= v <= self._normal_high
            near_ref = abs(v - self._spike_ref_v) <= self._spike_ret_v
            if near_ref or (in_band and self._spike_dur <= SPIKE_MAX_DUR):
                spike_was_out = not (self._normal_low <= (self._spike_ref_v + self._spike_delta) <= self._normal_high)
                if near_ref or spike_was_out:
                    self._spike_active    = False
                    self._stable_baseline = self._spike_ref_v
                    self._drift_start_v   = self._spike_ref_v
                    sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                    return _r(sev,
                              f"Spike resolved — ΔV={self._spike_delta:+.1f}V "
                              f"({abs(self._spike_delta)/self.vn*100:.1f}% Vn), "
                              f"{self._spike_dur} samples, returned to normal band")

            # Escalating
            if abs_dv >= self._spike_warn_v:
                if abs(dv) > abs(self._spike_delta):
                    self._spike_delta = dv
                sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                return _r(sev,
                          f"Spike escalating — ΔV={dv:+.1f}V, "
                          f"peak ΔV={self._spike_delta:+.1f}V "
                          f"[{self._spike_dur}/{SPIKE_MAX_DUR} samples]")

            # Exceeded max duration — not a spike, becomes Drift territory
            if self._spike_dur > SPIKE_MAX_DUR:
                self._spike_active = False
                self._spike_dur    = 0
                return None

            sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
            return _r(sev,
                      f"Spike ongoing — ΔV={self._spike_delta:+.1f}V "
                      f"[{self._spike_dur}/{SPIKE_MAX_DUR} samples]")

        # New spike onset — triggered by ΔV threshold
        # Guard: if BOTH old and new voltage are within normal band,
        # it's normal operating variation, not a spike.
        if abs_dv >= self._spike_warn_v:
            ref_v = self._stable_baseline if self._stable_baseline is not None else self.vn
            both_in_band = (
                self._normal_low <= v <= self._normal_high and
                self._normal_low <= ref_v <= self._normal_high
            )
            if both_in_band:
                return None  # normal variation within band — not a spike
            self._spike_active = True
            self._spike_dur    = 1
            self._spike_delta  = dv
            # Lock ref to pre-spike baseline (the previous stable reading, NOT current v)
            self._spike_ref_v  = ref_v
            # Clear stable_baseline — spike samples should not contaminate drift reference
            self._stable_baseline = None
            sev = "Critical" if abs_dv >= self._spike_crit_v else "Warning"
            return _r(sev,
                      f"Spike onset — ΔV={dv:+.1f}V "
                      f"({abs_dv/self.vn*100:.1f}% Vn) — "
                      f"threshold: ≥{int(SPIKE_CRIT_PCT*100) if sev=='Critical' else int(SPIKE_WARN_PCT*100)}% Vn")

        return None

    # ── Drift ─────────────────────────────────────────────────────────────────

    def _check_drift(self, v: float, pu: float, dv: float) -> Optional[AnomalyResult]:
        baseline = self._baseline()
        if baseline is None:
            return None

        # Use locked baseline — rolling average would drift WITH the voltage, masking it
        if self._drift_start_v is not None:
            ref = self._drift_start_v
        elif self._stable_baseline is not None:
            ref = self._stable_baseline
        else:
            hist = list(self._v_history)
            half = max(1, len(hist) // 2)
            ref  = sum(hist[:half]) / half

        deviation = abs(v - ref)

        if deviation < self._drift_warn_v:
            self._drift_samples = 0
            self._drift_start_v = None
            return None

        # Lock the reference at first detection
        if self._drift_start_v is None:
            self._drift_start_v = ref

        self._drift_samples += 1

        # Require consistent direction (not just noise fluctuation)
        if not self._is_consistent_drift() and deviation < self._drift_crit_v:
            self._drift_samples = max(0, self._drift_samples - 1)
            return None

        def _r(sev, detail):
            return AnomalyResult(anomaly_type="Drift", severity=sev, detail=detail,
                                 voltage=v, pu=pu, delta_v=dv, source=self.source)

        direction = "below" if v < ref else "above"

        if deviation >= self._drift_crit_v and self._drift_samples >= DRIFT_CRIT_SAMPLES:
            return _r("Critical",
                      f"Drift {deviation:.1f}V {direction} baseline "
                      f"({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")

        if deviation >= self._drift_warn_v and self._drift_samples >= DRIFT_WARN_SAMPLES:
            return _r("Warning",
                      f"Drift {deviation:.1f}V {direction} baseline "
                      f"({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")

        return None

    # ── Context check (load-switching suppression) ────────────────────────────

    def _context_check(self, result: AnomalyResult, dv: float,
                       sample: SensorSample) -> AnomalyResult:
        """Suppress false anomalies caused by normal load ON/OFF events."""
        if len(self._i_history) < 2 or len(self._p_history) < 2:
            return result

        di = self._i_history[-1] - self._i_history[-2]
        dp = self._p_history[-1] - self._p_history[-2]

        load_event = False
        note       = ""

        if dv < 0 and (di > CTX_CURR_DELTA_A or dp > CTX_PWR_DELTA_W):
            load_event = True
            note = (f"V drop ({dv:+.1f}V) coincides with load increase "
                    f"(ΔI={di:+.2f}A, ΔP={dp:+.1f}W) — likely Load ON event")
        elif dv > 0 and (di < -CTX_CURR_DELTA_A or dp < -CTX_PWR_DELTA_W):
            load_event = True
            note = (f"V rise ({dv:+.1f}V) coincides with load decrease "
                    f"(ΔI={di:+.2f}A, ΔP={dp:+.1f}W) — likely Load OFF event")

        if load_event:
            if self._settling_check():
                result.confirmed    = False
                result.context_note = note + " — suppressed (voltage settled after event)"
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
        window = hist[-BASELINE_WINDOW:] if len(hist) >= BASELINE_WINDOW else hist
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
        if len(hist) < CTX_SETTLE_SAMPLES:
            return False
        recent   = hist[-CTX_SETTLE_SAMPLES:]
        baseline = self._baseline() or self.vn
        return all(abs(v - baseline) < self._drift_warn_v for v in recent)

    def reset(self) -> None:
        """Full state reset — call on sensor reconnect or system restart."""
        self._v_history.clear()
        self._i_history.clear()
        self._p_history.clear()
        self._drop_counter    = 0
        self._spike_active    = False
        self._spike_dur       = 0
        self._spike_delta     = 0.0
        self._spike_ref_v     = self.vn
        self._drift_samples   = 0
        self._drift_start_v   = None
        self._stable_baseline = None


# ─────────────────────────────────────────────────────────────────────────────
# Convenience wrappers — one per AC source
# ─────────────────────────────────────────────────────────────────────────────

_grid_engine    : Optional[AnomalyEngine] = None
_inverter_engine: Optional[AnomalyEngine] = None


def detect_grid(voltage: float, current: float = 0.0, power: float = 0.0) -> AnomalyResult:
    """
    Stateful grid anomaly detection.
    Vn=230V, ±10% tolerance → Normal band: 207V–253V
    """
    global _grid_engine
    if _grid_engine is None:
        _grid_engine = AnomalyEngine(vn=230.0, drop_warn_pu=0.90, source="grid")
    return _grid_engine.process(SensorSample(voltage=voltage, current=current, power=power))


def detect_inverter(voltage: float, current: float = 0.0, power: float = 0.0) -> AnomalyResult:
    """
    Stateful inverter anomaly detection.
    Vn=220V, ±5% tolerance → Normal band: 209V–231V
    """
    global _inverter_engine
    if _inverter_engine is None:
        _inverter_engine = AnomalyEngine(vn=220.0, drop_warn_pu=0.95, source="inverter")
    return _inverter_engine.process(SensorSample(voltage=voltage, current=current, power=power))


def detect(voltage: float, current: float = 0.0, power: float = 0.0) -> AnomalyResult:
    """Legacy alias — defaults to grid engine."""
    return detect_grid(voltage=voltage, current=current, power=power)


# ─────────────────────────────────────────────────────────────────────────────
# Self-test
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 90)
    print("GRID ENGINE — Vn=230V | ±10% | Normal: 207–253V")
    print("  Dropout: warn<207V(0.90pu) | crit<184V(0.80pu) | instant<23V(0.10pu)")
    print("  Spike  : warn≥11.5V(5%Vn) | crit≥23V(10%Vn)")
    print("  Drift  : warn≥6.9V(3%Vn)≥5s | crit≥11.5V(5%Vn)≥10s")
    print("=" * 90)
    g = AnomalyEngine(vn=230.0, drop_warn_pu=0.90, source="grid")
    grid_cases = [
        ("Normal 230V",        230.0, 2.0,  460.0),
        ("Normal 215V (OK)",   215.0, 2.0,  430.0),
        ("Dropout warn s1",    205.0, 1.8,  370.0),
        ("Dropout warn s2",    205.0, 1.8,  370.0),
        ("Dropout warn s3",    205.0, 1.8,  370.0),
        ("Dropout crit band",  183.0, 1.5,  310.0),
        ("Dropout crit band",  183.0, 1.5,  310.0),
        ("Dropout crit band",  183.0, 1.5,  310.0),
        ("Dropout crit band",  183.0, 1.5,  310.0),
        ("Dropout crit band",  183.0, 1.5,  310.0),
        ("Recovery",           230.0, 2.0,  460.0),
        ("Spike warn",         242.0, 2.1,  462.0),
        ("Return base",        230.5, 2.0,  461.0),
        ("Spike crit",         256.0, 2.2,  563.0),
        ("Return base",        230.0, 2.0,  460.0),
        ("Drift warn s1",      222.0, 1.9,  420.0),
        ("Drift warn s2",      221.5, 1.9,  420.0),
        ("Drift warn s3",      221.0, 1.9,  420.0),
        ("Drift warn s4",      220.5, 1.9,  419.0),
        ("Drift warn s5",      220.0, 1.9,  418.0),
        ("Load ON (ctx)",      222.0, 5.0,  990.0),
        ("Instant crit 0V",      0.0, 0.0,    0.0),
    ]
    print(f"{'Scenario':<22}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 90)
    for label, v, i, p in grid_cases:
        r = g.process(SensorSample(voltage=v, current=i, power=p))
        flag = "" if r.confirmed else " [ctx-suppressed]"
        print(f"{label:<22}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.1f}  {r.delta_v:>+7.2f}  {r.detail[:55]}{flag}")

    print()
    print("=" * 90)
    print("INVERTER ENGINE — Vn=220V | ±5% | Normal: 209–231V")
    print("  Dropout: warn<209V(0.95pu) | crit<176V(0.80pu) | instant<22V(0.10pu)")
    print("  Spike  : warn≥11V(5%Vn) | crit≥22V(10%Vn)")
    print("  Drift  : warn≥11V(5%Vn)≥5s | crit≥22V(10%Vn)≥10s")
    print("=" * 90)
    inv = AnomalyEngine(vn=220.0, drop_warn_pu=0.95, source="inverter")
    inv_cases = [
        ("Normal 220V",        220.0, 3.0,  660.0),
        ("Normal 215V (OK)",   215.0, 3.0,  645.0),
        ("Normal 225V (OK)",   225.0, 3.0,  675.0),
        ("Dropout warn s1",    207.0, 2.8,  580.0),
        ("Dropout warn s2",    207.0, 2.8,  580.0),
        ("Dropout warn s3",    207.0, 2.8,  580.0),
        ("Dropout crit band",  174.0, 2.5,  435.0),
        ("Dropout crit band",  174.0, 2.5,  435.0),
        ("Dropout crit band",  174.0, 2.5,  435.0),
        ("Dropout crit band",  174.0, 2.5,  435.0),
        ("Dropout crit band",  174.0, 2.5,  435.0),
        ("Recovery",           220.0, 3.0,  660.0),
        ("Spike warn",         232.0, 3.1,  719.0),
        ("Return base",        220.5, 3.0,  661.5),
        ("Spike crit",         244.0, 3.2,  780.0),
        ("Return base",        220.0, 3.0,  660.0),
        ("Load ON (ctx)",      216.0, 7.0, 1540.0),
        ("Instant crit 0V",      0.0, 0.0,    0.0),
    ]
    print(f"{'Scenario':<22}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 90)
    for label, v, i, p in inv_cases:
        r = inv.process(SensorSample(voltage=v, current=i, power=p))
        flag = "" if r.confirmed else " [ctx-suppressed]"
        print(f"{label:<22}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.1f}  {r.delta_v:>+7.2f}  {r.detail[:55]}{flag}")
