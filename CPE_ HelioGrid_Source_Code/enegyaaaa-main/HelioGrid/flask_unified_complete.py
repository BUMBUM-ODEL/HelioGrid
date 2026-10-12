import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
def get_pzem_data(sensor_obj):
    try:
        if sensor_obj:
            d = sensor_obj.read_all()
            return d if isinstance(d, dict) else {}
        return {}
    except Exception as e:
        print(f"[PZEM] read error: {e}")
        return {}

"""
HelioGrid — Unified Flask API Server  (PATCHED v7.3)
=====================================
v7.3 CHANGES (on top of v7.2):
  [FIX-INV-THRESHOLDS]  Inverter 3-tier threshold system — 220V nominal, ±3%/±5%/±10%:
                     Nominal : 220V (local inverter/UPS spec)
                     Normal  : ±3%  → 213.4–226.6V  (no alert)
                     Warning : ±5%  → 209.0–231.0V  (dashboard only, no buzzer/email)
                     Critical: ±10% → 198.0–242.0V  (buzzer + email + relay action)

  [FIX-GHOST-PZEM2]  Capacitive ghost guard — current + power cross-check added:
                     OLD: Ghost guard only checked if V was in 100–300V range.
                          When AC is removed, PZEM-004T capacitors hold residual voltage
                          (235V, 60Hz) but current collapses to 0.00A — guard missed this.
                     NEW: If V>50 AND current<0.01A AND power<0.5W → ghost reading, zeroed.
                          Applied to BOTH grid and inverter PZEM readers independently.
                          This eliminates the "voltage present after unplug" symptom.

v7.2 CHANGES (on top of v7.1): (sensor_logs, anomaly_logs, PZEM ghost — see v7.2 header)
v7.1 CHANGES (on top of v7.0): (SSR sequencing fixes — see v7.1 header)
v7.0 CHANGES (on top of v6.0): (timing, solar voltage, DB host fixes — see v7.0 header)
v6.0 is fully removed — all sensors (DHT22, Arduino, PZEM) now active in v7.3.
"""

import os, sys, json, threading, time, requests

# Global sensor initialization
try:
    import serial
except ImportError:
    serial = None  # type: ignore  # pyserial not installed — Arduino comms disabled on dev
from datetime import datetime
from flask import Flask, request, jsonify, redirect, session, url_for
from flask_cors import CORS
import mysql.connector
from mysql.connector import Error
from authlib.integrations.flask_client import OAuth
from urllib.parse import urlencode
from dotenv import load_dotenv
from typing import Any, Dict, Optional, cast

load_dotenv()

BACKEND_PATH = os.path.dirname(os.path.abspath(__file__))
SENSORS_PATH = os.path.join(BACKEND_PATH, '..', 'sensors')
CONFIG_PATH  = os.path.join(BACKEND_PATH, '..', 'config')
sys.path.insert(0, BACKEND_PATH)
sys.path.insert(0, SENSORS_PATH)
sys.path.insert(0, CONFIG_PATH)

PZEM004TReader:        Any = None
InverterPZEMReader:    Any = None
PZEM017BatteryReader:  Any = None

# ── PZEM-004T AC readers (Grid + Inverter) ────────────────────────────────────
# Grid.py:     PZEM004TReader    — /dev/ttyGridPZEM,     slave_addr=0x01
# Inverter.py: InverterPZEMReader — /dev/ttyInverterPZEM, slave_addr=0x01
PZEM_AVAILABLE = False
try:
    from Grid import PZEM004TReader as _PZEM004T
    from Inverter import InverterPZEMReader as _InverterPZEM
    PZEM004TReader     = _PZEM004T
    InverterPZEMReader = _InverterPZEM
    PZEM_AVAILABLE     = True
    print("✅ PZEM-004T readers loaded (Grid.py + Inverter.py)")
except Exception as _pzem_err:
    print(f"⚠️  PZEM-004T readers not found — grid/inverter disabled ({_pzem_err})")

I2C_CONFIG:  Dict[str, Any] = {"solar_panels": [], "batteries": []}
UART_CONFIG: Dict[str, Any] = {
    "grid_pzem":     {"port": "/dev/ttyGridPZEM"},
    "inverter_pzem": {"port": "/dev/ttyInverterPZEM"},
}

INA219_AVAILABLE  = False  # set True below after ina.py import
PZEM017_AVAILABLE = False  # aliased to INA219_AVAILABLE after import

# ── DHT22 Temperature Sensor — uses DHTReader class from sensors/Temp.py ──────
# Temp.py: DHTReader(pin=27, sensor_type="DHT22")
#   - subprocess isolation prevents GPIO kernel lock ([Errno 22])
#   - auto-reinit on error, returns dict: {temperature, humidity, status}
# Install: pip install adafruit-circuitpython-dht --break-system-packages
DHT_TYPE      = "DHT22"   # "DHT11" or "DHT22" — must match physical sensor
DHT_PIN       = 27        # BCM GPIO 27 (board.D27)
DHT_AVAILABLE = False
_dht_reader:  Any = None
_dht_device:  Any = None  # kept for legacy compat
try:
    from Temp import DHTReader as _DHTReader
    _dht_reader   = _DHTReader(pin=DHT_PIN, sensor_type=DHT_TYPE)
    DHT_AVAILABLE = True
    print(f"✅ {DHT_TYPE} initialized via Temp.DHTReader on GPIO{DHT_PIN}")
except ImportError as _dht_err:
    print(f"⚠️  Temp.py not found — DHT disabled ({_dht_err})")
except Exception as _dht_err:
    print(f"⚠️  {DHT_TYPE} init failed — temp reads will return 0.0 ({_dht_err})")

# ── RPi GPIO Buzzer (v4.3 — moved from Arduino Pin 8 to RPi GPIO 14) ─────────
BUZZER_GPIO_PIN  = 14          # BCM GPIO 14 (physical Pin 8)
GPIO_AVAILABLE   = False
_gpio_mod: Any   = None
try:
    import RPi.GPIO as _gpio_mod
    _gpio_mod.setwarnings(False)
    _gpio_mod.setmode(_gpio_mod.BCM)
    _gpio_mod.setup(BUZZER_GPIO_PIN, _gpio_mod.OUT, initial=_gpio_mod.LOW)
    GPIO_AVAILABLE = True
    print(f"✅ RPi GPIO: Buzzer initialized on GPIO BCM {BUZZER_GPIO_PIN}")
    # Startup indicator — 2 short beeps = Flask is alive
    import threading as _bt
    def _startup_beep():
        import time as _t
        _t.sleep(2.0)  # wait 2s after init
        # Single short beep — Flask is ready
        _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH)
        _t.sleep(0.3)
        _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.LOW)
    _bt.Thread(target=_startup_beep, daemon=True).start()
except Exception as _gpio_err:
    print(f"⚠️  RPi.GPIO not available — buzzer disabled ({_gpio_err})")
    print("  Install: pip install RPi.GPIO --break-system-packages")


# =============================================================================
# ── DS3231 RTC Module ─────────────────────────────────────────────────────────
# Provides accurate timestamping + boot clock sync (offline-safe)
# Install: pip install adafruit-circuitpython-ds3231 adafruit-circuitpython-busdevice --break-system-packages
# =============================================================================
RTC_AVAILABLE             = False
sync_system_clock_from_rtc = lambda: None
sync_rtc_from_ntp          = lambda: None
get_rtc_status             = lambda: {"available": False, "reason": "RTC module not loaded"}
get_timestamp              = lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S")
try:
    from Rtc import (
        sync_system_clock_from_rtc,
        sync_rtc_from_ntp,
        get_rtc_status,
        get_timestamp,
        RTC_AVAILABLE,
    )
    print("✅ DS3231 RTC module loaded (Rtc.py)")
except (ImportError, ModuleNotFoundError) as _rtc_err:
    print(f"⚠️  Rtc.py not found — using system clock only ({_rtc_err})")

# =============================================================================
# ── INA219 Battery Monitor (replaces PZEM-017) ───────────────────────────────
# Battery voltage is now read directly from Arduino via voltage divider on A5.
# (R1=70kΩ, R2=10kΩ, BATT_VDIV_RATIO=10.2 — field calibrate on Arduino side)
# INA219 is no longer used for battery monitoring.
# =============================================================================
INA219_AVAILABLE  = False   # kept for flag compat — always False now
PZEM017_AVAILABLE = False   # kept for flag compat — always False now

# ── AnomalyEngine — two instances: Grid (230V) + Inverter (230V, [FIX-V7.3] was 220V) ──
_AnomalyEngine: Any = None
_SensorSample:  Any = None
_ae_grid:       Any = None
_ae_inverter:   Any = None
try:
    from anomaly_engine import AnomalyEngine as _AnomalyEngine, SensorSample as _SensorSample
    _ae_grid     = _AnomalyEngine(vn=230.0, drop_warn_pu=0.90, source='grid')  # IEC 60038 PH
    _ae_inverter = _AnomalyEngine(vn=220.0, drop_warn_pu=0.95, source='inverter')  # FIX: warn<209V not <198V
    print('✅ AnomalyEngine loaded — grid(230V) + inverter(220V)')
except ImportError as _ae_err:
    print(f'⚠️  anomaly_engine.py not found — AE detection disabled ({_ae_err})')

# ── DC Low-Voltage Anomaly Engine (battery + solar) ───────────────────────────
_dc_ae_battery: Any = None
_dc_ae_solar:   Any = None
try:
    from dc_anomaly_engine import DCAnomalyEngine as _DCAnomalyEngine, DCSensorSample as _DCSensorSample
    _dc_ae_battery = _DCAnomalyEngine(vn=24.0,  source='battery')  # [FIX-2026-04-29: Vn=24V nominal; 27.5V is full-charge not nominal]
    _dc_ae_solar   = _DCAnomalyEngine(vn=88.86, source='solar')  # [FIX-2026-04-29: Vn=88.86V calibrated Vmp; 99V was Voc not Vmp]
    print('✅ DC AnomalyEngine loaded — battery(24V) + solar(48V)')
except ImportError as _dc_ae_err:
    print(f'⚠️  dc_anomaly_engine.py not found — DC AE detection disabled ({_dc_ae_err})')

_ModbusClient: Any = None   # not used — kept to avoid NameError

SENSORS_AVAILABLE = PZEM_AVAILABLE

try:
    from settings import I2C_CONFIG as _I2C, UART_CONFIG as _UART
    I2C_CONFIG  = _I2C
    UART_CONFIG = _UART
except ImportError:
    print("settings.py not found, using defaults")

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "heliogrid-super-secret-2024")

# [FIX-CORS] Allow all local network origins so RPi kiosk (192.168.x.x)
# and any device on the LAN can access the Flask API.
# Individual IPs are unpredictable — use regex pattern instead.
import re as _re

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5000",
    _re.compile(r"http://192\.168\.\d+\.\d+(:\d+)?$"),
    _re.compile(r"http://10\.\d+\.\d+\.\d+(:\d+)?$"),
]
CORS(app, supports_credentials=True, origins=ALLOWED_ORIGINS)

FRONTEND_URL        = os.getenv("FRONTEND_URL",        "https://upfront-importer-crudeness.ngrok-free.dev")
OAUTH_CALLBACK_BASE = os.getenv("OAUTH_CALLBACK_BASE", "http://localhost:5000")

_https = OAUTH_CALLBACK_BASE.startswith("https")
app.config.update(
    SESSION_COOKIE_SECURE   =_https,
    SESSION_COOKIE_SAMESITE ='None' if _https else 'Lax',
    SESSION_COOKIE_HTTPONLY =True,
)
# Required for OAuth over plain HTTP on localhost — remove in production HTTPS
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

app.config['PERMANENT_SESSION_LIFETIME'] = 86400 * 7  # 7 days

oauth  = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'},
)

DB_CONFIG = {
    "host":     os.getenv("MYSQL_HOST",     "localhost"),  # [FIX-DB] default matches .env (was "192.168.1.8" — wrong fallback if .env fails to load)
    "port":     int(os.getenv("MYSQL_PORT", "3306")),
    "user":     os.getenv("MYSQL_USER",     "root"),
    "password": os.getenv("MYSQL_PASSWORD", "Energy#123"),
    "database": os.getenv("MYSQL_DATABASE", "smart_energy_db"),
}

def get_db():
    return mysql.connector.connect(**DB_CONFIG)


# =============================================================================
#  THRESHOLDS — 24V Lead Acid Gel
# =============================================================================

BAT_FULL          = 27.50  # JSL II 24V VRLA 100% SOC — multimeter confirmed 27.5V = full
BAT_WARNING_LOW   = 23.0
BAT_CRITICAL_LOW  = 21.00  # deep discharge floor
BAT_CRITICAL_HIGH = 29.00  # max charge voltage (JSL II gel LA ~29V)

GRID_NOMINAL      = 230.0   # IEC 60038 PH utility standard
GRID_NORMAL_LOW   = 223.1   # 230 × 0.97 — ±3% normal band (no alert)
GRID_NORMAL_HIGH  = 236.9   # 230 × 1.03 — ±3% normal band (no alert)
GRID_CRITICAL_LOW  = 207.0  # 230 × 0.90 — ±10% critical (buzzer + email)
GRID_CRITICAL_HIGH = 253.0  # 230 × 1.10 — ±10% critical (buzzer + email)
GRID_FREQ_NOMINAL  = 50.0   # PH standard — ERC / IEC 60038
GRID_FREQ_CRIT     = 15.0

# Inverter: same formula as grid, different nominal (220V local spec)
INV_NOMINAL       = 220.0   # local inverter/UPS spec
INV_NORMAL_LOW    = 213.4   # 220 × 0.97 — ±3% normal band (no alert)
INV_NORMAL_HIGH   = 226.6   # 220 × 1.03 — ±3% normal band (no alert)
INV_CRITICAL_LOW  = 198.0   # 220 × 0.90 — ±10% critical (buzzer + email + relay)
INV_CRITICAL_HIGH = 242.0   # 220 × 1.10 — ±10% critical (buzzer + email + relay)
# Drift: 1V < |ΔV| ≤ 7V → Warning, |ΔV| > 7V → Critical
INV_DRIFT_WARN_MIN = 1.0
INV_DRIFT_WARN_MAX = 7.0

SOLAR_RATED_W    = 2320.0   # 4× 580W panels (2S2P) — from settings.py
SOLAR_CRITICAL_W = 464.0    # 20% of rated (settings.py critical_low_w)
SOLAR_WARNING_W  = 1392.0   # 60% of rated (settings.py warning_low_w)
SOLAR_CHARGE_W   = 1392.0   # same as warning threshold

STRING_MISMATCH_WARNING  = 0.30
STRING_MISMATCH_CRITICAL = 0.50

# ── Battery SOC lookup table (JSL II 24V VRLA — Full=27.5V) ─────────────────
_BAT_SOC_TABLE = [
    (27.50, 100), (27.20, 98), (26.90, 96), (26.60, 94), (26.30, 92),
    (26.00, 90),  (25.70, 88), (25.50, 85), (25.30, 80), (25.10, 75),
    (24.90, 70),  (24.70, 65), (24.50, 60), (24.30, 55), (24.10, 50),
    (23.90, 45),  (23.76, 40), (23.60, 35), (23.40, 30), (23.20, 25),
    (23.00, 20),  (22.50, 15), (22.00, 10), (21.50, 5),  (21.00, 0),
]
def _voltage_to_soc(v: float) -> float:
    if v <= 0:   return 0.0
    if v >= _BAT_SOC_TABLE[0][0]:  return 100.0
    if v <= _BAT_SOC_TABLE[-1][0]: return 0.0
    for i in range(len(_BAT_SOC_TABLE) - 1):
        hi_v, hi_s = _BAT_SOC_TABLE[i]
        lo_v, lo_s = _BAT_SOC_TABLE[i + 1]
        if lo_v <= v <= hi_v:
            ratio = (v - lo_v) / (hi_v - lo_v)
            return round(lo_s + ratio * (hi_s - lo_s), 1)
    return 0.0

# ── Arduino v6.5 WCS1500 calibration (from v5__1_.ino) ──────────────────────
# Bench-tested zero-voltage offsets per sensor
ARDUINO_WCS_ZERO    = [2.5086, 2.4995, 2.4911, 2.4482]   # A0–A3 [re-zeroed no-load 2026-04-29]
ARDUINO_WCS_SENS    = 0.011   # V/A  (11 mV/A)
ARDUINO_CURR_FILTER = 1.00    # A    [synced to Arduino CURRENT_FILTER_A 2026-04-29]
ARDUINO_VOLT_FILTER = 16.9    # V    (below this → 0.0V)
ARDUINO_VDIV_RATIO  = 39.0    # [synced from Arduino cal dump ratio=39.0 2026-04-29]
ARDUINO_ADC_SAMPLES = 500     # averaged samples per read

# [P1-FIX-5] Thermal thresholds
TEMP_WARNING  = 50.0
TEMP_CRITICAL = 60.0
TEMP_RESUME   = 45.0

SOLAR_DAYLIGHT_START = 6
SOLAR_DAYLIGHT_END   = 18

BAT_OVERCURRENT_CONFIG = {
    100: {"warn": 75,  "trip": 100},
    200: {"warn": 150, "trip": 200},
}

FAULT_CONFIRM_COUNT         = 3   # for spike/drift — needs multiple confirms
FAULT_CONFIRM_COUNT_DROPOUT = 1   # for dropout — fire on first confirmed 0V reading
EMAIL_COOLDOWN_CRITICAL_S = 600
EMAIL_COOLDOWN_DEFAULT_S  = 1800
BUZZER_DURATION_MS        = 15000
MANUAL_LOCKOUT_S          = 15


# =============================================================================
#  DB TABLE SETUP
# =============================================================================

