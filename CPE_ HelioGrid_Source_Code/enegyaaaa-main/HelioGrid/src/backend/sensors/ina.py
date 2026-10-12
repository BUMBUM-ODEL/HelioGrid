"""
ina.py — INA219 Single-Module Battery Monitor
Hybrid Smart Energy System — Raspberry Pi 4

System: 24V 100Ah (2× 12V JSL II VRLA Lead Acid in SERIES)
  INA219 @ 0x41 — measures full 24V pack via voltage divider
  Voltage Divider: scales pack voltage (max ~29V) down to INA219 bus range (≤26V)
  Example divider ratio: R1=3kΩ, R2=10kΩ → ratio = (R1+R2)/R2 = 13/10 = 1.3
  Measured V_adc × divider_ratio = actual pack voltage

  Shunt: 200A / 75mV External Shunt Bar
         Resistance = 75mV / 200A = 0.000375 Ω

  Pack voltage  = V_adc × VOLTAGE_DIVIDER_RATIO
  Pack current  = from shunt (+ charging / − discharging)
  Pack SOC      = JSL II 24V VRLA table

Install:
  pip install adafruit-circuitpython-ina219 --break-system-packages
"""

import time
import board
import busio
from adafruit_ina219 import INA219

# ── INA219 I2C Address ────────────────────────────────────────────────────────
INA219_ADDR = 0x41   # Single INA219 for full 24V pack

# ── Voltage Divider Ratio ─────────────────────────────────────────────────────
# Adjust this to match your actual resistor values.
# Example: R1=3kΩ (top), R2=10kΩ (bottom) → ratio = (R1+R2)/R2 = 1.3
# At 24V pack: V_adc = 24 / 1.3 ≈ 18.46V (within INA219 26V limit)
# At 29V pack: V_adc = 29 / 1.3 ≈ 22.31V (within INA219 26V limit) ✅
VOLTAGE_DIVIDER_RATIO = 2.33   # 14.77kΩ (top) + 11.11kΩ (bottom) → 25.88/11.11 = 2.33

# ── External Shunt: 200A / 75mV ───────────────────────────────────────────────
# R = V / I = 0.075V / 200A = 0.000375 Ω
INA219_SHUNT_OHMS = 0.000375   # Ω

# ── INA219 Custom Calibration Constants ──────────────────────────────────────
#
#  Cal = trunc(0.04096 / (I_max_lsb × R_shunt))
#
#  We want to measure up to 200A.
#  Current LSB = max_expected_current / 32768
#              = 200A / 32768 ≈ 0.006104 A/bit  (~6.1 mA per LSB)
#
#  Cal = trunc(0.04096 / (0.006104 × 0.000375))
#      = trunc(0.04096 / 0.000002289)
#      ≈ 17892
#
INA219_CURRENT_LSB = 200.0 / 32768.0
INA219_CAL_VALUE   = int(0.04096 / (INA219_CURRENT_LSB * INA219_SHUNT_OHMS))  # → 17892

# ── INA219 Register Constants ─────────────────────────────────────────────────
INA219_REG_CONFIG      = 0x00
INA219_REG_CALIBRATION = 0x05

# Config: BRNG=32V | PGA=/2 (±160mV) | 12-bit 128sps averaging | Continuous
_CONFIG_WORD = (
    0x2000 |   # BRNG = 32V bus range
    0x0800 |   # PGA  = /2 → ±160 mV shunt range
    0x0780 |   # BADC = 1111 → 128-sample averaging
    0x0078 |   # SADC = 1111 → 128-sample averaging
    0x0007     # MODE = shunt+bus continuous
)

# ── Pack voltage thresholds (JSL II 24V VRLA) ─────────────────────────────────
BAT_FULL         = 25.70   # V — 100% SOC (resting)
BAT_WARNING_LOW  = 23.00   # V — ~50% SOC, send warning email
BAT_CRITICAL_LOW = 21.00   # V — deep discharge

# ── Shared I2C ────────────────────────────────────────────────────────────────
_i2c     = None
_ina_bat = None


