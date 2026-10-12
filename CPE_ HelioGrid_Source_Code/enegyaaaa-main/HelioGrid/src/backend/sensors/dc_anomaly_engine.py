"""
dc_anomaly_engine.py  —  HelioGrid DC Voltage Anomaly Detection
================================================================
Detects voltage anomalies for DC sources (Battery and Solar PV).
Based on voltage_anomaly_ina219.ino approved detection logic,
adapted for DC with correct per-unit thresholds per source.

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
  Battery  — Vn=24V  (2× JSL 12V 100Ah in series)
             Normal band  : 23V – 27.5V  (inverter ON / solar source)
             Normal idle  : 24V – 26V    (standby, no charge/discharge)
             Full charge  : 27.5V
             Overcharge   : > 29V → instant Critical
             Dropout warn : < 22.8V (0.95 pu), 2–4 samples
             Dropout crit : < 21.6V (0.90 pu), ≥5 samples
             Instant crit : = 0V  (sensor disconnect or hard fault)
             Spike warn   : |ΔV| ≥ 2.4V (10% Vn)
             Spike crit   : |ΔV| ≥ 4.8V (20% Vn)
             Drift warn   : ≥3.6V from baseline (15% Vn), ≥10 samples
             Drift crit   : ≥4.8V from baseline (20% Vn), ≥20 samples

  Solar    — Vn=84.74V  (2S2P JAM72D40-580, Vmp=42.37V×2)
             Normal band  : 80V – 105V   (daytime operating range)
             Voc limit    : ~104.74V     (2×Voc per panel ≈52.37V)
             Night 0V     : Normal       (handled by Flask time check)
             Dropout warn : < 63.7V (0.75 pu), 2–4 samples
             Dropout crit : < 35.2V (0.41 pu), ≥5 samples
             Instant crit : 0V daytime   (Flask passes is_daytime flag)
             Spike warn   : |ΔV| ≥ 8.5V  (10% Vn)
             Spike crit   : |ΔV| ≥ 16.9V (20% Vn)
             Drift warn   : ≥6.8V from baseline (8% Vn), ≥10 samples
             Drift crit   : ≥12.7V from baseline (15% Vn), ≥20 samples

String mismatch detection (current-based, 30%/50% deviation) is handled
by flask_unified_complete.py and is separate from this engine.

Usage:
    from dc_anomaly_engine import DCAnomalyEngine, DCSensorSample

    _bat_engine = DCAnomalyEngine(vn=24.0,    source="battery")
    _sol_engine = DCAnomalyEngine(vn=84.74,   source="solar")

    result = _bat_engine.process(DCSensorSample(voltage=v))
    result = _sol_engine.process(DCSensorSample(voltage=v), is_daytime=True)
    print(result.anomaly_type, result.severity, result.detail)
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Per-unit thresholds — based on approved ino detection logic
# All voltage thresholds derived from vn passed into DCAnomalyEngine.__init__()
# ─────────────────────────────────────────────────────────────────────────────

# Dropout
DC_DROP_WARN_MIN        = 2       # samples before Warning fires
DC_DROP_WARN_MAX        = 4
DC_DROP_CRIT_MIN        = 5       # samples before Critical fires
DC_DROP_CRIT_LONG       = 20      # prolonged dropout

# Battery-specific dropout per-unit
BAT_DROP_WARN_PU        = 0.95    # < 0.95 pu = < 22.8V → Warning
BAT_DROP_CRIT_PU        = 0.90    # < 0.90 pu = < 21.6V → Critical (deep discharge)
BAT_OVERCHARGE_V        = 29.0    # > 29V → overcharge Critical (fixed threshold)

# Solar-specific dropout per-unit
SOL_DROP_WARN_PU        = 0.75    # < 0.75 pu = < 63.5V → Warning (partial cloud/evening)
SOL_DROP_CRIT_PU        = 0.41    # < 0.41 pu = < 34.7V → Critical (major fault)

# Spike — fraction of Vn
# Battery normal charging range is 24V–27.5V = 3.5V = 14.6% of 24V Vn.
# To avoid false-spiking normal charge/discharge transitions, battery
# spike warn must be > 14.6% Vn. Use 20% warn / 30% crit.
# Solar uses 10% warn / 20% crit — PV voltage is more stable per-cycle.
BAT_SPIKE_WARN_PCT      = 0.20    # battery |ΔV| ≥ 20% Vn = 4.8V → Warning
BAT_SPIKE_CRIT_PCT      = 0.30    # battery |ΔV| ≥ 30% Vn = 7.2V → Critical
SOL_SPIKE_WARN_PCT      = 0.10    # solar   |ΔV| ≥ 10% Vn = 8.5V → Warning
SOL_SPIKE_CRIT_PCT      = 0.20    # solar   |ΔV| ≥ 20% Vn = 16.9V → Critical
DC_SPIKE_MAX_DUR        = 3       # max samples before spike expires

# Drift — fraction of Vn deviation from locked baseline
# Battery: tighter — lead acid should be stable under normal conditions
BAT_DRIFT_WARN_PCT      = 0.15    # ≥ 15% Vn → Warning  (3.6V for 24V)
BAT_DRIFT_CRIT_PCT      = 0.20    # ≥ 20% Vn → Critical (4.8V for 24V)
# Solar: wider — PV naturally varies with irradiance
SOL_DRIFT_WARN_PCT      = 0.08    # ≥ 8%  Vn → Warning  (6.8V for 84.74V)
SOL_DRIFT_CRIT_PCT      = 0.15    # ≥ 15% Vn → Critical (12.7V for 84.74V)

DC_DRIFT_WARN_SAMPLES   = 10      # ≥10 consecutive samples → Warning
DC_DRIFT_CRIT_SAMPLES   = 20      # ≥20 consecutive samples → Critical

# Context check (load-switching suppression)
DC_CTX_CURR_DELTA_A     = 1.0     # |ΔI| > 1.0A → likely load event
DC_CTX_PWR_DELTA_W      = 5.0     # |ΔP| > 5W   → likely load event
DC_CTX_SETTLE_SAMPLES   = 3

# Baseline window
DC_BASELINE_WINDOW      = 30      # samples (~150s at 5s/sample)


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
    detail       : str    # human-readable message
    voltage      : float
    delta_v      : float = 0.0
    pu           : float = 0.0
    confirmed    : bool  = True   # False if context-check suppresses it
    context_note : str   = ""
    source       : str   = ""     # "battery" | "solar"


# ─────────────────────────────────────────────────────────────────────────────
# Main engine
# ─────────────────────────────────────────────────────────────────────────────

class DCAnomalyEngine:
    """
    Stateful DC voltage anomaly engine — one instance per source.

    Args:
        vn           : Nominal DC voltage (V)
                       Battery → 24.0   (2× JSL 12V 100Ah series)
                       Solar   → 84.74  (2S2P JAM72D40-580, Vmp×2)
        source       : "battery" or "solar" (for logging/labeling)
        drop_warn_pu : Per-unit dropout warning threshold
                       Battery → 0.95  (warn < 22.8V)
                       Solar   → 0.75  (warn < 63.5V)
        drop_crit_pu : Per-unit dropout critical threshold
                       Battery → 0.90  (crit < 21.6V)
                       Solar   → 0.41  (crit < 34.7V)
        drift_warn_pct: Drift warning fraction of Vn
        drift_crit_pct: Drift critical fraction of Vn
    """

    def __init__(
        self,
        vn             : float = 24.0,
        source         : str   = "dc",
        drop_warn_pu   : float = BAT_DROP_WARN_PU,
        drop_crit_pu   : float = BAT_DROP_CRIT_PU,
        drift_warn_pct : float = BAT_DRIFT_WARN_PCT,
        drift_crit_pct : float = BAT_DRIFT_CRIT_PCT,
        spike_warn_pct : float = BAT_SPIKE_WARN_PCT,
        spike_crit_pct : float = BAT_SPIKE_CRIT_PCT,
    ) -> None:
        self.vn     = vn
        self.source = source

        # ── Computed thresholds (all derived from vn) ─────────────────────
        self._drop_warn_v    = drop_warn_pu    * vn    # 22.8V / 63.5V
        self._drop_crit_v    = drop_crit_pu    * vn    # 21.6V / 34.7V

        self._spike_warn_v   = spike_warn_pct  * vn    # bat: 4.8V | sol: 8.5V
        self._spike_crit_v   = spike_crit_pct  * vn    # bat: 7.2V | sol: 16.9V
        self._spike_ret_v    = self._spike_warn_v * 0.5

        self._drift_warn_v   = drift_warn_pct  * vn    # 3.6V / 6.8V
        self._drift_crit_v   = drift_crit_pct  * vn    # 4.8V / 12.7V

        # Normal band — spike only fires if voltage exits this band
        # Battery: 22.8V–29V  |  Solar: 63.5V–105V (Voc limit)
        self._normal_low     = drop_warn_pu * vn       # same as dropout warn floor
        self._normal_high    = (29.0 if source == "battery"
                                else vn * 1.24)        # solar: ~105V (Voc≈104.74V)

        # ── State ─────────────────────────────────────────────────────────
        self._v_history      : Deque[float] = deque(maxlen=max(DC_DRIFT_CRIT_SAMPLES + 5, DC_BASELINE_WINDOW))
        self._i_history      : Deque[float] = deque(maxlen=DC_CTX_SETTLE_SAMPLES + 5)
        self._p_history      : Deque[float] = deque(maxlen=DC_CTX_SETTLE_SAMPLES + 5)

        self._drop_counter   : int           = 0
        self._spike_active   : bool          = False
        self._spike_dur      : int           = 0
        self._spike_delta    : float         = 0.0
        self._spike_ref_v    : float         = vn
        self._drift_samples  : int           = 0
        self._drift_start_v  : Optional[float] = None
        self._stable_baseline: Optional[float] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def process(self, sample: DCSensorSample, is_daytime: bool = True) -> DCAnomalyResult:
        """
        Process one DC voltage sample.

        Args:
            sample     : DCSensorSample with voltage, current, power
            is_daytime : For solar only — if False and voltage=0V, treat as Normal (night).
                         Flask checks time (6AM–6PM) and passes this flag.
                         Battery ignores this flag.
        """
        v   = sample.voltage
        cur = sample.current
        pwr = sample.power
        pu  = v / self.vn if self.vn else 0.0
        dv  = self._delta_v(v)

        self._v_history.append(v)
        self._i_history.append(cur)
        self._p_history.append(pwr)

        def _r(atype, sev, detail, **kw) -> DCAnomalyResult:
            return DCAnomalyResult(
                anomaly_type=atype, severity=sev, detail=detail,
                voltage=v, pu=pu, delta_v=dv, source=self.source, **kw
            )

        # ── Step 1: 0V handling — different per source ────────────────────
        if v <= 0:
            # Battery: always instant Critical (should never be 0V)
            if self.source == "battery":
                self._drop_counter += 1
                return _r("Dropout", "Critical",
                          f"Battery voltage is 0V — immediate Critical: "
                          f"sensor disconnect or hard fault [sample {self._drop_counter}]")
            # Solar: 0V at night is Normal; 0V daytime is Dropout Critical
            else:
                if not is_daytime:
                    return _r("Normal", "Normal",
                              "Solar voltage 0V — nighttime, no irradiance (Normal)")
                else:
                    self._drop_counter += 1
                    return _r("Dropout", "Critical",
                              f"Solar voltage 0V during daytime — panel disconnect or fault "
                              f"[sample {self._drop_counter}]")

        # ── Step 2: Battery overcharge check ─────────────────────────────
        if self.source == "battery" and v > BAT_OVERCHARGE_V:
            return _r("Spike", "Critical",
                      f"Battery overcharge — {v:.2f}V > {BAT_OVERCHARGE_V}V limit "
                      f"(charge controller fault or runaway charging)")

        # ── Step 3: Dropout detection ─────────────────────────────────────
        result = self._check_dropout(v, pu, dv)
        if result:
            return self._ctx(result, dv, sample)

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
            self._stable_baseline = v        # seed baseline from first recovery reading
            self._v_history.clear()

        # ── Step 4: Spike detection ───────────────────────────────────────
        # Skip if recovering from dropout or currently in a drift
        if not was_dropping and self._drift_samples == 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._ctx(result, dv, sample)

        # ── Step 5: Drift detection ───────────────────────────────────────
        result = self._check_drift(v, pu, dv)
        if result:
            return self._ctx(result, dv, sample)

        # Deferred spike check (when drift was active)
        if not was_dropping and self._drift_samples != 0:
            result = self._check_spike(v, pu, dv)
            if result:
                return self._ctx(result, dv, sample)

        # ── Step 6: Normal ────────────────────────────────────────────────
        # Note: drift state is managed by _check_drift() — do NOT reset here.
        if self._drift_samples == 0:
            self._drift_start_v = None
            bl = self._baseline()
            if bl is not None:                    # only update if we have enough history
                self._stable_baseline = bl
            # else keep the seeded value (set on dropout recovery)
        return _r("Normal", "Normal",
                  f"DC voltage {v:.2f}V ({pu:.3f} pu) — within normal operating band")

    # ── Dropout ───────────────────────────────────────────────────────────────

    def _check_dropout(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Dropout", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        # Critical band — below crit threshold
        if v < self._drop_crit_v:
            self._drop_counter += 1
            if self._drop_counter >= DC_DROP_CRIT_MIN:
                return _r("Critical",
                          f"{v:.2f}V ({pu:.3f} pu) — sustained dropout "
                          f"[{self._drop_counter} samples, ≥{DC_DROP_CRIT_MIN} → Critical]")
            elif self._drop_counter >= DC_DROP_WARN_MIN:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — severe dropout "
                          f"[{self._drop_counter} samples, Critical if ≥{DC_DROP_CRIT_MIN}]")
            else:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — below critical threshold "
                          f"[{self._drop_counter} sample]")

        # Warning band — between crit and warn thresholds
        if v < self._drop_warn_v:
            self._drop_counter += 1
            if self._drop_counter < DC_DROP_WARN_MIN:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — undervoltage onset "
                          f"[{self._drop_counter} sample]")
            elif self._drop_counter <= DC_DROP_WARN_MAX:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — undervoltage "
                          f"[{self._drop_counter} samples]")
            else:
                return _r("Warning",
                          f"{v:.2f}V ({pu:.3f} pu) — prolonged undervoltage "
                          f"[{self._drop_counter} samples]")

        # ── Voltage is back above warn threshold — reset counter here ────
        # This ensures _drop_counter does not leak into subsequent samples
        # when voltage recovers to normal band. The outer process() also
        # resets it, but resetting here prevents stale state from
        # contaminating was_dropping logic and keeps _check_dropout pure.
        self._drop_counter = 0
        return None

    # ── Spike ─────────────────────────────────────────────────────────────────

    def _check_spike(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        abs_dv = abs(dv)

        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Spike", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        if self._spike_active:
            self._spike_dur += 1

            # Returned to baseline? — resolve if voltage is close to ref OR back in normal band
            in_band    = self._normal_low <= v <= self._normal_high
            near_ref   = abs(v - self._spike_ref_v) <= self._spike_ret_v
            if near_ref or (in_band and self._spike_dur <= DC_SPIKE_MAX_DUR):
                # Only resolve if the spike itself was OUT of band (not just ref-distance)
                spike_was_out = not (self._normal_low <= (self._spike_ref_v + self._spike_delta) <= self._normal_high)
                if near_ref or spike_was_out:
                    self._spike_active    = False
                    # Restore baseline from pre-spike reference
                    self._stable_baseline = self._spike_ref_v
                    # Also prime drift detection from the same pre-spike reference
                    self._drift_start_v   = self._spike_ref_v
                    sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                    return _r(sev,
                              f"Spike resolved — ΔV={self._spike_delta:+.2f}V "
                              f"({abs(self._spike_delta)/self.vn*100:.1f}% Vn), "
                              f"{self._spike_dur} samples, returned to normal band")

            # Escalating
            if abs_dv >= self._spike_warn_v:
                if abs(dv) > abs(self._spike_delta):
                    self._spike_delta = dv
                sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
                return _r(sev,
                          f"Spike escalating — ΔV={dv:+.2f}V, "
                          f"peak ΔV={self._spike_delta:+.2f}V "
                          f"[{self._spike_dur}/{DC_SPIKE_MAX_DUR} samples]")

            # Exceeded max duration — transitions to Drift territory
            if self._spike_dur > DC_SPIKE_MAX_DUR:
                self._spike_active = False
                self._spike_dur    = 0
                return None

            sev = "Critical" if abs(self._spike_delta) >= self._spike_crit_v else "Warning"
            return _r(sev,
                      f"Spike ongoing — ΔV={self._spike_delta:+.2f}V "
                      f"[{self._spike_dur}/{DC_SPIKE_MAX_DUR} samples]")

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
            self._spike_ref_v  = ref_v
            # Clear stable_baseline — spike samples should not contaminate drift reference
            self._stable_baseline = None
            sev = "Critical" if abs_dv >= self._spike_crit_v else "Warning"
            thr = self._spike_crit_v if sev == "Critical" else self._spike_warn_v
            return _r(sev,
                      f"Spike onset — ΔV={dv:+.2f}V "
                      f"({abs_dv/self.vn*100:.1f}% Vn) — "
                      f"threshold: ≥{thr/self.vn*100:.0f}% Vn ({thr:.1f}V)")

        return None

    # ── Drift ─────────────────────────────────────────────────────────────────

    def _check_drift(self, v: float, pu: float, dv: float) -> Optional[DCAnomalyResult]:
        baseline = self._baseline()
        if baseline is None:
            return None

        # Use locked baseline — rolling average would drift WITH voltage, masking it
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

        # Require consistent direction (not just noisy fluctuation)
        if not self._is_consistent_drift() and deviation < self._drift_crit_v:
            self._drift_samples = max(0, self._drift_samples - 1)
            return None

        def _r(sev, detail):
            return DCAnomalyResult(anomaly_type="Drift", severity=sev, detail=detail,
                                   voltage=v, pu=pu, delta_v=dv, source=self.source)

        direction = "below" if v < ref else "above"

        if deviation >= self._drift_crit_v and self._drift_samples >= DC_DRIFT_CRIT_SAMPLES:
            return _r("Critical",
                      f"Drift {deviation:.2f}V {direction} baseline "
                      f"({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")

        if deviation >= self._drift_warn_v and self._drift_samples >= DC_DRIFT_WARN_SAMPLES:
            return _r("Warning",
                      f"Drift {deviation:.2f}V {direction} baseline "
                      f"({deviation/self.vn*100:.1f}% Vn) — {self._drift_samples} samples")

        return None

    # ── Context check (load-switching suppression) ────────────────────────────

    def _ctx(self, result: DCAnomalyResult, dv: float, sample: DCSensorSample) -> DCAnomalyResult:
        """Suppress false anomalies caused by normal load ON/OFF events."""
        if len(self._i_history) < 2 or len(self._p_history) < 2:
            return result

        di = self._i_history[-1] - self._i_history[-2]
        dp = self._p_history[-1] - self._p_history[-2]

        load_event = False
        note       = ""

        if dv < 0 and (di > DC_CTX_CURR_DELTA_A or dp > DC_CTX_PWR_DELTA_W):
            load_event = True
            note = (f"V drop ({dv:+.2f}V) coincides with load increase "
                    f"(ΔI={di:+.2f}A, ΔP={dp:+.1f}W) — likely Load ON event")
        elif dv > 0 and (di < -DC_CTX_CURR_DELTA_A or dp < -DC_CTX_PWR_DELTA_W):
            load_event = True
            note = (f"V rise ({dv:+.2f}V) coincides with load decrease "
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
        if len(hist) < DC_CTX_SETTLE_SAMPLES:
            return False
        recent   = hist[-DC_CTX_SETTLE_SAMPLES:]
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
# Convenience wrappers — one per DC source
# ─────────────────────────────────────────────────────────────────────────────

_battery_engine : Optional[DCAnomalyEngine] = None
_solar_engine   : Optional[DCAnomalyEngine] = None


def detect_battery(voltage: float, current: float = 0.0, power: float = 0.0) -> DCAnomalyResult:
    """
    Stateful battery anomaly detection.
    Vn=24V (2× JSL 12V 100Ah series)
    Normal: 23V–27.5V (inverter+solar ON) / 24V–26V (idle)
    """
    global _battery_engine
    if _battery_engine is None:
        _battery_engine = DCAnomalyEngine(
            vn=24.0, source="battery",
            drop_warn_pu=BAT_DROP_WARN_PU,     # 0.95 → warn < 22.8V
            drop_crit_pu=BAT_DROP_CRIT_PU,     # 0.90 → crit < 21.6V
            drift_warn_pct=BAT_DRIFT_WARN_PCT,  # 0.15 → 3.6V
            drift_crit_pct=BAT_DRIFT_CRIT_PCT,  # 0.20 → 4.8V
            spike_warn_pct=BAT_SPIKE_WARN_PCT,  # 0.20 → 4.8V (above normal 3.5V charge range)
            spike_crit_pct=BAT_SPIKE_CRIT_PCT,  # 0.30 → 7.2V
        )
    return _battery_engine.process(
        DCSensorSample(voltage=voltage, current=current, power=power)
    )


def detect_solar(voltage: float, current: float = 0.0, power: float = 0.0,
                 is_daytime: bool = True) -> DCAnomalyResult:
    """
    Stateful solar PV anomaly detection.
    Vn=84.74V (2S2P JAM72D40-580, Vmp=42.37V×2)
    Normal daytime: 80V–105V
    is_daytime: pass from Flask time check (6AM–6PM).
                If False and voltage=0V → Normal (night). Default True.
    """
    global _solar_engine
    if _solar_engine is None:
        _solar_engine = DCAnomalyEngine(
            vn=84.74, source="solar",
            drop_warn_pu=SOL_DROP_WARN_PU,     # 0.75 → warn < 63.5V
            drop_crit_pu=SOL_DROP_CRIT_PU,     # 0.41 → crit < 34.7V
            drift_warn_pct=SOL_DRIFT_WARN_PCT,  # 0.08 → 6.8V
            drift_crit_pct=SOL_DRIFT_CRIT_PCT,  # 0.15 → 12.7V
            spike_warn_pct=SOL_SPIKE_WARN_PCT,  # 0.10 → 8.5V (but guarded by in-band check)
            spike_crit_pct=SOL_SPIKE_CRIT_PCT,  # 0.20 → 16.9V
        )
    return _solar_engine.process(
        DCSensorSample(voltage=voltage, current=current, power=power),
        is_daytime=is_daytime
    )


# ─────────────────────────────────────────────────────────────────────────────
# Self-test
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 90)
    print("BATTERY ENGINE — Vn=24V | 2× JSL 12V 100Ah series")
    print("  Normal  : 23V–27.5V (inverter+solar ON) | 24V–26V (idle)")
    print("  Dropout : warn<22.8V(0.95pu) | crit<21.6V(0.90pu) | 0V→instant Critical")
    print("  Overchg : >29V → instant Critical")
    print("  Spike   : warn≥4.8V(20%Vn) | crit≥7.2V(30%Vn)")
    print("  Drift   : warn≥3.6V(15%Vn)≥10s | crit≥4.8V(20%Vn)≥20s")
    print("=" * 90)
    bat = DCAnomalyEngine(
        vn=24.0, source="battery",
        drop_warn_pu=BAT_DROP_WARN_PU, drop_crit_pu=BAT_DROP_CRIT_PU,
        drift_warn_pct=BAT_DRIFT_WARN_PCT, drift_crit_pct=BAT_DRIFT_CRIT_PCT,
    )
    bat_cases = [
        ("Normal 25V",          25.0,  5.0, 125.0),
        ("Normal 26V (full)",   26.0,  4.8, 124.8),
        ("Normal 24V (idle)",   24.0,  0.5,  12.0),
        ("Dropout warn s1",     22.5,  2.0,  45.0),
        ("Dropout warn s2",     22.5,  2.0,  45.0),
        ("Dropout warn s3",     22.0,  1.8,  39.6),
        ("Dropout crit band",   21.0,  1.5,  31.5),
        ("Dropout crit band",   21.0,  1.5,  31.5),
        ("Dropout crit band",   21.0,  1.5,  31.5),
        ("Dropout crit band",   21.0,  1.5,  31.5),
        ("Dropout crit band",   21.0,  1.5,  31.5),
        ("Recovery",            24.5,  5.0, 122.5),
        ("Spike warn",          27.0,  5.2, 127.4),
        ("Return base",         24.2,  5.0, 121.0),
        ("Spike crit",          29.5,  5.5, 131.7),
        ("Return base",         24.0,  5.0, 120.0),
        ("Overcharge crit",     30.0,  0.1,   3.0),
        ("0V instant crit",      0.0,  0.0,   0.0),
        ("Load ON (ctx)",       22.8,  9.0, 205.2),
    ]
    print(f"{'Scenario':<22}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 90)
    for label, v, i, p in bat_cases:
        r = bat.process(DCSensorSample(voltage=v, current=i, power=p))
        flag = "" if r.confirmed else " [ctx-suppressed]"
        print(f"{label:<22}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.2f}  {r.delta_v:>+7.2f}  {r.detail[:50]}{flag}")

    print()
    print("=" * 90)
    print("SOLAR ENGINE — Vn=84.74V | 2S2P JAM72D40-580 (Vmp=42.37V×2)")
    print("  Normal  : 80V–105V (daytime) | 0V night = Normal")
    print("  Dropout : warn<63.5V(0.75pu) | crit<34.7V(0.41pu) | 0V daytime→Critical")
    print("  Spike   : warn≥8.5V(10%Vn) | crit≥16.9V(20%Vn)")
    print("  Drift   : warn≥6.8V(8%Vn)≥10s | crit≥12.7V(15%Vn)≥20s")
    print("=" * 90)
    sol = DCAnomalyEngine(
        vn=84.74, source="solar",
        drop_warn_pu=SOL_DROP_WARN_PU, drop_crit_pu=SOL_DROP_CRIT_PU,
        drift_warn_pct=SOL_DRIFT_WARN_PCT, drift_crit_pct=SOL_DRIFT_CRIT_PCT,
        spike_warn_pct=SOL_SPIKE_WARN_PCT, spike_crit_pct=SOL_SPIKE_CRIT_PCT,
    )
    sol_cases = [
        # (label, voltage, current, power, is_daytime)
        ("Normal 95V (day)",    95.0, 13.5, 1282.5, True),
        ("Normal 100V (day)",  100.0, 13.8, 1380.0, True),
        ("Normal 85V (cloud)",  85.0, 10.0,  850.0, True),
        ("Dropout warn s1",     60.0,  4.0,  240.0, True),
        ("Dropout warn s2",     60.0,  4.0,  240.0, True),
        ("Dropout warn s3",     55.0,  3.5,  192.5, True),
        ("Dropout crit band",   30.0,  1.0,   30.0, True),
        ("Dropout crit band",   30.0,  1.0,   30.0, True),
        ("Dropout crit band",   30.0,  1.0,   30.0, True),
        ("Dropout crit band",   30.0,  1.0,   30.0, True),
        ("Dropout crit band",   30.0,  1.0,   30.0, True),
        ("Recovery",            92.0, 13.0, 1196.0, True),
        ("Spike warn",         103.5, 14.0, 1449.0, True),
        ("Return base",         92.5, 13.1, 1211.8, True),
        ("Spike crit",         112.0, 14.5, 1624.0, True),
        ("Return base",         91.0, 13.0, 1183.0, True),
        ("0V night (Normal)",    0.0,  0.0,    0.0, False),
        ("0V daytime (Crit)",    0.0,  0.0,    0.0, True),
    ]
    print(f"{'Scenario':<24}  {'Type':<10}  {'Sev':<9}  {'V':>6}  {'ΔV':>7}  {'Detail'}")
    print("-" * 90)
    for label, v, i, p, daylight in sol_cases:
        r = sol.process(DCSensorSample(voltage=v, current=i, power=p), is_daytime=daylight)
        flag = "" if r.confirmed else " [ctx-suppressed]"
        print(f"{label:<24}  {r.anomaly_type:<10}  {r.severity:<9}  "
              f"{r.voltage:>6.2f}  {r.delta_v:>+7.2f}  {r.detail[:50]}{flag}")