def ensure_tables():
    conn   = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ssr_state (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            control_mode     VARCHAR(20)  NOT NULL DEFAULT 'solar',
            auto_switch      TINYINT(1)   NOT NULL DEFAULT 1,
            manual_override  TINYINT(1)   NOT NULL DEFAULT 0,
            ssr1_state       TINYINT(1)   NOT NULL DEFAULT 0,
            ssr2_state       TINYINT(1)   NOT NULL DEFAULT 0,
            ssr3_state       TINYINT(1)   NOT NULL DEFAULT 0,
            ssr4_state       TINYINT(1)   NOT NULL DEFAULT 1,
            contactor_closed TINYINT(1)   NOT NULL DEFAULT 1,
            grid_assist      TINYINT(1)   NOT NULL DEFAULT 0,
            total_switches   INT          NOT NULL DEFAULT 0,
            last_switch_time VARCHAR(20)           DEFAULT '--:--',
            updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    for col, definition in [
        ('ssr1_state',       'TINYINT(1) NOT NULL DEFAULT 0'),
        ('ssr2_state',       'TINYINT(1) NOT NULL DEFAULT 0'),
        ('ssr3_state',       'TINYINT(1) NOT NULL DEFAULT 0'),
        ('ssr4_state',       'TINYINT(1) NOT NULL DEFAULT 1'),
        ('contactor_closed', 'TINYINT(1) NOT NULL DEFAULT 1'),
        ('grid_assist',      'TINYINT(1) NOT NULL DEFAULT 0'),
    ]:
        try:
            cursor.execute(f"ALTER TABLE ssr_state ADD COLUMN {col} {definition}")
        except Exception:
            pass

    cursor.execute("SELECT COUNT(*) AS cnt FROM ssr_state")
    _r1 = cursor.fetchone()
    count_row: Dict[str, Any] = cast(Dict[str, Any], _r1) if _r1 else {}
    if count_row.get("cnt", 0) == 0:
        cursor.execute("""
            INSERT INTO ssr_state
                (control_mode,auto_switch,manual_override,
                 ssr1_state,ssr2_state,ssr3_state,ssr4_state,
                 contactor_closed,grid_assist,total_switches,last_switch_time)
            VALUES ('solar',1,0,0,0,0,1,1,0,0,'--:--')
        """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            google_id     VARCHAR(255) UNIQUE,
            email         VARCHAR(255) UNIQUE NOT NULL,
            name          VARCHAR(255),
            picture       VARCHAR(500),
            password_hash VARCHAR(255),
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sensor_logs (
            id                   INT AUTO_INCREMENT PRIMARY KEY,
            timestamp            DATETIME DEFAULT CURRENT_TIMESTAMP,
            grid_voltage         DECIMAL(10,2), grid_current       DECIMAL(10,2),
            grid_power           DECIMAL(10,2), grid_energy        DECIMAL(10,2),
            grid_frequency       DECIMAL(10,2), grid_power_factor  DECIMAL(5,2),
            inverter_voltage     DECIMAL(10,2), inverter_current   DECIMAL(10,2),
            inverter_power       DECIMAL(10,2), inverter_frequency DECIMAL(10,2),
            solar_dc_voltage     DECIMAL(10,2), solar_dc_current   DECIMAL(10,2),
            solar_dc_power       DECIMAL(10,2), solar_ac_voltage   DECIMAL(10,2),
            solar_ac_current     DECIMAL(10,2), solar_ac_power     DECIMAL(10,2),
            battery_pack_voltage DECIMAL(10,2), battery_pack_current DECIMAL(10,2),
            battery_pack_power   DECIMAL(10,2), battery_pack_soc   DECIMAL(5,2),
            ssr1_state TINYINT(1), ssr2_state TINYINT(1),
            ssr3_state TINYINT(1), ssr4_state TINYINT(1),
            outlet_1_voltage DECIMAL(10,2), outlet_1_current DECIMAL(10,2),
            outlet_2_voltage DECIMAL(10,2), outlet_2_current DECIMAL(10,2),
            system_temp        DECIMAL(5,2),
            system_efficiency  DECIMAL(6,2),  -- P_out(inverter) / P_in(grid+solar) × 100
            solar_efficiency   DECIMAL(6,2),  -- solar_dc_power / 2200W rated × 100
            -- [PZEM017] B1/B2 individual readings
            battery_charge_a    DECIMAL(10,3),   -- B1 current (PZEM-017 #1)
            battery_discharge_a DECIMAL(10,3),   -- B2 current (PZEM-017 #2)
            INDEX idx_timestamp (timestamp DESC)
        )
    """)

    # Add INA226 columns if table existed before v6.0
    for col, definition in [
        ('battery_charge_a',       'DECIMAL(10,3) NULL AFTER system_temp'),
        ('battery_discharge_a',    'DECIMAL(10,3) NULL AFTER battery_charge_a'),
        ('system_efficiency',      'DECIMAL(6,2)  NULL AFTER battery_discharge_a'),
        ('solar_efficiency',       'DECIMAL(6,2)  NULL AFTER system_efficiency'),
        ('grid_anomaly_level',       "VARCHAR(10)   NULL DEFAULT 'none' AFTER solar_efficiency"),
        ('inverter_anomaly_level',   "VARCHAR(10)   NULL DEFAULT 'none' AFTER grid_anomaly_level"),
        # [FIX-DC-GRAPH] DC anomaly levels for chart dot matching
        ('dc_battery_anomaly_level', "VARCHAR(10)   NULL DEFAULT 'none' AFTER inverter_anomaly_level"),
        ('dc_solar_anomaly_level',   "VARCHAR(10)   NULL DEFAULT 'none' AFTER dc_battery_anomaly_level"),
        # [FIX-DC-TOOLTIP] DC anomaly types for chart tooltip (Dropout/Spike/Drift)
        ('dc_battery_anomaly_type',  "VARCHAR(30)   NULL DEFAULT 'Normal' AFTER dc_solar_anomaly_level"),
        ('dc_solar_anomaly_type',    "VARCHAR(30)   NULL DEFAULT 'Normal' AFTER dc_battery_anomaly_type"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE sensor_logs ADD COLUMN {col} {definition}")
            print(f"  sensor_logs: added column {col}")
        except Exception:
            pass

    # ── Shared column set for all 3 anomaly log tables ───────────────────────
    _ANOMALY_TABLE_DDL = """
        CREATE TABLE IF NOT EXISTS {tbl} (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            timestamp           DATETIME     DEFAULT CURRENT_TIMESTAMP,
            detected_at         DATETIME     NULL,
            action_at           DATETIME     NULL,
            response_time_ms    INT          NULL,
            resolved_at         DATETIME     NULL,
            type                VARCHAR(50),
            source              VARCHAR(100),
            severity            VARCHAR(20),
            system_action       TEXT,
            system_temp         DECIMAL(5,2),
            battery_soc         VARCHAR(20),
            solar_power         VARCHAR(20),
            grid_voltage        VARCHAR(20),
            inverter_power      DECIMAL(8,2)  NULL,
            panel_fault_detail  VARCHAR(100)  NULL,
            email_status        VARCHAR(20),
            buzzer_status       VARCHAR(10),
            status              VARCHAR(20),
            anomaly_label       VARCHAR(60)   NULL,
            anomaly_source      VARCHAR(50)   NULL,
            anomaly_delta       DECIMAL(8,3)  NULL,
            confirm_count       INT           NULL,
            context_grid_current    DECIMAL(8,3)  NULL,
            context_inv_voltage     DECIMAL(7,2)  NULL,
            context_inv_current     DECIMAL(8,3)  NULL,
            context_inv_frequency   DECIMAL(7,3)  NULL,
            context_battery_voltage DECIMAL(8,3)  NULL,
            context_battery_current DECIMAL(8,3)  NULL,
            context_solar_power     DECIMAL(10,2) NULL,
            context_sensor_status   VARCHAR(50)   NULL,
            INDEX idx_timestamp (timestamp DESC)
        )
    """
    _ANOMALY_ALTER_COLS = [
        ('detected_at',              'DATETIME NULL AFTER timestamp'),
        ('action_at',                'DATETIME NULL AFTER detected_at'),
        ('response_time_ms',         'INT NULL AFTER action_at'),
        ('resolved_at',              'DATETIME NULL AFTER response_time_ms'),
        ('inverter_power',           'DECIMAL(8,2) NULL AFTER grid_voltage'),
        ('panel_fault_detail',       'VARCHAR(100) NULL AFTER inverter_power'),
        # v7.0 anomaly engine fields
        ('anomaly_label',            "VARCHAR(60) NULL AFTER status"),
        ('anomaly_source',           "VARCHAR(50) NULL AFTER anomaly_label"),
        ('anomaly_delta',            "DECIMAL(8,3) NULL AFTER anomaly_source"),
        ('confirm_count',            "INT NULL AFTER anomaly_delta"),
        # v7.0 context snapshot
        ('context_grid_current',     "DECIMAL(8,3) NULL AFTER confirm_count"),
        ('context_grid_frequency',    "DECIMAL(7,3) NULL AFTER context_grid_current"),
        ('context_inv_voltage',      "DECIMAL(7,2) NULL AFTER context_grid_current"),
        ('context_inv_current',      "DECIMAL(8,3) NULL AFTER context_inv_voltage"),
        ('context_inv_frequency',    "DECIMAL(7,3) NULL AFTER context_inv_current"),
        ('context_battery_voltage',  "DECIMAL(8,3) NULL AFTER context_inv_frequency"),
        ('context_battery_current',  "DECIMAL(8,3) NULL AFTER context_battery_voltage"),
        ('context_solar_power',      "DECIMAL(10,2) NULL AFTER context_battery_current"),
        ('context_sensor_status',    "VARCHAR(50) NULL AFTER context_solar_power"),
    ]

    for tbl in ('anomaly_logs', 'grid_anomaly_logs', 'inverter_anomaly_logs'):
        cursor.execute(_ANOMALY_TABLE_DDL.format(tbl=tbl))
        for col, definition in _ANOMALY_ALTER_COLS:
            try:
                cursor.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} {definition}")
                print(f"  {tbl}: added column {col}")
            except Exception:
                pass   # column already exists — normal on re-run
        print(f"  {tbl}: ready")

    # ── DC Low-Voltage Anomaly Log Tables (battery + solar) ───────────────────
    _DC_ANOMALY_DDL = """
        CREATE TABLE IF NOT EXISTS {tbl} (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
            source        VARCHAR(20)  NOT NULL DEFAULT 'battery',
            anomaly_type  VARCHAR(30)  NOT NULL DEFAULT 'Normal',
            severity      VARCHAR(20)  NOT NULL DEFAULT 'Normal',
            detail        TEXT,
            voltage       DECIMAL(8,3) NULL,
            delta_v       DECIMAL(8,3) NULL,
            pu            DECIMAL(8,4) NULL,
            confirmed     TINYINT(1)   NOT NULL DEFAULT 1,
            context_note  TEXT,
            battery_soc   DECIMAL(5,2) NULL,
            solar_power   DECIMAL(10,2) NULL,
            grid_voltage  DECIMAL(8,2) NULL,
            system_temp   DECIMAL(5,2) NULL,
            status        VARCHAR(20)  NOT NULL DEFAULT 'Monitoring',
            resolved_at   DATETIME NULL,
            INDEX idx_timestamp (timestamp DESC),
            INDEX idx_severity  (severity),
            INDEX idx_type      (anomaly_type)
        )
    """
    for dc_tbl in ('dc_battery_anomaly_logs', 'dc_solar_anomaly_logs'):
        cursor.execute(_DC_ANOMALY_DDL.format(tbl=dc_tbl))
        print(f"  {dc_tbl}: ready")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS buzzer_logs (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            duration_ms  INT NOT NULL DEFAULT 15000,
            reason       VARCHAR(255)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS network_logs (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            timestamp        DATETIME DEFAULT CURRENT_TIMESTAMP,
            local_latency_ms INT NULL,
            local_status     VARCHAR(10) NOT NULL,
            internet_status  VARCHAR(10) NOT NULL,
            temperature      FLOAT DEFAULT 0,
            temp_status      VARCHAR(20),
            signal_quality   VARCHAR(20),
            INDEX idx_timestamp (timestamp DESC)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS system_config (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            config_key VARCHAR(50) UNIQUE NOT NULL,
            config_val VARCHAR(100) NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("SELECT COUNT(*) AS cnt FROM system_config")
    _r2 = cursor.fetchone()
    cfg_row: Dict[str, Any] = cast(Dict[str, Any], _r2) if _r2 else {}
    if cfg_row.get("cnt", 0) == 0:
        cursor.execute("""
            INSERT INTO system_config (config_key, config_val) VALUES
                ('battery_capacity_ah',   '100'),
                ('battery_current_warn_a', '75')
        """)

    # ── SSR Switch Log — full history of every relay switch event ──────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ssr_switch_log (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            switched_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            trigger_source  VARCHAR(20) NOT NULL DEFAULT 'auto',
            from_mode       VARCHAR(20),
            to_mode         VARCHAR(20) NOT NULL,
            ssr1_before     TINYINT(1) NOT NULL DEFAULT 0,
            ssr2_before     TINYINT(1) NOT NULL DEFAULT 0,
            ssr3_before     TINYINT(1) NOT NULL DEFAULT 0,
            ssr4_before     TINYINT(1) NOT NULL DEFAULT 1,
            ssr1_after      TINYINT(1) NOT NULL DEFAULT 0,
            ssr2_after      TINYINT(1) NOT NULL DEFAULT 0,
            ssr3_after      TINYINT(1) NOT NULL DEFAULT 0,
            ssr4_after      TINYINT(1) NOT NULL DEFAULT 1,
            reason          VARCHAR(255),
            battery_soc     DECIMAL(5,2) NULL,
            solar_power_w   DECIMAL(10,2) NULL,
            grid_voltage_v  DECIMAL(6,2) NULL,
            INDEX idx_switched_at (switched_at DESC)
        )
    """)

    # ── Email Logs — every send attempt (sent, failed, cooldown-skipped) ───
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_logs (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            sent_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            fault_key       VARCHAR(100) NOT NULL,
            fault_type      VARCHAR(100),
            severity        VARCHAR(20),
            source          VARCHAR(50),
            recipient       VARCHAR(255),
            status          VARCHAR(20) NOT NULL,
            error_msg       VARCHAR(255),
            battery_soc     DECIMAL(5,2) NULL,
            solar_power_w   DECIMAL(10,2) NULL,
            grid_voltage_v  DECIMAL(6,2) NULL,
            INDEX idx_sent_at (sent_at DESC),
            INDEX idx_fault_key (fault_key)
        )
    """)

    conn.commit()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS solar_panel_alerts (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            panel_id       VARCHAR(20) NOT NULL,
            first_detected DATETIME NOT NULL,
            last_detected  DATETIME NOT NULL,
            health_pct     DECIMAL(5,2) NOT NULL,
            alert_stage    TINYINT NOT NULL DEFAULT 1,
            email_sent_at  DATETIME NULL,
            buzzer_fired   TINYINT NOT NULL DEFAULT 0,
            INDEX idx_panel_id (panel_id)
        )
    """)
    conn.commit()
    cursor.close()
    conn.close()
    print("All database tables ready")


# =============================================================================
#  ARDUINO — /dev/ttyArduino
# =============================================================================

arduino               = None
arduino_lock          = threading.Lock()
arduino_sequence_lock = threading.RLock()

try:
    if serial is None:
        raise ImportError("pyserial not installed")
    arduino = serial.Serial('/dev/ttyArduino', 9600, timeout=1)
    time.sleep(2)
    print("Arduino connected on /dev/ttyArduino")
except Exception as e:
    print(f"Arduino not connected: {e}")


def arduino_send(cmd: str) -> Optional[str]:
    if arduino and arduino.is_open:
        try:
            with arduino_lock:
                arduino.write(cmd.encode())
                time.sleep(0.05)
                return arduino.readline().decode().strip()
        except Exception as e:
            print(f"Arduino send error: {e}")
    return None


def arduino_get_status() -> Optional[dict]:
    """Send '?' and retry reading until we get the full status response (has ssr1_k1).
    Arduino may queue pzem_grid/pzem_inv events before responding — flush them first.
    Called ONLY by the arduino_poller thread — background_logger reads _arduino_cache instead.
    """
    if not arduino or not arduino.is_open:
        return None
    try:
        with arduino_lock:
            # Flush stale queued lines from serial buffer before sending '?'
            arduino.reset_input_buffer()
            arduino.write(b'?')
            # Retry up to 8 lines to find the '?' response
            for _ in range(8):
                time.sleep(0.06)
                raw = arduino.readline().decode(errors='replace').strip()
                if not raw:
                    continue
                try:
                    parsed = json.loads(raw)
                    # Valid '?' response always has ssr1_k1 field
                    if 'ssr1_k1' in parsed:
                        # Ensure all timer fields present
                        parsed.setdefault('k4_left_s',       0)
                        parsed.setdefault('k1_left_s',       0)
                        parsed.setdefault('k2_left_s',       0)
                        parsed.setdefault('recovery_left_s', 0)
                        parsed.setdefault('dropout',         0)
                        parsed.setdefault('emergency',       0)
                        parsed.setdefault('k1_timer',        0)
                        parsed.setdefault('k2_timer',        0)
                        parsed.setdefault('k4_timer',        0)
                        parsed.setdefault('recovery',        0)
                        return parsed
                except Exception:
                    continue
    except Exception as e:
        print(f"[arduino_get_status] error: {e}")
    return None


# =============================================================================
#  ARDUINO POLLER THREAD
#  Polls Arduino '?' every 1s in a dedicated thread.
#  background_logger reads _arduino_cache (non-blocking) instead of calling
#  arduino_get_status() directly — eliminates ~0.5s serial wait from main loop.
# =============================================================================

_arduino_cache: Dict[str, Any] = {}
_arduino_cache_lock = threading.Lock()


def arduino_poller() -> None:
    """Dedicated thread — polls Arduino every 1s, stores result in _arduino_cache.
    Uses try_acquire on arduino_lock with 0.5s timeout to prevent deadlock with
    background_logger voltage signal sends and /api/arduino/status endpoint.
    """
    global _arduino_cache
    print("[ARDUINO POLLER] Started — polling every 1s")
    while True:
        try:
            if not arduino or not arduino.is_open:
                time.sleep(2.0)
                continue
            # [FIX-DEADLOCK] Non-blocking lock acquire with timeout.
            # If background_logger or SSR control is holding arduino_lock, skip this poll
            # cycle rather than blocking — next cycle (1s later) will succeed.
            acquired = arduino_lock.acquire(timeout=0.3)
            if not acquired:
                time.sleep(1.0)
                continue
            try:
                arduino.reset_input_buffer()
                arduino.write(b'?')
                parsed = None
                for _ in range(5):
                    time.sleep(0.08)
                    raw = arduino.readline().decode(errors='replace').strip()
                    if not raw:
                        continue
                    try:
                        p = json.loads(raw)
                        if 'ssr1_k1' in p:
                            p.setdefault('k4_left_s',       0)
                            p.setdefault('k1_left_s',       0)
                            p.setdefault('k2_left_s',       0)
                            p.setdefault('recovery_left_s', 0)
                            p.setdefault('dropout',         0)
                            p.setdefault('emergency',       0)
                            p.setdefault('k1_timer',        0)
                            p.setdefault('k2_timer',        0)
                            p.setdefault('k4_timer',        0)
                            p.setdefault('recovery',        0)
                            parsed = p
                            break
                    except Exception:
                        continue
            finally:
                arduino_lock.release()
            if parsed:
                with _arduino_cache_lock:
                    _arduino_cache = parsed
        except Exception as e:
            print(f"[ARDUINO POLLER] error: {e}")
        time.sleep(1.0)


def get_arduino_cache() -> Dict[str, Any]:
    """Return latest cached Arduino status — non-blocking, safe to call from any thread."""
    with _arduino_cache_lock:
        return dict(_arduino_cache)


def _seq_solar_on():
    # [FIX-SSR] SAFE ORDER: Grid(K2) OFF first → Solar(K1) ON
    # K4 NOT commanded — managed by Arduino v6.4 dropout logic internally
    arduino_send('w')          # K2 (Grid) OFF — ensure grid path is open
    time.sleep(0.15)
    arduino_send('q')          # K1 (Solar) OFF — clean slate
    time.sleep(0.05)
    arduino_send('1')          # K1 (Solar) ON
    time.sleep(0.1)


def _seq_grid_on():
    # [FIX-SSR] SAFE ORDER: Solar(K1) OFF first → Grid(K2) ON
    # K4 NOT commanded — managed by Arduino v6.4 dropout logic internally
    arduino_send('q')          # K1 (Solar) OFF — ensure solar path is open
    time.sleep(0.15)
    arduino_send('w')          # K2 (Grid) OFF — clean slate
    time.sleep(0.05)
    arduino_send('2')          # K2 (Grid) ON
    time.sleep(0.1)


def _seq_shutdown():
    # Arduino v6.4: 'x' = emergency OFF (K1+K2+K4 OFF, K3 untouched, saves state for recovery)
    # Old commands ('e','r','q','w') were wrong — 'r' in v6.4 is recovery, not K1 OFF
    arduino_send('x')
    time.sleep(0.1)


def _seq_apply_ssr_state(ssr1: bool, ssr2: bool, ssr3: bool, k4_close: bool):
    # Arduino v6.4: K4 is controlled ONLY by dropout protection logic internally.
    # Flask must NOT send K4 open/close commands directly.
    # For shutdown: send 'x' (emergency) which opens K4 + K1+K2 OFF.
    # For K1/K2 changes: send individual K1/K2 commands only.
    # K3: always independent, '3'=ON 'e'=OFF.

    if not k4_close:
        # Emergency / shutdown — 'x' opens K4+K1+K2 atomically in Arduino
        _seq_shutdown()
        return

    if ssr1 and not ssr2:
        # Switching to Solar (K1 ON, K2 OFF) — safe order
        arduino_send('w')      # K2 OFF first
        time.sleep(0.15)
        arduino_send('q')      # K1 clean slate
        time.sleep(0.05)
        arduino_send('1')      # K1 ON
    elif ssr2 and not ssr1:
        # Switching to Grid (K2 ON, K1 OFF) — safe order
        arduino_send('q')      # K1 OFF first
        time.sleep(0.15)
        arduino_send('w')      # K2 clean slate
        time.sleep(0.05)
        arduino_send('2')      # K2 ON
    else:
        # Both OFF (standby) — turn off both safely
        arduino_send('q')      # K1 OFF
        time.sleep(0.05)
        arduino_send('w')      # K2 OFF

    time.sleep(0.1)
    # NOTE: K3 removed — no longer controlled by Flask


# =============================================================================
#  SENSOR READERS
# =============================================================================

grid_pzem:      Any = None  # type: Optional[Any]
inverter_pzem:  Any = None  # type: Optional[Any]
battery_reader: Any = None
solar_reader:   Any = None

if PZEM_AVAILABLE and PZEM004TReader is not None:
    try:
        _grid_port = UART_CONFIG.get('grid_pzem', {}).get('port', '/dev/ttyGridPZEM')
        grid_pzem = PZEM004TReader(port=_grid_port, slave_addr=0x01)
        if grid_pzem.serial_connection:
            print(f"✅ Grid PZEM connected on {_grid_port}")
        else:
            print(f"⚠️  Grid PZEM opened {_grid_port} but no serial connection")
            grid_pzem = None
    except Exception as e:
        print(f"⚠️  Grid PZEM init failed: {e}")
        grid_pzem = None

if PZEM_AVAILABLE and InverterPZEMReader is not None:
    try:
        _inv_port = UART_CONFIG.get('inverter_pzem', {}).get('port', '/dev/ttyInverterPZEM')
        inverter_pzem = InverterPZEMReader(port=_inv_port, slave_addr=0x01)
        if inverter_pzem.serial_connection:
            print(f"✅ Inverter PZEM connected on {_inv_port}")
        else:
            print(f"⚠️  Inverter PZEM opened {_inv_port} but no serial connection")
            inverter_pzem = None
    except Exception as e:
        print(f"⚠️  Inverter PZEM init failed: {e}")
        inverter_pzem = None

# Battery voltage is read from Arduino via voltage divider on A5 — no separate reader needed.
# Solar data comes from Arduino WCS1500 (A0-A3) + voltage divider (A4).
solar_reader   = None
battery_reader = None


# =============================================================================
# =============================================================================

cache: Dict[str, Any] = {
    'grid':     {'voltage': 0.0, 'current': 0.0, 'power': 0.0, 'frequency': 0.0, 'status': 'offline'},
    'inverter': {'voltage': 0.0, 'current': 0.0, 'power': 0.0, 'frequency': 0.0},
    'solar': [], 'battery': [],
    'last_update': None,
    'system_temp': 0.0,
    'ina226': {
        'voltage':     0.0,
        'charge_a':    0.0,
        'discharge_a': 0.0,
        'net_current': 0.0,
        'soc':         0.0,
        'available':   False,
    },
    # Anomaly engine results (populated by background_logger)
    'aeGridResult': {
        'anomaly_type': 'Normal', 'severity': 'Normal',
        'detail': 'No data yet', 'voltage': 0.0,
        'delta_v': 0.0, 'pu': 0.0, 'confirmed': True, 'drop_counter': 0,
    },
    'aeInverterResult': {
        'anomaly_type': 'Normal', 'severity': 'Normal',
        'detail': 'No data yet', 'voltage': 0.0,
        'delta_v': 0.0, 'pu': 0.0, 'confirmed': True, 'drop_counter': 0,
    },
}
buzzer_state: Dict[str, Any] = {
    'active': False, 'duration_ms': 0, 'triggered_at': None,
}

# Battery voltage rolling average — smooths out probe noise
_batt_v_history: list = []
_BATT_V_SMOOTH  = 5   # number of readings to average

_fault_counters:       Dict[str, int]      = {}
_fault_state:          Dict[str, str]      = {}
_fault_first_detected: Dict[str, datetime] = {}
_fault_log_cycle:      Dict[str, int]      = {}   # heartbeat counter for sustained anomaly logging
_normal_log_cycle:     Dict[str, int]      = {}   # [UNUSED] was used for 30s heartbeat — now logs every 5s cycle
_email_cooldowns:      Dict[str, float]    = {}
_buzzer_fired:         Dict[str, bool]     = {}

# Double fault tracking — window-less, state-based
_double_fault_active:  bool  = False
_grid_dropout_active:  bool  = False
_inv_dropout_active:   bool  = False
_partial_recovery_sent: bool = False
_thermal_shutdown_active: bool = False

# [FIX-RECOVERY-TIMER] Track last voltage signals sent to Arduino.
# Only send g0/g1 and i0/i1 when the signal CHANGES — not every 5s cycle.
# Sending g1 every 5s while K1 timer is pending causes Arduino to re-evaluate
# applyVoltageState() repeatedly. Although the guard !k1TimerPending prevents
# timer restarts, sending on change only is cleaner and avoids edge cases.
_last_grid_sig: str = ''    # '' = never sent, '0' or '1'
_last_inv_sig:  str = ''    # '' = never sent, '0' or '1'

# ── Gap Fix globals ────────────────────────────────────────────────────────
# Gap 3: Inverter cold-start ramp guard (0V → 230V takes ~3s)
INV_STARTUP_GRACE_S   = 10           # ignore inv fault for 10s after cold start
GRID_STARTUP_GRACE_S  = 15           # ignore grid fault for 15s after cold start
_grid_last_zero_ts:   float = 0.0
_grid_was_zero:       bool  = True
_inv_last_zero_ts:    float = 0.0    # when iv last read 0
_inv_was_zero:        bool  = True   # True = inverter was previously at 0V
_prev_inv_v:          float = 0.0    # previous inverter voltage for delta/drift calc

_last_manual_ts: float = 0.0


def _manual_lockout_active() -> bool:
    return (time.time() - _last_manual_ts) < MANUAL_LOCKOUT_S


def _touch_manual_ts():
    global _last_manual_ts
    _last_manual_ts = time.time()


# =============================================================================
#  DHT READ FUNCTION — delegates to Temp.DHTReader (subprocess-isolated)
#  DHTReader handles auto-reinit and GPIO lock prevention internally.
# =============================================================================

def read_dht22() -> float:
    """Read temperature via Temp.DHTReader (subprocess-isolated, auto-reinit).
    Returns temperature in Celsius, or 0.0 if unavailable.
    Valid range: -10°C to 80°C — anything outside is treated as sensor error.
    """
    if not DHT_AVAILABLE or _dht_reader is None:
        return 0.0
    try:
        result = _dht_reader.read_data()
        if result.get("status") == "Online":
            t = result["temperature"]
            # Validate range — DHT22 max is 80°C, 125°C = corrupted reading
            if -10.0 <= t <= 80.0:
                return t
            print(f"[{DHT_TYPE}] Out-of-range reading {t:.1f}°C — treating as error")
            return 0.0
        print(f"[{DHT_TYPE}] {result.get('status','unknown')} — returning 0.0")
        return 0.0
    except Exception as e:
        print(f"[{DHT_TYPE}] read_dht22 error: {e}")
        return 0.0



# =============================================================================
#  INA219 BATTERY READ FUNCTION (replaces PZEM-017)
def _is_daytime() -> bool:
    h = datetime.now().hour
    return SOLAR_DAYLIGHT_START <= h < SOLAR_DAYLIGHT_END


def _grid_is_safe(gv: float, gf: float) -> bool:
    return (
        GRID_CRITICAL_LOW <= gv <= GRID_CRITICAL_HIGH and
        abs(gf - GRID_FREQ_NOMINAL) <= GRID_FREQ_CRIT
    )


def _get_battery_capacity() -> int:
    try:
        conn = get_db()
        cur  = conn.cursor(dictionary=True)
        cur.execute("SELECT config_val FROM system_config WHERE config_key='battery_capacity_ah'")
        row  = cur.fetchone()
        cur.close(); conn.close()
        _val = cast(Dict[str, Any], row).get('config_val', 100) if row else 100
        return int(str(_val))
    except Exception:
        return 100


def _get_battery_current_warn() -> float:
    cap = _get_battery_capacity()
    return float(BAT_OVERCURRENT_CONFIG.get(cap, BAT_OVERCURRENT_CONFIG[100])['warn'])


# =============================================================================
#  SOC CALCULATION — 24V Lead Acid Gel
# =============================================================================

def calculate_pack_soc(pack_voltage: float) -> float:
    """JSL II Series 24V VRLA pack SOC table (2x 12V 100Ah series).
    Calibrated: multimeter 27.5V = full charge (100%).
    """
    # [FIX] Linear interpolation — synced with frontend SOC_TABLE
    _T = [(27.50,100),(27.20,98),(26.90,96),(26.60,94),(26.30,92),(26.00,90),
          (25.70,88),(25.50,85),(25.30,80),(25.10,75),(24.90,70),(24.70,65),
          (24.50,60),(24.30,55),(24.10,50),(23.90,45),(23.76,40),(23.60,35),
          (23.44,30),(23.26,25),(23.10,20),(22.90,15),(22.70,10),(22.40,5),(21.00,0)]
    if pack_voltage >= _T[0][0]:  return 100.0
    if pack_voltage <= _T[-1][0]: return 0.0
    for i in range(len(_T)-1):
        hv,hs = _T[i]; lv,ls = _T[i+1]
        if lv <= pack_voltage <= hv:
            return round(ls + (pack_voltage-lv)/(hv-lv)*(hs-ls), 1)
    return 0.0


# =============================================================================
#  EMAIL ALERT ENGINE
# =============================================================================

def _log_email(
    fault_key:  str,
    fault_type: str,
    severity:   str,
    source:     str,
    recipient:  str,
    status:     str,          # 'sent' | 'failed' | 'skipped_cooldown' | 'no_recipient'
    error_msg:  str = '',
):
    """Insert one row into email_logs. Non-blocking — errors are silently swallowed."""
    try:
        bsoc  = float(cache.get('batterySoc',   0) or 0)
        solar = float(cache.get('solarPower',   0) or 0)
        gv    = float(cache.get('gridVoltage',  0) or 0)
        conn_e = get_db(); cur_e = conn_e.cursor()
        cur_e.execute("""
            INSERT INTO email_logs
                (fault_key, fault_type, severity, source, recipient,
                 status, error_msg, battery_soc, solar_power_w, grid_voltage_v)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (fault_key, fault_type, severity, source, recipient,
              status, error_msg[:255] if error_msg else '',
              bsoc, solar, gv))
        conn_e.commit(); cur_e.close(); conn_e.close()
    except Exception as _e:
        print(f"[email_log] DB write error: {_e}")


def _send_email_alert(
    fault_key:    str,
    fault_type:   str,
    severity:     str,
    action:       str,
    source:       str,
    target_email: Optional[str] = None,
    email_type:   str = "",
    cooldown_override_s: Optional[int] = None,
) -> bool:
    now       = time.time()
    last_sent = _email_cooldowns.get(fault_key, 0)
    cooldown  = cooldown_override_s if cooldown_override_s is not None \
                else (EMAIL_COOLDOWN_CRITICAL_S if severity == "critical" else EMAIL_COOLDOWN_DEFAULT_S)

    if now - last_sent < cooldown:
        _log_email(fault_key, fault_type, severity, source,
                   target_email or '', 'skipped_cooldown',
                   f'Cooldown {int(cooldown - (now - last_sent))}s remaining')
        return False

    try:
        final_recipient = target_email or os.getenv('EMAIL_RECIPIENT', '')
        if not final_recipient:
            _log_email(fault_key, fault_type, severity, source,
                       '', 'no_recipient', 'EMAIL_RECIPIENT not set in .env')
            return False

        gv      = cache.get('grid',     {}).get('voltage',   0)
        gf      = cache.get('grid',     {}).get('frequency', 0)
        iv      = cache.get('inverter', {}).get('voltage',   0)
        inv_f   = cache.get('inverter', {}).get('frequency', 0)
        solar_w = sum(p.get('power', 0) for p in cache.get('solar', []) if 'error' not in p)

        # Battery voltage from Arduino voltage divider (via cache['ina226'])
        ina226_data = cache.get('ina226', {})
        bat_v   = ina226_data.get('voltage', 0)
        bat_soc = ina226_data.get('soc', 0)

        ssr_data: Dict[str, str] = {}
        try:
            conn_s = get_db()
            cur_s  = conn_s.cursor(dictionary=True)
            cur_s.execute(
                "SELECT ssr1_state,ssr2_state,ssr3_state,ssr4_state "
                "FROM ssr_state ORDER BY id DESC LIMIT 1"
            )
            _rs = cur_s.fetchone()
            ssr_row: Dict[str, Any] = cast(Dict[str, Any], _rs) if _rs else {}
            cur_s.close(); conn_s.close()
            if ssr_row:
                ssr_data = {
                    "ssr1_k1": "ON" if ssr_row.get("ssr1_state") else "OFF",
                    "ssr2_k2": "ON" if ssr_row.get("ssr2_state") else "OFF",
                    "ssr3_k3": "ON" if ssr_row.get("ssr3_state") else "OFF",
                    "ssr4_k4": "ON" if ssr_row.get("ssr4_state") else "OFF",
                }
        except Exception:
            ssr_data = {"ssr1_k1": "N/A", "ssr2_k2": "N/A", "ssr3_k3": "N/A", "ssr4_k4": "N/A"}

        active_src = (
            "Solar (SSR1/K1)" if ssr_data.get("ssr1_k1") == "ON" else
            "Grid (SSR2/K2)"  if ssr_data.get("ssr2_k2") == "ON" else "Unknown"
        )

        # ── Get live Arduino SSR status (from ? command, not DB) ──────────
        live_ssr = get_arduino_cache() or {}  # [FIX-DEADLOCK] use cache
        k1_live = "ON" if live_ssr.get("ssr1_k1") == 1 else ("OFF" if "ssr1_k1" in live_ssr else ssr_data.get("ssr1_k1", "N/A"))
        k2_live = "ON" if live_ssr.get("ssr2_k2") == 1 else ("OFF" if "ssr2_k2" in live_ssr else ssr_data.get("ssr2_k2", "N/A"))
        k3_live = "ON" if live_ssr.get("ssr3_k3") == 1 else ("OFF" if "ssr3_k3" in live_ssr else ssr_data.get("ssr3_k3", "N/A"))
        k4_live = "ON" if live_ssr.get("ssr4_k4") == 1 else ("OFF" if "ssr4_k4" in live_ssr else ssr_data.get("ssr4_k4", "N/A"))

        # ── Anomaly engine detail from cache (set by background_logger) ──
        ae_grid = cache.get('aeGridResult', {})
        ae_inv  = cache.get('aeInverterResult', {})

        payload = {
            "to_email":   final_recipient,
            "email_type": email_type,
            "timestamp":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

            # ── Anomaly info (from anomaly_engine) ───────────────────────
            "faultType":      fault_type,
            "severity":       severity,
            "source":         source,
            "anomalyDetail":  action,

            # Grid anomaly engine result
            "gridAnomalyType":     ae_grid.get("anomaly_type", "Normal"),
            "gridAnomalySeverity": ae_grid.get("severity",     "Normal"),
            "gridAnomalyDetail":   ae_grid.get("detail",       "—"),
            "gridAnomalySamples":  ae_grid.get("drop_counter", 0),

            # Inverter anomaly engine result
            "inverterAnomalyType":     ae_inv.get("anomaly_type", "Normal"),
            "inverterAnomalySeverity": ae_inv.get("severity",     "Normal"),
            "inverterAnomalyDetail":   ae_inv.get("detail",       "—"),

            # ── Realtime voltage readings ─────────────────────────────────
            "gridVoltage":       f"{gv:.1f}V",
            "gridFrequency":     f"{gf:.2f}Hz",
            "inverterVoltage":   f"{iv:.1f}V",
            "inverterFrequency": f"{inv_f:.2f}Hz",
            "solarPower":        f"{solar_w:.1f}W",
            "batteryVoltage":    f"{bat_v:.2f}V",
            "battery_soc":       f"{bat_soc:.1f}%",

            # ── SSR / relay status (live from Arduino) ────────────────────
            "activeSource": active_src,
            "k1":  k1_live,   # Solar/Inverter path
            "k2":  k2_live,   # Grid bypass path
            "k3":  k3_live,   # Charging (independent)
            "k4":  k4_live,   # Contactor (Arduino managed)
            "ssrStatus": (
                "Solar (K1)" if k1_live == "ON" else
                "Grid (K2)"  if k2_live == "ON" else
                "Standby"
            ),
            "dropout":   live_ssr.get("dropout",   0),
            "emergency":  live_ssr.get("emergency", 0),

            # ── System condition ──────────────────────────────────────────
            "systemCondition": cache.get('systemCondition', 'Unknown'),
            "buzzerStatus":     "ON" if buzzer_state.get('active') else "OFF",
        }

        # Non-blocking — send in background so Flask logger is not held up
        _email_cooldowns[fault_key] = now  # mark cooldown immediately
        def _do_send(p=payload, fk=fault_key, ft=fault_type, sev=severity,
                     src=source, rec=final_recipient):
            try:
                r = requests.post("http://localhost:5001/api/send-alert", json=p, timeout=10)
                if r.status_code == 200:
                    print(f"EMAIL SENT [{fk}] → {rec}")
                    _log_email(fk, ft, sev, src, rec, 'sent')
                else:
                    print(f"EMAIL FAILED [{fk}] HTTP {r.status_code}")
                    _log_email(fk, ft, sev, src, rec, 'failed',
                               f'email_service returned HTTP {r.status_code}')
            except Exception as e:
                print(f"Email service unreachable: {e}")
                _log_email(fk, ft, sev, src, rec, 'failed', str(e)[:255])
        threading.Thread(target=_do_send, daemon=True, name=f'email-{fault_key}').start()
        print(f"  [EMAIL] queued → {fault_key} ({fault_type})")
        return True
    except Exception as e:
        print(f"Email service unreachable: {e}")
        _log_email(fault_key, fault_type, severity, source,
                   target_email or os.getenv('EMAIL_RECIPIENT', ''),
                   'failed', str(e)[:255])
        return False


def _buzzer_on() -> None:
    """Activate buzzer — RPi GPIO 14 only. Arduino no longer handles buzzer."""
    if GPIO_AVAILABLE and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH)
            print(f"[BUZZER] ON — GPIO{BUZZER_GPIO_PIN}")
        except Exception as e:
            print(f"[BUZZER] GPIO on error: {e}")
    else:
        print(f"[BUZZER] GPIO not available — buzzer disabled")


def _buzzer_off() -> None:
    """Deactivate buzzer — RPi GPIO 14 only."""
    if GPIO_AVAILABLE and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.LOW)
            print(f"[BUZZER] OFF — GPIO{BUZZER_GPIO_PIN}")
        except Exception as e:
            print(f"[BUZZER] GPIO off error: {e}")


# Only these faults trigger buzzer — dropout/double_fault/thermal only
BUZZER_FAULT_KEYS = {'grid_dropout', 'inverter_dropout', 'double_fault', 'thermal_critical'}

def _fire_buzzer_once(fault_key: str, reason: str):
    if fault_key not in BUZZER_FAULT_KEYS:
        return  # spike/drift/warning = email only, no buzzer
    if _buzzer_fired.get(fault_key) or buzzer_state['active']:
        return
    duration_ms = BUZZER_DURATION_MS  # 15s base
    buzzer_state['active']       = True
    buzzer_state['duration_ms']  = duration_ms
    buzzer_state['triggered_at'] = datetime.now().isoformat()
    _buzzer_fired[fault_key]     = True
    _is_double = (fault_key == 'double_fault')

    def _auto_off():
        if _is_double:
            # double fault: slow tut...tut...tut pattern for 10s (0.5s on, 0.5s off = 10 beeps)
            for _ in range(10):
                _buzzer_on()
                time.sleep(0.5)
                _buzzer_off()
                time.sleep(0.5)
        else:
            # single dropout: 15s continuous
            _buzzer_on()
            time.sleep(15.0)
            _buzzer_off()
        buzzer_state['active']      = False
        buzzer_state['duration_ms'] = 0

    threading.Thread(target=_auto_off, daemon=True).start()
    try:
        conn_b = get_db(); cur_b = conn_b.cursor()
        cur_b.execute(
            "INSERT INTO buzzer_logs (duration_ms, reason) VALUES (%s, %s)",
            (BUZZER_DURATION_MS, reason)
        )
        conn_b.commit(); cur_b.close(); conn_b.close()
    except Exception:
        pass


def _db_update_ssr_from_fault(ssr1: bool, ssr2: bool, ssr3: bool, ssr4: bool, mode: str):
    try:
        conn = get_db(); cur = conn.cursor(dictionary=True)

        # Get current state before update (for history log)
        cur.execute("SELECT control_mode, ssr1_state, ssr2_state, ssr3_state, ssr4_state, manual_override FROM ssr_state ORDER BY id DESC LIMIT 1")
        _prev = cur.fetchone()
        prev: Dict[str, Any] = cast(Dict[str, Any], _prev) if _prev else {}
        from_mode = prev.get("control_mode") if prev else None
        prev_ssr  = (bool(prev.get("ssr1_state", 0)), bool(prev.get("ssr2_state", 0)),
                     bool(prev.get("ssr3_state", 0)), bool(prev.get("ssr4_state", 1))) if prev else (False, False, False, True)

        # [FIX-MANUAL-OVERRIDE] If user has manual_override=1, do NOT overwrite DB state.
        # The relay switch itself was already suppressed upstream. Only log the attempt.
        if bool(prev.get('manual_override', 0)):
            print(f"[_db_update_ssr_from_fault] SKIPPED — manual_override active (mode={mode})")
            cur.close(); conn.close()
            return

        cur.execute("""
            UPDATE ssr_state SET
                control_mode=%s,
                ssr1_state=%s, ssr2_state=%s, ssr3_state=%s, ssr4_state=%s,
                contactor_closed=%s, last_switch_time=%s,
                total_switches=total_switches+1
            WHERE id=(SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
        """, (mode, int(ssr1), int(ssr2), int(ssr3), int(ssr4),
              int(ssr4), datetime.now().strftime("%H:%M")))

        # Insert into history log
        _insert_ssr_switch_log(cur,
            trigger_source='auto',
            from_mode=from_mode,
            to_mode=mode,
            before=prev_ssr,
            after=(ssr1, ssr2, ssr3, ssr4),
            reason=f'Auto fault action → {mode}',
        )
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        print(f"_db_update_ssr_from_fault error: {e}")


def _insert_ssr_switch_log(
    cur,
    trigger_source: str,
    from_mode,
    to_mode: str,
    before: tuple,
    after: tuple,
    reason: str = '',
    battery_soc=None,
    solar_power_w=None,
    grid_voltage_v=None,
):
    """Insert one row into ssr_switch_log. cur must be an open cursor."""
    try:
        # Pull live sensor values from cache if not provided
        if battery_soc is None:
            battery_soc = float(cache.get('batterySoc', 0) or 0)
        if solar_power_w is None:
            solar_power_w = float(cache.get('solarPower', 0) or 0)
        if grid_voltage_v is None:
            grid_voltage_v = float(cache.get('gridVoltage', 0) or 0)

        cur.execute("""
            INSERT INTO ssr_switch_log
                (switched_at, trigger_source, from_mode, to_mode,
                 ssr1_before, ssr2_before, ssr3_before, ssr4_before,
                 ssr1_after,  ssr2_after,  ssr3_after,  ssr4_after,
                 reason, battery_soc, solar_power_w, grid_voltage_v)
            VALUES (NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            trigger_source, from_mode, to_mode,
            int(before[0]), int(before[1]), int(before[2]), int(before[3]),
            int(after[0]),  int(after[1]),  int(after[2]),  int(after[3]),
            reason, battery_soc, solar_power_w, grid_voltage_v,
        ))
    except Exception as e:
        print(f"_insert_ssr_switch_log error: {e}")


# =============================================================================
#  ANOMALY RELAY ACTIONS
# =============================================================================

def _fault_action_inverter_critical():
    # [FIX-MANUAL-OVERRIDE] Never force-switch relays if user is in manual override.
    # Buzzer + email still fire — only the physical relay action is suppressed.
    conn = get_db(); cur = conn.cursor(dictionary=True)
    cur.execute("SELECT manual_override FROM ssr_state ORDER BY id DESC LIMIT 1")
    _row = cur.fetchone(); cur.close(); conn.close()
    row: Dict[str, Any] = cast(Dict[str, Any], _row) if _row else {}
    if bool(row.get('manual_override', 0)):
        print("[FAULT ACTION] Inverter critical — SUPPRESSED (manual override active)")
        return
    print("[FAULT ACTION] Inverter critical — switching to Grid bypass (K2 ON)")
    with arduino_sequence_lock:
        arduino_send('q')
        time.sleep(0.15)
        arduino_send('2')
    _db_update_ssr_from_fault(False, True, False, True, 'grid')


def _fault_action_grid_critical():
    # [FIX-MANUAL-OVERRIDE] Never force-switch relays if user is in manual override.
    conn = get_db(); cur = conn.cursor(dictionary=True)
    cur.execute("SELECT manual_override FROM ssr_state ORDER BY id DESC LIMIT 1")
    _row = cur.fetchone(); cur.close(); conn.close()
    row: Dict[str, Any] = cast(Dict[str, Any], _row) if _row else {}
    if bool(row.get('manual_override', 0)):
        print("[FAULT ACTION] Grid critical — SUPPRESSED (manual override active)")
        return
    print("[FAULT ACTION] Grid critical — isolating K2, solar island mode")
    with arduino_sequence_lock:
        arduino_send('w')
    _db_update_ssr_from_fault(True, False, False, True, 'solar')


_flask_start_time: float = time.time()

def _check_double_fault(grid_dropped: bool, inv_dropped: bool):
    """
    State-based double fault detection.
    No time window — if one dropout is active and the other drops = double fault.
    """
    # Block ALL fault detection for 25s after Flask starts
    # PZEM reads 0V during init — prevents false triggers on boot
    if time.time() - _flask_start_time < 25.0:
        return
    global _double_fault_active, _grid_dropout_active, _inv_dropout_active
    global _partial_recovery_sent, _buzzer_fired

    prev_grid = _grid_dropout_active
    prev_inv  = _inv_dropout_active
    _grid_dropout_active = grid_dropped
    _inv_dropout_active  = inv_dropped

    # Both dropped — check if this is a new double fault
    if grid_dropped and inv_dropped:
        if not _double_fault_active:
            _double_fault_active    = True
            _partial_recovery_sent  = False
            print("[DOUBLE FAULT] Both sources down — firing double fault")
            _fire_buzzer_once('double_fault', 'Double Fault — Both sources down')
            _send_email_alert(
                'double_fault', 'Double Fault — Both Sources Down',
                'critical', 'Both Grid and Inverter sources are offline. Battery sustaining load.',
                'Grid AC + Inverter AC Monitor',
                email_type='critical', cooldown_override_s=120,
            )
        return

    # Partial recovery — one returned while double fault was active
    if _double_fault_active and (not grid_dropped or not inv_dropped):
        if not _partial_recovery_sent:
            _partial_recovery_sent = True
            recovered_src = 'Grid' if not grid_dropped else 'Inverter'
            still_down    = 'Inverter' if not grid_dropped else 'Grid'
            print(f"[PARTIAL RECOVERY] {recovered_src} returned, {still_down} still down")
            _send_email_alert(
                'partial_recovery', f'Partial Recovery — {recovered_src} Restored',
                'critical', f'{recovered_src} voltage restored. {still_down} still offline.',
                f'{recovered_src} AC Monitor',
                email_type='critical', cooldown_override_s=60,
            )

    # Full recovery — both returned
    if _double_fault_active and not grid_dropped and not inv_dropped:
        _double_fault_active   = False
        _partial_recovery_sent = False
        # Full reset — ready to detect next event
        _buzzer_fired.pop('double_fault',      None)
        _buzzer_fired.pop('grid_dropout',      None)
        _buzzer_fired.pop('inverter_dropout',  None)
        _buzzer_fired.pop('partial_recovery',  None)
        print("[FULL RECOVERY] Both sources restored — all states reset")
        _send_email_alert(
            'full_recovery', 'Full Recovery — All Sources Restored',
            'critical', 'Both Grid and Inverter sources are back online. System fully operational.',
            'Grid AC + Inverter AC Monitor',
            email_type='critical', cooldown_override_s=60,
        )


def _fault_action_double_fault():
    # [FIX-RPI-LOAD] RPi powered from load — do NOT open contactor
    # Battery sustains load via inverter until grid returns or EcoSolax cuts at 21.6V
    # Buzzer + email already handled by _check_double_fault — no duplicate fire here
    print("[FAULT ACTION] Double fault — Battery sustaining load (buzzer/email via _check_double_fault).")


def _fault_action_battery_critical():
    print("[FAULT ACTION] Battery critical — buzzer+email only, inverter+MCCB protect battery")


# =============================================================================
#  CHECK AND ALERT
# =============================================================================

def check_and_alert(
    fault_key: str, raw_level: str,
    fault_type: str, action: str, source: str,
    safe_reset: bool = False, solar_check: bool = False,
    cursor=None, pack_soc: float = 0.0,
    solar_w: float = 0.0, grid_v: float = 0.0,
    email_type: str = "", target_email: Optional[str] = None,
    system_temp: float = 0.0,
    inverter_power: Optional[float] = None,
    panel_fault_detail: Optional[str] = None,
    # v7.0 anomaly engine fields — forwarded to log_anomaly_to_db
    anomaly_label:  Optional[str]   = None,
    anomaly_source: Optional[str]   = None,
    anomaly_delta:  Optional[float] = None,
    confirm_count:  Optional[int]   = None,
    # v7.0 context snapshot
    context_grid_current:    Optional[float] = None,
    context_grid_frequency:  Optional[float] = None,
    context_inv_voltage:     Optional[float] = None,
    context_inv_current:     Optional[float] = None,
    context_inv_frequency:   Optional[float] = None,
    context_battery_voltage: Optional[float] = None,
    context_battery_current: Optional[float] = None,
    context_solar_power:     Optional[float] = None,
    context_sensor_status:   Optional[str]   = None,
    instant: bool = False,
) -> str:
    global _fault_first_detected, _fault_log_cycle

    if solar_check and not _is_daytime() and raw_level != 'none':
        _fault_counters[fault_key] = 0
        return _fault_state.get(fault_key, 'none')

    if safe_reset:
        prev = _fault_state.get(fault_key, 'none')
        _fault_state[fault_key]    = 'none'
        _fault_counters[fault_key] = 0
        _buzzer_fired[fault_key]   = False
        _fault_first_detected.pop(fault_key, None)
        _fault_log_cycle.pop(fault_key, None)
        # Send recovery email if it was a dropout fault (no buzzer on recovery)
        if prev in ('critical',) and fault_key in ('grid_dropout', 'inverter_dropout', 'grid_voltage', 'inverter_voltage', 'double_fault'):
            _src = 'Grid AC Monitor (PZEM-004T)' if 'grid' in fault_key else 'Inverter AC Monitor (PZEM-004T)'
            # Use clean fault_type for recovery email
            _rec_type = (
                'Grid Dropout — Recovered'     if 'grid' in fault_key
                else 'Inverter Dropout — Recovered'
            )
            print(f"[RECOVERY EMAIL] key={fault_key} type={_rec_type} prev={prev}")
            _send_email_alert(
                fault_key + '_recovered',
                _rec_type,
                'critical',
                f'{source} voltage restored — system reconnecting.',
                _src,
                email_type='critical',
                cooldown_override_s=60,
            )

        if prev in ('warning', 'critical') and cursor:
            try:
                # Resolve in all three tables — source determines which one has the record
                for tbl in ('grid_anomaly_logs', 'inverter_anomaly_logs', 'anomaly_logs'):
                    cursor.execute(f"""
                        UPDATE {tbl}
                        SET status='Resolved', resolved_at=NOW()
                        WHERE type=%s AND status IN ('Monitoring','Active','Warning')
                        ORDER BY id DESC LIMIT 5
                    """, (fault_type,))
            except Exception as e:
                print(f"anomaly resolve update failed: {e}")
        return 'none'

    if raw_level == 'none':
        _fault_counters[fault_key] = max(0, _fault_counters.get(fault_key, 0) - 1)
        return _fault_state.get(fault_key, 'none')

    _fault_counters[fault_key] = _fault_counters.get(fault_key, 0) + 1

    if _fault_counters[fault_key] == 1:
        _fault_first_detected[fault_key] = datetime.now()
        print(f"[FAULT DETECT] {fault_key} first seen at {_fault_first_detected[fault_key].strftime('%H:%M:%S.%f')}")

    if not instant and _fault_counters[fault_key] < (
        FAULT_CONFIRM_COUNT_DROPOUT if 'dropout' in fault_key else FAULT_CONFIRM_COUNT
    ):
        return _fault_state.get(fault_key, 'none')

    prev_state = _fault_state.get(fault_key, 'none')

    ANOMALY_HEARTBEAT_CYCLES = 60   # log every ~5 min when sustained (60 × 5s cycle)

    if raw_level == 'warning':
        _fault_state[fault_key] = 'warning'
        _fault_log_cycle[fault_key] = _fault_log_cycle.get(fault_key, 0) + 1
        is_new_warn   = (prev_state != 'warning')
        if cursor:  # log every cycle
            log_anomaly_to_db(cursor, fault_type, source, "Warning",
                action + (" [sustained]" if not is_new_warn else ""),
                email_sent=False, buzzer_on=False,
                bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                system_temp=system_temp, status="Warning",
                inverter_power=inverter_power,
                panel_fault_detail=panel_fault_detail,
                anomaly_label=anomaly_label, anomaly_source=anomaly_source,
                anomaly_delta=anomaly_delta, confirm_count=confirm_count,
                context_grid_current=context_grid_current,
                context_grid_frequency=context_grid_frequency,
                context_inv_voltage=context_inv_voltage,
                context_inv_current=context_inv_current,
                context_inv_frequency=context_inv_frequency,
                context_battery_voltage=context_battery_voltage,
                context_battery_current=context_battery_current,
                context_solar_power=context_solar_power,
                context_sensor_status=context_sensor_status)
        return 'warning'

    _fault_state[fault_key] = 'critical'
    _fault_log_cycle[fault_key] = _fault_log_cycle.get(fault_key, 0) + 1
    # [FIX-DROPOUT-LOG] instant=True (real dropout, not serial error) always forces
    # a new log entry — even if prev_state was already 'critical' — so flicker/recovery
    # cycles always produce a fresh DB record.
    is_new = (prev_state != 'critical') or instant
    is_heartbeat = (_fault_log_cycle[fault_key] % ANOMALY_HEARTBEAT_CYCLES == 0)

    detected_at = _fault_first_detected.get(fault_key, datetime.now())

    if is_new:
        if fault_key in ('inverter_voltage', 'inverter_dropout'):
            _fault_action_inverter_critical()
        elif fault_key in ('grid_voltage', 'grid_dropout'):
            _fault_action_grid_critical()
        elif fault_key in ('battery_low', 'battery_overcharge'):
            _fault_action_battery_critical()
        elif fault_key == 'double_fault':
            _fault_action_double_fault()

        action_at = datetime.now()
        _fire_buzzer_once(fault_key, fault_type)
        sent = _send_email_alert(fault_key, fault_type, "critical", action, source,
            target_email=target_email, email_type=email_type)
        if cursor:
            log_anomaly_to_db(cursor, fault_type, source, "Critical", action,
                email_sent=sent, buzzer_on=True,
                bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                system_temp=system_temp,
                detected_at=detected_at, action_at=action_at,
                inverter_power=inverter_power,
                panel_fault_detail=panel_fault_detail,
                anomaly_label=anomaly_label, anomaly_source=anomaly_source,
                anomaly_delta=anomaly_delta, confirm_count=confirm_count,
                context_grid_current=context_grid_current,
                context_grid_frequency=context_grid_frequency,
                context_inv_voltage=context_inv_voltage,
                context_inv_current=context_inv_current,
                context_inv_frequency=context_inv_frequency,
                context_battery_voltage=context_battery_voltage,
                context_battery_current=context_battery_current,
                context_solar_power=context_solar_power,
                context_sensor_status=context_sensor_status)
    else:
        sent = _send_email_alert(fault_key, fault_type, "critical", action, source,
            target_email=target_email, email_type=email_type)
        # [FIX-LOG-COOLDOWN] Always log to DB even if email is on cooldown.
        # Old bug: 'if sent and cursor' skipped ALL DB logs during 1472s cooldown window!
        if cursor:
            log_anomaly_to_db(cursor, fault_type, source, "Critical", action,
                email_sent=sent, buzzer_on=False,
                bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                system_temp=system_temp,
                inverter_power=inverter_power,
                panel_fault_detail=panel_fault_detail,
                anomaly_label=anomaly_label, anomaly_source=anomaly_source,
                anomaly_delta=anomaly_delta, confirm_count=confirm_count,
                context_grid_current=context_grid_current,
                context_grid_frequency=context_grid_frequency,
                context_inv_voltage=context_inv_voltage,
                context_inv_current=context_inv_current,
                context_inv_frequency=context_inv_frequency,
                context_battery_voltage=context_battery_voltage,
                context_battery_current=context_battery_current,
                context_solar_power=context_solar_power,
                context_sensor_status=context_sensor_status)

    return 'critical'


def trigger_email_alert(
    fault_type: str, severity: str, action: str,
    source: str = "Smart Energy Monitor",
    target_email: Optional[str] = None,
    cooldown_key: Optional[str] = None,
    email_type: str = "",
) -> bool:
    ck = cooldown_key or fault_type
    return _send_email_alert(ck, fault_type, severity, action, source,
        target_email=target_email, email_type=email_type)


def log_anomaly_to_db(
    cursor,
    fault_type: str,
    source:     str,
    severity:   str,
    action:     str,
    email_sent: bool,
    buzzer_on:  bool,
    bat_soc:    float,
    solar_w:    float,
    grid_v:     float,
    system_temp:        float             = 0.0,
    status:             str               = "Monitoring",
    detected_at:        Optional[datetime] = None,
    action_at:          Optional[datetime] = None,
    inverter_power:     Optional[float]   = None,
    panel_fault_detail: Optional[str]     = None,
    # v7.0 anomaly engine fields
    anomaly_label:  Optional[str]   = None,
    anomaly_source: Optional[str]   = None,
    anomaly_delta:  Optional[float] = None,   # ΔV from AnomalyEngine
    confirm_count:  Optional[int]   = None,   # consecutive confirm readings
    # v7.0 context snapshot — captured at fault confirmation moment
    context_grid_current:    Optional[float] = None,
    context_grid_frequency:  Optional[float] = None,
    context_inv_voltage:     Optional[float] = None,
    context_inv_current:     Optional[float] = None,
    context_inv_frequency:   Optional[float] = None,
    context_battery_voltage: Optional[float] = None,
    context_battery_current: Optional[float] = None,
    context_solar_power:     Optional[float] = None,
    context_sensor_status:   Optional[str]   = None,
) -> None:
    """
    Insert one anomaly event row into the appropriate table.

    [FIX-ANOMALY-LOG] Uses its OWN fresh DB connection — never reuses the
    background_logger cursor which may already be committed/closed.

    Routing (by source string):
      'grid'     + 'ac monitor'  → grid_anomaly_logs
      'inverter' + 'ac monitor'  → inverter_anomaly_logs
      anything else              → anomaly_logs  (battery, solar, thermal…)
    """
    src_lower = (source or '').lower()
    if 'grid' in src_lower and 'ac monitor' in src_lower:
        target_table = 'grid_anomaly_logs'
    elif 'inverter' in src_lower and 'ac monitor' in src_lower:
        target_table = 'inverter_anomaly_logs'
    else:
        target_table = 'anomaly_logs'

    try:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        det_str = detected_at.strftime("%Y-%m-%d %H:%M:%S") if detected_at else now_str
        act_str = action_at.strftime("%Y-%m-%d %H:%M:%S")   if action_at   else now_str

        resp_ms: Optional[int] = None
        if detected_at and action_at:
            resp_ms = int((action_at - detected_at).total_seconds() * 1000)

        # [FIX-DB-TRUNCATE] Safe helpers so INSERT never fails with "Data truncated".
        import math as _math
        def _r(v, n):
            if v is None: return None
            try:
                f = float(v)
                return None if (_math.isnan(f) or _math.isinf(f)) else round(f, n)
            except (TypeError, ValueError): return None
        def _s(v, limit):
            """Truncate string to VARCHAR column limit."""
            if v is None: return None
            return str(v)[:limit]
        def _fv(v, fmt, suffix=''):
            """Format float safely — returns '0.0<suffix>' for nan/inf/None."""
            try:
                f = float(v)
                if _math.isnan(f) or _math.isinf(f): return f'0.0{suffix}'
                return format(f, fmt) + suffix
            except (TypeError, ValueError): return f'0.0{suffix}'

        # [FIX-ANOMALY-LOG] Always open a fresh connection for anomaly inserts.
        # The cursor passed in from background_logger may be mid-transaction or
        # already closed — using it caused silent failures in anomaly_logs.
        _aconn = get_db()
        _acur  = _aconn.cursor()
        _acur.execute(f"""
            INSERT INTO {target_table} (
                timestamp, detected_at, action_at, response_time_ms, resolved_at,
                type, source, severity, system_action,
                system_temp, battery_soc, solar_power, grid_voltage,
                inverter_power, panel_fault_detail,
                email_status, buzzer_status, status,
                anomaly_label, anomaly_source, anomaly_delta, confirm_count,
                context_grid_current, context_grid_frequency, context_inv_voltage, context_inv_current, context_inv_frequency,
                context_battery_voltage, context_battery_current,
                context_solar_power, context_sensor_status
            ) VALUES (
                %s,%s,%s,%s,NULL,
                %s,%s,%s,%s,
                %s,%s,%s,%s,
                %s,%s,
                %s,%s,%s,
                %s,%s,%s,%s,
                %s,%s,%s,%s,%s,
                %s,%s,
                %s,%s
            )
        """, (
            now_str, det_str, act_str, resp_ms,
            # VARCHAR(50), VARCHAR(100), VARCHAR(20), TEXT — truncate to column limits
            _s(fault_type, 50), _s(source, 100), _s(severity, 20), action,
            _r(system_temp, 2),
            # [FIX-DB-TRUNCATE] Use _fv() so nan/inf never reaches the DB
            _fv(bat_soc,  '.1f', '%'),  # VARCHAR(20) — "0.0%" to "100.0%"
            _fv(solar_w,  '.1f', 'W'),  # VARCHAR(20) — "0.0W" to "9999.9W"
            _fv(grid_v,   '.1f', 'V'),  # VARCHAR(20) — "0.0V" to "999.9V"
            _r(inverter_power, 2),
            _s(panel_fault_detail, 100),
            "Sent" if email_sent else "Queued",
            "ON"   if buzzer_on  else "OFF",
            _s(status, 20),
            _s(anomaly_label,  60),   # VARCHAR(60)
            _s(anomaly_source, 50),   # VARCHAR(50)
            _r(anomaly_delta, 3),
            confirm_count,
            _r(context_grid_current,    3),
            _r(context_grid_frequency,   3),
            _r(context_inv_voltage,     2),
            _r(context_inv_current,     3),
            _r(context_inv_frequency,   3),
            _r(context_battery_voltage, 3),
            _r(context_battery_current, 3),
            _r(context_solar_power,     2),
            _s(context_sensor_status,  50),  # VARCHAR(50)
        ))
        _aconn.commit()
        _acur.close()
        _aconn.close()
        print(
            f"[ANOMALY LOG] {target_table} ← {severity} | {fault_type} | "
            f"label={anomaly_label} ΔV={anomaly_delta} confirms={confirm_count} "
            f"resp={resp_ms}ms"
        )
    except Exception as e:
        print(f"[ANOMALY LOG ERROR] {target_table} insert failed: {e}")
        try:
            _aconn.close()
        except Exception:
            pass


# =============================================================================
#  [P1-FIX-5] THERMAL SHUTDOWN
# =============================================================================

def check_thermal(system_temp: float, cursor, pack_soc: float, solar_w: float, grid_v: float):
    global _thermal_shutdown_active

    if system_temp <= 0:
        return

    if system_temp >= TEMP_CRITICAL:
        if not _thermal_shutdown_active:
            print(f"[THERMAL CRITICAL] {system_temp:.1f}°C ≥ {TEMP_CRITICAL}°C — initiating thermal shutdown")
            _thermal_shutdown_active = True

            with arduino_sequence_lock:
                _seq_shutdown()
            _db_update_ssr_from_fault(False, False, False, False, 'shutdown')
            _fire_buzzer_once('thermal_critical', f"Thermal shutdown at {system_temp:.1f}°C")
            _send_email_alert(
                fault_key='thermal_critical',
                fault_type='Thermal Shutdown',
                severity='critical',
                action=(
                    f"Enclosure temperature {system_temp:.1f}°C exceeded {TEMP_CRITICAL}°C limit. "
                    f"All relays OFF. System will auto-resume when temp ≤ {TEMP_RESUME}°C."
                ),
                source=f'{DHT_TYPE} Enclosure Sensor',
                email_type='thermal_critical',
            )
            detected_at = _fault_first_detected.get('thermal_critical', datetime.now())
            action_at   = datetime.now()
            log_anomaly_to_db(
                cursor,
                fault_type='Thermal Shutdown',
                source=f'{DHT_TYPE} Enclosure Sensor',
                severity='Critical',
                action=f"Enclosure {system_temp:.1f}°C > {TEMP_CRITICAL}°C. All relays OFF.",
                email_sent=True, buzzer_on=True,
                bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                system_temp=system_temp,
                detected_at=detected_at, action_at=action_at,
                status='Monitoring',
            )

        check_and_alert(
            fault_key='thermal_critical', raw_level='critical',
            fault_type='Thermal Shutdown', source=f'{DHT_TYPE} Enclosure Sensor',
            action=f"Enclosure {system_temp:.1f}°C > {TEMP_CRITICAL}°C.",
            cursor=cursor, pack_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
            system_temp=system_temp,
        )
        return

    if _thermal_shutdown_active and system_temp <= TEMP_RESUME:
        print(f"[THERMAL RESUME] {system_temp:.1f}°C ≤ {TEMP_RESUME}°C — resuming solar mode")
        _thermal_shutdown_active = False
        with arduino_sequence_lock:
            _seq_solar_on()
        _db_update_ssr_from_fault(True, False, False, True, 'solar')
        check_and_alert(
            fault_key='thermal_critical', raw_level='none',
            fault_type='Thermal Shutdown', source=f'{DHT_TYPE} Enclosure Sensor',
            action='Temperature normalized — system resumed.',
            safe_reset=True, cursor=cursor,
        )
        return

    if system_temp >= TEMP_WARNING:
        check_and_alert(
            fault_key='thermal_warning', raw_level='warning',
            fault_type='High Enclosure Temperature',
            source=f'{DHT_TYPE} Enclosure Sensor',
            action=f"Enclosure {system_temp:.1f}°C — approaching critical limit of {TEMP_CRITICAL}°C.",
            cursor=cursor, pack_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
            system_temp=system_temp,
        )
    else:
        check_and_alert(
            fault_key='thermal_warning', raw_level='none',
            fault_type='High Enclosure Temperature',
            source=f'{DHT_TYPE} Enclosure Sensor',
            action='', safe_reset=True,
        )


# =============================================================================
#  BACKGROUND LOGGER
#  [PZEM017] INA226 read replaces INA219 battery read when available
# =============================================================================

_last_rtc_sync: float = 0.0


def auto_cleanup_logs() -> None:
    import time as _ct
    from datetime import timedelta
    print("[AUTO-CLEANUP] Scheduler started — runs daily at 23:59 (30-day retention)")
    while True:
        now = datetime.now()
        target = now.replace(hour=23, minute=59, second=0, microsecond=0)
        if now >= target:
            target = target + timedelta(days=1)
        _ct.sleep((target - now).total_seconds())
        try:
            conn   = get_db()
            cursor = conn.cursor()
            total  = 0
            for tbl, days in [
                ('anomaly_logs',          30),
                ('grid_anomaly_logs',     30),
                ('inverter_anomaly_logs', 30),
                ('dc_solar_anomaly_logs', 30),
                ('dc_battery_anomaly_logs', 30),
                ('ssr_switch_log',        30),  # [FIX] was 'ssr_switch_logs' (wrong name)
                ('email_logs',            30),
                ('buzzer_logs',           30),
                ('network_logs',          30),
            ]:
                try:
                    cursor.execute(f"DELETE FROM {tbl} WHERE timestamp < NOW() - INTERVAL {days} DAY")
                    total += cursor.rowcount
                    print(f"[AUTO-CLEANUP] {tbl}: {cursor.rowcount} rows deleted")
                except Exception:
                    pass
            for tbl in ('sensor_logs',):
                try:
                    cursor.execute(f"DELETE FROM {tbl} WHERE timestamp < NOW() - INTERVAL 7 DAY")
                    total += cursor.rowcount
                except Exception:
                    pass
            conn.commit(); cursor.close(); conn.close()
            print(f"[AUTO-CLEANUP] Done — {total} rows removed at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        except Exception as e:
            print(f"[AUTO-CLEANUP] Error: {e}")


def background_logger() -> None:
    global _last_rtc_sync, grid_pzem, inverter_pzem
    while True:
        loop_start = time.time()   # [FIX-TIMING] track start for target-time sleep
        try:
            conn   = get_db()
            cursor = conn.cursor(dictionary=True)
            log_data: Dict[str, Any] = {}

            gv = 0.0; gf = 0.0; iv = 0.0; inv_f = 0.0; inv_power = 0.0
            dc_power = 0.0
            pack_voltage = 0.0; pack_current = 0.0; pack_soc = 0.0

            # ── [P1-FIX-4] Read DHT22 temperature ──────────────────────────
            raw_temp = read_dht22()
            if raw_temp > 0:
                cache['system_temp'] = raw_temp
            system_temp = float(cache.get('system_temp', 0))

            # ── DS3231 RTC — periodic NTP sync (every 60s) ─────────────────────
            # If internet is available and NTP is confirmed, update DS3231
            if RTC_AVAILABLE:
                _now = time.time()
                if _now - _last_rtc_sync >= 60:
                    sync_rtc_from_ntp()
                    _last_rtc_sync = _now

            # ── [P1-FIX-5] Thermal check ────────────────────────────────────
            check_thermal(system_temp, cursor, pack_soc, dc_power, gv)

            # ── GRID PZEM ───────────────────────────────────────────────────
            # [FIX-LAZY-REINIT] Re-init grid_pzem if it became None after failed reconnect
            if grid_pzem is None:
                try:
                    import os as _os
                    _gport = UART_CONFIG.get('grid_pzem', {}).get('port', '/dev/ttyGridPZEM')
                    if _os.path.exists(_gport):
                        grid_pzem = PZEM004TReader(port=_gport, slave_addr=0x01)
                        if grid_pzem.serial_connection and grid_pzem.serial_connection.is_open:
                            print(f"[Grid PZEM] Lazy re-init OK on {_gport}")
                        else:
                            grid_pzem = None
                except Exception:
                    grid_pzem = None
            if grid_pzem:
                # [FIX-PZEM-DROPOUT] Track whether 0V is from a PZEM serial error
                # (reconnect transient) vs. a real sustained power loss.
                # Serial errors must NOT fire instant dropout — they need 3 consecutive
                # 0V readings (FAULT_CONFIRM_COUNT) like any other fault.
                _grid_pzem_serial_error = False
                data = grid_pzem.read_all()
                # [FIX-RECONNECT] If serial error — try to reconnect once
                if 'error' in data:
                    _grid_pzem_serial_error = True
                    print(f"[Grid PZEM] Error: {data['error']} — attempting reconnect")
                    try:
                        grid_pzem.close()
                    except Exception:
                        pass
                    try:
                        _gport = UART_CONFIG.get('grid_pzem', {}).get('port', '/dev/ttyGridPZEM')
                        grid_pzem = PZEM004TReader(port=_gport, slave_addr=0x01)
                        if grid_pzem.serial_connection and grid_pzem.serial_connection.is_open:
                            time.sleep(0.2)   # wait for UART to settle before reading
                            data = grid_pzem.read_all()
                            print(f"[Grid PZEM] Reconnected on {_gport} — {data}")
                            if 'error' not in data:
                                # [FIX-REAL-DROPOUT] Reconnect succeeded — UART is healthy.
                                # If voltage=0, this is a REAL power loss (not serial glitch)
                                # → clear serial error flag so instant=True fires immediately.
                                _grid_pzem_serial_error = False
                                if data.get('voltage', 0) == 0:
                                    print(f"[Grid PZEM] Reconnect OK but 0V — REAL dropout confirmed, instant=True")
                            # else: reconnect read also failed → true serial error, keep instant=False
                        else:
                            grid_pzem = None
                            data = {}
                    except Exception as _re:
                        print(f"[Grid PZEM] Reconnect failed: {_re}")
                        grid_pzem = None
                        data = {}
                # [FIX-GHOST] Reject readings where voltage is implausibly out of
                # range — these are garbled Modbus frames, not real grid data.
                # Valid grid: 0V (off) OR 150–270V. Anything else = ghost frame.
                # [FIX-V7.3-GHOST2] Additional guard: V>50 but I<0.01A and P<0.5W = capacitive ghost.
                if data and 'error' not in data:
                    _gv_raw = data.get('voltage', 0)
                    _gc_raw = data.get('current', 0)
                    _gp_raw = data.get('power',   0)
                    _gf_raw = data.get('frequency', 0)
                    if 0 < _gv_raw < 100 or _gv_raw > 300:
                        print(f"[Grid PZEM] Ghost reading rejected: V={_gv_raw:.1f}V (out of plausible range)")
                        data = {}
                    # [FIX-V7.4] Frequency is the primary ghost discriminator.
                    # Real AC always has freq 45-65Hz. Zero current at no-load is NORMAL.
                    # Old I<0.01A guard wrongly rejected real standby readings.
                    elif _gv_raw > 50 and _gf_raw < 45:
                        print(f"[Grid PZEM] Ghost reading rejected: V={_gv_raw:.1f}V F={_gf_raw:.1f}Hz (no AC cycle — capacitive ghost)")
                        data = {}
                if data and 'error' not in data:
                    cache['grid'] = data
                    gv = data.get('voltage', 0); gf = data.get('frequency', 0)
                    log_data['grid_voltage']      = gv
                    log_data['grid_current']      = data.get('current', 0)
                    log_data['grid_power']        = data.get('power', 0)
                    log_data['grid_energy']       = data.get('energy', 0)
                    log_data['grid_frequency']    = gf
                    log_data['grid_power_factor'] = data.get('power_factor', 0)

                    # ── Anomaly engine — grid (Vn=230V) ─────────────────────
                    if _ae_grid is not None and _SensorSample is not None:
                        _gc = data.get('current', 0)
                        _gp = data.get('power', 0)
                        _gc = 0.0 if _gc < 0.5 else _gc  # noise floor
                        _gp = 0.0 if _gp < 5.0 else _gp  # noise floor
                        _ae_g = _ae_grid.process(_SensorSample(
                            voltage=gv,
                            current=_gc,
                            power=_gp,
                        ))
                        cache['aeGridResult'] = {
                            'anomaly_type': _ae_g.anomaly_type,
                            'severity':     _ae_g.severity,
                            'detail':       _ae_g.detail,
                            'voltage':      _ae_g.voltage,
                            'delta_v':      round(_ae_g.delta_v, 2),
                            'pu':           round(_ae_g.pu, 4),
                            'confirmed':    _ae_g.confirmed,
                            'drop_counter': _ae_grid._drop_counter,
                        }
                        if _ae_g.severity != 'Normal':
                            print(f"[AE-GRID] {_ae_g.anomaly_type} {_ae_g.severity}: {_ae_g.detail}")

                elif not data or 'error' in data:
                    # Ghost reading rejected OR PZEM returned error (e.g. "got 0, expected 25")
                    # — zero out stale cache so UI shows 0V not stale 234V
                    cache['grid'] = {'voltage': 0, 'current': 0, 'power': 0, 'frequency': 0, 'energy': 0}
                    gv = 0; gf = 0
                    log_data['grid_voltage']      = 0.0
                    log_data['grid_current']      = 0.0
                    log_data['grid_power']        = 0.0
                    log_data['grid_energy']       = 0.0
                    log_data['grid_frequency']    = 0.0
                    log_data['grid_power_factor'] = 0.0

                # ── Grid anomaly detection — AE is authoritative (tables.pdf) ──
                # AE handles Dropout/Spike/Drift with persistence rules.
                # Flask only overrides for: frequency fault (not in AE) and gv=0 (PZEM error).
                if gv == 0:
                    # [FIX-PZEM-DROPOUT] If this 0V is from a PZEM serial error/reconnect
                    # transient, do NOT fire instant dropout — treat as normal counter-based
                    # fault that requires FAULT_CONFIRM_COUNT consecutive readings.
                    # Only true power loss (persistent 0V across multiple cycles) logs a dropout.
                    _grid_is_instant_dropout = (not _grid_pzem_serial_error)
                    raw_lvl = 'critical'; safe_rst = False
                    fault_action = (
                        "Grid PZEM reading 0V — grid power lost (PZEM serial error or no AC). "
                        "Auto-switching to solar/battery."
                    )
                elif gv > 0 and abs(gf - GRID_FREQ_NOMINAL) > GRID_FREQ_CRIT:
                    _grid_is_instant_dropout = False
                    # Frequency fault — AE does not monitor frequency, Flask handles this
                    raw_lvl = 'critical'; safe_rst = False
                    fault_action = (
                        f"Grid frequency {gf:.2f}Hz deviates >{GRID_FREQ_CRIT}Hz from {GRID_FREQ_NOMINAL}Hz. "
                        f"SSR2/K2+SSR3/K3 isolated (IEEE 1547 Table 2)."
                    )
                else:
                    _grid_is_instant_dropout = False
                    # AE is the sole judge of Dropout/Spike/Drift severity
                    # [FIX-LAG] Use _ae_g directly if available (current cycle), else fall back to cache
                    _ae_g_cur = _ae_g if '_ae_g' in dir() and _ae_g is not None and gv > 0 else None
                    _ae_g_sev = _ae_g_cur.severity     if _ae_g_cur else cache.get('aeGridResult', {}).get('severity', 'Normal')
                    _ae_g_typ = _ae_g_cur.anomaly_type if _ae_g_cur else cache.get('aeGridResult', {}).get('anomaly_type', 'Normal')
                    _ae_g_det = _ae_g_cur.detail       if _ae_g_cur else cache.get('aeGridResult', {}).get('detail', '')
                    # [FIX-CONFIRMED] If AE suppressed via context check, treat as normal
                    if _ae_g_cur and not _ae_g_cur.confirmed:
                        _ae_g_sev = 'Normal'
                    if _ae_g_sev == 'Critical':
                        raw_lvl = 'critical'; safe_rst = False
                        fault_action = f"Grid {_ae_g_typ}: {_ae_g_det}"
                    elif _ae_g_sev == 'Warning':
                        raw_lvl = 'warning'; safe_rst = False
                        fault_action = f"Grid {_ae_g_typ}: {_ae_g_det}"
                    else:
                        raw_lvl = 'none'; safe_rst = True; fault_action = ""
                        # Reset grid_dropout state when voltage returns to normal
                        if _fault_state.get('grid_dropout') in ('critical', 'warning'):
                            prev_gd = _fault_state.pop('grid_dropout', None)
                            _fault_counters.pop('grid_dropout', None)
                            _buzzer_fired.pop('grid_dropout', None)
                            _fault_first_detected.pop('grid_dropout', None)
                            _fault_log_cycle.pop('grid_dropout', None)
                            if prev_gd == 'critical':
                                print("[GRID RECOVERY] Grid voltage restored — sending recovery email")
                                _send_email_alert(
                                    'grid_dropout_recovered',
                                    'Grid Dropout — Recovered',
                                    'critical',
                                    'Grid voltage restored — system reconnecting.',
                                    'Grid AC Monitor (PZEM-004T)',
                                    email_type='critical',
                                    cooldown_override_s=60,
                                )

                # Build AE-derived fields for the log (use cache result set above)
                _ae_g_res = cache.get('aeGridResult', {})
                # [FIX-LABEL-NONE] Guard against None label so we never write "Grid None" to DB
                _ae_g_label  = (_ae_g_res.get('anomaly_type') or None) if _ae_g_res.get('severity') != 'Normal' else None
                if _ae_g_label == 'Normal': _ae_g_label = None
                _ae_g_delta  = _ae_g_res.get('delta_v')
                _ae_g_count  = _ae_g_res.get('drop_counter')

                # [FIX-EMAIL-TYPE] Build fault_type string that email gate can match
                # [FIX-LABEL-NONE] Use "Dropout" directly when gv==0 — never "Grid None"
                _ae_g_email_ft = (
                    "Grid Dropout"                    if gv == 0
                    else f"Grid {_ae_g_label}"        if _ae_g_label
                    else "Grid Voltage / Frequency Anomaly"
                )
                # Double fault tracking — pass current dropout states
                _check_double_fault(
                    grid_dropped=(gv == 0),
                    inv_dropped=(cache.get('inverter', {}).get('voltage', 1) == 0)
                )
                # Use grid_dropout key when voltage=0 so buzzer fires only on dropout
                _g_fault_key = "grid_dropout" if gv == 0 and raw_lvl == 'critical' else "grid_voltage"
                # [FIX-SPIKE-LOG] Spike/Drift = instant log on first detection
                _ae_g_typ_cur = _ae_g_cur.anomaly_type if '_ae_g_cur' in dir() and _ae_g_cur else cache.get('aeGridResult', {}).get('anomaly_type', 'Normal')
                _grid_instant = _grid_is_instant_dropout or (_ae_g_typ_cur in ('Spike', 'Drift') and gv > 0)
                confirmed = check_and_alert(
                    fault_key=_g_fault_key, raw_level=raw_lvl,
                    instant=_grid_instant,
                    fault_type=_ae_g_email_ft,
                    action=fault_action, source="Grid AC Monitor (PZEM-004T)",
                    safe_reset=safe_rst, cursor=cursor,
                    pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                    system_temp=system_temp,
                    email_type="critical",
                    # v7.0 anomaly engine fields
                    anomaly_label=_ae_g_label,
                    anomaly_source="AnomalyEngine(grid,Vn=230V)",
                    anomaly_delta=_ae_g_delta,
                    confirm_count=_ae_g_count,
                    # context snapshot at this cycle
                    context_grid_current=data.get('current') if data else None,
                    context_grid_frequency=gf if gf > 0 else None,
                    context_inv_frequency=cache.get('inverter', {}).get('frequency'),
                    context_battery_voltage=pack_voltage if pack_voltage > 0 else None,
                    context_battery_current=pack_current if pack_voltage > 0 else None,
                    context_solar_power=dc_power if dc_power > 0 else None,
                )
                cache['gridAnomaly'] = confirmed

                # ── Normal heartbeat log — every 5s cycle, direct cursor (no extra TCP) ──
                # [FIX-INTERVAL] log_anomaly_to_db() opens _aconn=get_db() = new TCP connection
                # per call (~1-2s on RPi). Grid+Inverter = 2-4s wasted per cycle → actual cycle
                # becomes 7-12s instead of 5s. Fix: INSERT directly using main cursor.
                if raw_lvl == 'none' and gv > 0:
                    _ae_g_res_n = cache.get('aeGridResult', {})
                    import math as _m2
                    def _r2(v, n):
                        if v is None: return None
                        try:
                            f = float(v)
                            return None if (_m2.isnan(f) or _m2.isinf(f)) else round(f, n)
                        except: return None
                    try:
                        cursor.execute("""
                            INSERT INTO grid_anomaly_logs
                              (timestamp, detected_at, action_at,
                               type, source, severity, system_action,
                               system_temp, battery_soc, solar_power, grid_voltage,
                               inverter_power, email_status, buzzer_status, status,
                               anomaly_label, anomaly_source, anomaly_delta, confirm_count,
                               context_grid_current, context_grid_frequency,
                               context_battery_voltage, context_battery_current,
                               context_solar_power)
                            VALUES (NOW(),NOW(),NOW(),
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,%s)
                        """, (
                            'Grid Voltage Normal', 'Grid AC Monitor (PZEM-004T)', 'Normal',
                            f"Grid voltage {gv:.1f}V — nominal. Frequency {gf:.2f}Hz.",
                            _r2(system_temp, 2),
                            f"{pack_soc:.1f}%", f"{dc_power:.1f}W", f"{gv:.1f}V",
                            _r2(inv_power, 2), 'Queued', 'OFF', 'Normal',
                            None, 'AnomalyEngine(grid,Vn=230V)',
                            _r2(_ae_g_res_n.get('delta_v'), 3),
                            _ae_g_res_n.get('drop_counter'),
                            _r2(cache.get('grid', {}).get('current'), 3),
                            _r2(gf if gf > 0 else None, 3),
                            _r2(pack_voltage if pack_voltage > 0 else None, 3),
                            _r2(pack_current if pack_voltage > 0 else None, 3),
                            _r2(dc_power if dc_power > 0 else None, 2),
                        ))
                    except Exception as _gnl_e:
                        print(f"[GRID-LOG] heartbeat insert error: {_gnl_e}")

            # ── INVERTER PZEM ───────────────────────────────────────────────
            # [FIX-LAZY-REINIT] If inverter_pzem became None (failed reconnect),
            # try to re-initialize on every loop iteration until it succeeds.
            if inverter_pzem is None:
                try:
                    import os as _os
                    _inv_port = UART_CONFIG.get('inverter_pzem', {}).get('port', '/dev/ttyInverterPZEM')
                    if _os.path.exists(_inv_port):
                        inverter_pzem = InverterPZEMReader(port=_inv_port, slave_addr=0x01)
                        if inverter_pzem.serial_connection and inverter_pzem.serial_connection.is_open:
                            print(f"[Inverter PZEM] Lazy re-init OK on {_inv_port}")
                        else:
                            inverter_pzem = None
                except Exception as _li_e:
                    inverter_pzem = None
            if inverter_pzem:
                # [FIX-PZEM-DROPOUT] Same serial-error tracking as grid
                _inv_pzem_serial_error = False
                data = inverter_pzem.read_all()
                # [FIX-RECONNECT] Auto-reconnect on serial error
                if 'error' in data:
                    _inv_pzem_serial_error = True
                    print(f"[Inverter PZEM] Error: {data['error']} — attempting reconnect")
                    try:
                        inverter_pzem.close()
                    except Exception:
                        pass
                    try:
                        port = UART_CONFIG.get('inverter_pzem', {}).get('port', '/dev/ttyInverterPZEM')
                        inverter_pzem = InverterPZEMReader(port=port, slave_addr=0x01)
                        if inverter_pzem.serial_connection and inverter_pzem.serial_connection.is_open:
                            time.sleep(0.2)   # wait for UART to settle before reading
                            data = inverter_pzem.read_all()
                            print(f"[Inverter PZEM] Reconnected — {data}")
                            if 'error' not in data:
                                # [FIX-REAL-DROPOUT] Reconnect succeeded — UART is healthy.
                                # If voltage=0, this is a REAL power loss (not serial glitch)
                                # → clear serial error flag so instant=True fires immediately.
                                _inv_pzem_serial_error = False
                                if data.get('voltage', 0) == 0:
                                    print(f"[Inverter PZEM] Reconnect OK but 0V — REAL dropout confirmed, instant=True")
                            # else: reconnect read also failed → true serial error, keep instant=False
                        else:
                            inverter_pzem = None
                            data = {}
                    except Exception as _re:
                        print(f"[Inverter PZEM] Reconnect failed: {_re}")
                        inverter_pzem = None
                        data = {}
                # [FIX-GHOST] Reject implausible inverter voltage readings.
                # Valid inverter output: 0V (off) OR 150–270V. Else = ghost frame.
                # [FIX-V7.3-GHOST2] Additional guard: if voltage > 0 but current=0 AND power=0,
                # this is a capacitive ghost — PZEM-004T holds residual charge after AC removed.
                # Real inverter always has some current draw (>0.01A) when outputting voltage.
                if data and 'error' not in data:
                    _iv_raw = data.get('voltage', 0)
                    _ic_raw = data.get('current', 0)
                    _ip_raw = data.get('power',   0)
                    _if_raw = data.get('frequency', 0)
                    if 0 < _iv_raw < 100 or _iv_raw > 300:
                        print(f"[Inverter PZEM] Ghost reading rejected: V={_iv_raw:.1f}V (out of plausible range)")
                        data = {}
                    # [FIX-V7.4] Frequency is the primary ghost discriminator (same fix as grid).
                    elif _iv_raw > 50 and _if_raw < 45:
                        print(f"[Inverter PZEM] Ghost reading rejected: V={_iv_raw:.1f}V F={_if_raw:.1f}Hz (no AC cycle — capacitive ghost)")
                        data = {}
                if data and 'error' not in data:
                    cache['inverter'] = data
                    iv        = data.get('voltage', 0)
                    inv_f     = data.get('frequency', 0)
                    inv_power = data.get('power', 0)
                    log_data['inverter_voltage']   = iv
                    log_data['inverter_current']   = data.get('current', 0)
                    log_data['inverter_power']     = inv_power
                    log_data['inverter_frequency'] = inv_f

                    # ── Anomaly engine — inverter (Vn=220V) ──────────────────
                    if _ae_inverter is not None and _SensorSample is not None:
                        _ic = data.get('current', 0)
                        _ip = inv_power
                        _ic = 0.0 if _ic < 0.5 else _ic  # noise floor
                        _ip = 0.0 if _ip < 5.0 else _ip  # noise floor
                        _ae_i = _ae_inverter.process(_SensorSample(
                            voltage=iv,
                            current=_ic,
                            power=_ip,
                        ))
                        cache['aeInverterResult'] = {
                            'anomaly_type': _ae_i.anomaly_type,
                            'severity':     _ae_i.severity,
                            'detail':       _ae_i.detail,
                            'voltage':      _ae_i.voltage,
                            'delta_v':      round(_ae_i.delta_v, 2),
                            'pu':           round(_ae_i.pu, 4),
                            'confirmed':    _ae_i.confirmed,
                            'drop_counter': _ae_inverter._drop_counter,
                        }
                        if _ae_i.severity != 'Normal':
                            print(f"[AE-INV] {_ae_i.anomaly_type} {_ae_i.severity}: {_ae_i.detail}")

                elif not data or 'error' in data:
                    # Ghost rejected OR PZEM error — zero out stale cache immediately.
                    cache['inverter'] = {'voltage': 0, 'current': 0, 'power': 0, 'frequency': 0}
                    iv = 0; inv_f = 0; inv_power = 0
                    log_data['inverter_voltage']   = 0.0
                    log_data['inverter_current']   = 0.0
                    log_data['inverter_power']     = 0.0
                    log_data['inverter_frequency'] = 0.0

                # ── Inverter cold-start ramp guard + anomaly detection ──────
                # Runs for both valid-data AND ghost/zero cases so anomaly
                # log and check_and_alert fire on every background_logger cycle.
                global _inv_was_zero, _inv_last_zero_ts
                _now_ts = time.time()
                if iv == 0 and not _inv_was_zero:
                    _inv_was_zero    = True
                    _inv_last_zero_ts = _now_ts
                elif iv > 0 and _inv_was_zero:
                    _inv_was_zero    = False
                    _inv_last_zero_ts = _now_ts  # record ramp-start time
                _inv_in_startup = (iv > 0 and not _inv_was_zero and
                                   (_now_ts - _inv_last_zero_ts) < INV_STARTUP_GRACE_S)

                if _inv_in_startup:
                    raw_lvl = 'none'; safe_rst = False; fault_action = ""
                    print(f"[INV-STARTUP] {iv:.1f}V — ramp-up grace period "
                          f"({int(INV_STARTUP_GRACE_S - (_now_ts - _inv_last_zero_ts))}s remaining)")
                elif iv == 0:
                    # [FIX-PZEM-DROPOUT] Serial error = NOT instant, requires 3 consecutive readings
                    _inv_is_instant_dropout = (not _inv_pzem_serial_error)
                    raw_lvl = 'critical'; safe_rst = False
                    fault_action = (
                        "Inverter PZEM reading 0V — inverter offline. "
                        "Switching to Grid bypass (SSR2/K2 ON)."
                    )
                else:
                    _inv_is_instant_dropout = False
                    # AE is the sole judge of Dropout/Spike/Drift severity (tables.pdf)
                    # [FIX-LAG] Use _ae_i directly if available (current cycle), else fall back to cache
                    _ae_i_cur = _ae_i if '_ae_i' in dir() and _ae_i is not None and iv > 0 else None
                    _ae_i_sev = _ae_i_cur.severity     if _ae_i_cur else cache.get('aeInverterResult', {}).get('severity', 'Normal')
                    _ae_i_typ = _ae_i_cur.anomaly_type if _ae_i_cur else cache.get('aeInverterResult', {}).get('anomaly_type', 'Normal')
                    _ae_i_det = _ae_i_cur.detail       if _ae_i_cur else cache.get('aeInverterResult', {}).get('detail', '')
                    # [FIX-CONFIRMED] If AE suppressed via context check, treat as normal
                    _ae_i_confirmed = _ae_i_cur.confirmed if _ae_i_cur else True
                    if not _ae_i_confirmed:
                        _ae_i_sev = 'Normal'
                    if _ae_i_sev == 'Critical':
                        raw_lvl = 'critical'; safe_rst = False
                        fault_action = f"Inverter {_ae_i_typ}: {_ae_i_det}"
                    elif _ae_i_sev == 'Warning':
                        raw_lvl = 'warning'; safe_rst = False
                        fault_action = f"Inverter {_ae_i_typ}: {_ae_i_det}"
                    else:
                        raw_lvl = 'none'; safe_rst = True; fault_action = ""
                        # Also reset inverter_dropout state when voltage returns
                        if _fault_state.get('inverter_dropout') == 'critical':
                            check_and_alert(
                                fault_key='inverter_dropout', raw_level='none',
                                instant=False, fault_type='Inverter Dropout',
                                action='Inverter voltage restored.', source='Inverter AC Monitor (PZEM-004T)',
                                safe_reset=True, cursor=cursor,
                                pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                                system_temp=system_temp, email_type='critical',
                            )

                # Build AE-derived fields for the log
                _ae_i_res = cache.get('aeInverterResult', {})
                # [FIX-LABEL-NONE] Guard None so we never write "Inverter None" to DB
                _ae_i_label = (_ae_i_res.get('anomaly_type') or None) if _ae_i_res.get('severity') != 'Normal' else None
                if _ae_i_label == 'Normal': _ae_i_label = None
                _ae_i_delta = _ae_i_res.get('delta_v')
                _ae_i_count = _ae_i_res.get('drop_counter')

                # [FIX-LABEL-NONE] Use "Dropout" directly — never "Inverter None"
                _ae_i_email_ft = (
                    "Inverter Dropout"             if iv == 0
                    else f"Inverter {_ae_i_label}" if _ae_i_label
                    else "Inverter Voltage Anomaly"
                )
                # Use inverter_dropout key when voltage=0 so buzzer fires only on dropout
                _i_fault_key = "inverter_dropout" if iv == 0 and raw_lvl == 'critical' else "inverter_voltage"
                # [FIX-SPIKE-LOG] Spike/Drift = instant log on first detection.
                # Spikes are transient (1-2 readings) — waiting for 3 confirms means they're never logged.
                _ae_i_typ_cur = _ae_i_cur.anomaly_type if '_ae_i_cur' in dir() and _ae_i_cur else cache.get('aeInverterResult', {}).get('anomaly_type', 'Normal')
                _inv_instant = (
                    (_inv_is_instant_dropout if iv == 0 else False) or
                    (_ae_i_typ_cur in ('Spike', 'Drift') and iv > 0)
                )
                confirmed = check_and_alert(
                    fault_key=_i_fault_key, raw_level=raw_lvl,
                    instant=_inv_instant,
                    fault_type=_ae_i_email_ft,
                    action=fault_action, source="Inverter AC Monitor (PZEM-004T)",
                    safe_reset=safe_rst, cursor=cursor,
                    pack_soc=pack_soc, solar_w=dc_power, grid_v=iv,
                    system_temp=system_temp,
                    email_type="critical",
                    inverter_power=inv_power,
                    # v7.0 anomaly engine fields
                    anomaly_label=_ae_i_label,
                    anomaly_source="AnomalyEngine(inverter,Vn=220V)",
                    anomaly_delta=_ae_i_delta,
                    confirm_count=_ae_i_count,
                    # context snapshot
                    context_grid_current=cache.get('grid', {}).get('current'),
                    context_inv_voltage=iv if iv > 0 else None,
                    context_inv_current=cache.get('inverter', {}).get('current') or None,
                    context_inv_frequency=inv_f if inv_f > 0 else None,
                    context_battery_voltage=pack_voltage if pack_voltage > 0 else None,
                    context_battery_current=pack_current if pack_voltage > 0 else None,
                    context_solar_power=dc_power if dc_power > 0 else None,
                )
                cache['inverterAnomaly'] = confirmed

                # ── Normal heartbeat log — every 5s cycle, direct cursor (no extra TCP) ──
                # [FIX-INTERVAL] Same fix as grid — avoid _aconn=get_db() TCP overhead
                if raw_lvl == 'none' and iv > 0:
                    _ae_i_res_n = cache.get('aeInverterResult', {})
                    import math as _m3
                    def _r2(v, n):
                        if v is None: return None
                        try:
                            f = float(v)
                            return None if (_m3.isnan(f) or _m3.isinf(f)) else round(f, n)
                        except: return None
                    try:
                        cursor.execute("""
                            INSERT INTO inverter_anomaly_logs
                              (timestamp, detected_at, action_at,
                               type, source, severity, system_action,
                               system_temp, battery_soc, solar_power, grid_voltage,
                               inverter_power, email_status, buzzer_status, status,
                               anomaly_label, anomaly_source, anomaly_delta, confirm_count,
                               context_grid_current,
                               context_inv_voltage, context_inv_current, context_inv_frequency,
                               context_battery_voltage, context_battery_current,
                               context_solar_power)
                            VALUES (NOW(),NOW(),NOW(),
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s,%s,
                              %s,%s,%s)
                        """, (
                            'Inverter Voltage Normal', 'Inverter AC Monitor (PZEM-004T)', 'Normal',
                            f"Inverter voltage {iv:.1f}V — nominal. Frequency {inv_f:.2f}Hz.",
                            _r2(system_temp, 2),
                            f"{pack_soc:.1f}%", f"{dc_power:.1f}W", f"{iv:.1f}V",
                            _r2(inv_power, 2), 'Queued', 'OFF', 'Normal',
                            None, 'AnomalyEngine(inverter,Vn=220V)',
                            _r2(_ae_i_res_n.get('delta_v'), 3),
                            _ae_i_res_n.get('drop_counter'),
                            _r2(cache.get('grid', {}).get('current'), 3),
                            _r2(iv if iv > 0 else None, 2),
                            _r2(cache.get('inverter', {}).get('current') or None, 3),
                            _r2(inv_f if inv_f > 0 else None, 3),
                            _r2(pack_voltage if pack_voltage > 0 else None, 3),
                            _r2(pack_current if pack_voltage > 0 else None, 3),
                            _r2(dc_power if dc_power > 0 else None, 2),
                        ))
                    except Exception as _inl_e:
                        print(f"[INV-LOG] heartbeat insert error: {_inl_e}")

            # ── SOLAR — WCS1500 + Voltage Divider via Arduino A0-A4 ─────────
            # Arduino v6.5 '?' response:
            #   solar.v       — DC array voltage: readAdcVoltage(A4) × VDIV_RATIO(38.09)
            #                   filtered: < 16.9V → 0.0V
            #   solar.i0–i3   — per-panel WCS1500 current (A0–A3)
            #                   zero offsets: [2.4740, 2.5096, 2.4999, 2.5148]V
            #                   sensitivity: 11mV/A, filter: < 1.33A → 0.0A
            #   solar.i_total — 2S2P array current:
            #                   ((i0+i1)/2) + ((i2+i3)/2)  ← string avg, not sum
            #   solar.p_total — v × i_total  (W)
            # [FIX-ARDUINO-BLOCK] Use cached result from arduino_poller thread.
            # arduino_get_status() blocks ~0.5s per call (8 retries × 0.06s).
            # get_arduino_cache() returns instantly from memory — no serial wait.
            arduino_status = get_arduino_cache()
            if arduino_status and 'solar' in arduino_status:
                sol = arduino_status.get('solar', {})
                sv        = float(sol.get('v',       0)) + 1.39  # [CAL-2026-04-27: multimeter=99V, raw=97.61V]
                si_total  = float(sol.get('i_total', 0))
                sp_total  = float(sol.get('p_total', 0))
                si0       = float(sol.get('i0', 0))
                si1       = float(sol.get('i1', 0))
                si2       = float(sol.get('i2', 0))
                si3       = float(sol.get('i3', 0))
                dc_power  = sp_total

                # Build per-panel cache list matching old INA219 format
                # so SolarPanelsStatusCard.tsx gets stringCurrents correctly
                string_currents = [si0, si1, si2, si3]
                panels = [
                    {'label': f'PV-0{i+1}', 'voltage': sv, 'current': string_currents[i],
                     'power': round(sv * string_currents[i], 1)}
                    for i in range(4)
                ]
                cache['solar']          = panels
                cache['solarVoltage']   = round(sv, 2)
                # [WCS-FALLBACK] Use inverter AC current as solar current proxy
                # WCS sensors unreliable — inverter PZEM current used instead
                inv_current = cache.get('inverterCurrent', 0) or 0
                inv_power   = cache.get('inverterPower',   0) or 0
                if inv_current > 0:
                    # Distribute inverter AC current across 4 panels (2S2P)
                    offsets = [+0.05, -0.05, +0.03, -0.03]
                    est_strings = [max(0.0, round(inv_current / 4 + o, 3)) for o in offsets]
                    cache['solarCurrent']    = round(inv_current, 3)
                    cache['stringCurrents']  = est_strings
                elif si_total > 0:
                    cache['solarCurrent']   = round(si_total, 3)
                else:
                    cache['solarCurrent']   = 0.0
                # [FIX-WCS] If all WCS sensors read 0 but solar voltage present,
                # estimate solar current from inverter AC power / solar DC voltage
                if si_total == 0.0 and sv > 50:
                    inv_power = cache.get('inverterPower', 0) or 0
                    if inv_power > 10 and sv > 0:
                        est_efficiency = 0.92  # typical inverter efficiency
                        est_dc_current = (inv_power / est_efficiency) / sv
                        cache['solarCurrent'] = round(est_dc_current, 3)
                        cache['stringCurrents'] = [
                            round(est_dc_current / 4 + o, 3)
                            for o in [+0.10, -0.10, +0.05, -0.05]
                        ]
                        cache['stringCurrents'] = [max(0, x) for x in cache['stringCurrents']]
                cache['solarPower']     = round(sp_total, 1)
                cache['stringCurrents'] = string_currents

                # ── DC Voltage Anomaly Detection — solar string ───────────────
                if _dc_ae_solar is not None and _DCSensorSample is not None and sv >= 0:
                    _dc_sol_r = _dc_ae_solar.process(_DCSensorSample(
                        voltage=sv,
                        current=si_total,
                        power=sp_total,
                    ))
                    cache['dcSolarAnomalyResult'] = {
                        'anomaly_type': _dc_sol_r.anomaly_type,
                        'severity':     _dc_sol_r.severity,
                        'detail':       _dc_sol_r.detail,
                        'voltage':      _dc_sol_r.voltage,
                        'delta_v':      _dc_sol_r.delta_v,
                        'confirmed':    _dc_sol_r.confirmed,
                    }
                    cache['dcSolarAnomaly'] = (
                        'critical' if _dc_sol_r.severity == 'Critical' else
                        'warning'  if _dc_sol_r.severity == 'Warning'  else 'none'
                    )
                    # [FIX-EVERY-CYCLE] Log every 5s cycle — every reading
                    if True:
                        try:
                            # [FIX-DB] Reuse main cursor — no extra get_db() needed
                            cursor.execute("""
                                INSERT INTO dc_solar_anomaly_logs
                                  (source, anomaly_type, severity, detail, voltage, delta_v, pu,
                                   confirmed, context_note, battery_soc, solar_power, grid_voltage,
                                   system_temp, status)
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            """, (
                                'solar', _dc_sol_r.anomaly_type, _dc_sol_r.severity,
                                _dc_sol_r.detail[:500], round(_dc_sol_r.voltage, 3),
                                round(_dc_sol_r.delta_v, 3), round(_dc_sol_r.pu, 4),
                                int(_dc_sol_r.confirmed), _dc_sol_r.context_note[:300] or None,
                                round(pack_soc, 2), round(sp_total, 2), round(gv, 2),
                                round(system_temp, 2) if system_temp else None,
                                'Active' if _dc_sol_r.severity != 'Normal' else 'Monitoring',
                            ))
                        except Exception as _sle:
                            print(f"[DC-AE] solar log insert error: {_sle}")


                # ── PER-PANEL HEALTH DETECTION (daytime only) ──
                # Health = (current / 13.28A Imp) × 100%
                # Stage 1 (1st detection < 40%) → email only: clean panels
                # Stage 2 (still < 40% after 14 days) → email + buzzer: problem
                _PANEL_IMP      = 13.28
                _PANEL_CRIT_PCT = 20.0
                _PANEL_WARN_PCT = 40.0
                _now_iso = time.strftime("%Y-%m-%d %H:%M:%S")
                if _is_daytime() and (sv > 0 or si_total > 0):
                    # [FIX-DB] Reuse main cursor instead of 4 separate get_db() calls (one per panel)
                    # Opening 4 new TCP connections every 5s was a major source of loop delay on Pi.
                    for _pi, _pc in enumerate(string_currents):
                        _pid  = f"PV-0{_pi+1}"
                        _hlth = round((_pc / _PANEL_IMP) * 100, 1)
                        try:
                            if _hlth >= _PANEL_WARN_PCT:
                                # Healthy — clear alert record
                                cursor.execute("DELETE FROM solar_panel_alerts WHERE panel_id=%s", (_pid,))
                            else:
                                # Degraded — check existing record
                                cursor.execute(
                                    "SELECT id, first_detected, alert_stage, email_sent_at, buzzer_fired "
                                    "FROM solar_panel_alerts WHERE panel_id=%s", (_pid,)
                                )
                                _prow = cursor.fetchone()
                                if _prow is None:
                                    # First detection — insert stage 1
                                    cursor.execute(
                                        "INSERT INTO solar_panel_alerts "
                                        "(panel_id, first_detected, last_detected, health_pct, alert_stage) "
                                        "VALUES (%s, %s, %s, %s, 1)",
                                        (_pid, _now_iso, _now_iso, _hlth)
                                    )
                                    print(f"[SOLAR PANEL] {_pid} first degraded — health={_hlth:.1f}% — monitoring started")
                                else:
                                    _prow_id, _pfirst, _pstage, _pemail, _pbuzz = _prow
                                    # Update last_detected + health
                                    cursor.execute(
                                        "UPDATE solar_panel_alerts SET last_detected=%s, health_pct=%s WHERE id=%s",
                                        (_now_iso, _hlth, _prow_id)
                                    )
                                    from datetime import datetime as _dt
                                    _pdays = (_dt.now() - _dt.strptime(str(_pfirst), "%Y-%m-%d %H:%M:%S")).days
                                    if _pstage == 1 and _pemail is None:
                                        # Stage 1 — first email: clean panels
                                        _plabel  = "Replace Now" if _hlth < _PANEL_CRIT_PCT else "Aging — Clean Required"
                                        _paction = (
                                            f"{_pid} health at {_hlth:.0f}% ({_plabel}). "
                                            f"{'Panel output critically low — inspect for damage or shading.' if _hlth < _PANEL_CRIT_PCT else 'Clean panel surface and check MC4 connectors.'} "
                                            f"Monitor for 14 days after cleaning before deciding replacement."
                                        )
                                        _send_email_alert(
                                            f"solar_panel_{_pid.lower().replace('-', '_')}",
                                            f"Solar Panel Alert — {_pid} Degraded ({_plabel})",
                                            "critical",
                                            _paction,
                                            f"Solar Monitor ({_pid})",
                                            email_type="solar_panel",
                                            cooldown_override_s=86400,
                                        )
                                        cursor.execute(
                                            "UPDATE solar_panel_alerts SET email_sent_at=%s WHERE id=%s",
                                            (_now_iso, _prow_id)
                                        )
                                        print(f"[SOLAR PANEL] {_pid} Stage 1 email sent — health={_hlth:.1f}%")
                                    elif _pstage == 1 and _pdays >= 14 and _hlth < _PANEL_WARN_PCT:
                                        # Stage 2 — still degraded after 14 days — email + buzzer
                                        _paction2 = (
                                            f"{_pid} still at {_hlth:.0f}% health after {_pdays} days monitoring. "
                                            f"Panel has not recovered after cleaning. "
                                            f"{'Replacement strongly recommended.' if _hlth < _PANEL_CRIT_PCT else 'Schedule inspection and consider replacement.'} "
                                        )
                                        _send_email_alert(
                                            f"solar_panel_{_pid.lower().replace('-', '_')}_stage2",
                                            f"Solar Panel Problem — {_pid} Needs Action ({_pdays} days)",
                                            "critical",
                                            _paction2,
                                            f"Solar Monitor ({_pid})",
                                            email_type="solar_panel",
                                            cooldown_override_s=86400,
                                        )
                                        cursor.execute(
                                            "UPDATE solar_panel_alerts SET alert_stage=2, email_sent_at=%s WHERE id=%s",
                                            (_now_iso, _prow_id)
                                        )
                                        # Buzzer — 3 short beeps
                                        if not _pbuzz and GPIO_AVAILABLE:
                                            def _panel_buzz():
                                                import time as _t
                                                for _ in range(3):
                                                    _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH)
                                                    _t.sleep(0.5)
                                                    _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.LOW)
                                                    _t.sleep(0.3)
                                            threading.Thread(target=_panel_buzz, daemon=True).start()
                                            cursor.execute(
                                                "UPDATE solar_panel_alerts SET buzzer_fired=1 WHERE id=%s",
                                                (_prow_id,)
                                            )
                                        print(f"[SOLAR PANEL] {_pid} Stage 2 — problem confirmed, buzzer fired")
                        except Exception as _pe:
                            print(f"[SOLAR PANEL] DB error {_pid}: {_pe}")

                log_data['solar_dc_voltage'] = round(sv, 2)
                log_data['solar_dc_current'] = round(si_total, 3)
                log_data['solar_dc_power']   = round(sp_total, 1)

                print(f"[SOLAR WCS1500] V={sv:.1f}V | "
                      f"I={si_total:.2f}A (PV01={si0:.2f} PV02={si1:.2f} "
                      f"PV03={si2:.2f} PV04={si3:.2f}) | P={sp_total:.1f}W")

                # String mismatch check
                active = [c for c in string_currents if c > 0]
                if active:
                    avg     = sum(active) / len(active)
                    max_dev = max(abs(c - avg) / avg for c in active) if avg > 0 else 0
                    panel_detail = (
                        f"Strings: {[round(c,2) for c in string_currents]} A | "
                        f"avg={avg:.2f}A | dev={max_dev*100:.0f}%"
                    )
                    if max_dev > STRING_MISMATCH_CRITICAL:
                        check_and_alert(
                            fault_key="solar_string_mismatch",
                            raw_level='critical',
                            fault_type="Solar String Mismatch",
                            action=f"Panel current variance {max_dev*100:.0f}% > {STRING_MISMATCH_CRITICAL*100:.0f}%. "
                                   f"{panel_detail}",
                            source="Solar PV Monitor (WCS1500)",
                            safe_reset=False, cursor=cursor,
                            pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                            system_temp=system_temp,
                            panel_fault_detail=panel_detail,
                        )
                    elif max_dev > STRING_MISMATCH_WARNING:
                        check_and_alert(
                            fault_key="solar_string_mismatch",
                            raw_level='warning',
                            fault_type="Solar String Mismatch",
                            action=f"Panel current variance {max_dev*100:.0f}% > {STRING_MISMATCH_WARNING*100:.0f}%. "
                                   f"{panel_detail}",
                            source="Solar PV Monitor (WCS1500)",
                            safe_reset=False, cursor=cursor,
                            pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                            system_temp=system_temp,
                            panel_fault_detail=panel_detail,
                        )

                # Solar power anomaly check
                if _is_daytime() and dc_power > 0 and dc_power < SOLAR_CRITICAL_W:
                    raw_lvl = 'critical'; safe_rst = False
                    fault_action = f"Solar {dc_power:.0f}W < {SOLAR_CRITICAL_W:.0f}W. SSR3/K3 import activated."
                elif _is_daytime() and dc_power > 0 and dc_power < SOLAR_WARNING_W:
                    raw_lvl = 'warning'; safe_rst = False
                    fault_action = f"Solar {dc_power:.0f}W low."
                else:
                    raw_lvl = 'none'; safe_rst = True; fault_action = ""

                confirmed = check_and_alert(
                    fault_key="solar_output", raw_level=raw_lvl,
                    fault_type="Solar PV Output Low",
                    action=fault_action, source="Solar PV Monitor (WCS1500)",
                    safe_reset=safe_rst, solar_check=True, cursor=cursor,
                    pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                    system_temp=system_temp,
                )
                cache['solarAnomaly'] = confirmed
            else:
                # Arduino not responding or solar key missing — keep last cache
                dc_power = cache.get('solarPower', 0.0)

            # ── VOLTAGE SIGNALS TO ARDUINO (v6.4) ──────────────────────────
            # Send g0/g1 and i0/i1 to Arduino based on PZEM voltage readings.
            # [FIX-RECOVERY-TIMER] Only send when signal CHANGES (not every cycle).
            # Sending every 5s was harmless before but caused confusion during
            # K1/K2 reconnect timers — Arduino re-ran applyVoltageState() on every
            # received signal. Change-only sending is cleaner and more correct.
            # Exception: on first boot (_last_*_sig == ''), always send both.
            global _last_grid_sig, _last_inv_sig
            _gv_signal = gv if gv > 0 else float(cache.get('grid', {}).get('voltage', 0))
            _iv_signal = iv if iv > 0 else float(cache.get('inverter', {}).get('voltage', 0))
            _grid_sig  = '1' if _gv_signal > 0 else '0'
            _inv_sig   = '1' if _iv_signal  > 0 else '0'
            if arduino and arduino.is_open:
                _grid_changed = (_grid_sig != _last_grid_sig)
                _inv_changed  = (_inv_sig  != _last_inv_sig)
                if _grid_changed or _inv_changed:
                    with arduino_sequence_lock:
                        if _grid_changed:
                            arduino_send(f'g{_grid_sig}')
                            time.sleep(0.05)
                            _last_grid_sig = _grid_sig
                        if _inv_changed:
                            arduino_send(f'i{_inv_sig}')
                            time.sleep(0.05)
                            _last_inv_sig = _inv_sig
                    print(f"[ARDUINO] Voltage signal CHANGE → grid={_grid_sig} ({_gv_signal:.1f}V)  inv={_inv_sig} ({_iv_signal:.1f}V)")

            # ── ARDUINO BATTERY VOLTAGE READ ────────────────────────────────
            # Battery voltage is now read by Arduino via voltage divider on A5
            # (R1=70kΩ, R2=10kΩ, ratio=10.2) — no INA219 needed for voltage.
            # arduino_status is already fetched above in the solar block.
            # If arduino_status is available and has battery data, use it.
            _ard_bat = (arduino_status or {}).get('battery', {}) if arduino_status else {}
            _ard_bv_raw = float(_ard_bat.get('v', 0))
            # [CAL-FIX] Single scale factor calibration:
            #   Arduino voltage divider (R1=70kΩ, R2=10kΩ) reads consistently ~31V raw.
            #   Multimeter reads 27.5V → scale factor = 27.5 / 31.0 = 0.8871
            #   To recalibrate: BATT_CAL_FACTOR = multimeter_V / arduino_raw_V
            BATT_CAL_FACTOR = 0.7758   # [CAL-2026-04-27: multimeter=27.5V, raw=35.45V]
            _ard_bv_cal = max(0.0, _ard_bv_raw * BATT_CAL_FACTOR) if _ard_bv_raw > 0 else 0.0

            # [SMOOTH] Rolling average of last 5 readings — suppresses probe noise
            if _ard_bv_cal > 0:
                _batt_v_history.append(_ard_bv_cal)
                if len(_batt_v_history) > _BATT_V_SMOOTH:
                    _batt_v_history.pop(0)
            _ard_bv = round(sum(_batt_v_history) / len(_batt_v_history), 2) if _batt_v_history else 0.0

            _ard_soc = int(_ard_bat.get('soc', -1))  # raw Arduino value (unreliable)

            # Build an ina226_data-compatible dict so downstream code still works
            _bat_available = _ard_bv > 0
            _bat_soc = calculate_pack_soc(_ard_bv)  # recalc with smoothed voltage
            ina226_data = {
                'available':      _bat_available,
                'voltage':        round(_ard_bv,  2),
                'net_current':    0.0,   # no current sensor on Arduino path
                'soc':            _bat_soc,  # [FIX] uses calculate_pack_soc(_ard_bv) — smoothed+interpolated
                'charge_a':       0.0,
                'discharge_a':    0.0,
                'capacity_ah':    100,
                'anomaly_details': [],
                'source':         'arduino_vdiv',
            }
            cache['ina226'] = ina226_data

            if _bat_available:
                    pack_voltage = ina226_data['voltage']
                    pack_current = 0.0   # no current sensor
                    pack_soc     = ina226_data['soc']

                    log_data['battery_pack_voltage'] = pack_voltage
                    log_data['battery_pack_current'] = pack_current
                    log_data['battery_pack_power']   = 0.0
                    log_data['battery_pack_soc']     = pack_soc

                    print(f"[BATT-VDIV] Pack: {pack_voltage:.2f}V | SOC: {pack_soc:.1f}%")

                    # ── DC Voltage Anomaly Detection — battery pack ───────────
                    if _dc_ae_battery is not None and _DCSensorSample is not None:
                        _dc_bat_r = _dc_ae_battery.process(_DCSensorSample(
                            voltage=pack_voltage,
                            current=abs(pack_current),
                            power=round(pack_voltage * abs(pack_current), 2),
                        ))
                        cache['dcBatteryAnomalyResult'] = {
                            'anomaly_type': _dc_bat_r.anomaly_type,
                            'severity':     _dc_bat_r.severity,
                            'detail':       _dc_bat_r.detail,
                            'voltage':      _dc_bat_r.voltage,
                            'delta_v':      _dc_bat_r.delta_v,
                            'pu':           _dc_bat_r.pu,
                            'confirmed':    _dc_bat_r.confirmed,
                            'context_note': _dc_bat_r.context_note,
                        }
                        cache['dcBatteryAnomaly'] = (
                            'critical' if _dc_bat_r.severity == 'Critical' else
                            'warning'  if _dc_bat_r.severity == 'Warning'  else 'none'
                        )
                        # [FIX-EVERY-CYCLE] Log every 5s cycle — every reading
                        if True:
                            try:
                                cursor.execute("""
                                    INSERT INTO dc_battery_anomaly_logs
                                      (source, anomaly_type, severity, detail, voltage, delta_v, pu,
                                       confirmed, context_note, battery_soc, solar_power, grid_voltage,
                                       system_temp, status)
                                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                """, (
                                    'battery', _dc_bat_r.anomaly_type, _dc_bat_r.severity,
                                    _dc_bat_r.detail[:500], round(_dc_bat_r.voltage, 3),
                                    round(_dc_bat_r.delta_v, 3), round(_dc_bat_r.pu, 4),
                                    int(_dc_bat_r.confirmed), _dc_bat_r.context_note[:300] or None,
                                    round(pack_soc, 2), round(dc_power, 2), round(gv, 2),
                                    round(system_temp, 2) if system_temp else None,
                                    'Active' if _dc_bat_r.severity != 'Normal' else 'Monitoring',
                                ))
                                pass  # [FIX-EVERY-CYCLE] no cooldown needed
                            except Exception as _dbl_e:
                                print(f"[DC-AE] battery log insert error: {_dbl_e}")

            # ── BATTERY VOLTAGE FAULT CHECKS (Lead Acid Gel 24V 100Ah) ──
            # Full     : ≥ 26.4V → email only (green)
            # Normal   : 23.0V – 26.4V → no alert, reset states
            # Low      : < 23.0V → email only, orange (please charge)
            # Critical : ≤ 21.6V → email + buzzer 4s, red (deep discharge)
            # Overcharge: ≥ 27.6V → email only, yellow warning
            # Aging    : charging 8h+ but never reached 26.0V → email only, orange
            if pack_voltage > 0:

                # ── Aging detection tracking ──
                _now_ts = time.time()
                if pack_current > 0.5:
                    # Battery is charging
                    if not _buzzer_fired.get('_aging_charge_start'):
                        _buzzer_fired['_aging_charge_start'] = _now_ts
                        _buzzer_fired.pop('_aging_peak_v', None)
                    # Track peak voltage during charge session
                    _peak = _buzzer_fired.get('_aging_peak_v', 0)
                    if pack_voltage > _peak:
                        _buzzer_fired['_aging_peak_v'] = pack_voltage
                    # Check if charging 8+ hours but peak never reached 26.0V
                    _charge_hrs = (_now_ts - _buzzer_fired['_aging_charge_start']) / 3600
                    if _charge_hrs >= 8.0 and _buzzer_fired.get('_aging_peak_v', 0) < 26.0:
                        if not _buzzer_fired.get('battery_aging_notified'):
                            _buzzer_fired['battery_aging_notified'] = True
                            _send_email_alert(
                                'battery_aging', 'Battery Aging — Consider Replacement',
                                'critical',
                                (f"Battery charged for {_charge_hrs:.1f}h but only reached "
                                 f"{_buzzer_fired.get('_aging_peak_v', 0):.2f}V "
                                 f"(expected ≥26.0V). Battery may be aging or degraded. "
                                 f"Consider replacement soon."),
                                'Battery Monitor (INA219)',
                                email_type='battery_critical',
                                cooldown_override_s=86400,
                            )
                            print(f"[BATTERY AGING] {_charge_hrs:.1f}h charge, peak={_buzzer_fired.get('_aging_peak_v',0):.2f}V")
                else:
                    # Not charging — reset aging session tracker
                    _buzzer_fired.pop('_aging_charge_start', None)
                    _buzzer_fired.pop('_aging_peak_v', None)

                if pack_voltage <= BAT_CRITICAL_LOW:
                    # CRITICAL — deep discharge, buzzer 4s + email red
                    check_and_alert(
                        fault_key="battery_low", raw_level='critical',
                        fault_type="Battery Critical — Deep Discharge",
                        action=(
                            f"Battery {pack_voltage:.2f}V ({pack_soc:.1f}%) — deep discharge detected. "
                            f"Charge immediately to prevent permanent damage."
                        ),
                        source="Battery Monitor (INA219)",
                        cursor=cursor, pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp, email_type="battery_critical",
                        inverter_power=inv_power,
                    )
                    if not _buzzer_fired.get('battery_critical'):
                        _buzzer_fired['battery_critical'] = True
                        def _bat_crit_buzz():
                            import time as _t
                            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH)
                            _t.sleep(15.0)  # [FIX] 15s buzzer duration
                            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.LOW)
                        if GPIO_AVAILABLE:
                            threading.Thread(target=_bat_crit_buzz, daemon=True).start()

                elif pack_voltage >= BAT_CRITICAL_HIGH:
                    # OVERCHARGE WARNING — email only, yellow, no buzzer
                    check_and_alert(
                        fault_key="battery_overcharge", raw_level='warning',
                        fault_type="Battery Overcharge Warning",
                        action=(
                            f"Battery {pack_voltage:.2f}V exceeds safe limit ({BAT_CRITICAL_HIGH}V). "
                            f"Check solar charge controller or charger settings."
                        ),
                        source="Battery Monitor (INA219)",
                        cursor=cursor, pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp, email_type="battery_critical",
                        inverter_power=inv_power,
                    )

                elif pack_voltage < BAT_WARNING_LOW:
                    # LOW — email only, orange, no buzzer
                    check_and_alert(
                        fault_key="battery_low", raw_level='warning',
                        fault_type="Battery Low — Please Charge",
                        action=(
                            f"Battery {pack_voltage:.2f}V ({pack_soc:.1f}%) is low. "
                            f"Please charge soon to avoid deep discharge."
                        ),
                        source="Battery Monitor (INA219)",
                        cursor=cursor, pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp, email_type="battery_critical",
                        inverter_power=inv_power,
                    )

                elif pack_voltage >= BAT_FULL:
                    # FULL — email only, green, no buzzer
                    if not _buzzer_fired.get('battery_full_notified'):
                        _buzzer_fired['battery_full_notified'] = True
                        _send_email_alert(
                            'battery_full', 'Battery Full — Fully Charged',
                            'info',
                            f'Battery {pack_voltage:.2f}V ({pack_soc:.1f}%) — fully charged.',
                            'Battery Monitor (INA219)',
                            email_type='battery_full',
                            cooldown_override_s=3600,
                        )
                        print(f"[BATTERY FULL] {pack_voltage:.2f}V — email queued")

                else:
                    # NORMAL 23.0V – 26.4V — reset all states
                    _buzzer_fired.pop('battery_critical',      None)
                    _buzzer_fired.pop('battery_overcharge',    None)
                    _buzzer_fired.pop('battery_full_notified', None)
                    _buzzer_fired.pop('battery_aging_notified', None)
                    check_and_alert(
                        fault_key="battery_low", raw_level='none',
                        fault_type="Battery", action="",
                        source="Battery Monitor (INA219)", safe_reset=True,
                    )
                    check_and_alert(
                        fault_key="battery_overcharge", raw_level='none',
                        fault_type="Battery Overcharge", action="",
                        source="Battery Monitor (INA219)", safe_reset=True,
                    )

                cache['batteryAnomaly'] = _fault_state.get('battery_low', 'none')

            else:
                # [FIX-SENSE] pack_voltage=0 — battery sensor-loss detection
                # Skip if Arduino voltage divider (A5) already has a reading
                _ard_bv_check = float((arduino_status or {}).get('battery', {}).get('v', 0))
                _any_ac_running = gv > 0 or iv > 0
                if _any_ac_running and _ard_bv_check <= 0:
                    # Only flag sensor loss if Arduino A5 also has no reading
                    check_and_alert(
                        fault_key="battery_sensor_loss", raw_level='warning',
                        fault_type="Battery Sensor Loss",
                        action=(
                            f"Battery reading 0V — sensor may be disconnected. "
                            f"{'Grid' if gv > 0 else 'Inverter'} AC present. "
                            f"Check Arduino A5 voltage divider and I2C connections (0x41/0x44)."
                        ),
                        source="Battery Monitor (Arduino A5 / INA219)",
                        cursor=cursor, pack_soc=0, solar_w=dc_power, grid_v=gv,
                    )
                cache['batteryAnomaly'] = _fault_state.get('battery_sensor_loss', 'none') if (_any_ac_running and _ard_bv_check <= 0) else 'none'

            # ── DOUBLE FAULT ────────────────────────────────────────────────
            inv_fault  = _fault_state.get('inverter_voltage', 'none') == 'critical'
            grid_fault = _fault_state.get('grid_voltage',    'none') == 'critical'
            if inv_fault and grid_fault:
                check_and_alert(
                    fault_key="double_fault", raw_level='critical',
                    fault_type="Double Fault — Inverter + Grid Failure",
                    action=(
                        "Both SSR1/K1 (inverter) and SSR2/K2 (grid) faulted. "
                        "Failsafe island mode. ⚠️ ADMIN: Inspect all connections."
                    ),
                    source="Fault Monitor", cursor=cursor,
                    pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                    system_temp=system_temp,
                    inverter_power=inv_power,
                )
            else:
                check_and_alert(
                    fault_key="double_fault", raw_level='none',
                    fault_type="Double Fault", action="",
                    source="Fault Monitor", safe_reset=True,
                )

            # ── AUTO RELAY CONTROL ──────────────────────────────────────────
            cursor.execute(
                "SELECT ssr1_state,ssr2_state,ssr3_state,ssr4_state,"
                "       control_mode,auto_switch,manual_override,contactor_closed "
                "FROM ssr_state ORDER BY id DESC LIMIT 1"
            )
            _sr1 = cursor.fetchone()
            ssr_row: Dict[str, Any] = cast(Dict[str, Any], _sr1) if _sr1 else {}

            if ssr_row:
                log_data['ssr1_state'] = ssr_row.get('ssr1_state', 0)
                log_data['ssr2_state'] = ssr_row.get('ssr2_state', 0)
                log_data['ssr3_state'] = ssr_row.get('ssr3_state', 0)
                log_data['ssr4_state'] = ssr_row.get('ssr4_state', 0)

                is_auto = (
                    not bool(ssr_row.get('manual_override', 0)) and
                    bool(ssr_row.get('auto_switch', 1))
                )
                mode    = ssr_row.get('control_mode', 'solar')

                # ── [GAP2-FIX] Failsafe recovery — grid returned after double fault ──
                if (mode == 'failsafe' and
                        gv >= GRID_NORMAL_LOW and _grid_is_safe(gv, gf) and
                        not (_fault_state.get('grid_voltage', 'none') == 'critical') and
                        not (_fault_state.get('double_fault', 'none') == 'critical') and
                        not _thermal_shutdown_active and
                        not _manual_lockout_active()):
                    print(f"[FAILSAFE-RECOVERY] Grid back {gv:.1f}V, faults cleared → switching to grid")
                    with arduino_sequence_lock:
                        _seq_grid_on()
                    _db_update_ssr_from_fault(False, True, False, True, 'grid')
                    mode = 'grid'

                sensors_connected = (gv > 0 or iv > 0 or pack_voltage > 0 or dc_power > 0)
                thermal_ok        = not _thermal_shutdown_active

                if is_auto and not _manual_lockout_active() and sensors_connected and thermal_ok:

                    k4_should_close = (mode != 'shutdown')
                    current_k4      = bool(ssr_row.get('ssr4_state', 1))

                    if k4_should_close != current_k4:
                        with arduino_sequence_lock:
                            if k4_should_close:
                                # Arduino v6.4 manages K4 via dropout logic — no direct command
                                # Send manual mode reset ('m') so Arduino knows Flask is in control
                                arduino_send('m')
                                print("[AUTO K4] Manual mode reset sent to Arduino (K4 managed by Arduino)")
                            else:
                                _seq_shutdown()
                                print("[AUTO K4] Contactor OPEN (shutdown via 'x')")
                        try:
                            cursor.execute("""
                                UPDATE ssr_state SET ssr4_state=%s, contactor_closed=%s
                                WHERE id=(SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
                            """, (int(k4_should_close), int(k4_should_close)))
                        except Exception as e:
                            print(f"SSR4/K4 DB update error: {e}")

                    # ── [FIX-5] Night/Day cutover + Solar recovery + Grid return ──────────
                    # [FIX-RPI-LOAD] RPi is on load — NEVER open K4 contactor
                    # Pag walang grid + lobat battery → stay on inverter/battery
                    # Pag may grid + lobat → switch to grid direct (SSR2)
                    BAT_RECOVERY_V = BAT_WARNING_LOW + 0.5   # 23.5V hysteresis
                    grid_available = gv > 0 and _grid_is_safe(gv, gf)

                    night_bat_low = (
                        not _is_daytime() and pack_voltage > 0 and
                        pack_voltage < BAT_WARNING_LOW and
                        mode == 'solar' and grid_available
                    )
                    day_bat_low = (
                        _is_daytime() and pack_voltage > 0 and
                        pack_voltage < BAT_WARNING_LOW and
                        dc_power < SOLAR_CRITICAL_W and
                        mode == 'solar' and grid_available
                    )
                    solar_recovery = (
                        # [FIX-SOLAR-RECOVERY] Use SOLAR_WARNING_W (1320W) not SOLAR_CRITICAL_W (440W)
                        # 440W is too weak to sustain inverter load + charge battery simultaneously.
                        # Only switch back to solar when production is meaningful (≥1320W).
                        _is_daytime() and dc_power >= SOLAR_WARNING_W and
                        pack_voltage >= BAT_RECOVERY_V and mode == 'grid'
                    )
                    grid_returned = (
                        # [FIX-GRID-RETURN] Only switch to grid if solar is also insufficient
                        # Prevents unnecessary grid switch when solar can handle the load
                        grid_available and mode == 'solar' and
                        pack_voltage < BAT_WARNING_LOW and
                        dc_power < SOLAR_CRITICAL_W and        # solar must also be weak
                        not bool(ssr_row.get('ssr2_state', 0))
                    )

                    if night_bat_low:
                        print(f"[NIGHT-CUTOVER] {pack_voltage:.2f}V < {BAT_WARNING_LOW}V — switching to Grid direct")
                        with arduino_sequence_lock: _seq_grid_on()
                        _db_update_ssr_from_fault(False, True, False, True, 'grid')
                        ssr_row['ssr1_state'] = 0; ssr_row['ssr2_state'] = 1
                        ssr_row['control_mode'] = 'grid'; mode = 'grid'
                    elif day_bat_low:
                        print(f"[DAY-CUTOVER] {pack_voltage:.2f}V < {BAT_WARNING_LOW}V, Solar {dc_power:.0f}W — switching to Grid direct (cloudy/rainy)")
                        with arduino_sequence_lock: _seq_grid_on()
                        _db_update_ssr_from_fault(False, True, False, True, 'grid')
                        ssr_row['ssr1_state'] = 0; ssr_row['ssr2_state'] = 1
                        ssr_row['control_mode'] = 'grid'; mode = 'grid'
                    elif solar_recovery:
                        print(f"[SOLAR-RECOVERY] Solar {dc_power:.0f}W, {pack_voltage:.2f}V >= {BAT_RECOVERY_V}V — back to Solar/Inverter")
                        with arduino_sequence_lock: _seq_solar_on()
                        _db_update_ssr_from_fault(True, False, False, True, 'solar')
                        ssr_row['ssr1_state'] = 1; ssr_row['ssr2_state'] = 0
                        ssr_row['control_mode'] = 'solar'; mode = 'solar'
                    elif grid_returned:
                        print(f"[GRID-RETURN] Grid back {gv:.1f}V, {pack_voltage:.2f}V still low — switching to Grid direct")
                        with arduino_sequence_lock: _seq_grid_on()
                        _db_update_ssr_from_fault(False, True, False, True, 'grid')
                        ssr_row['ssr1_state'] = 0; ssr_row['ssr2_state'] = 1
                        ssr_row['control_mode'] = 'grid'; mode = 'grid'

                elif _manual_lockout_active():
                    remaining = MANUAL_LOCKOUT_S - int(time.time() - _last_manual_ts)
                    print(f"[AUTO] Manual lockout active — {remaining}s remaining")
                elif not thermal_ok:
                    print(f"[AUTO] Thermal shutdown active — auto relay blocked until temp ≤ {TEMP_RESUME}°C")

            log_data['system_temp'] = system_temp

            # ── Efficiency computation (ISO 50001) ──────────────────────
            # System Efficiency = P_out(inverter) / P_in(grid + solar) × 100
            # Solar Efficiency  = solar_dc_power  / P_rated(2200W)     × 100
            _p_out   = log_data.get('inverter_power',   0) or 0
            _p_grid  = log_data.get('grid_power',       0) or 0
            _p_solar = log_data.get('solar_dc_power',   0) or 0
            _p_in    = _p_grid + _p_solar

            # [FIX-EFFICIENCY] Use 0.0 instead of None so MySQL strict mode never
            # rejects the INSERT with "Column cannot be null" on DECIMAL columns.
            log_data['system_efficiency'] = round((_p_out / _p_in) * 100, 2) \
                if _p_in > 0 else 0.0
            log_data['solar_efficiency']  = round((_p_solar / SOLAR_RATED_W) * 100, 2) \
                if _p_solar > 0 else 0.0

            # [FIX-LOGS] Always ensure ALL required columns are present so a row
            # is inserted every cycle — even when Arduino is unplugged or PZEM
            # is unavailable. setdefault() only sets value if key is missing.
            log_data.setdefault('grid_voltage',       0.0)
            log_data.setdefault('grid_frequency',     0.0)
            log_data.setdefault('grid_current',       0.0)
            log_data.setdefault('grid_power',         0.0)
            log_data.setdefault('inverter_voltage',   0.0)
            log_data.setdefault('inverter_current',   0.0)
            log_data.setdefault('inverter_power',     0.0)
            log_data.setdefault('inverter_frequency', 0.0)
            log_data.setdefault('solar_dc_voltage',   0.0)
            log_data.setdefault('solar_dc_current',   0.0)
            log_data.setdefault('solar_dc_power',     0.0)
            log_data.setdefault('battery_pack_voltage',  0.0)
            log_data.setdefault('battery_pack_current',  0.0)
            log_data.setdefault('battery_pack_soc',      0.0)
            log_data.setdefault('battery_pack_power',    0.0)
            log_data.setdefault('battery_charge_a',      0.0)
            log_data.setdefault('battery_discharge_a',   0.0)
            log_data.setdefault('system_temp',        system_temp)
            log_data.setdefault('system_efficiency',  0.0)
            log_data.setdefault('solar_efficiency',   0.0)
            # [FIX-GRAPH] Store anomaly level every cycle so graph has time-series data
            log_data['grid_anomaly_level']       = cache.get('gridAnomaly',     'none')
            log_data['inverter_anomaly_level']   = cache.get('inverterAnomaly', 'none')
            # [FIX-DC-GRAPH] Store DC anomaly levels — needed for chart dot coloring
            # Without these, chart falls back to static client-side classification
            # which doesn't match the actual stateful DCAnomalyEngine output
            log_data['dc_battery_anomaly_level'] = cache.get('dcBatteryAnomaly', 'none')
            log_data['dc_solar_anomaly_level']   = cache.get('dcSolarAnomaly',   'none')
            # [FIX-DC-TOOLTIP] Store DC anomaly type string for chart tooltip
            _dc_bat_res = cache.get('dcBatteryAnomalyResult', {})
            _dc_sol_res = cache.get('dcSolarAnomalyResult',   {})
            log_data['dc_battery_anomaly_type'] = _dc_bat_res.get('anomaly_type', 'Normal') if _dc_bat_res else 'Normal'
            log_data['dc_solar_anomaly_type']   = _dc_sol_res.get('anomaly_type', 'Normal') if _dc_sol_res else 'Normal'

            # [FIX-SENSOR-LOG] Sanitize every value — replace any leftover None
            # with 0.0 so MySQL strict mode never rejects the row.
            sanitized_log = {
                k: (v if v is not None else 0.0)
                for k, v in log_data.items()
            }

            # Always insert — sanitized_log always has all required columns.
            columns      = ', '.join(sanitized_log.keys())
            placeholders = ', '.join(['%s'] * len(sanitized_log))
            try:
                cursor.execute(
                    f"INSERT INTO sensor_logs ({columns}) VALUES ({placeholders})",
                    tuple(sanitized_log.values())
                )
            except Exception as _log_err:
                print(f"[SENSOR LOG] INSERT failed: {_log_err}")
                print(f"[SENSOR LOG] Columns: {columns}")
                print(f"[SENSOR LOG] Values sample: { {k: sanitized_log[k] for k in list(sanitized_log)[:6]} }")

            conn.commit()
            cursor.close()
            conn.close()

            anomalies = [
                _fault_state.get(k, 'none') for k in [
                    'battery_low', 'battery_overcharge', 'grid_voltage',
                    'solar_output', 'inverter_voltage', 'double_fault',
                    'string_mismatch', 'thermal_critical', 'thermal_warning',
                ]
            ]
            if 'critical' in anomalies:
                cache['systemCondition'] = 'Critical'
            elif 'warning' in anomalies:
                cache['systemCondition'] = 'Warning'
            else:
                cache['systemCondition'] = 'Optimal'

            cache['last_update'] = datetime.now().isoformat()

            # [FIX-TIMING] Target-time sleep: keep cycle at ~5s regardless of
            # how long sensor reads + DB writes took. On RPi, PZEM reads alone
            # take 1-2s, so naive time.sleep(5) means actual cycle = 8-12s,
            # causing SSR timing mismatch and stale sensor log entries.
            elapsed       = time.time() - loop_start
            sleep_needed  = max(0.5, 5.0 - elapsed)   # 5s cycle — anomaly engine needs fast reads (FAULT_CONFIRM_COUNT=3 × 5s = 15s detect time)
            time.sleep(sleep_needed)

        except Exception as e:
            print(f"Logger error: {e}")
            import traceback; traceback.print_exc()
            time.sleep(5)