def _write_register(ina: INA219, register: int, value: int):
    """Write a 16-bit value to an INA219 register over I2C."""
    buf = bytes([register, (value >> 8) & 0xFF, value & 0xFF])
    with ina.i2c_device as i2c:
        i2c.write(buf)


def _apply_custom_calibration(ina: INA219):
    """Apply custom config + calibration for 200A/75mV external shunt."""
    _write_register(ina, INA219_REG_CONFIG,      _CONFIG_WORD)
    _write_register(ina, INA219_REG_CALIBRATION, INA219_CAL_VALUE)


def _init_sensor():
    global _i2c, _ina_bat
    if _i2c is None:
        _i2c = board.I2C()
    if _ina_bat is None:
        try:
            _ina_bat = INA219(_i2c, addr=INA219_ADDR)
            _apply_custom_calibration(_ina_bat)
            print(f"✅ INA219 initialized at 0x{INA219_ADDR:02X}")
            print(f"   Cal={INA219_CAL_VALUE}  LSB={INA219_CURRENT_LSB*1000:.3f}mA/bit  "
                  f"Shunt={INA219_SHUNT_OHMS*1000:.4f}mΩ  Divider={VOLTAGE_DIVIDER_RATIO}")
        except Exception as e:
            print(f"⚠️  INA219 @ 0x{INA219_ADDR:02X}: {e}")


def _read_current_a(ina: INA219) -> float:
    """
    Read current from raw shunt voltage.
    shunt_voltage from adafruit library is in VOLTS (not mV).
    Formula: I = V_shunt / R_shunt
    Noise floor: ignore below 0.5A.
    """
    try:
        shunt_v = ina.shunt_voltage
        amps = shunt_v / INA219_SHUNT_OHMS
        return round(amps, 2) if abs(amps) >= 0.5 else 0.0
    except Exception:
        return 0.0


def calc_pack_soc(v: float) -> float:
    """
    SOC from 24V JSL II VRLA pack voltage (2× 12V 100Ah series).
    Based on open-circuit voltage table.
    """
    if v >= 25.70: return 100.0
    if v >= 25.50: return 95.0
    if v >= 25.30: return 90.0
    if v >= 25.10: return 85.0
    if v >= 24.90: return 80.0
    if v >= 24.70: return 75.0
    if v >= 24.50: return 70.0
    if v >= 24.30: return 65.0
    if v >= 24.10: return 60.0
    if v >= 23.90: return 55.0
    if v >= 23.76: return 50.0
    if v >= 23.60: return 45.0
    if v >= 23.44: return 40.0
    if v >= 23.26: return 35.0
    if v >= 23.10: return 30.0
    if v >= 22.90: return 25.0
    if v >= 22.70: return 20.0
    if v >= 22.40: return 15.0
    if v >= 22.00: return 10.0
    if v >= 21.00: return  5.0
    return 0.0

# Keep old name for compatibility
calculate_pack_soc = calc_pack_soc


