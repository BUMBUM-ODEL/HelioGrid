"""
settings.py — HelioGrid System Configuration
Hybrid Smart Energy System — Raspberry Pi 4

Hardware:
  Battery:  24V 2S Lead Acid — 100Ah (2× 12V 100Ah in series)
            Monitored by 2× INA219 via I2C
              Bat1 @ 0x41 — 12V bottom cell
              Bat2 @ 0x44 — 12V top cell
            External shunt: 200A / 75mV
  AC:       2× PZEM-004T via UART
              Grid     → /dev/ttyGridPZEM,     slave_addr=0x01
              Inverter → /dev/ttyInverterPZEM, slave_addr=0x01
  Solar:    4× 580W panels (2S2P) — WCS1500 current sensors (A0–A3)
            + voltage divider on A4, all read by Arduino Uno
  Relays:   Arduino Uno v6.5 → K1/K2/K3/K4 via /dev/ttyArduino (USB)
  Temp:     DHT22 on GPIO BCM 27
  Clock:    DS3231 RTC @ I2C 0x68
"""

# ============================================================
# BATTERY — 24V 2S Lead Acid Gel (2× 12V 100Ah series)
# Monitored by INA219 (sensors/ina.py)
# ============================================================
BATTERY_CONFIG = {
    "rated_capacity_ah":     100,
    "nominal_voltage":       24,
    "num_cells":             2,            # 2× 12V in series
    "cell_nominal_voltage":  12,
    "cell_full_voltage":     13.2,         # 26.4V pack / 2
    "cell_critical_voltage": 10.8,         # 21.6V pack / 2
    "pack_full_voltage":     26.4,
    "pack_nominal_voltage":  24.0,
    "pack_warning_low":      23.0,
    "pack_critical_low":     21.6,
    "pack_critical_high":    27.6,
    "chemistry":             "lead_acid_gel",
}

# ============================================================
# INA219 BATTERY MONITOR (sensors/ina.py)
# 2× INA219 via I2C shared bus
# External shunt: 200A / 75mV → R = 0.000375 Ω
# ============================================================
INA219_CONFIG = {
    "bat1": {
        "address":     0x41,
        "label":       "Battery 1",
        "description": "12V 100Ah — bottom cell (series)",
    },
    "bat2": {
        "address":     0x44,
        "label":       "Battery 2",
        "description": "12V 100Ah — top cell (series)",
    },
    "shunt_ohms":    0.000375,   # 200A / 75mV external shunt bar
    "max_current_a": 200,
    "cal_value":     17892,      # trunc(0.04096 / (LSB × R_shunt))
    "current_lsb_a": 0.006104,   # 200A / 32768
}

# ============================================================
# THRESHOLDS
# Based on anomaly_engine.py (IEC 60038 / IEEE 1547 per-unit values)
# Nominal: Vn = 230V
# ============================================================
Vn = 230.0  # Nominal voltage