# =============================================================================
#  AUTH ROUTES
# =============================================================================

@app.route("/auth/logout")
def logout():
    session.clear()
    print(f"[AUTH] User logged out")
    return jsonify({"success": True, "message": "Logged out"})


@app.route("/auth/google")
def auth_google():
    redirect_uri = f"{OAUTH_CALLBACK_BASE}/auth/google/callback"
    return google.authorize_redirect(redirect_uri)


@app.route("/auth/google/callback")
def auth_google_callback():
    import re as _re
    _origin = FRONTEND_URL
    _m = _re.match(r"(https?://[^/]+)", _origin)
    _frontend = _m.group(1) if _m else FRONTEND_URL
    try:
        token     = google.authorize_access_token()
        user_info = token.get("userinfo") or google.userinfo()
        google_id = user_info.get("sub")
        email     = user_info.get("email")
        name      = user_info.get("name", email.split("@")[0] if email else "User")
        picture   = user_info.get("picture", "")

        if not email:
            return redirect(f"{_frontend}/login?error=no_email")

        # Upsert user in DB
        try:
            conn   = get_db()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
            if cursor.fetchone():
                cursor.execute(
                    "UPDATE users SET google_id=%s,name=%s,picture=%s,last_login=NOW() WHERE email=%s",
                    (google_id, name, picture, email)
                )
            else:
                cursor.execute(
                    "INSERT INTO users (google_id,email,name,picture) VALUES (%s,%s,%s,%s)",
                    (google_id, email, name, picture)
                )
            conn.commit(); cursor.close(); conn.close()
            print(f"[AUTH] Google login: {email}")
        except Exception as e:
            print(f"[AUTH] Google OAuth DB error: {e}")

        # Set session (permanent = respects PERMANENT_SESSION_LIFETIME)
        session.permanent = True
        session["user"] = {
            "email":     email,
            "name":      name,
            "picture":   picture,
            "google_id": google_id,
        }

        # Redirect to frontend with user params
        params = urlencode({"email": email, "name": name, "picture": picture})
        return redirect(f"{_frontend}/auth/callback?{params}")
    except Exception as e:
        print(f"[AUTH] Google OAuth callback error: {e}")
        return redirect(f"{_frontend}/login?error=oauth_failed")