def read_battery() -> dict:
    """
    Read single INA219 — full 24V pack via voltage divider.

    Returns dict compatible with flask read_pzem017_battery():
        voltage        — actual pack voltage (V), divider-compensated
        current        — pack current, + charging / − discharging (A)
        charge_a       — charging current, always ≥ 0 (A)
        discharge_a    — discharging current, always ≥ 0 (A)
        net_current    — charge_a − discharge_a
        soc            — pack SOC % (JSL II 24V VRLA table)
        available      — True if INA219 responded
        b1_voltage     — same as pack voltage (for context compat, single sensor)
        b1_current     — same as pack current
        b1_available   — same as available
        b2_voltage     — 0.0 (no second sensor)
        b2_current     — 0.0
        b2_available   — False
        capacity_ah    — 100
        anomaly_details — list of warning strings
    """
    global _ina_bat
    _init_sensor()

    result = {
        "voltage":         0.0,
        "current":         0.0,
        "charge_a":        0.0,
        "discharge_a":     0.0,
        "net_current":     0.0,
        "soc":             0.0,
        "available":       False,
        "b1_voltage":      0.0,
        "b1_current":      0.0,
        "b1_available":    False,
        "b2_voltage":      0.0,
        "b2_current":      0.0,
        "b2_available":    False,
        "bank_b_available": False,
        "bank_b_voltage":   0.0,
        "bank_b_current":   0.0,
        "bank_b_soc":       0.0,
        "capacity_ah":     100,
        "anomaly_details": [],
    }

    if _ina_bat is None:
        return result

    try:
        # Raw ADC voltage × divider ratio = actual pack voltage
        v_adc   = round(_ina_bat.bus_voltage, 3)
        pack_v  = round(v_adc * VOLTAGE_DIVIDER_RATIO, 3)
        pack_i  = _read_current_a(_ina_bat)

        print(f"  [DEBUG] bus_voltage={v_adc}V  pack_v={pack_v}V  current={pack_i}A")

        if pack_v > 5.0:   # sanity check — must be above noise floor
            result["available"]    = True
            result["voltage"]      = pack_v
            result["current"]      = pack_i
            result["charge_a"]     = max(0.0, pack_i)
            result["discharge_a"]  = max(0.0, abs(min(0.0, pack_i)))
            result["net_current"]  = round(result["charge_a"] - result["discharge_a"], 2)
            result["soc"]          = calc_pack_soc(pack_v)
            # b1 mirrors pack for context compatibility
            result["b1_voltage"]   = pack_v
            result["b1_current"]   = pack_i
            result["b1_available"] = True

    except Exception as e:
        print(f"⚠️  INA219 read error: {e}")
        _ina_bat = None  # trigger re-init on next call

    # ── Anomaly detection ─────────────────────────────────────────────────────
    if result["available"]:
        pv = result["voltage"]
        if pv < BAT_CRITICAL_LOW:
            result["anomaly_details"].append(
                f"CRITICAL: Pack voltage {pv:.2f}V below {BAT_CRITICAL_LOW}V (deep discharge)")
        elif pv < BAT_WARNING_LOW:
            result["anomaly_details"].append(
                f"WARNING: Pack voltage {pv:.2f}V below {BAT_WARNING_LOW}V (~50% SOC)")

    return result


# ── Stubs for old code paths ──────────────────────────────────────────────────
INA226_CHARGE_ADDR    = INA219_ADDR
INA226_DISCHARGE_ADDR = INA219_ADDR


# =============================================================================
# TEST SCRIPT
# =============================================================================
if __name__ == "__main__":
    print("🔋 INA219 Battery Monitor — 24V Pack (Single Sensor + Voltage Divider)")
    print("=" * 60)
    print(f"  INA219  @ 0x{INA219_ADDR:02X}")
    print(f"  Voltage Divider Ratio : {VOLTAGE_DIVIDER_RATIO}")
    print(f"  External Shunt        : 200A / 75mV  →  R = {INA219_SHUNT_OHMS*1000:.4f} mΩ")
    print(f"  Cal Register          : {INA219_CAL_VALUE}")
    print(f"  Current LSB           : {INA219_CURRENT_LSB*1000:.3f} mA/bit")
    print(f"  Pack Range            : {BAT_CRITICAL_LOW}V – {BAT_FULL}V")
    print("=" * 60)

    try:
        while True:
            data = read_battery()
            print("-" * 60)
            if data["available"]:
                net   = data["net_current"]
                sign  = "+" if net >= 0 else ""
                state = ("⚡ CHARGING"    if net >  0.1 else
                         "🔋 DISCHARGING" if net < -0.1 else "— IDLE")
                print(f"  Pack : {data['voltage']:.2f}V  SOC: {data['soc']:.0f}%  {state}")
                print(f"  Current: {sign}{net:.2f}A  "
                      f"(Chg: {data['charge_a']:.2f}A  Dis: {data['discharge_a']:.2f}A)")
                for msg in data["anomaly_details"]:
                    print(f"  ⚠️  {msg}")
            else:
                print("  ❌ INA219 not responding")
            time.sleep(2)
    except KeyboardInterrupt:
        print("\n⏹️  Stopped")