THRESHOLDS = {
    # ── Grid (PZEM-004T) ──────────────────────────────────────
    # anomaly_engine.py dropout/spike/drift rules apply here
    "grid": {
        "voltage_nominal":       Vn,        # 230V (IEC 60038 PH standard)
        "frequency_nominal":     60.0,

        # Dropout thresholds (anomaly_engine DROP_*)
        "dropout_instant_v":     0.10 * Vn, # 23.0V  — instant Critical (sensor loss)
        "dropout_critical_v":    0.80 * Vn, # 184.0V — Critical after 5 samples
        "dropout_warning_v":     0.91 * Vn, # 209.3V — Warning after 2–4 samples
        "dropout_warn_samples":  2,
        "dropout_crit_samples":  5,
        "dropout_long_samples":  20,

        # Spike thresholds (anomaly_engine SPIKE_*)
        "spike_warn_delta_v":    0.05 * Vn, # ±11.5V ΔV — Warning
        "spike_crit_delta_v":    0.10 * Vn, # ±23.0V ΔV — Critical
        "spike_max_dur_samples": 3,          # must return to baseline within 3 samples

        # Drift thresholds (anomaly_engine DRIFT_*)
        "drift_warn_dev_v":      0.03 * Vn, # 6.9V deviation — Warning (20 samples)
        "drift_crit_dev_v":      0.05 * Vn, # 11.5V deviation — Critical (40 samples)
        "drift_warn_samples":    20,
        "drift_crit_samples":    40,

        # Frequency deviation
        "frequency_crit_dev":    1.0,        # ±1.0Hz from nominal → Critical

        # Context check (load-switching suppression)
        "ctx_curr_delta_a":      0.5,        # |ΔI| > 0.5A → load event
        "ctx_pwr_delta_w":       10.0,       # |ΔP| > 10W  → load event
        "ctx_settle_samples":    3,
        "baseline_window":       60,          # ~9s at 0.15s/sample
    },

    # ── Battery (INA219) ──────────────────────────────────────
    # 24V 2S Lead Acid Gel pack
    "battery": {
        "voltage_full":          26.4,   # 100% SOC
        "voltage_warning_low":   23.0,   # Warning — discharge threshold
        "voltage_critical_low":  21.6,   # Critical — deep discharge (10.8V × 2)
        "voltage_critical_high": 27.6,   # Critical — overcharge
        "soc_critical":          20.0,   # % — trigger grid assist
        "soc_warning":           30.0,   # % — early warning
        "overcurrent": {
            100: {"warn_a": 75, "trip_a": 100},  # 100Ah pack
        },
    },

    # ── Solar (Arduino WCS1500 + voltage divider) ─────────────
    # 4× 580W panels, 2S2P array
    "solar": {
        "array_config":           "2S2P",
        "panels":                 4,
        "rated_power_w":          2320.0,   # 4× 580W
        "panel_rated_w":          580.0,
        "vmp_v":                  84.74,    # max power voltage
        "voc_v":                  100.80,   # open circuit voltage
        "imp_a":                  27.38,    # max power current
        "critical_low_w":         464.0,    # 20% of rated — Critical
        "warning_low_w":          1392.0,   # 60% of rated — Warning
        "string_mismatch_warn":   0.30,     # 30% deviation — Warning
        "string_mismatch_crit":   0.50,     # 50% deviation — Critical
        # ── Arduino v6.5 WCS1500 calibration (bench-tested) ──
        "wcs1500_sensitivity_va": 0.011,    # 11 mV/A (WCS_SENSITIVITY)
        "wcs1500_zero_v":         2.5,      # nominal; per-sensor offsets in Arduino
        "wcs1500_zero_filter_a":  1.33,     # below this → 0.0A (CURRENT_FILTER_A)
        "voltage_divider_ratio":  38.09,    # A4 bench-tested (VDIV_RATIO)
        "voltage_filter_v":       16.9,     # below this → 0.0V (VOLTAGE_FILTER_V)
        "wcs_zero_offsets":       [2.4740, 2.5096, 2.4999, 2.5148],  # WCS_ZERO_V0–V3
        "adc_samples":            500,      # ADC_SAMPLES averaging
    },

    # ── Inverter (PZEM-004T) ──────────────────────────────────
    # NOTE: Inverter uses its own threshold logic — NOT anomaly_engine.
    # anomaly_engine.py applies to GRID only.
    #
    # Inverter nominal is 220V (NOT same as grid 230V).
    # Tolerance: ±3%
    #   critical_low  = 220 × 0.97 = 213.4V
    #   critical_high = 220 × 1.03 = 226.6V
    #
    # Drift detection (ΔV per cycle, from flask background_logger):
    #   1V < |ΔV| ≤ 7V → Warning
    #   |ΔV| > 7V      → Critical
    "inverter": {
        "voltage_nominal":       220.0,    # inverter output — 220V (not same as grid)
        "voltage_tolerance_pct": 3.0,      # ±3%
        "voltage_critical_low":  213.4,    # 220 × 0.97
        "voltage_critical_high": 226.6,    # 220 × 1.03
        "frequency_nominal":     60.0,
        "frequency_min":         59.0,
        "frequency_max":         61.0,
        "drift_warn_min_v":      1.0,      # |ΔV| > 1V  → Warning onset
        "drift_warn_max_v":      7.0,      # |ΔV| ≤ 7V → Warning, > 7V → Critical
        "startup_grace_s":       10,       # ignore faults 10s after cold start
    },

    # ── Temperature (DHT22) ───────────────────────────────────
    "temperature": {
        "normal_max": 40.0,   # °C — normal operating ceiling
        "warning":    50.0,   # °C — fan on, alert
        "critical":   60.0,   # °C — thermal shutdown
        "resume":     45.0,   # °C — resume after thermal shutdown
    },
}

# ============================================================
# I2C CONFIG — DS3231 RTC + INA219
# ============================================================
I2C_CONFIG = {
    "bus": 1,
    "ds3231": {
        "address": 0x68,
        "label":   "Real-Time Clock",
    },
    "ina219": {
        "bat1_address": 0x41,
        "bat2_address": 0x44,
    },
}

# ============================================================
# UART — PZEM-004T AC Power Meters
# Both slave_addr=0x01, isolated by separate serial ports
# ============================================================
UART_CONFIG = {
    "grid_pzem":     {"port": "/dev/ttyGridPZEM",     "slave_addr": 0x01},
    "inverter_pzem": {"port": "/dev/ttyInverterPZEM", "slave_addr": 0x01},
}