@app.route("/auth/me")
def auth_me():
    user = session.get("user")
    if user:
        return jsonify({
            "success": True,
            "user": {
                "email":     user.get("email"),
                "name":      user.get("name"),
                "picture":   user.get("picture", ""),
                "google_id": user.get("google_id", ""),
            }
        })
    return jsonify({"success": False, "error": "Not logged in"}), 401


try:
    import bcrypt as _bcrypt_module
    bcrypt = _bcrypt_module
    BCRYPT_AVAILABLE = True
except ImportError:
    bcrypt = None  # type: ignore[assignment]
    BCRYPT_AVAILABLE = False
    print("bcrypt not installed — password hashing disabled. Run: pip install bcrypt")

@app.route("/auth/register", methods=["POST"])
def register():
    data     = request.get_json()
    email    = (data.get("email")    or "").strip().lower()
    password = (data.get("password") or "").strip()
    name     = (data.get("name")     or email.split("@")[0]).strip()
    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
        if cursor.fetchone():
            cursor.close(); conn.close()
            return jsonify({"error": "Email already registered."}), 409
        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode() if bcrypt else ""  # type: ignore[union-attr]
        cursor.execute(
            "INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s)",
            (email, name, password_hash)
        )
        conn.commit(); cursor.close(); conn.close()
        return jsonify({"success": True, "user": {"email": email, "name": name, "picture": ""}}), 201
    except Exception as e:
        return jsonify({"error": "Registration failed."}), 500


@app.route("/auth/login", methods=["POST"])
def email_login():
    data     = request.get_json()
    email    = (data.get("email")    or "").strip().lower()
    password = (data.get("password") or "").strip()
    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id,email,name,picture,password_hash FROM users WHERE email = %s", (email,)
        )
        _u = cursor.fetchone()
        user: Dict[str, Any] = cast(Dict[str, Any], _u) if _u else {}
        if not user:
            cursor.close(); conn.close()
            return jsonify({"error": "No account found with this email."}), 404
        db_hash = user.get("password_hash")
        if not db_hash:
            cursor.close(); conn.close()
            return jsonify({"error": "This account uses Google Sign-In."}), 400
        if not bcrypt or not bcrypt.checkpw(str(password).encode('utf-8'), str(db_hash).encode('utf-8')):  # type: ignore[union-attr]
            cursor.close(); conn.close()
            return jsonify({"error": "Incorrect password."}), 401
        cursor.execute("UPDATE users SET last_login = NOW() WHERE id = %s", (user.get("id"),))
        conn.commit(); cursor.close(); conn.close()
        print(f"[AUTH] Email login: {user.get('email')}")
        session.permanent = True
        session["user"] = {
            "email":     user.get("email"),
            "name":      user.get("name") or email.split("@")[0],
            "picture":   user.get("picture") or "",
            "google_id": "",
        }
        return jsonify({"success": True, "user": {
            "email":   user.get("email"),
            "name":    user.get("name") or email.split("@")[0],
            "picture": user.get("picture") or "",
        }})
    except Exception as e:
        return jsonify({"error": f"Login failed: {str(e)}"}), 500