# ============================================================
# ARDUINO RELAY EXECUTOR — heliogrid_controller.ino v6.5
# RPi 4 → /dev/ttyArduino (USB) → Arduino Uno → K1/K2/K3/K4
#
# Serial commands (9600 baud):
#   '1'/'q'   → K1 ON/OFF   (Solar/Inverter path)
#   '2'/'w'   → K2 ON/OFF   (Grid bypass path)
#   '3'/'e'   → K3 ON/OFF   (Charging — always independent)
#   'm'       → Reset to manual mode
#   'x'       → Emergency OFF (K1+K2+K4 OFF, K3 untouched, saves state)
#   'r'       → Recovery (15s countdown → restore pre-emergency state)
#   'g0'/'g1' → Grid voltage signal (0V / >0V) from Flask PZEM reading
#   'i0'/'i1' → Inverter voltage signal (0V / >0V) from Flask PZEM reading
#   '?'       → Full status JSON
#   'c'       → Calibration ADC dump
#
# K4 managed ONLY by Arduino dropout logic:
#   OFF — both sources 0V (full dropout, after both ever confirmed)
#   ON  — 15s after either source returns
#   Flask must NOT send K4 commands directly
#
# K3 — ALWAYS independent, never touched by dropout/emergency/recovery
# ============================================================
ARDUINO_CONFIG = {
    "port": "/dev/ttyArduino",
    "baud": 9600,
    "pins": {
        "SSR1_K1": 7,              # Solar/Inverter line  (PIN_SSR1_K1)
        "SSR2_K2": 6,              # Grid bypass line     (PIN_SSR2_K2)
        "SSR3_K3": 5,              # Charging — independent (PIN_SSR3_K3)
        "SSR4_K4": 4,              # Contactor — Arduino managed (PIN_SSR4_K4)
        "BUZZER":  "RPi_GPIO14",   # Buzzer on RPi GPIO 14 (not Arduino)
    },
    "timers": {
        "k4_reconnect_ms":  15000,  # 15s after full dropout clears → K4 ON
        "k1_reconnect_ms":  10000,  # 10s after inverter voltage returns → K1 ON
        "k2_reconnect_ms":  10000,  # 10s after grid voltage returns → K2 ON
        "recovery_ms":      15000,  # 15s after 'r' → restore pre-emergency state
        "dropout_debounce": 200,    # ms debounce on full dropout trigger
    },
}

# ============================================================
# DHT TEMPERATURE SENSOR (sensors/Temp.py — DHTReader class)
# Library: adafruit-circuitpython-dht
# Install: pip install adafruit-circuitpython-dht --break-system-packages
# ============================================================
DHT_CONFIG = {
    "sensor_type": "DHT22",
    "gpio_pin":    27,       # BCM GPIO 27 (board.D27)
}

# ============================================================
# CONTROL MODES
# K4 not listed — managed by Arduino dropout logic only
# ============================================================
CONTROL_MODES = {
    "solar": {
        "K1": True,  "K2": False, "K3": "auto",
        "description": "Solar Priority — Inverter AC powers outlets via K1",
    },
    "grid": {
        "K1": False, "K2": True,  "K3": "auto",
        "description": "Grid Backup — Grid AC powers outlets via K2",
    },
    "failsafe": {
        "K1": False, "K2": True,  "K3": "auto",
        "description": "Failsafe — defaults to Grid",
    },
    "shutdown": {
        "K1": False, "K2": False, "K3": False,
        "description": "Emergency Shutdown — sends 'x' to Arduino (K4 opens)",
    },
}

# ============================================================
# K3 GRID ASSIST / CHARGING LOGIC
# ============================================================
K3_CONFIG = {
    "reconnect_delay_s": 300,
    "daylight_start_h":  6,
    "daylight_end_h":    18,
    "charge_min_soc":    95,
    "import_conditions": [
        "battery_voltage < BAT_WARNING_LOW (23V)",
        "night time and battery not full (< 26.4V)",
        "solar_power < SOLAR_CRITICAL_W (464W) during harvest",
    ],
    "charge_conditions": [
        "battery_voltage >= BAT_FULL (26.4V)",
        "solar_power > SOLAR_CHARGE_W (1392W)",
    ],
}

# ============================================================
# API & SYSTEM
# ============================================================
API_CONFIG = {
    "host":               "0.0.0.0",
    "port":               5000,
    "email_service_port": 5001,
    "debug":              False,
}

SYSTEM_CONFIG = {
    "startup_mode":          "solar",
    "enable_auto_switching": True,
    "sensor_poll_rate_s":    2.0,
    "manual_lockout_s":      15,
    "buzzer_duration_ms":    5000,
    "fault_confirm_count":   3,
    "email_cooldown_crit_s": 600,
    "email_cooldown_def_s":  1800,
    "k3_reconnect_delay_s":  300,
}