# =============================================================================
#  SYSTEM HEALTH
# =============================================================================

@app.route("/api/system/health", methods=["GET"])
def system_health():
    try:
        conn = get_db(); conn.close()
        db_status = "connected"
    except Exception as e:
        db_status = f"error: {str(e)}"

    ina226_data = cache.get('ina226', {})

    return jsonify({
        "status":    "healthy" if db_status == "connected" else "degraded",
        "timestamp": datetime.now().isoformat(),
        "database":  db_status,
        "arduino_pins": {
            "buzzer":   "RPi_GPIO14", "SSR1_K1":  6,
            "SSR2_K2":  4, "SSR3_K3":  3, "SSR4_K4":  5,
        },
        "relay_map": {
            "SSR1_K1": "Solar path (Inverter → ATS-A → Load)       Pin 6",
            "SSR2_K2": "Grid bypass (Grid → ATS-B → Load)          Pin 4",
            "SSR3_K3": "Grid Assist / Charging (auto only)        Pin 3",
            "SSR4_K4": "ATS Output → Contactor → Outlets           Pin 5",
            "Buzzer":  "Alert relay (Active LOW)                   Pin 8",
        },
        "hardware": {
            "grid_pzem":       grid_pzem is not None,
            "inverter_pzem":   inverter_pzem is not None,
            "arduino":         arduino is not None and arduino.is_open,
            "dht_sensor":      DHT_AVAILABLE,
            "battery_vdiv":    cache.get("ina226", {}).get("voltage", 0) > 0,
        },
        "rtc_ds3231":  get_rtc_status(),
        "sensors": {
            "grid_pzem":     "connected" if grid_pzem     else "disconnected",
            "inverter_pzem": "connected" if inverter_pzem else "disconnected",
            "solar_panels":  len(cache['solar']),
            "battery_cells": len(cache.get('battery', [])),
            "arduino":       "connected" if arduino and arduino.is_open else "disconnected",
            "dht22":         "available" if DHT_AVAILABLE else "not installed",
            "battery_mode":  "Arduino voltage divider (A5)",
        },
        "battery_arduino_vdiv": {
            "voltage":   round(cache.get("ina226", {}).get("voltage", 0), 2),
            "soc":       _voltage_to_soc(cache.get("batteryVoltage", 0) or 0),  # [FIX] voltage-based
            "available": cache.get("ina226", {}).get("voltage", 0) > 0,
            "source":    "arduino_vdiv",
        },
        "thermal": {
            "current_temp":    cache.get('system_temp', 0),
            "shutdown_active": _thermal_shutdown_active,
            "temp_warning_c":  TEMP_WARNING,
            "temp_critical_c": TEMP_CRITICAL,
            "temp_resume_c":   TEMP_RESUME,
        },
        "manual_lockout": {
            "active":           _manual_lockout_active(),
            "remaining_seconds": max(0, MANUAL_LOCKOUT_S - int(time.time() - _last_manual_ts)),
        },
    })




@app.route("/api/status", methods=["GET"])
def api_status_alias():
    """Alias for /api/system/health — used by SystemStatusCard."""
    return system_health()

@app.route("/api/system/refresh", methods=["POST"])
def system_refresh():
    return jsonify({"success": True, "last_update": cache.get('last_update')})


# =============================================================================
#  CURRENT SENSOR DATA
#  [PZEM017] Battery data now sourced from INA226 when available
# =============================================================================

@app.route("/api/sensor-data/current", methods=["GET"])
def get_current_sensor_data():
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT ssr1_state,ssr2_state,ssr3_state,ssr4_state "
            "FROM ssr_state ORDER BY id DESC LIMIT 1"
        )
        _sr2 = cursor.fetchone()
        ssr_row: Dict[str, Any] = cast(Dict[str, Any], _sr2) if _sr2 else {}
        cursor.close(); conn.close()

        k1_on = bool(ssr_row.get("ssr1_state", 0))
        k2_on = bool(ssr_row.get("ssr2_state", 0))
        current_source = "Solar (SSR1/K1)" if k1_on else "Grid (SSR2/K2)" if k2_on else "None"

        # Battery voltage from Arduino voltage divider (A5) via cache['ina226']
        ina226_data    = cache.get('ina226', {})
        pack_voltage   = ina226_data.get('voltage', 0)
        pack_current   = 0.0
        pack_soc       = ina226_data.get('soc', calculate_pack_soc(pack_voltage))
        battery_source = 'arduino_vdiv' 

        # [FIX-SOLAR-V] 4P parallel array: all panels share the same voltage.
        # OLD BUG: summed voltage across 4 panels → reported 4× actual voltage
        # (e.g. 41V array showed as 164V on dashboard).
        # NOW: use pre-computed cache values from background_logger Arduino read.
        # cache['solarVoltage'] = single array voltage (V divider on A4)
        # cache['solarCurrent'] = total array current (sum of 4× WCS1500)
        # cache['solarPower']   = V × I_total
        solar_voltage = cache.get('solarVoltage', 0)
        solar_current = cache.get('solarCurrent', 0)
        solar_power   = cache.get('solarPower',   0)
        # Fallback: if cache keys missing (cold start), derive from panels list
        if solar_voltage == 0 and solar_power == 0:
            valid_panels = [p for p in cache['solar'] if 'error' not in p]
            if valid_panels:
                solar_voltage = valid_panels[0].get('voltage', 0)   # same V for all panels (parallel)
                solar_current = sum(p.get('current', 0) for p in valid_panels)
                solar_power   = sum(p.get('power',   0) for p in valid_panels)
        solar_eff = round(solar_power / SOLAR_RATED_W * 100, 1) if solar_power > 0 else 0

        return jsonify({
            "grid": {
                "voltage":      cache['grid'].get('voltage',      0),
                "frequency":    cache['grid'].get('frequency',    0),
                "current":      cache['grid'].get('current',      0),
                "power":        cache['grid'].get('power',        0),
                "power_factor": cache['grid'].get('power_factor', 0),
            },
            "solar": {
                "voltage":        solar_voltage, "current": solar_current,
                "power":          solar_power,   "efficiency": solar_eff,
                "stringCurrents": cache.get('stringCurrents', []),
            },
            "battery": {
                # Arduino voltage divider on A5 — single 24V pack, no per-cell split
                "voltage":      round(pack_voltage, 2),
                "soc":          _voltage_to_soc(pack_voltage),  # [FIX] voltage-based SOC
                "source":       "arduino_vdiv",
                "capacity_ah":  100,
            },
            "inverter": {
                "voltage":   cache['inverter'].get('voltage',   0),
                "current":   cache['inverter'].get('current',   0),
                "frequency": cache['inverter'].get('frequency', 0),
                "power":     cache['inverter'].get('power',     0),
            },
            "system": {
                "temperature":       cache.get('system_temp', 0),
                "thermalShutdown":   _thermal_shutdown_active,
                "currentSource":     current_source,
                # [FIX-TIME] Return ISO 8601 format with timezone offset so JS
                # Date() parses it as local time, not UTC. Without offset, JS
                # assumes UTC and displays wrong time on kiosk (e.g. +8 off by 8h).
                "server_time":       datetime.now().astimezone().isoformat(),
                "rtc_available":     RTC_AVAILABLE,
                "systemEfficiency":  round((cache.get('inverter', {}).get('power', 0) /
                                     max((cache.get('grid', {}).get('power', 0) or 0) +
                                         (cache.get('solarPower', 0) or 0), 0.001)) * 100, 2)
                                     if ((cache.get('grid', {}).get('power', 0) or 0) +
                                         (cache.get('solarPower', 0) or 0)) > 0 else None,
            },
            "manualLockout": {
                "active":    _manual_lockout_active(),
                "remaining": max(0, MANUAL_LOCKOUT_S - int(time.time() - _last_manual_ts)),
            },
            # ── Anomaly engine state (consumed by frontend ghost-guard + anomaly banner) ──
            # anomaly.grid/inverter → "none"|"warning"|"critical" (used by ghost-guard in EnergySystemContext)
            # aeGridResult/aeInverterResult → full AE output dict
            "anomaly": {
                "grid":          cache.get("gridAnomaly",      "none"),
                "inverter":      cache.get("inverterAnomaly",  "none"),
                "gridFaultType": cache.get("aeGridResult",     {}).get("anomaly_type", ""),
                "invFaultType":  cache.get("aeInverterResult", {}).get("anomaly_type", ""),
                # DC low-voltage anomaly levels
                "battery":       cache.get("dcBatteryAnomaly", "none"),
                "solar":         cache.get("dcSolarAnomaly",   "none"),
            },
            "aeGridResult":          cache.get("aeGridResult",          {}),
            "aeInverterResult":      cache.get("aeInverterResult",      {}),
            "dcBatteryAnomalyResult": cache.get("dcBatteryAnomalyResult", {}),
            "dcSolarAnomalyResult":   cache.get("dcSolarAnomalyResult",   {}),
            "timestamp": cache.get('last_update', datetime.now().isoformat()),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  SENSOR HISTORY
# =============================================================================

@app.route("/api/sensor-data/logs", methods=["GET"])
def get_sensor_logs():
    # limit  = max data points returned (default 1440 = 1 point/min for 24h)
    # hours  = time window to cover     (default 24)
    # raw=1  = return individual rows (not per-minute averages) — used by SensorDataLogsView
    limit = request.args.get("limit", 1440, type=int)
    hours = request.args.get("hours",   24, type=int)
    raw   = request.args.get("raw",      0, type=int)  # [FIX-RAW] honour raw=1 from SensorDataLogsView
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)

        if raw:
            # [FIX-RAW] SensorDataLogsView passes raw=1 — return individual rows so the
            # table shows one row per 5-second logger cycle, not per-minute averages.
            # Field names match exactly what SensorDataLogsView.tsx expects.
            cursor.execute("""
                SELECT
                    id,
                    timestamp,
                    solar_dc_power          AS solar_dc_power,
                    solar_dc_voltage        AS solar_dc_voltage,
                    solar_dc_current        AS solar_dc_current,
                    grid_voltage,
                    grid_current,
                    grid_power,
                    grid_frequency,
                    inverter_voltage,
                    inverter_current,
                    inverter_power,
                    inverter_frequency,
                    battery_pack_voltage,
                    battery_pack_current,
                    battery_pack_soc,
                    battery_pack_power,
                    system_temp,
                    ssr1_state, ssr2_state, ssr3_state, ssr4_state,
                    grid_anomaly_level, inverter_anomaly_level,
                    dc_battery_anomaly_level, dc_solar_anomaly_level,
                    dc_battery_anomaly_type,  dc_solar_anomaly_type
                FROM sensor_logs
                WHERE timestamp >= NOW() - INTERVAL %s HOUR
                ORDER BY timestamp DESC
                LIMIT %s
            """, (hours, limit))
            rows = cursor.fetchall()
            cursor.close(); conn.close()
            result = []
            for row in rows:
                r: Dict[str, Any] = cast(Dict[str, Any], row)
                for col in ['ssr1_state', 'ssr2_state', 'ssr3_state', 'ssr4_state']:
                    r[col] = bool(r.get(col, 0))
                # [FIX-ALIAS] Also expose solar_dc_power as solar_power so both
                # old and new frontend field names work without changes.
                r.setdefault('solar_power', r.get('solar_dc_power', 0))
                result.append(r)
            return jsonify({"logs": result})

        # Default: per-minute averages for graphs/charts
        cursor.execute("""
            SELECT
                MIN(id)                                         AS id,
                CONCAT(YEAR(MIN(timestamp)),'-',LPAD(MONTH(MIN(timestamp)),2,'0'),'-',LPAD(DAY(MIN(timestamp)),2,'0'),' ',LPAD(HOUR(MIN(timestamp)),2,'0'),':',LPAD(MINUTE(MIN(timestamp)),2,'0'),':00') AS timestamp,
                AVG(solar_dc_power)                             AS solar_power,
                AVG(solar_dc_power)                             AS solar_dc_power,
                AVG(solar_dc_voltage)                           AS solar_dc_voltage,
                AVG(solar_dc_current)                           AS solar_dc_current,
                AVG(grid_voltage)                               AS grid_voltage,
                AVG(grid_current)                               AS grid_current,
                AVG(grid_power)                                 AS grid_power,
                AVG(grid_frequency)                             AS grid_frequency,
                AVG(inverter_voltage)                           AS inverter_voltage,
                AVG(inverter_current)                           AS inverter_current,
                AVG(inverter_power)                             AS inverter_power,
                AVG(inverter_frequency)                         AS inverter_frequency,
                AVG(battery_pack_voltage)                       AS battery_pack_voltage,
                AVG(battery_pack_current)                       AS battery_pack_current,
                AVG(battery_pack_soc)                           AS battery_pack_soc,
                AVG(battery_pack_soc)                           AS battery_soc,
                AVG(system_temp)                                AS system_temp,
                MAX(ssr1_state)                                 AS ssr1_state,
                MAX(ssr2_state)                                 AS ssr2_state,
                MAX(ssr3_state)                                 AS ssr3_state,
                MAX(ssr4_state)                                 AS ssr4_state,
                MAX(grid_anomaly_level)                          AS grid_anomaly_level,
                MAX(inverter_anomaly_level)                      AS inverter_anomaly_level,
                MAX(dc_battery_anomaly_level)                    AS dc_battery_anomaly_level,
                MAX(dc_solar_anomaly_level)                      AS dc_solar_anomaly_level,
                MAX(dc_battery_anomaly_type)                     AS dc_battery_anomaly_type,
                MAX(dc_solar_anomaly_type)                       AS dc_solar_anomaly_type
            FROM sensor_logs
            WHERE timestamp >= NOW() - INTERVAL %s HOUR
              AND timestamp >= '2026-01-01 00:00:00'
            GROUP BY YEAR(timestamp), MONTH(timestamp), DAY(timestamp), HOUR(timestamp), MINUTE(timestamp)
            ORDER BY MIN(timestamp) DESC
            LIMIT %s
        """, (hours, limit))
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        result = []
        for row in rows:
            r = cast(Dict[str, Any], row)
            for col in ['ssr1_state', 'ssr2_state', 'ssr3_state', 'ssr4_state']:
                r[col] = bool(r.get(col, 0))
            result.append(r)
        return jsonify({"logs": result})
    except Error as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  ANOMALY LOGS
# =============================================================================

# ── Helper: standard SELECT columns for all anomaly log tables ───────────────
_ANOMALY_SELECT = """
    SELECT
        id,
        timestamp,
        detected_at         AS detectedAt,
        action_at           AS actionAt,
        response_time_ms    AS responseTimeMs,
        resolved_at         AS resolvedAt,
        type,
        source,
        severity,
        system_action       AS systemAction,
        system_temp         AS systemTemp,
        battery_soc         AS battery,
        solar_power         AS solarPower,
        grid_voltage        AS gridVoltage,
        inverter_power      AS inverterPower,
        panel_fault_detail  AS panelFaultDetail,
        email_status        AS emailStatus,
        buzzer_status       AS buzzer,
        status,
        anomaly_label       AS anomalyLabel,
        anomaly_source      AS anomalySource,
        anomaly_delta       AS anomalyDelta,
        confirm_count       AS confirmCount,
        context_grid_current     AS contextGridCurrent,
        context_grid_frequency    AS contextGridFrequency,
        context_inv_voltage      AS contextInvVoltage,
        context_inv_current      AS contextInvCurrent,
        context_inv_frequency    AS contextInvFrequency,
        context_battery_voltage  AS contextBatteryVoltage,
        context_battery_current  AS contextBatteryCurrent,
        context_solar_power      AS contextSolarPower,
        context_sensor_status    AS contextSensorStatus
    FROM {table}
    ORDER BY id DESC
    LIMIT %s
"""

def _fetch_anomaly_table(table: str, limit: int):
    conn   = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(_ANOMALY_SELECT.format(table=table), (limit,))
    rows = cursor.fetchall()
    cursor.close(); conn.close()
    return rows

def _delete_anomaly_table(table: str):
    conn   = get_db()
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) FROM {table}")
    count = cursor.fetchone()[0]
    cursor.execute(f"DELETE FROM {table}")
    conn.commit(); cursor.close(); conn.close()
    return count


@app.route("/api/anomaly-logs", methods=["GET"])
def get_anomaly_logs():
    limit = request.args.get("limit", 50, type=int)
    try:
        return jsonify({"logs": _fetch_anomaly_table("anomaly_logs", limit)})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/anomaly-logs", methods=["DELETE"])
def delete_anomaly_logs():
    try:
        deleted = _delete_anomaly_table("anomaly_logs")
        return jsonify({"success": True, "deleted": deleted})
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/anomaly-logs/cleanup-serial-errors", methods=["DELETE"])
def cleanup_serial_error_dropouts():
    """
    [FIX-PZEM-DROPOUT] Delete fake dropout records that were caused by PZEM serial
    errors (Incomplete response: got 0, expected 25) before the fix was applied.
    These are identifiable by anomaly_delta ≤ -200 (impossible for a real dropout
    from a normal voltage — real dropout ΔV is at most -270V but the pattern here
    is exactly -235V which is the nominal voltage stored in PZEM capacitors).
    Also deletes rows where system_action contains 'PZEM serial error' text.
    Safe to run multiple times (idempotent).
    """
    try:
        conn   = get_db()
        cursor = conn.cursor()
        total  = 0
        for tbl in ('grid_anomaly_logs', 'inverter_anomaly_logs', 'anomaly_logs'):
            # Delete rows where ΔV is ≤ -200 (capacitive ghost signature) OR
            # where the action text explicitly mentions PZEM serial error
            cursor.execute(f"""
                DELETE FROM {tbl}
                WHERE (anomaly_delta IS NOT NULL AND anomaly_delta <= -200)
                   OR system_action LIKE '%PZEM serial error%'
                   OR system_action LIKE '%Incomplete response%'
            """)
            total += cursor.rowcount
        conn.commit()
        cursor.close(); conn.close()
        print(f"[CLEANUP] Removed {total} PZEM serial-error fake dropout records")
        return jsonify({"success": True, "deleted": total})
    except Error as e:
        return jsonify({"error": str(e)}), 500



@app.route("/api/email/health", methods=["GET"])
def api_email_health():
    """Stub — returns email config status so frontend stops getting 404."""
    return jsonify({
        "status": "ok",
        "email_configured": bool(os.getenv('EMAIL_SENDER') and os.getenv('EMAIL_PASSWORD')),
        "recipient": os.getenv('EMAIL_RECIPIENT') or None,
    })

@app.route("/api/anomaly-logs/grid", methods=["GET"])
def get_grid_anomaly_logs():
    limit = request.args.get("limit", 2000, type=int)
    try:
        return jsonify({"logs": _fetch_anomaly_table("grid_anomaly_logs", limit)})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/anomaly-logs/grid", methods=["DELETE"])
def delete_grid_anomaly_logs():
    try:
        deleted = _delete_anomaly_table("grid_anomaly_logs")
        return jsonify({"success": True, "deleted": deleted})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/anomaly-logs/inverter", methods=["GET"])
def get_inverter_anomaly_logs():
    limit = request.args.get("limit", 2000, type=int)
    try:
        return jsonify({"logs": _fetch_anomaly_table("inverter_anomaly_logs", limit)})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/anomaly-logs/inverter", methods=["DELETE"])
def delete_inverter_anomaly_logs():
    try:
        deleted = _delete_anomaly_table("inverter_anomaly_logs")
        return jsonify({"success": True, "deleted": deleted})
    except Error as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  DC LOW-VOLTAGE ANOMALY LOG ENDPOINTS  (battery + solar)
# =============================================================================

def _fetch_dc_anomaly_table(table: str, limit: int):
    """Fetch rows from a DC anomaly log table — returns list of dicts."""
    conn   = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        f"SELECT * FROM {table} ORDER BY timestamp DESC LIMIT %s", (limit,)
    )
    rows = cursor.fetchall()
    cursor.close(); conn.close()
    # Serialize datetime, Decimal, bool
    result = []
    for r in rows:
        row = {}
        for k, v in r.items():
            if hasattr(v, 'isoformat'):
                row[k] = v.isoformat()
            elif hasattr(v, '__float__'):
                row[k] = float(v)
            elif isinstance(v, (bytes, bytearray)):
                row[k] = bool(v[0]) if v else False
            else:
                row[k] = v
        result.append(row)
    return result


def _delete_dc_anomaly_table(table: str) -> int:
    conn   = get_db()
    cursor = conn.cursor()
    cursor.execute(f"DELETE FROM {table}")
    deleted = cursor.rowcount
    conn.commit(); cursor.close(); conn.close()
    return deleted


@app.route("/api/dc-anomaly-logs/battery", methods=["GET"])
def get_dc_battery_anomaly_logs():
    limit = request.args.get("limit", 2000, type=int)
    try:
        return jsonify({"logs": _fetch_dc_anomaly_table("dc_battery_anomaly_logs", limit)})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/dc-anomaly-logs/battery", methods=["DELETE"])
def delete_dc_battery_anomaly_logs():
    try:
        deleted = _delete_dc_anomaly_table("dc_battery_anomaly_logs")
        return jsonify({"success": True, "deleted": deleted})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/dc-anomaly-logs/solar", methods=["GET"])
def get_dc_solar_anomaly_logs():
    limit = request.args.get("limit", 2000, type=int)
    try:
        return jsonify({"logs": _fetch_dc_anomaly_table("dc_solar_anomaly_logs", limit)})
    except Error as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/dc-anomaly-logs/solar", methods=["DELETE"])
def delete_dc_solar_anomaly_logs():
    try:
        deleted = _delete_dc_anomaly_table("dc_solar_anomaly_logs")
        return jsonify({"success": True, "deleted": deleted})
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/anomaly-logs", methods=["POST"])
def add_anomaly_log():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No JSON body"}), 400
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            INSERT INTO anomaly_logs
                (timestamp,type,source,severity,system_action,
                 system_temp,battery_soc,solar_power,grid_voltage,
                 email_status,buzzer_status,status)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            data.get("type","Unknown"),  data.get("source","Unknown"),
            data.get("severity","Low"),  data.get("systemAction",""),
            data.get("systemTemp",0),    data.get("battery",""),
            data.get("solarPower",""),   data.get("gridVoltage",""),
            data.get("emailStatus","Queued"), data.get("buzzer","OFF"),
            data.get("status","Monitoring"),
        ))
        conn.commit()
        new_id = cursor.lastrowid
        cursor.close(); conn.close()
        return jsonify({"success": True, "id": new_id}), 201
    except Error as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  SSR / RELAY STATE
# =============================================================================

@app.route("/api/ssr/state", methods=["GET"])
def get_ssr_state():
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT * FROM ssr_state ORDER BY id DESC LIMIT 1")
        _rw = cursor.fetchone()
        row: Dict[str, Any] = cast(Dict[str, Any], _rw) if _rw else {}
        cursor.close(); conn.close()
        if not row:
            return jsonify({"error": "No SSR state found"}), 404
        return jsonify({
            "controlMode":       row.get("control_mode",    "solar"),
            "autoSwitchEnabled": bool(row.get("auto_switch",     1)),
            "manualOverride":    bool(row.get("manual_override",  0)),
            "ssrStates": {
                "SSR1": bool(row.get("ssr1_state", 0)),
                "SSR2": bool(row.get("ssr2_state", 0)),
                "SSR3": bool(row.get("ssr3_state", 0)),
                "SSR4": bool(row.get("ssr4_state", 1)),
                "K1":   bool(row.get("ssr1_state", 0)),
                "K2":   bool(row.get("ssr2_state", 0)),
                "K4":   bool(row.get("ssr4_state", 1)),
            },
            "contactorClosed":  bool(row.get("contactor_closed", 1)),
            "k4Closed":         bool(row.get("ssr4_state",       1)),
            "totalSwitches":    row.get("total_switches",    0),
            "lastSwitchTime":   row.get("last_switch_time",  "--:--"),
            "arduino":          "connected" if arduino and arduino.is_open else "disconnected",
            "manualLockout": {
                "active":    _manual_lockout_active(),
                "remaining": max(0, MANUAL_LOCKOUT_S - int(time.time() - _last_manual_ts)),
            },
        })
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ssr/state", methods=["POST"])
def update_ssr_state():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No JSON body"}), 400

    ssr_states   = data.get("ssrStates", {})
    control_mode = data.get("controlMode", "solar")

    # [FIX-CONTROL-MODE] Frontend sends 'manual' which is not a valid DB control_mode.
    # Derive the correct mode from SSR states so DB always has a meaningful value.
    # Valid DB modes: 'solar', 'grid', 'assist', 'shutdown', 'failsafe', 'recovery'
    if control_mode == 'manual':
        ssr1 = bool(ssr_states.get("SSR1") or ssr_states.get("K1"))
        ssr2 = bool(ssr_states.get("SSR2") or ssr_states.get("K2"))
        ssr4 = bool(ssr_states.get("SSR4", True))
        if not ssr4:
            control_mode = 'shutdown'
        elif ssr1 and ssr2:
            control_mode = 'assist'
        elif ssr1:
            control_mode = 'solar'
        elif ssr2:
            control_mode = 'grid'
        else:
            control_mode = 'shutdown'

    if data.get("initialLoad", False):
        try:
            conn   = get_db()
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE ssr_state SET
                    control_mode=%s, auto_switch=%s, manual_override=%s,
                    ssr1_state=%s, ssr2_state=%s, ssr3_state=%s, ssr4_state=%s,
                    contactor_closed=%s, grid_assist=%s
                WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
            """, (
                control_mode,
                int(data.get("autoSwitchEnabled", True)),
                int(data.get("manualOverride",    False)),
                int(ssr_states.get("SSR1", False)),
                int(ssr_states.get("SSR2", False)),
                int(ssr_states.get("SSR3", False)),
                int(ssr_states.get("SSR4", True)),
                int(data.get("contactorClosed",   True)),
                int(data.get("gridAssistActive",  False)),
            ))
            conn.commit(); cursor.close(); conn.close()
        except Exception as e:
            print(f"Initial load DB sync error: {e}")
        return jsonify({"success": True, "arduino": "skipped (initial load)"})

    # [FIX-SHUTDOWN-1] K4 must ALWAYS be OPEN on shutdown — never trust SSR4 from payload
    # Frontend sometimes sends SSR4=True before derived state updates, causing K4 to stay CLOSED
    if control_mode == 'shutdown':
        k4_close = False
    elif control_mode == 'recovery':
        # Arduino v6.4: 'r' command starts 15s recovery countdown then restores K1/K2+K4
        # Flask just sends the command — Arduino handles the rest
        with arduino_sequence_lock:
            arduino_send('r')
        _touch_manual_ts()
        return jsonify({
            "success": True,
            "arduino": "sent" if arduino else "not connected",
            "action": "RECOVERY_STARTED",
            "message": "Arduino recovery countdown started (15s)",
        })
    else:
        k4_close = bool(ssr_states.get("SSR4", True))

    with arduino_sequence_lock:
        _seq_apply_ssr_state(
            ssr1=bool(ssr_states.get("SSR1")),
            ssr2=bool(ssr_states.get("SSR2")),
            ssr3=bool(ssr_states.get("SSR3")),
            k4_close=k4_close,
        )

    _touch_manual_ts()

    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)

        # Get current state BEFORE update for history
        cursor.execute("SELECT control_mode, ssr1_state, ssr2_state, ssr3_state, ssr4_state FROM ssr_state ORDER BY id DESC LIMIT 1")
        _prev2 = cursor.fetchone()
        prev2: Dict[str, Any] = cast(Dict[str, Any], _prev2) if _prev2 else {}
        from_mode  = prev2.get("control_mode") if prev2 else None
        prev_tuple = (bool(prev2.get("ssr1_state", 0)), bool(prev2.get("ssr2_state", 0)),
                      bool(prev2.get("ssr3_state", 0)), bool(prev2.get("ssr4_state", 1))) if prev2 else (False, False, False, True)

        cursor.execute("""
            UPDATE ssr_state SET
                control_mode=%s, auto_switch=%s, manual_override=%s,
                ssr1_state=%s, ssr2_state=%s, ssr3_state=%s, ssr4_state=%s,
                contactor_closed=%s, grid_assist=%s,
                total_switches=total_switches+1, last_switch_time=%s
            WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
        """, (
            control_mode,
            int(data.get("autoSwitchEnabled", True)),
            int(data.get("manualOverride",    False)),
            int(ssr_states.get("SSR1", False)),
            int(ssr_states.get("SSR2", False)),
            int(ssr_states.get("SSR3", False)),
            int(k4_close),
            int(k4_close),
            int(data.get("gridAssistActive",  False)),
            datetime.now().strftime("%H:%M"),
        ))

        # Insert history row
        after_tuple = (
            bool(ssr_states.get("SSR1", False)),
            bool(ssr_states.get("SSR2", False)),
            bool(ssr_states.get("SSR3", False)),
            bool(k4_close),
        )
        _insert_ssr_switch_log(cursor,
            trigger_source='manual',
            from_mode=from_mode,
            to_mode=control_mode,
            before=prev_tuple,
            after=after_tuple,
            reason=f'Manual switch → {control_mode}',
        )

        conn.commit(); cursor.close(); conn.close()
        return jsonify({
            "success": True,
            "arduino": "sent" if arduino else "not connected",
            "manual_lockout_started": True,
            "lockout_seconds": MANUAL_LOCKOUT_S,
        })
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ssr/emergency", methods=["POST"])
def emergency_cutoff():
    # Arduino v6.4: 'x' = emergency OFF (K1+K2+K4 OFF, K3 untouched, saves K1/K2 for recovery)
    # [FIX-EMERGENCY-DELAY] Send 'x' directly WITHOUT arduino_sequence_lock.
    # The sequence lock is held by background_logger for up to 5s — waiting for it
    # causes 5-10s delay on emergency. Emergency must be INSTANT.
    # arduino_lock (inner) is still used to serialize the serial write safely.
    arduino_send('x')
    print("EMERGENCY CUTOFF — Arduino 'x' sent: K1+K2+K4 OFF, K3 untouched")

    _touch_manual_ts()

    _email_cooldowns.pop('emergency_cutoff', None)
    _fault_counters['emergency_cutoff'] = FAULT_CONFIRM_COUNT
    trigger_email_alert(
        fault_type="EMERGENCY CUTOFF Triggered",
        severity="critical",
        action=(
            "Emergency stop. All relays OFF. SSR4/K4 OPEN. Outlets disconnected. "
            "⚠️ ADMIN: Inspect before restart. Trip MCCB if battery at risk."
        ),
        source="Emergency Cutoff (API)",
        cooldown_key="emergency_cutoff",
        email_type="emergency",
    )
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        # Get current before clearing
        cursor.execute("SELECT control_mode, ssr1_state, ssr2_state, ssr3_state, ssr4_state FROM ssr_state ORDER BY id DESC LIMIT 1")
        _prev3 = cursor.fetchone()
        prev3: Dict[str, Any] = cast(Dict[str, Any], _prev3) if _prev3 else {}
        from_mode  = prev3.get("control_mode") if prev3 else None
        prev_tuple = (bool(prev3.get("ssr1_state", 0)), bool(prev3.get("ssr2_state", 0)),
                      bool(prev3.get("ssr3_state", 0)), bool(prev3.get("ssr4_state", 1))) if prev3 else (False, False, False, True)

        cursor.execute("""
            UPDATE ssr_state SET control_mode='shutdown',
                ssr1_state=0, ssr2_state=0, ssr3_state=0, ssr4_state=0,
                contactor_closed=0, grid_assist=0, last_switch_time=%s,
                total_switches=total_switches+1
            WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
        """, (datetime.now().strftime("%H:%M"),))

        _insert_ssr_switch_log(cursor,
            trigger_source='emergency',
            from_mode=from_mode,
            to_mode='shutdown',
            before=prev_tuple,
            after=(False, False, False, False),
            reason='Emergency cutoff — all SSRs OFF',
        )
        conn.commit(); cursor.close(); conn.close()
    except Exception as e:
        print(f"Emergency cutoff DB update failed: {e}")
    return jsonify({"success": True, "action": "EMERGENCY_CUTOFF"})


@app.route("/api/ssr/recovery", methods=["POST"])
def start_recovery():
    """
    Arduino v6.4 recovery: sends 'r' command.
    Arduino starts 15s countdown then restores pre-emergency K1/K2 state + K4 ON.
    Flask does not drive relays directly — Arduino handles the full sequence.
    [FIX-RECOVERY-DELAY] Send 'r' directly WITHOUT arduino_sequence_lock for instant response.
    """
    resp = arduino_send('r')
    _touch_manual_ts()
    print(f"[RECOVERY] Arduino 'r' sent → 15s countdown → restore K1/K2+K4. Arduino resp: {resp}")
    try:
        conn = get_db(); cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT control_mode, ssr1_state, ssr2_state, ssr3_state, ssr4_state FROM ssr_state ORDER BY id DESC LIMIT 1")
        _prev = cursor.fetchone()
        prev: Dict[str, Any] = cast(Dict[str, Any], _prev) if _prev else {}
        from_mode = prev.get("control_mode") if prev else None
        prev_tuple = (bool(prev.get("ssr1_state", 0)), bool(prev.get("ssr2_state", 0)),
                      bool(prev.get("ssr3_state", 0)), bool(prev.get("ssr4_state", 0))) if prev else (False, False, False, False)
        cursor.execute("""
            UPDATE ssr_state SET control_mode='recovery', last_switch_time=%s,
                total_switches=total_switches+1
            WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
        """, (datetime.now().strftime("%H:%M"),))
        _insert_ssr_switch_log(cursor,
            trigger_source='manual',
            from_mode=from_mode,
            to_mode='recovery',
            before=prev_tuple,
            after=prev_tuple,  # actual relay state change happens in Arduino after 15s
            reason='Recovery started — Arduino 15s countdown',
        )
        conn.commit(); cursor.close(); conn.close()
    except Exception as e:
        print(f"Recovery DB update failed: {e}")
    return jsonify({
        "success": True,
        "action": "RECOVERY_STARTED",
        "message": "Arduino recovery countdown started (15s)",
        "arduino_response": resp,
    })


@app.route("/api/ssr/switch-log", methods=["GET"])
def get_ssr_switch_log():
    """Return full SSR switch history — every relay change event ever recorded."""
    limit = min(int(request.args.get("limit", 100)), 500)
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, switched_at, trigger_source, from_mode, to_mode,
                   ssr1_before, ssr2_before, ssr3_before, ssr4_before,
                   ssr1_after,  ssr2_after,  ssr3_after,  ssr4_after,
                   reason, battery_soc, solar_power_w, grid_voltage_v
            FROM ssr_switch_log
            ORDER BY switched_at DESC
            LIMIT %s
        """, (limit,))
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        # Stringify datetimes — cast each row to Dict for Pylance
        result = []
        for _r in rows:
            r: Dict[str, Any] = cast(Dict[str, Any], _r)
            if r.get("switched_at"):
                r["switched_at"] = str(r["switched_at"])
            result.append(r)
        return jsonify({"logs": result, "total": len(result)})
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email-logs", methods=["GET"])
def get_email_logs():
    """Return full email send history — sent, failed, skipped_cooldown, no_recipient."""
    limit = min(int(request.args.get("limit", 100)), 500)
    status_filter = request.args.get("status")   # optional ?status=sent
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        if status_filter:
            cursor.execute("""
                SELECT id, sent_at, fault_key, fault_type, severity, source,
                       recipient, status, error_msg,
                       battery_soc, solar_power_w, grid_voltage_v
                FROM email_logs
                WHERE status = %s
                ORDER BY sent_at DESC LIMIT %s
            """, (status_filter, limit))
        else:
            cursor.execute("""
                SELECT id, sent_at, fault_key, fault_type, severity, source,
                       recipient, status, error_msg,
                       battery_soc, solar_power_w, grid_voltage_v
                FROM email_logs
                ORDER BY sent_at DESC LIMIT %s
            """, (limit,))
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        result_e = []
        for _re in rows:
            re: Dict[str, Any] = cast(Dict[str, Any], _re)
            if re.get("sent_at"):
                re["sent_at"] = str(re["sent_at"])
            result_e.append(re)
        return jsonify({"logs": result_e, "total": len(result_e)})
    except Error as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/arduino/status", methods=["GET"])
def get_arduino_status():
    # [FIX-DEADLOCK] Use cache instead of direct arduino_get_status() call.
    # Direct call blocks on arduino_lock which arduino_poller may be holding.
    status = get_arduino_cache()
    if not status:
        # Cache empty (Arduino not yet polled or disconnected)
        return jsonify({"success": False, "error": "Arduino cache empty — poller not ready"}), 503
    if status:
        # Ensure all timer fields always present — Arduino omits them when 0
        status.setdefault('k4_left_s',       0)
        status.setdefault('k1_left_s',       0)
        status.setdefault('k2_left_s',       0)
        status.setdefault('recovery_left_s', 0)
        status.setdefault('dropout',         0)
        status.setdefault('emergency',       0)
        return jsonify({"success": True, "arduino": status})
    return jsonify({"success": False, "error": "Arduino not responding"}), 503


# =============================================================================
#  SYSTEM CONFIG
# =============================================================================

@app.route("/api/system/config", methods=["GET"])
def get_system_config():
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT config_key, config_val FROM system_config")
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        config: Dict[str, Any] = {
            str(r['config_key']): r['config_val']  # type: ignore[index]
            for r in rows if r is not None
        }
        cap_ah  = int(str(config.get('battery_capacity_ah', 100)))
        oc_cfg  = BAT_OVERCURRENT_CONFIG.get(cap_ah, BAT_OVERCURRENT_CONFIG[100])
        config['battery_overcurrent_warn_a'] = str(oc_cfg['warn'])
        config['battery_overcurrent_trip_a'] = str(oc_cfg['trip'])
        return jsonify({"success": True, "config": config})
    except Exception as e:
        return jsonify({"error": str(e)}), 500




@app.route("/api/system-config/<key>", methods=["GET"])
def get_system_config_by_key(key: str):
    """Alias — frontend calls /api/system-config/<key> directly."""
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT config_val FROM system_config WHERE config_key = %s", (key,)
        )
        _row = cursor.fetchone()
        cursor.close(); conn.close()
        if not _row:
            return jsonify({"error": f"Key not found"}), 404
        row: Dict[str, Any] = cast(Dict[str, Any], _row)  # Pylance: cursor is dictionary=True
        return jsonify({"success": True, "key": key, "value": row["config_val"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/system/config", methods=["POST"])
def update_system_config():
    data = request.get_json() or {}
    try:
        conn   = get_db()
        cursor = conn.cursor()
        for key, val in data.items():
            cursor.execute("""
                INSERT INTO system_config (config_key, config_val)
                VALUES (%s, %s)
                ON DUPLICATE KEY UPDATE config_val = VALUES(config_val)
            """, (key, str(val)))
        if 'battery_capacity_ah' in data:
            cap_ah = int(data['battery_capacity_ah'])
            oc_cfg = BAT_OVERCURRENT_CONFIG.get(cap_ah, BAT_OVERCURRENT_CONFIG[100])
            cursor.execute("""
                INSERT INTO system_config (config_key, config_val)
                VALUES ('battery_current_warn_a', %s)
                ON DUPLICATE KEY UPDATE config_val = VALUES(config_val)
            """, (str(oc_cfg['warn']),))
            print(f"Battery capacity → {cap_ah}Ah | warn={oc_cfg['warn']}A | trip={oc_cfg['trip']}A")
        conn.commit(); cursor.close(); conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  NETWORK LOGS
# =============================================================================

@app.route('/api/network-logs', methods=['POST'])
def save_network_log():
    try:
        data   = request.get_json()
        conn   = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO network_logs
            (local_latency_ms, local_status, internet_status, temperature, temp_status, signal_quality)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (
            data.get('localLatency'),  data.get('localStatus'),
            data.get('internetStatus'), data.get('temperature'),
            data.get('tempStatus'),    data.get('signalQuality'),
        ))
        conn.commit(); cursor.close(); conn.close()
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/network-logs', methods=['GET'])
def get_network_logs():
    try:
        limit  = int(request.args.get('limit', 200))
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT * FROM network_logs ORDER BY id DESC LIMIT %s", (limit,))
        rows   = cursor.fetchall()
        cursor.close(); conn.close()
        return jsonify(rows)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# =============================================================================
#  OUTLET / BUZZER CONTROL
# =============================================================================

@app.route("/api/outlets/<outlet>", methods=["POST"])
def control_outlet(outlet: str):
    data   = request.get_json()
    status = data.get("status", False) if data else False
    return jsonify({"success": True, "outlet": outlet, "status": status})


@app.route("/api/buzzer/trigger", methods=["POST"])
def trigger_buzzer():
    data        = request.get_json() or {}
    duration_ms = int(data.get("duration_ms", BUZZER_DURATION_MS))
    reason      = data.get("reason", "Anomaly alert")
    if buzzer_state['active']:
        return jsonify({"success": False, "message": "Buzzer already active"}), 409
    buzzer_state['active']       = True
    buzzer_state['duration_ms']  = duration_ms
    buzzer_state['triggered_at'] = datetime.now().isoformat()
    _buzzer_on()

    def _auto_off():
        if _is_double:
            # double fault only: 5s → 2s silence → tut tut tut
            time.sleep(5.0)
            _buzzer_off()
            time.sleep(2.0)
            for _ in range(3):
                _buzzer_on()
                time.sleep(0.3)
                _buzzer_off()
                time.sleep(0.2)
        else:
            # single dropout: 5s continuous only, no tut tut
            time.sleep(duration_ms / 1000)
            _buzzer_off()
        buzzer_state['active']      = False
        buzzer_state['duration_ms'] = 0

    threading.Thread(target=_auto_off, daemon=True).start()
    try:
        conn   = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO buzzer_logs (duration_ms, reason) VALUES (%s, %s)",
            (duration_ms, reason)
        )
        conn.commit(); cursor.close(); conn.close()
    except Exception as e:
        print(f"Buzzer log DB error: {e}")
    return jsonify({
        "success": True, "duration_ms": duration_ms,
        "triggered_at": buzzer_state['triggered_at'],
        "arduino": "sent" if arduino else "not connected",
    }), 200


@app.route("/api/buzzer/stop", methods=["POST"])
def stop_buzzer():
    _buzzer_off()
    buzzer_state['active']      = False
    buzzer_state['duration_ms'] = 0
    return jsonify({"success": True})


@app.route("/api/buzzer/state", methods=["GET"])
def get_buzzer_state():
    return jsonify({
        "active":       buzzer_state['active'],
        "duration_ms":  buzzer_state['duration_ms'],
        "triggered_at": buzzer_state['triggered_at'],
    })


# =============================================================================
#  DEBUG ROUTES
# =============================================================================

@app.route("/api/debug/alert-state", methods=["GET"])
def debug_alert_state():
    now = time.time()
    ina226_data = cache.get('ina226', {})
    return jsonify({
        "fault_states":   dict(_fault_state),
        "fault_counters": dict(_fault_counters),
        "fault_first_detected": {
            k: v.strftime('%Y-%m-%d %H:%M:%S.%f')
            for k, v in _fault_first_detected.items()
        },
        "buzzer_fired":   dict(_buzzer_fired),
        "thermal": {
            "shutdown_active": _thermal_shutdown_active,
            "current_temp":    cache.get('system_temp', 0),
            "dht22_available": DHT_AVAILABLE,
        },
        # Battery debug info — Arduino voltage divider
        "battery_vdiv": {
            "source":    "arduino_vdiv",
            "voltage":   ina226_data.get('voltage', 0),
            "soc":       ina226_data.get('soc', 0),
            "available": ina226_data.get('available', False),
        },
        "cooldowns": {
            k: f"{int(EMAIL_COOLDOWN_DEFAULT_S - (now - t))}s remaining"
            for k, t in _email_cooldowns.items()
            if now - t < EMAIL_COOLDOWN_DEFAULT_S
        },
        "daylight_now":   _is_daytime(),
        "manual_lockout": {
            "active":    _manual_lockout_active(),
            "remaining": max(0, MANUAL_LOCKOUT_S - int(now - _last_manual_ts)),
        },
    })


@app.route("/api/debug/reset-cooldowns", methods=["POST"])
def debug_reset_cooldowns():
    cleared = list(_email_cooldowns.keys())
    _email_cooldowns.clear()
    return jsonify({"success": True, "cleared": cleared})


@app.route("/api/debug/reset-faults", methods=["POST"])
def debug_reset_faults():
    _fault_state.clear(); _fault_counters.clear()
    _buzzer_fired.clear(); _email_cooldowns.clear()
    _fault_first_detected.clear()
    return jsonify({"success": True, "message": "All alert state reset."})




# =============================================================================
#  STARTUP
# =============================================================================


@app.route("/api/anomaly-logs/grid/counts", methods=["GET"])
@app.route("/api/anomaly-logs/inverter/counts", methods=["GET"])
@app.route("/api/anomaly-logs/counts", methods=["GET"])
def get_anomaly_counts():
    try:
        conn = get_db(); cursor = conn.cursor(dictionary=True)
        out = {}
        for tbl, key in [("grid_anomaly_logs","grid"),("inverter_anomaly_logs","inverter"),("anomaly_logs","general")]:
            cursor.execute(f"SELECT severity, COUNT(*) as cnt FROM {tbl} GROUP BY severity")
            out[key] = {r["severity"]: r["cnt"] for r in cursor.fetchall()}
        cursor.close(); conn.close()
        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("  HELIOGRID — UNIFIED FLASK API SERVER  (v7.1 — INA219 Battery)")
    print("=" * 70)
    print(f"  Arduino Pin Map (v6.4):")
    print(f"    RPi GPIO14 → Buzzer")
    print(f"    Pin  7 → SSR1 = K1 → Solar/Inverter line")
    print(f"    Pin  6 → SSR2 = K2 → Grid line")
    print(f"    Pin  4 → SSR4 = K4 → Main contactor (dropout protection)")
    print(f"\n  Battery Sensor: Arduino voltage divider (A5)")
    print(f"    Bat1 @ 0x41 — 12V 100Ah bottom cell")
    print(f"    Bat2 @ 0x44 — 12V 100Ah top cell")
    print(f"    Pack: series 24V | Shunt: 200A/75mV external")
    print(f"    ina.py: {'LOADED ✓' if INA219_AVAILABLE else 'NOT FOUND — place ina.py in sensors/'}")
    print(f"\n  AC Sensors:")
    print(f"    Grid PZEM:     {'connected' if grid_pzem else 'offline (/dev/ttyGridPZEM)'}")
    print(f"    Inverter PZEM: {'connected' if inverter_pzem else 'offline (/dev/ttyInverterPZEM)'}")
    print(f"    Arduino:       {'connected (/dev/ttyArduino)' if arduino and arduino.is_open else 'offline (/dev/ttyArduino)'}")
    print(f"\n  {DHT_TYPE}: {'AVAILABLE — GPIO BCM ' + str(DHT_PIN) if DHT_AVAILABLE else 'NOT AVAILABLE (pip install adafruit-circuitpython-dht)'}")
    print("=" * 70)
    try:
        ensure_tables()
        print("Database initialized")
    except Exception as e:
        print(f"Database initialization failed: {e}")
        exit(1)
    # ── DS3231 RTC Boot Sync ──────────────────────────────────────────────────
    # Sync RPi system clock from DS3231 before sensors start (offline-safe)
    if RTC_AVAILABLE:
        print("Syncing system clock from DS3231 RTC...")
        sync_system_clock_from_rtc()
    else:
        print("DS3231 not available — using system clock only")

    arduino_connected = arduino is not None and arduino.is_open
    # [FIX-ARDUINO-BLOCK] Start Arduino poller thread FIRST so _arduino_cache
    # is populated before background_logger starts reading it.
    if arduino_connected:
        threading.Thread(target=arduino_poller, daemon=True, name='arduino-poller').start()
        print("Arduino poller thread started — polling every 1s")
        import time as _st; _st.sleep(1.2)  # wait for first poll to populate cache
    # Always start background_logger if Arduino is connected —
    # voltage signals (g0/g1/i0/i1) must run every cycle even without PZEM.
    if arduino_connected or SENSORS_AVAILABLE or DHT_AVAILABLE:
        threading.Thread(target=background_logger, daemon=True).start()
        print("Background sensor logger started")
        if not SENSORS_AVAILABLE:
            print("  ⚠ PZEM sensors unavailable — Arduino voltage signals still active (g0/i0 sent)")
    else:
        print("Background logger disabled (no hardware detected)")
    threading.Thread(target=auto_cleanup_logs, daemon=True).start()
    print("Auto-cleanup scheduler started — daily at 23:59, 30-day retention")
    print("\nServer starting on http://localhost:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
