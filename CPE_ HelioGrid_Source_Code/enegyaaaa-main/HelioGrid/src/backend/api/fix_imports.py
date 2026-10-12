def get_pzem_data(sensor_obj):
    try:
        if sensor_obj:
            d = sensor_obj.read_all()
            return d if isinstance(d, dict) else {}
        return {}
    except:
        return {}

"""
HelioGrid — Unified Flask API Server  (PATCHED v7.1)
=====================================
v7.0 CHANGES (on top of v6.0):
  [FIX-SSR-1] _seq_solar_on — FIXED command order:
              OLD (WRONG): 'q','w' → '1' → '4'
                Sent K1+K2 OFF simultaneously then K1 ON.
                Arduino SSR1_SSR2_INTERLOCK triggered briefly, leaving
                system on Solar even after clicking Grid.
              NEW (CORRECT): 'w'(K2 OFF) → sleep → 'q'(K1 clean) → '1'(K1 ON) → '4'

  [FIX-SSR-2] _seq_grid_on — FIXED command order:
              OLD (WRONG): '1'(K1 ON) → 'q'(K1 OFF) → '2' → '4'
                Momentarily turned Solar ON, interlock forced Grid OFF,
                left system on Solar despite clicking Grid.
              NEW (CORRECT): 'q'(K1 OFF) → sleep → 'w'(K2 clean) → '2'(K2 ON) → '4'

grid_pzem = None
inv_pzem = None
  [FIX-SSR-3] _seq_apply_ssr_state — FIXED mutual exclusion:
              Now always turns OFF the opposite relay first before
              turning ON the desired one. Prevents interlock race condition
              on every manual SSR state change from the UI.

  [FIX-TIMING] background_logger — FIXED RPi loop timing:
              OLD: naive time.sleep(5) AFTER sensor reads.
                On RPi, PZEM reads take 1-2s each + DB writes = 8-12s actual cycle.
                SSR manual lockout (15s) was relative to stale loop, causing UI
                clicks to appear unresponsive on RPi.
              NEW: target-time sleep = max(0.5, 5.0 - elapsed).
                Keeps cycle at ~5s regardless of sensor read duration.

  [FIX-LOGS]  sensor_logs INSERT — FIXED missing rows when Arduino disconnected:
              OLD: INSERT guarded by `if any(k in log_data for k in _sensor_keys)`.
                When Arduino unplugged (no solar data) AND Inverter PZEM missing,
                log_data was empty → INSERT skipped → blank sensor log table.
              NEW: setdefault() fills all required columns with 0.0 before INSERT.
                A row is always written every cycle, even with partial hardware.

  [FIX-SOLAR-V] /api/sensor-data/current solar voltage — FIXED 4× voltage bug:
              OLD: summed voltage of all 4 panels (valid_panels loop) →
                4P parallel array has SAME voltage on all panels, so
                dashboard showed 164V instead of 41V.
              NEW: uses cache['solarVoltage'] / cache['solarCurrent'] / cache['solarPower']
                which are set directly from Arduino A4 voltage divider read.

  [FIX-DB]    DB default host — FIXED wrong fallback:
              OLD: os.getenv("MYSQL_HOST", "192.168.1.8") — if .env fails to load,
                Flask tried to connect to wrong IP, causing silent DB errors.
              NEW: os.getenv("MYSQL_HOST", "localhost") — matches .env default.

v6.0 CHANGES (on top of v5.0):
  [v7.0] Battery via PZEM-017 DC meters (B1=/dev/ttyBattery1PZEM, B2=/dev/ttyBattery2PZEM)

All v5.0 Phase 1 fixes remain active:
  [P1-FIX-1..6] — see v5.0 header
All v4.2-safe patches remain active:
  [FIX-1..8]    — see original header
"""

import os, sys, json, threading, time, requests

# Global sensor initialization
inv_pzem = None
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
sys.path.insert(0, SENSORS_PATH)
sys.path.insert(0, CONFIG_PATH)

PZEM004TReader:        Any = None
InverterPZEMReader:    Any = None
PZEM017BatteryReader:  Any = None

# ── PZEM-004T AC readers (Grid + Inverter) ────────────────────────────────────
# PZEM_AVAILABLE = True only when at least one reader class loads successfully
try:
    PZEM_AVAILABLE  = True
    print("GridPZEM reader loaded (PZEM004TReader)")
except ImportError:
    try:
        from PZEM import PZEM004TReader as _PZEM
        PZEM004TReader  = _PZEM
        PZEM_AVAILABLE  = True
        print("PZEM reader loaded (PZEM004TReader from PZEM.py)")
    except ImportError:
        print("⚠️  GridPZEM/PZEM module not found — grid PZEM disabled")

try:
    PZEM_AVAILABLE     = True
    print("InverterPZEM reader loaded")
except ImportError:
    try:
        # Fallback: some setups use the same PZEM class for both
        if PZEM004TReader is not None:
            InverterPZEMReader = PZEM004TReader
            print("InverterPZEM using PZEM004TReader (shared class)")
        else:
            print("⚠️  InverterPZEM module not found — inverter PZEM disabled")
    except Exception:
        print("⚠️  InverterPZEM import failed")

I2C_CONFIG:  Dict[str, Any] = {"solar_panels": [], "batteries": []}
UART_CONFIG: Dict[str, Any] = {
    "grid_pzem":     {"port": "/dev/ttyGridPZEM"},
    "inverter_pzem": {"port": "/dev/ttyInverterPZEM"},
}

PZEM_AVAILABLE    = False
INA219_AVAILABLE  = False  # set True below after ina.py import
PZEM017_AVAILABLE = False  # aliased to INA219_AVAILABLE after import

# [P1-FIX-4] DHT import — uses adafruit_dht (CircuitPython, matches Temp.py)
#   Sensor type: DHT22 (physical sensor on GPIO27)
#   GPIO pin:    BCM 27 (matches Temp.py board.D27)
#   Install:     pip install adafruit-circuitpython-dht --break-system-packages
DHT_TYPE      = "DHT22"   # "DHT11" or "DHT22" — must match physical sensor
DHT_PIN       = 27        # RPi GPIO BCM 27 (board.D27 in Temp.py)
DHT_AVAILABLE = False
_dht_device:  Any = None
try:
    import board as _board
    import adafruit_dht as _adafruit_dht_mod
    _dht_pin = getattr(_board, f"D{DHT_PIN}")
    if DHT_TYPE == "DHT22":
        _dht_device = _adafruit_dht_mod.DHT22(_dht_pin, use_pulseio=False)
    else:
        _dht_device = _adafruit_dht_mod.DHT11(_dht_pin, use_pulseio=False)
    DHT_AVAILABLE = True
    print(f"{DHT_TYPE} (adafruit_dht CircuitPython) initialized on GPIO{DHT_PIN}")
except Exception as _dht_err:
    print(f"{DHT_TYPE} not available — temp reads will return 0.0 ({_dht_err})")

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
    from RTC import (
        sync_system_clock_from_rtc,
        sync_rtc_from_ntp,
        get_rtc_status,
        get_timestamp,
        RTC_AVAILABLE,
    )
except (ImportError, ModuleNotFoundError):
    pass  # RPi-only module — stubs active on Windows/dev

# =============================================================================
# ── INA219 Battery Monitor (replaces PZEM-017) ───────────────────────────────
# 2× INA219 via I2C (shared bus)
#   Bat1 @ 0x41 — 12V series cell 1 (bottom)
#   Bat2 @ 0x44 — 12V series cell 2 (top)
# Pack = series sum: voltage = B1+B2 (~24V), current = avg(B1,B2)
# ina.py must be in sensors/ directory
# Install: pip install adafruit-circuitpython-ina219 --break-system-packages
# =============================================================================
INA219_AVAILABLE = False
_read_ina219_battery: Any = None

try:
    from ina import read_battery as _read_ina219_battery_import
    _read_ina219_battery = _read_ina219_battery_import
    INA219_AVAILABLE     = True
    print("✅ INA219 battery module loaded (ina.py)")
except ImportError as _ina_err:
    print(f"⚠️  ina.py not found — battery monitoring disabled ({_ina_err})")

# Backward-compat flags — old code checks PZEM017_AVAILABLE
PZEM017_AVAILABLE = INA219_AVAILABLE   # alias so existing checks work
_ModbusClient: Any = None              # not used — kept to avoid NameError

SENSORS_AVAILABLE = PZEM_AVAILABLE or INA219_AVAILABLE

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
    "https://nontheoretic-submedially-grayce.ngrok-free.dev",
]
CORS(app, supports_credentials=True, origins=ALLOWED_ORIGINS)

FRONTEND_URL        = os.getenv("FRONTEND_URL",        "http://localhost:3000")
OAUTH_CALLBACK_BASE = os.getenv("OAUTH_CALLBACK_BASE", "http://localhost:5000")

_https = OAUTH_CALLBACK_BASE.startswith("https")
app.config.update(
    SESSION_COOKIE_SECURE   =_https,
    SESSION_COOKIE_SAMESITE ='None' if _https else 'Lax',
    SESSION_COOKIE_HTTPONLY =True,
)
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

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

BAT_FULL          = 26.4
BAT_WARNING_LOW   = 23.0
BAT_CRITICAL_LOW  = 21.6
BAT_CRITICAL_HIGH = 27.6

GRID_CRITICAL_LOW  = 200.0
GRID_CRITICAL_HIGH = 245.0
GRID_NORMAL_LOW    = 210.0
GRID_NORMAL_HIGH   = 241.0
GRID_FREQ_NOMINAL  = 60.0
GRID_FREQ_CRIT     = 1.0

INV_CRITICAL_LOW  = 207.0
INV_CRITICAL_HIGH = 253.0
# Drift warning: 1V < |ΔV| ≤ 7V — same rule as anomaly_engine.py
INV_DRIFT_WARN_MIN = 1.0
INV_DRIFT_WARN_MAX = 7.0

SOLAR_RATED_W    = 2200.0
SOLAR_CRITICAL_W = 440.0
SOLAR_WARNING_W  = 1320.0
SOLAR_CHARGE_W   = 1320.0

STRING_MISMATCH_WARNING  = 0.30
STRING_MISMATCH_CRITICAL = 0.50

# [P1-FIX-5] Thermal thresholds
TEMP_WARNING  = 50.0
TEMP_CRITICAL = 60.0
TEMP_RESUME   = 45.0

K3_RECONNECT_DELAY_S = 300
SOLAR_DAYLIGHT_START = 6
SOLAR_DAYLIGHT_END   = 18

BAT_OVERCURRENT_CONFIG = {
    100: {"warn": 75,  "trip": 100},
    200: {"warn": 150, "trip": 200},
}

FAULT_CONFIRM_COUNT       = 3
EMAIL_COOLDOWN_CRITICAL_S = 600
EMAIL_COOLDOWN_DEFAULT_S  = 1800
BUZZER_DURATION_MS        = 5000
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
        ('battery_charge_a',    'DECIMAL(10,3) NULL AFTER system_temp'),
        ('battery_discharge_a', 'DECIMAL(10,3) NULL AFTER battery_charge_a'),
        ('system_efficiency',   'DECIMAL(6,2)  NULL AFTER battery_discharge_a'),
        ('solar_efficiency',    'DECIMAL(6,2)  NULL AFTER system_efficiency'),
    ]:
        try:
            cursor.execute(f"ALTER TABLE sensor_logs ADD COLUMN {col} {definition}")
            print(f"  sensor_logs: added column {col}")
        except Exception:
            pass

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS anomaly_logs (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            timestamp           DATETIME DEFAULT CURRENT_TIMESTAMP,
            detected_at         DATETIME NULL,
            action_at           DATETIME NULL,
            response_time_ms    INT NULL,
            resolved_at         DATETIME NULL,
            type                VARCHAR(50),  source           VARCHAR(50),
            severity            VARCHAR(20),  system_action    TEXT,
            system_temp         DECIMAL(5,2), battery_soc      VARCHAR(20),
            solar_power         VARCHAR(20),  grid_voltage     VARCHAR(20),
            inverter_power      DECIMAL(8,2) NULL,
            panel_fault_detail  VARCHAR(100) NULL,
            email_status        VARCHAR(20),  buzzer_status    VARCHAR(10),
            status              VARCHAR(20),
            INDEX idx_timestamp (timestamp DESC)
        )
    """)

    for col, definition in [
        ('detected_at',        'DATETIME NULL AFTER timestamp'),
        ('action_at',          'DATETIME NULL AFTER detected_at'),
        ('response_time_ms',   'INT NULL AFTER action_at'),
        ('resolved_at',        'DATETIME NULL AFTER response_time_ms'),
        ('inverter_power',     'DECIMAL(8,2) NULL AFTER grid_voltage'),
        ('panel_fault_detail', 'VARCHAR(100) NULL AFTER inverter_power'),
    ]:
        try:
            cursor.execute(f"ALTER TABLE anomaly_logs ADD COLUMN {col} {definition}")
            print(f"  anomaly_logs: added column {col}")
        except Exception:
            pass

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS buzzer_logs (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            duration_ms  INT NOT NULL DEFAULT 5000,
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

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS k3_reconnect (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            fault_started   DATETIME,
            grid_recovered  DATETIME,
            reconnect_ok    TINYINT(1) NOT NULL DEFAULT 1,
            grid_stable_s   INT NOT NULL DEFAULT 300,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("SELECT COUNT(*) AS cnt FROM k3_reconnect")
    _r3 = cursor.fetchone()
    k3r: Dict[str, Any] = cast(Dict[str, Any], _r3) if _r3 else {}
    if k3r.get("cnt", 0) == 0:
        cursor.execute("""
            INSERT INTO k3_reconnect (fault_started, grid_recovered, reconnect_ok, grid_stable_s)
            VALUES (NULL, NULL, 1, 300)
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
    response = arduino_send('?')
    if response:
        try:
            return json.loads(response)
        except Exception:
            return None
    return None


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


def _seq_k3_on():
    arduino_send('3')


def _seq_k3_off():
    arduino_send('e')


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
    # NOTE: No '4' command — K4 is managed by Arduino v6.4 dropout logic, not Flask
    arduino_send('3' if ssr3 else 'e')  # K3 always independent
    time.sleep(0.1)


# =============================================================================
#  SENSOR READERS
# =============================================================================

grid_pzem:      Any = None  # type: Optional[Any]
inverter_pzem:  Any = None  # type: Optional[Any]
battery_reader: Any = None
solar_reader:   Any = None

if PZEM_AVAILABLE and PZEM004TReader is not None:
    try:
        port = UART_CONFIG.get('grid_pzem', {}).get('port', '/dev/ttyGridPZEM')
        grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')
        if not grid_pzem.serial_connection:
            from sensors.Grid import PZEM004TReader; grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')
    except Exception as e:
        print(f"Grid PZEM error: {e}"); from sensors.Grid import PZEM004TReader; grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')

if PZEM_AVAILABLE and InverterPZEMReader is not None:
    try:
        port = UART_CONFIG.get('inverter_pzem', {}).get('port', '/dev/ttyInverterPZEM')
        inverter_pzem = InverterPZEMReader(port=port, slave_addr=0x01)  # same addr as Grid PZEM — isolated by separate serial port
        if not inverter_pzem.serial_connection:
            inverter_pzem = None
    except Exception as e:
        print(f"Inverter PZEM error: {e}"); inverter_pzem = None

# INA219 battery reader initialized via ina.py import above (no object needed —
# read_battery() is called directly in background_logger).
# Solar data comes from Arduino WCS1500 (A0-A3) + voltage divider (A4).
solar_reader   = None
battery_reader = None


# =============================================================================
# =============================================================================

cache: Dict[str, Any] = {
    'grid': {'voltage': 240.4, 'current': 0.8, 'power': 190.0, 'frequency': 60.0, 'status': 'online'}, 'inverter': {'voltage': 0.0 if inv_pzem else 0, 'current': inv_pzem.get_current() if inv_pzem else 0, 'power': inv_pzem.get_power() if inv_pzem else 0}, 'solar': [], 'battery': [],
    'last_update': None,
    'system_temp': 0.0,
    # [PZEM017] INA226 battery data cache
    'ina226': {
        'voltage':     0.0,
        'charge_a':    0.0,
        'discharge_a': 0.0,
        'net_current': 0.0,
        'soc':         0.0,
        'available':   False,
    },
}
buzzer_state: Dict[str, Any] = {
    'active': False, 'duration_ms': 0, 'triggered_at': None,
}

_fault_counters:       Dict[str, int]      = {}
_fault_state:          Dict[str, str]      = {}
_fault_first_detected: Dict[str, datetime] = {}
_email_cooldowns:      Dict[str, float]    = {}
_buzzer_fired:         Dict[str, bool]     = {}
_thermal_shutdown_active: bool = False

# ── Gap Fix globals ────────────────────────────────────────────────────────
# Gap 1: K3 cloud-drop hysteresis
K3_CLOUD_HYSTERESIS_S     = 60       # K3 stays ON for 60s after solar drops below SOLAR_CHARGE_W
_k3_charge_last_eligible:  float = 0.0

# Gap 3: Inverter cold-start ramp guard (0V → 230V takes ~3s)
INV_STARTUP_GRACE_S   = 10           # ignore inv fault for 10s after cold start
_inv_last_zero_ts:    float = 0.0    # when iv last read 0
_inv_was_zero:        bool  = True   # True = inverter was previously at 0V
_prev_inv_v:          float = 0.0    # previous inverter voltage for delta/drift calc

_k3_reconnect_state: Dict[str, Any] = {
    'grid_fault_active': False,
    'grid_recovered_at': None,
    'reconnect_allowed': True,
    'stable_seconds':    300,
}

_last_manual_ts: float = 0.0


def _manual_lockout_active() -> bool:
    return (time.time() - _last_manual_ts) < MANUAL_LOCKOUT_S


def _touch_manual_ts():
    global _last_manual_ts
    _last_manual_ts = time.time()


# =============================================================================
#  [P1-FIX-4] DHT READ FUNCTION — adafruit_dht CircuitPython API (matches Temp.py)
# =============================================================================

def read_dht22() -> float:
    """Read temperature from DHT22 sensor using adafruit_dht CircuitPython API.
    Auto-reinitializes the device on [Errno 22] / Invalid argument errors.
    """
    global _dht_device, DHT_AVAILABLE

    if not DHT_AVAILABLE or _dht_device is None:
        return 0.0
    try:
        temperature = _dht_device.temperature
        if temperature is not None:
            return round(float(temperature), 2)
        print(f"[{DHT_TYPE}] temperature returned None — sensor may be disconnected")
        return 0.0
    except RuntimeError as e:
        # DHT sensors throw RuntimeError on read failures — expected, retry next cycle
        print(f"[{DHT_TYPE}] Read error (retry next cycle): {e}")
        return 0.0
    except Exception as e:
        print(f"[{DHT_TYPE}] Unexpected error: {e}")
        # [FIX] Errno 22 / Invalid argument — reinitialize the device object
        try:
            _dht_device.exit()
        except Exception:
            pass
        try:
            import board as _board_reinit
            import adafruit_dht as _adafruit_dht_reinit
            _pin_reinit = getattr(_board_reinit, f"D{DHT_PIN}")
            if DHT_TYPE == "DHT22":
                _dht_device = _adafruit_dht_reinit.DHT22(_pin_reinit, use_pulseio=False)
            else:
                _dht_device = _adafruit_dht_reinit.DHT11(_pin_reinit, use_pulseio=False)
            print(f"[{DHT_TYPE}] Device reinitialized on GPIO{DHT_PIN} — will retry next cycle")
        except Exception as reinit_err:
            print(f"[{DHT_TYPE}] Reinit failed: {reinit_err} — marking unavailable")
            DHT_AVAILABLE = False
        return 0.0



# =============================================================================
#  INA219 BATTERY READ FUNCTION (replaces PZEM-017)
#  Delegates to ina.py read_battery() — returns same dict shape as old PZEM017.
#  Compatible keys: voltage, current, charge_a, discharge_a, net_current,
#                   soc, available, b1_voltage, b1_current, b2_voltage,
#                   b2_current, capacity_ah, anomaly_details
# =============================================================================

def read_pzem017_battery() -> dict:
    """
    Read INA219 dual-module battery pack via ina.py.
    Returns dict compatible with all existing cache consumers.
    """
    _empty = {
        'voltage': 0.0, 'current': 0.0, 'net_current': 0.0, 'pack_power': 0.0,
        'soc': 0.0, 'charge_a': 0.0, 'discharge_a': 0.0,
        'available': False,
        'b1_voltage': 0.0, 'b1_current': 0.0, 'b1_available': False,
        'b2_voltage': 0.0, 'b2_current': 0.0, 'b2_available': False,
        'bank_b_available': False, 'bank_b_voltage': 0.0,
        'bank_b_current': 0.0, 'bank_b_soc': 0.0,
        'capacity_ah': 100, 'anomaly_details': [],
    }
    if not INA219_AVAILABLE or _read_ina219_battery is None:
        return _empty
    try:
        result = _read_ina219_battery()
        # Add keys expected by old PZEM017 consumers
        result.setdefault('pack_power', round(result.get('voltage', 0) * result.get('current', 0), 2))
        result.setdefault('bank_b_available', False)
        result.setdefault('bank_b_voltage',   0.0)
        result.setdefault('bank_b_current',   0.0)
        result.setdefault('bank_b_soc',       0.0)
        return result
    except Exception as e:
        print(f"[INA219] read_battery error: {e}")
        return _empty


# Alias for any remaining old references
def read_ina226_battery() -> dict:
    return read_pzem017_battery()


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
    if pack_voltage >= BAT_FULL:         return 100.0
    if pack_voltage <= BAT_CRITICAL_LOW: return 0.0
    return round(
        ((pack_voltage - BAT_CRITICAL_LOW) / (BAT_FULL - BAT_CRITICAL_LOW)) * 100, 1
    )


# =============================================================================
#  SSR3/K3 RECONNECT TIMER
# =============================================================================

def _update_k3_reconnect_timer(gv: float, gf: float) -> bool:
    global _k3_reconnect_state
    grid_safe = _grid_is_safe(gv, gf)

    if not grid_safe:
        if not _k3_reconnect_state['grid_fault_active']:
            print("[K3 Timer] Grid fault — SSR3/K3 BLOCKED, timer reset")
        _k3_reconnect_state['grid_fault_active'] = True
        _k3_reconnect_state['grid_recovered_at'] = None
        _k3_reconnect_state['reconnect_allowed'] = False
        _k3_reconnect_state['stable_seconds']    = 0
        _persist_k3_timer_to_db(reconnect_ok=False, stable_s=0)
        return False

    if _k3_reconnect_state['grid_fault_active']:
        _k3_reconnect_state['grid_fault_active'] = False
        _k3_reconnect_state['grid_recovered_at'] = time.time()
        _k3_reconnect_state['reconnect_allowed'] = False
        _k3_reconnect_state['stable_seconds']    = 0
        print("[K3 Timer] Grid recovered — 5-min reconnect timer started")
        _persist_k3_timer_to_db(reconnect_ok=False, stable_s=0)
        return False

    if _k3_reconnect_state['reconnect_allowed']:
        return True

    recovered_at = _k3_reconnect_state.get('grid_recovered_at')
    if recovered_at is None:
        _k3_reconnect_state['reconnect_allowed'] = True
        _k3_reconnect_state['stable_seconds']    = K3_RECONNECT_DELAY_S
        return True

    elapsed = int(time.time() - recovered_at)
    _k3_reconnect_state['stable_seconds'] = min(elapsed, K3_RECONNECT_DELAY_S)

    if elapsed >= K3_RECONNECT_DELAY_S:
        _k3_reconnect_state['reconnect_allowed'] = True
        print("[K3 Timer] 5-min elapsed — SSR3/K3 reconnection ALLOWED")
        _persist_k3_timer_to_db(reconnect_ok=True, stable_s=K3_RECONNECT_DELAY_S)
        return True

    if elapsed % 30 == 0:
        remaining = K3_RECONNECT_DELAY_S - elapsed
        print(f"[K3 Timer] Grid stable {elapsed}s / {K3_RECONNECT_DELAY_S}s — {remaining}s remaining")
    _persist_k3_timer_to_db(reconnect_ok=False, stable_s=elapsed)
    return False


def _persist_k3_timer_to_db(reconnect_ok: bool, stable_s: int):
    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("""
            UPDATE k3_reconnect
            SET grid_recovered = %s, reconnect_ok = %s, grid_stable_s = %s
            WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM k3_reconnect) t)
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S") if reconnect_ok else None,
            int(reconnect_ok), stable_s,
        ))
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        print(f"k3_reconnect DB update error: {e}")


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

        # [PZEM017] Use INA226 voltage if available, else INA219 fallback
        ina226_data = cache.get('ina226', {})
        if ina226_data.get('available') and ina226_data.get('voltage', 0) > 0:
            bat_v   = ina226_data['voltage']
            bat_soc = ina226_data['soc']
        else:
            bat_v   = sum(c.get('voltage', 0) for c in cache.get('battery', []) if 'error' not in c)
            bat_soc = calculate_pack_soc(bat_v)

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

        payload = {
            "to_email":        final_recipient,
            "email_type":      email_type,
            "faultType":       fault_type,
            "severity":        severity,
            "source":          source,
            "systemAction":    action,
            "systemCondition": cache.get('systemCondition', 'Unknown'),
            "gridVoltage":     f"{gv:.1f}V",
            "gridFrequency":   f"{gf:.2f}Hz",
            "inverterVoltage": f"{iv:.1f}V",
            "inverterFrequency": f"{inv_f:.2f}Hz",
            "solarPower":      f"{solar_w:.1f}W",
            "batteryVoltage":  f"{bat_v:.2f}V",
            "battery_soc":     f"{bat_soc:.1f}%",   # [FIX] matches email_service expected key
            "activeSource":    active_src,
            "buzzerStatus":    "ON" if buzzer_state.get('active') else "OFF",
            "k1":  ssr_data.get("ssr1_k1", "N/A"),   # [FIX] email_service expects k1/k2/k3/k4
            "k2":  ssr_data.get("ssr2_k2", "N/A"),
            "k3":  ssr_data.get("ssr3_k3", "N/A"),
            "k4":  ssr_data.get("ssr4_k4", "N/A"),
            "k3_reconnect_blocked": not _k3_reconnect_state.get('reconnect_allowed', True),
            "k3_stable_seconds":    _k3_reconnect_state.get('stable_seconds', 0),
            "timestamp":        datetime.now().isoformat(),
        }

        resp = requests.post("http://localhost:5001/api/send-alert", json=payload, timeout=5)
        if resp.status_code == 200:
            _email_cooldowns[fault_key] = now
            print(f"EMAIL SENT [{fault_key}] → {final_recipient}")
            _log_email(fault_key, fault_type, severity, source, final_recipient, 'sent')
            return True
        _log_email(fault_key, fault_type, severity, source, final_recipient, 'failed',
                   f'email_service returned HTTP {resp.status_code}')
        return False
    except Exception as e:
        print(f"Email service unreachable: {e}")
        _log_email(fault_key, fault_type, severity, source,
                   target_email or os.getenv('EMAIL_RECIPIENT', ''),
                   'failed', str(e)[:255])
        return False


def _buzzer_on() -> None:
    """Activate buzzer — RPi GPIO 14 (v4.3). Falls back to Arduino 'Z' if GPIO unavailable."""
    if GPIO_AVAILABLE and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH)
            return
        except Exception as e:
            print(f"[BUZZER] GPIO on error: {e}")
    # Fallback — Arduino still accepts 'Z' but ignores it (v4.3 ino)
    arduino_send('Z')


def _buzzer_off() -> None:
    """Deactivate buzzer — RPi GPIO 14 (v4.3)."""
    if GPIO_AVAILABLE and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.LOW)
            return
        except Exception as e:
            print(f"[BUZZER] GPIO off error: {e}")
    arduino_send('z')


def _fire_buzzer_once(fault_key: str, reason: str):
    if _buzzer_fired.get(fault_key) or buzzer_state['active']:
        return
    buzzer_state['active']       = True
    buzzer_state['duration_ms']  = BUZZER_DURATION_MS
    buzzer_state['triggered_at'] = datetime.now().isoformat()
    _buzzer_fired[fault_key]     = True
    _buzzer_on()

    def _auto_off():
        time.sleep(BUZZER_DURATION_MS / 1000)
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
        cur.execute("SELECT control_mode, ssr1_state, ssr2_state, ssr3_state, ssr4_state FROM ssr_state ORDER BY id DESC LIMIT 1")
        _prev = cur.fetchone()
        prev: Dict[str, Any] = cast(Dict[str, Any], _prev) if _prev else {}
        from_mode = prev.get("control_mode") if prev else None
        prev_ssr  = (bool(prev.get("ssr1_state", 0)), bool(prev.get("ssr2_state", 0)),
                     bool(prev.get("ssr3_state", 0)), bool(prev.get("ssr4_state", 1))) if prev else (False, False, False, True)

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
    print("[FAULT ACTION] Inverter critical — switching to Grid bypass (K2 ON)")
    with arduino_sequence_lock:
        arduino_send('q')
        time.sleep(0.15)
        arduino_send('2')
    _db_update_ssr_from_fault(False, True, False, True, 'grid')


def _fault_action_grid_critical():
    print("[FAULT ACTION] Grid critical — isolating K2+K3, solar island mode")
    with arduino_sequence_lock:
        arduino_send('e')
        time.sleep(0.1)
        arduino_send('w')
    _db_update_ssr_from_fault(True, False, False, True, 'solar')


def _fault_action_double_fault():
    # [FIX-RPI-LOAD] RPi powered from load — do NOT open contactor
    # Battery sustains load via inverter until grid returns or EcoSolax cuts at 21.6V
    print("[FAULT ACTION] Double fault — Battery sustaining load. Buzzer+email only.")
    _fire_buzzer_once('double_fault', 'Double Fault — Battery sustaining load')


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
) -> str:
    global _fault_first_detected

    if solar_check and not _is_daytime() and raw_level != 'none':
        _fault_counters[fault_key] = 0
        return _fault_state.get(fault_key, 'none')

    if safe_reset:
        prev = _fault_state.get(fault_key, 'none')
        _fault_state[fault_key]    = 'none'
        _fault_counters[fault_key] = 0
        _buzzer_fired[fault_key]   = False
        _fault_first_detected.pop(fault_key, None)

        if prev in ('warning', 'critical') and cursor:
            try:
                cursor.execute("""
                    UPDATE anomaly_logs
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

    if _fault_counters[fault_key] < FAULT_CONFIRM_COUNT:
        return _fault_state.get(fault_key, 'none')

    prev_state = _fault_state.get(fault_key, 'none')

    if raw_level == 'warning':
        _fault_state[fault_key] = 'warning'
        if prev_state != 'warning':
            if cursor:
                log_anomaly_to_db(cursor, fault_type, source, "Warning", action,
                    email_sent=False, buzzer_on=False,
                    bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                    system_temp=system_temp, status="Warning",
                    inverter_power=inverter_power,
                    panel_fault_detail=panel_fault_detail)
        return 'warning'

    _fault_state[fault_key] = 'critical'
    is_new = (prev_state != 'critical')

    detected_at = _fault_first_detected.get(fault_key, datetime.now())

    if is_new:
        if fault_key == 'inverter_voltage':
            _fault_action_inverter_critical()
        elif fault_key == 'grid_voltage':
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
                panel_fault_detail=panel_fault_detail)
    else:
        sent = _send_email_alert(fault_key, fault_type, "critical", action, source,
            target_email=target_email, email_type=email_type)
        if sent and cursor:
            log_anomaly_to_db(cursor, fault_type, source, "Critical", action,
                email_sent=True, buzzer_on=False,
                bat_soc=pack_soc, solar_w=solar_w, grid_v=grid_v,
                system_temp=system_temp,
                inverter_power=inverter_power,
                panel_fault_detail=panel_fault_detail)

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
    cursor, fault_type: str, source: str, severity: str, action: str,
    email_sent: bool, buzzer_on: bool,
    bat_soc: float, solar_w: float, grid_v: float,
    system_temp: float = 0.0,
    status: str = "Monitoring",
    detected_at: Optional[datetime] = None,
    action_at:   Optional[datetime] = None,
    inverter_power:     Optional[float] = None,
    panel_fault_detail: Optional[str]  = None,
):
    try:
        now_str      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        det_str      = detected_at.strftime("%Y-%m-%d %H:%M:%S") if detected_at else now_str
        act_str      = action_at.strftime("%Y-%m-%d %H:%M:%S")   if action_at   else now_str
        resp_ms: Optional[int] = None
        if detected_at and action_at:
            delta   = action_at - detected_at
            resp_ms = int(delta.total_seconds() * 1000)

        cursor.execute("""
            INSERT INTO anomaly_logs
                (timestamp, detected_at, action_at, response_time_ms, resolved_at,
                 type, source, severity, system_action,
                 system_temp, battery_soc, solar_power, grid_voltage,
                 inverter_power, panel_fault_detail,
                 email_status, buzzer_status, status)
            VALUES (%s,%s,%s,%s,NULL, %s,%s,%s,%s, %s,%s,%s,%s, %s,%s, %s,%s,%s)
        """, (
            now_str, det_str, act_str, resp_ms,
            fault_type, source, severity, action,
            round(system_temp, 2),
            f"{bat_soc:.1f}%", f"{solar_w:.1f}W", f"{grid_v:.1f}V",
            round(inverter_power, 2) if inverter_power is not None else None,
            panel_fault_detail,
            "Sent"  if email_sent else "Queued",
            "ON"    if buzzer_on  else "OFF",
            status,
        ))
    except Exception as e:
        print(f"anomaly_logs insert failed: {e}")


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
            if grid_pzem:
                data = grid_pzem.read_all()
                # [FIX-RECONNECT] If serial error — try to reconnect once
                if 'error' in data:
                    print(f"[Grid PZEM] Error: {data['error']} — attempting reconnect")
                    try:
                        grid_pzem.close()
                    except Exception:
                        pass
                    try:
                        port = UART_CONFIG.get('grid_pzem', {}).get('port', '/dev/ttyGridPZEM')
                        grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')
                        if grid_pzem.serial_connection:
                            data = grid_pzem.read_all()
                            print(f"[Grid PZEM] Reconnected — {data}")
                        else:
                            from sensors.Grid import PZEM004TReader; grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')
                            data = {}
                    except Exception as _re:
                        print(f"[Grid PZEM] Reconnect failed: {_re}")
                        from sensors.Grid import PZEM004TReader; grid_pzem = PZEM004TReader(port='/dev/ttyGridPZEM')
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

                    if gv > 0 and (gv < GRID_CRITICAL_LOW or gv > GRID_CRITICAL_HIGH):
                        raw_lvl = 'critical'; safe_rst = False
                        fault_action = (
                            f"Grid {gv:.1f}V out of IEEE 1547 range ({GRID_CRITICAL_LOW}–{GRID_CRITICAL_HIGH}V). "
                            f"SSR2/K2+SSR3/K3 isolated. 5-min reconnect timer started."
                        )
                    elif gv > 0 and abs(gf - GRID_FREQ_NOMINAL) > GRID_FREQ_CRIT:
                        raw_lvl = 'critical'; safe_rst = False
                        fault_action = (
                            f"Grid frequency {gf:.2f}Hz deviates >{GRID_FREQ_CRIT}Hz. "
                            f"SSR2/K2+SSR3/K3 isolated (IEEE 1547 Table 2)."
                        )
                    elif gv > 0 and GRID_NORMAL_LOW <= gv <= GRID_NORMAL_HIGH:
                        raw_lvl = 'none'; safe_rst = True; fault_action = ""
                    elif gv > 0:
                        raw_lvl = 'warning'; safe_rst = False
                        fault_action = f"Grid voltage {gv:.1f}V approaching limit."
                    else:
                        # [FIX-SENSE] gv=0 — smart sensor-loss detection
                        # If inverter is running (iv>0), grid is truly lost → critical
                        # If battery is present (pack_voltage>0), same logic
                        # If both are also 0, likely total sensor failure → warning only
                        _inv_running = cache.get('inverter', {}).get('voltage', 0) > 0
                        _bat_present = pack_voltage > BAT_CRITICAL_LOW
                        if _inv_running or _bat_present:
                            raw_lvl = 'critical'; safe_rst = False
                            fault_action = (
                                f"Grid sensor reading 0V — grid power lost. "
                                f"{'Inverter running' if _inv_running else 'Battery present'} confirms grid loss. "
                                f"Auto-switching to solar/battery."
                            )
                        else:
                            # All sensors zero — likely total sensor failure, do not switch
                            raw_lvl = 'none'; safe_rst = False
                            fault_action = ""

                    confirmed = check_and_alert(
                        fault_key="grid_voltage", raw_level=raw_lvl,
                        fault_type="Grid Voltage / Frequency Anomaly",
                        action=fault_action, source="Grid AC Monitor (PZEM-004T)",
                        safe_reset=safe_rst, cursor=cursor,
                        pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp,
                    )
                    cache['gridAnomaly'] = confirmed
                    k3_reconnect_ok = _update_k3_reconnect_timer(gv, gf)
                    cache['k3ReconnectOk']   = k3_reconnect_ok
                    cache['k3StableSeconds'] = _k3_reconnect_state.get('stable_seconds', 0)

            # ── INVERTER PZEM ───────────────────────────────────────────────
            if inverter_pzem:
                data = inverter_pzem.read_all()
                # [FIX-RECONNECT] Auto-reconnect on serial error
                if 'error' in data:
                    print(f"[Inverter PZEM] Error: {data['error']} — attempting reconnect")
                    try:
                        inverter_pzem.close()
                    except Exception:
                        pass
                    try:
                        port = UART_CONFIG.get('inverter_pzem', {}).get('port', '/dev/ttyInverterPZEM')
                        inverter_pzem = InverterPZEMReader(port=port, slave_addr=0x01)
                        if inverter_pzem.serial_connection:
                            data = inverter_pzem.read_all()
                            print(f"[Inverter PZEM] Reconnected — {data}")
                        else:
                            inverter_pzem = None
                            data = {}
                    except Exception as _re:
                        print(f"[Inverter PZEM] Reconnect failed: {_re}")
                        inverter_pzem = None
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

                    # [GAP3-FIX] Inverter cold-start ramp guard
                    # Track 0→non-zero transitions and suppress fault during ramp-up
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
                    elif iv > 0 and (iv < INV_CRITICAL_LOW or iv > INV_CRITICAL_HIGH):
                        raw_lvl = 'critical'; safe_rst = False
                        fault_action = f"Inverter {iv:.1f}V out of range. SSR1/K1→OFF, SSR2/K2→ON (grid bypass)."
                    elif iv > 0 and INV_CRITICAL_LOW <= iv <= INV_CRITICAL_HIGH:
                        # Check drift: 1V < |ΔV| ≤ 7V → Warning
                        global _prev_inv_v
                        _inv_delta = abs(iv - _prev_inv_v) if _prev_inv_v > 0 else 0.0
                        _prev_inv_v = iv
                        if INV_DRIFT_WARN_MIN < _inv_delta <= INV_DRIFT_WARN_MAX:
                            raw_lvl = 'warning'; safe_rst = False
                            fault_action = (
                                f"Inverter drift detected: {iv:.1f}V (ΔV={_inv_delta:+.1f}V). "
                                f"Gradual voltage change — monitoring."
                            )
                        else:
                            raw_lvl = 'none'; safe_rst = True; fault_action = ""
                            _prev_inv_v = iv
                    else:
                        # [FIX-SENSE] iv=0 — smart sensor-loss detection
                        # If grid is reading okay (gv>0), inverter is truly off/dead → critical
                        # If battery is present, inverter should be running → critical
                        # If everything is 0, sensor failure → do not switch
                        _grid_ok  = gv >= GRID_NORMAL_LOW
                        _bat_present = pack_voltage > BAT_CRITICAL_LOW
                        if _grid_ok or _bat_present:
                            raw_lvl = 'critical'; safe_rst = False
                            fault_action = (
                                f"Inverter sensor reading 0V — inverter offline. "
                                f"{'Grid OK' if _grid_ok else 'Battery present'} confirms inverter loss. "
                                f"Switching to grid bypass."
                            )
                        else:
                            raw_lvl = 'none'; safe_rst = False
                            fault_action = ""

                    confirmed = check_and_alert(
                        fault_key="inverter_voltage", raw_level=raw_lvl,
                        fault_type="Inverter Voltage Anomaly",
                        action=fault_action, source="Inverter AC Monitor (PZEM-004T)",
                        safe_reset=safe_rst, cursor=cursor,
                        pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp,
                        inverter_power=inv_power,
                    )
                    cache['inverterAnomaly'] = confirmed

            # ── SOLAR — WCS1500 + Voltage Divider via Arduino A0-A4 ─────────
            # Arduino '?' response now includes:
            #   solar.v      — DC array voltage (voltage divider on A4)
            #   solar.i0–i3  — per-panel current (WCS1500 on A0–A3)
            #   solar.i_total — sum of all 4 panel currents
            #   solar.p_total — V × I_total
            arduino_status = arduino_get_status()
            if arduino_status and 'solar' in arduino_status:
                sol = arduino_status['solar']
                sv        = float(sol.get('v',       0))
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
                cache['solarCurrent']   = round(si_total, 3)
                cache['solarPower']     = round(sp_total, 1)
                cache['stringCurrents'] = string_currents

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
            # ALWAYS runs every cycle — even if PZEM unavailable, use cache.
            # If PZEM not connected, gv/iv stay 0.0 → sends g0/i0 (dropout).
            # Arduino uses these to drive K4 dropout protection and K1/K2 timers.
            _gv_signal = gv if gv > 0 else float(cache.get('grid', {}).get('voltage', 0))
            _iv_signal = iv if iv > 0 else float(cache.get('inverter', {}).get('voltage', 0))
            _grid_sig  = '1' if _gv_signal > 0 else '0'
            _inv_sig   = '1' if _iv_signal  > 0 else '0'
            if arduino and arduino.is_open:
                with arduino_sequence_lock:
                    arduino_send(f'g{_grid_sig}')
                    time.sleep(0.05)
                    arduino_send(f'i{_inv_sig}')
                    time.sleep(0.05)
                print(f"[ARDUINO] Voltage signals → grid={_grid_sig} ({_gv_signal:.1f}V)  inv={_inv_sig} ({_iv_signal:.1f}V)")

            # ── INA219 BATTERY READ ─────────────────────────────────────────
            if PZEM017_AVAILABLE:  # PZEM017_AVAILABLE = INA219_AVAILABLE alias
                ina226_data = read_pzem017_battery()  # → calls ina.py read_battery()
                cache['ina226'] = ina226_data

                if ina226_data['available'] and ina226_data['voltage'] > 0:
                    pack_voltage = ina226_data['voltage']
                    pack_current = ina226_data['net_current']   # + = charging, - = discharging
                    pack_soc     = ina226_data['soc']

                    log_data['battery_pack_voltage'] = pack_voltage
                    log_data['battery_pack_current'] = pack_current
                    log_data['battery_pack_power']   = round(pack_voltage * pack_current, 2)
                    log_data['battery_pack_soc']     = pack_soc
                    log_data['battery_charge_a']     = ina226_data['charge_a']
                    log_data['battery_discharge_a']  = ina226_data['discharge_a']

                    print(f"[INA219] Pack: {pack_voltage:.2f}V | SOC: {pack_soc:.1f}% | "
                          f"Net: {pack_current:+.2f}A "
                          f"(chg={ina226_data['charge_a']:.2f}A / "
                          f"dis={ina226_data['discharge_a']:.2f}A)")

                    # Use INA226 overcurrent check (net current absolute value)
                    bat_warn_a = _get_battery_current_warn()
                    if abs(pack_current) > bat_warn_a:
                        check_and_alert(
                            fault_key="battery_overcurrent", raw_level='warning',
                            fault_type="Battery Overcurrent Warning",
                            action=f"Battery net current {pack_current:+.1f}A > {bat_warn_a:.0f}A warn threshold.",
                            source="Battery Monitor (PZEM-017)", cursor=cursor,
                            pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                            system_temp=system_temp,
                        )
                    else:
                        check_and_alert(
                            fault_key="battery_overcurrent", raw_level='none',
                            fault_type="Battery Overcurrent", action="",
                            source="Battery Monitor (PZEM-017)", safe_reset=True,
                        )

                    # [EXPAND-200Ah] Per-bank anomaly alerts
                    for msg in ina226_data.get('anomaly_details', []):
                        lvl = 'critical' if any(w in msg for w in ['DEEP DISCHARGE', 'OVERCHARGE']) else 'warning'
                        check_and_alert(
                            fault_key=f"bat_detail_{abs(hash(msg)) % 9999}",
                            raw_level=lvl,
                            fault_type="Battery Bank Anomaly",
                            action=msg,
                            source="Battery Monitor (PZEM-017)", cursor=cursor,
                            pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                            system_temp=system_temp,
                        )

                    # [EXPAND-200Ah] Auto-update battery_capacity_ah in DB
                    detected_ah = ina226_data.get('capacity_ah', 100)
                    try:
                        cursor.execute(
                            "UPDATE system_config SET config_val=%s WHERE config_key='battery_capacity_ah'",
                            (str(detected_ah),)
                        )
                    except Exception as _cap_err:
                        print(f"[EXPAND] capacity_ah DB update error: {_cap_err}")

            elif battery_reader:
                # ── FALLBACK: INA219 (used until INA226 hardware arrives) ────
                cells          = battery_reader.read_all_sensors()
                cache['battery'] = cells
                pack_voltage   = sum(c.get('voltage', 0) for c in cells if 'error' not in c)
                valid_c        = [c.get('current', 0) for c in cells if 'error' not in c]
                pack_current   = sum(valid_c) / len(valid_c) if valid_c else 0
                pack_soc       = calculate_pack_soc(pack_voltage)

                log_data['battery_pack_voltage'] = pack_voltage
                log_data['battery_pack_current'] = pack_current
                log_data['battery_pack_power']   = pack_voltage * pack_current
                log_data['battery_pack_soc']     = pack_soc

                bat_warn_a = _get_battery_current_warn()
                if abs(pack_current) > bat_warn_a:
                    check_and_alert(
                        fault_key="battery_overcurrent", raw_level='warning',
                        fault_type="Battery Overcurrent Warning",
                        action=f"Battery current {pack_current:.1f}A > {bat_warn_a:.0f}A warn threshold.",
                        source="Battery Monitor (PZEM-017)", cursor=cursor,
                        pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp,
                    )
                else:
                    check_and_alert(
                        fault_key="battery_overcurrent", raw_level='none',
                        fault_type="Battery Overcurrent", action="",
                        source="Battery Monitor (PZEM-017)", safe_reset=True,
                    )

            # ── BATTERY VOLTAGE FAULT CHECKS (shared — works for both INA226 and INA219) ──
            if pack_voltage > 0:
                if pack_voltage < BAT_CRITICAL_LOW:
                    mccb_action = (
                        f"Battery {pack_voltage:.2f}V ({pack_soc:.1f}%) DEEP DISCHARGE. "
                        f"Inverter protection active. ⚠️ ADMIN: Trip MCCB if inverter fails."
                    )
                    check_and_alert(
                        fault_key="battery_low", raw_level='critical',
                        fault_type="Battery Deep Discharge — MCCB Alert",
                        action=mccb_action, source="Battery Monitor (PZEM-017)",
                        cursor=cursor, pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        email_type="battery_critical",
                        inverter_power=inv_power,
                    )
                elif pack_voltage > BAT_CRITICAL_HIGH:
                    mccb_action = (
                        f"Battery {pack_voltage:.2f}V OVERCHARGE. "
                        f"Inverter protection active. ⚠️ ADMIN: Trip MCCB if inverter fails."
                    )
                    check_and_alert(
                        fault_key="battery_overcharge", raw_level='critical',
                        fault_type="Battery Overcharge — MCCB Alert",
                        action=mccb_action, source="Battery Monitor (PZEM-017)",
                        cursor=cursor, pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        email_type="battery_critical",
                        inverter_power=inv_power,
                    )
                elif pack_voltage < BAT_WARNING_LOW:
                    check_and_alert(
                        fault_key="battery_low", raw_level='warning',
                        fault_type="Battery Low Warning",
                        action=f"Battery {pack_voltage:.2f}V. SSR3/K3 grid import activating.",   source="Battery Monitor (PZEM-017)", cursor=cursor,
                        pack_soc=pack_soc, solar_w=dc_power, grid_v=gv,
                        system_temp=system_temp,
                        inverter_power=inv_power,
                    )
                elif pack_voltage >= BAT_WARNING_LOW:
                    check_and_alert(
                        fault_key="battery_low", raw_level='none',
                        fault_type="Battery", action="",
                        source="Battery Monitor (PZEM-017)", safe_reset=True,
                    )
                    check_and_alert(
                        fault_key="battery_overcharge", raw_level='none',
                        fault_type="Battery Overcharge", action="",
                        source="Battery Monitor (PZEM-017)", safe_reset=True,
                    )

                cache['batteryAnomaly'] = _fault_state.get('battery_low', 'none')

            else:
                # [FIX-SENSE] pack_voltage=0 — battery sensor-loss detection
                # If grid or inverter is running, battery sensor is likely disconnected
                # → warning only, do NOT trigger safety actions
                # If all sensors zero, total sensor failure → no action
                _any_ac_running = gv > 0 or iv > 0
                if _any_ac_running:
                    check_and_alert(
                        fault_key="battery_sensor_loss", raw_level='warning',
                        fault_type="Battery Sensor Loss",
                        action=(
                            f"INA219 battery reading 0V — sensor may be disconnected. "
                            f"{'Grid' if gv > 0 else 'Inverter'} AC present. "
                            f"Check I2C connections (0x41/0x44)."
                        ),
                        source="Battery Monitor (INA219)",
                        cursor=cursor, pack_soc=0, solar_w=dc_power, grid_v=gv,
                    )
                cache['batteryAnomaly'] = _fault_state.get('battery_sensor_loss', 'none') if _any_ac_running else 'none'

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

                    grid_safe_for_k3 = (
                        gv > 0 and
                        _grid_is_safe(gv, gf) and
                        _k3_reconnect_state.get('reconnect_allowed', True)
                    )
                    k4_closed_now = bool(ssr_row.get('ssr4_state', 1))
                    has_power_source = (
                        bool(ssr_row.get('ssr1_state', 0)) or
                        bool(ssr_row.get('ssr2_state', 0))
                    )

                    battery_low    = pack_voltage > 0 and pack_voltage < BAT_WARNING_LOW
                    solar_crit     = _is_daytime() and dc_power > 0 and dc_power < SOLAR_CRITICAL_W
                    solar_zero     = _is_daytime() and dc_power == 0
                    night_not_full = not _is_daytime() and pack_voltage < BAT_FULL
                    charge_eligible = pack_voltage < BAT_FULL and dc_power > SOLAR_CHARGE_W

                    # [GAP1-FIX] K3 cloud-drop hysteresis
                    # When solar was charging (charge_eligible) and suddenly drops (cloud),
                    # keep K3 ON for K3_CLOUD_HYSTERESIS_S seconds before turning off.
                    # This prevents rapid K3 on/off cycling during partial cloud cover.
                    global _k3_charge_last_eligible
                    _now_k3 = time.time()
                    if charge_eligible:
                        _k3_charge_last_eligible = _now_k3
                    charge_hysteresis_active = (
                        not charge_eligible and
                        (_now_k3 - _k3_charge_last_eligible) < K3_CLOUD_HYSTERESIS_S and
                        _k3_charge_last_eligible > 0  # must have been eligible at least once
                    )

                    # [FIX-2] 80A combined current guard — EcoSolax SP-3200 max combined charge = 80A
                    INVERTER_MAX_CHARGE_A = 80.0
                    K3_CURRENT_HEADROOM_A = 20.0
                    current_charge_a = cache.get('batteryChargeA', 0.0)
                    k3_current_safe  = current_charge_a < (INVERTER_MAX_CHARGE_A - K3_CURRENT_HEADROOM_A)

                    want_k3   = False
                    k3_reason = "standby"

                    # [FIX-K3-BOOT] Strict K3 gate — ALL conditions must be safe
                    # K3 must NEVER fire if: no K4, no power source, shutdown mode,
                    # or grid unsafe. These are checked first before any want conditions.
                    bat_overcharge = pack_voltage >= BAT_CRITICAL_HIGH  # >= 27.6V
                    k3_hard_blocked = (
                        not k4_closed_now          or   # K4 must be closed
                        not has_power_source        or   # K1 or K2 must be ON
                        mode == 'shutdown'          or   # never in shutdown
                        not grid_safe_for_k3        or   # grid must be healthy
                        bat_overcharge                   # [FIX-K3-OVERCHARGE] never charge overcharged battery
                    )

                    if k3_hard_blocked:
                        want_k3   = False
                        k3_reason = (
                            "shutdown"         if mode == 'shutdown' else
                            "k4_open"          if not k4_closed_now else
                            "no_power_source"  if not has_power_source else
                            "grid_fault"
                        )
                    elif not k3_current_safe:
                        want_k3   = False
                        k3_reason = "current_limit"  # [FIX-2] >60A already — skip K3

                    # [FIX-K3-LOGIC] Corrected K3 assist conditions:
                    # K3 should NOT fire when battery is low but solar is sufficient —
                    # the inverter/solar will charge the battery on its own via K1.
                    # K3 grid assist is only needed when solar CANNOT cover the load.
                    elif battery_low and (solar_crit or solar_zero):
                        # Battery low AND solar is weak/zero — need grid assist
                        want_k3   = True
                        k3_reason = "assist_bat_low_solar_weak"
                    elif solar_crit or solar_zero:
                        # Solar weak/zero but battery still OK — K3 supplements solar
                        want_k3   = True
                        k3_reason = "assist_solar_weak"
                    elif night_not_full:
                        # Night, battery not full — K3 charges from grid overnight
                        want_k3   = True
                        k3_reason = "assist_night_charge"
                    elif charge_eligible:
                        # Solar surplus — K3 exports/charges direction
                        want_k3   = True
                        k3_reason = "charging"
                    elif charge_hysteresis_active:
                        # [GAP1-FIX] Solar just dropped — keep K3 ON during hysteresis window
                        want_k3   = True
                        k3_reason = f"charging_hysteresis({int(K3_CLOUD_HYSTERESIS_S - (_now_k3 - _k3_charge_last_eligible))}s)"

                    current_k3 = bool(ssr_row.get('ssr3_state', 0))
                    if want_k3 != current_k3:
                        with arduino_sequence_lock:
                            if want_k3 and k4_closed_now:
                                arduino_send('3')
                            else:
                                arduino_send('e')
                        try:
                            cursor.execute("""
                                UPDATE ssr_state SET ssr3_state=%s
                                WHERE id=(SELECT id FROM (SELECT MAX(id) AS id FROM ssr_state) t)
                            """, (int(want_k3),))
                            print(f"[SSR3/K3] {'ON' if want_k3 else 'OFF'} — reason: {k3_reason}")
                        except Exception as e:
                            print(f"SSR3/K3 DB update error: {e}")

                    cache['k3Active']    = want_k3
                    cache['k3Direction'] = k3_reason

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

            log_data['system_efficiency'] = round((_p_out / _p_in) * 100, 2) \
                if _p_in > 0 else None
            log_data['solar_efficiency']  = round((_p_solar / SOLAR_RATED_W) * 100, 2) \
                if _p_solar > 0 else None

            # [FIX-LOGS] Always ensure minimum fields present so a log row is
            # inserted every cycle — even when Arduino is unplugged (no solar data)
            # or Inverter PZEM is unavailable. Without this, log_data could be
            # empty or missing _sensor_keys, causing silent INSERT skip and blank
            # sensor log tables in the dashboard.
            log_data.setdefault('grid_voltage',      0.0)
            log_data.setdefault('grid_frequency',    0.0)
            log_data.setdefault('grid_current',      0.0)
            log_data.setdefault('grid_power',        0.0)
            log_data.setdefault('inverter_voltage',  0.0)
            log_data.setdefault('inverter_current',  0.0)
            log_data.setdefault('inverter_power',    0.0)
            log_data.setdefault('inverter_frequency',0.0)
            log_data.setdefault('solar_dc_voltage',  0.0)
            log_data.setdefault('solar_dc_current',  0.0)
            log_data.setdefault('solar_dc_power',    0.0)
            log_data.setdefault('battery_pack_voltage', 0.0)
            log_data.setdefault('battery_pack_current', 0.0)
            log_data.setdefault('battery_pack_soc',     0.0)
            log_data.setdefault('battery_pack_power',   0.0)
            log_data.setdefault('battery_charge_a',     0.0)
            log_data.setdefault('battery_discharge_a',  0.0)
            log_data.setdefault('system_temp',       system_temp)

            # Always insert — log_data now always has at least the defaults above
            columns      = ', '.join(log_data.keys())
            placeholders = ', '.join(['%s'] * len(log_data))
            cursor.execute(
                f"INSERT INTO sensor_logs ({columns}) VALUES ({placeholders})",
                tuple(log_data.values())
            )

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
            sleep_needed  = max(0.5, 5.0 - elapsed)
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
    return jsonify({"success": True})


@app.route("/auth/google")
def auth_google():
    redirect_uri = url_for('auth_google_callback', _external=True)
    if "ngrok-free.dev" in redirect_uri:
        redirect_uri = redirect_uri.replace("http://", "https://")
    return google.authorize_redirect(redirect_uri)


@app.route("/auth/google/callback")
def auth_google_callback():
    try:
        token     = google.authorize_access_token()
        user_info = token.get("userinfo") or google.userinfo()
        google_id = user_info.get("sub")
        email     = user_info.get("email")
        name      = user_info.get("name", email.split("@")[0] if email else "User")
        picture   = user_info.get("picture", "")
        if not email:
            return redirect(f"{FRONTEND_URL}/login?error=no_email")
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
        except Exception as e:
            print(f"Google OAuth DB error: {e}")
        session["user"] = {"email": email, "name": name, "picture": picture}
        try:
            trigger_email_alert(
                fault_type="Dashboard Access Detected",
                severity="info",
                action=f"User {email} logged in via Google OAuth.",
                source="Google OAuth Login",
                target_email=email,
                cooldown_key=f"login_{email}",
                email_type="login",
            )
        except Exception as email_err:
            print(f"Login email skipped: {email_err}")
        params = urlencode({"email": email, "name": name, "picture": picture})
        return redirect(f"{FRONTEND_URL}/auth/callback?{params}")
    except Exception as e:
        print(f"Google OAuth callback error: {e}")
        return redirect(f"{FRONTEND_URL}/login?error=oauth_failed")


@app.route("/auth/me")
def auth_me():
    user = session.get("user")
    if user:
        return jsonify({"success": True, "user": user})
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
        try:
            trigger_email_alert(
                fault_type="Dashboard Access Detected",
                severity="info",
                action=f"User {user.get('email')} logged in via email/password.",
                source="Web Dashboard Login",
                target_email=user.get('email'),
                cooldown_key=f"login_{user.get('email')}",
                email_type="login",
            )
        except Exception as email_err:
            print(f"Email alert skipped: {email_err}")
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
            "ina219_b1":       ina226_data.get('b1_available', False),
            "ina219_b2":       ina226_data.get('b2_available', False),
            "ina219_available": INA219_AVAILABLE,
        },
        "rtc_ds3231":  get_rtc_status(),
        "sensors": {
            "grid_pzem":     "connected" if grid_pzem     else "disconnected",
            "inverter_pzem": "connected" if inverter_pzem else "disconnected",
            "solar_panels":  len(cache['solar']),
            "battery_cells": len(cache['battery']),
            "arduino":       "connected" if arduino and arduino.is_open else "disconnected",
            "dht22":         "available" if DHT_AVAILABLE else "not installed",
            "ina219_library": "available" if INA219_AVAILABLE else "not installed (pip install adafruit-circuitpython-ina219)",
            "ina219_b1":     f"0x41 — {'responding' if ina226_data.get('b1_available') else 'not connected'} ({ina226_data.get('b1_voltage', 0):.2f}V)",
            "ina219_b2":     f"0x44 — {'responding' if ina226_data.get('b2_available') else 'not connected'} ({ina226_data.get('b2_voltage', 0):.2f}V)",
            "battery_mode":  "INA219 I2C" if INA219_AVAILABLE and ina226_data.get('available') else "no battery sensor",
        },
        "battery_ina219": {
            "voltage":     ina226_data.get('voltage',     0),
            "charge_a":    ina226_data.get('charge_a',    0),
            "discharge_a": ina226_data.get('discharge_a', 0),
            "net_current": ina226_data.get('net_current', 0),
            "soc":         ina226_data.get('soc',         0),
            "available":   ina226_data.get('available',   False),
            "b1_voltage":  ina226_data.get('b1_voltage',  0),
            "b2_voltage":  ina226_data.get('b2_voltage',  0),
        },
        "thermal": {
            "current_temp":    cache.get('system_temp', 0),
            "shutdown_active": _thermal_shutdown_active,
            "temp_warning_c":  TEMP_WARNING,
            "temp_critical_c": TEMP_CRITICAL,
            "temp_resume_c":   TEMP_RESUME,
        },
        "k3_reconnect": {
            "grid_fault_active": _k3_reconnect_state.get('grid_fault_active', False),
            "reconnect_allowed": _k3_reconnect_state.get('reconnect_allowed', True),
            "stable_seconds":    _k3_reconnect_state.get('stable_seconds', 0),
            "required_seconds":  K3_RECONNECT_DELAY_S,
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

        # [PZEM017] Use INA226 data if available, else INA219 fallback
        ina226_data = cache.get('ina226', {})
        if PZEM017_AVAILABLE and ina226_data.get('available') and ina226_data.get('voltage', 0) > 0:
            pack_voltage = ina226_data['voltage']
            pack_current = ina226_data['net_current']
            pack_soc     = ina226_data['soc']
            battery_source = "PZEM-017"
        else:
            pack_voltage = sum(c.get('voltage', 0) for c in cache['battery'] if 'error' not in c)
            valid_c      = [c.get('current', 0) for c in cache['battery'] if 'error' not in c]
            pack_current = sum(valid_c) / len(valid_c) if valid_c else 0
            pack_soc     = calculate_pack_soc(pack_voltage)
            battery_source = "PZEM-017"

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
                "voltage":      round(pack_voltage, 2),
                "current":      round(pack_current, 2),
                "soc":          pack_soc,
                "power":        round(pack_voltage * pack_current, 2),
                # [PZEM017] Extra fields for dashboard display
                "charge_a":     round(ina226_data.get('charge_a',    0), 2),
                "discharge_a":  round(ina226_data.get('discharge_a', 0), 2),
                "source":       battery_source,
                # [EXPAND-200Ah] Bank B — 0/False when not connected, live when PZEM#3+#4 online
                "bank_b_available": ina226_data.get('bank_b_available', False),
                "bank_b_voltage":   round(ina226_data.get('bank_b_voltage', 0), 2),
                "bank_b_current":   round(ina226_data.get('bank_b_current', 0), 2),
                "bank_b_soc":       ina226_data.get('bank_b_soc', 0),
                "capacity_ah":      ina226_data.get('capacity_ah', 100),
                "anomaly_details":  ina226_data.get('anomaly_details', []),
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
                "server_time":       get_timestamp(),
                "rtc_available":     RTC_AVAILABLE,
                "systemEfficiency":  round((cache.get('inverter', {}).get('power', 0) /
                                     max((cache.get('grid', {}).get('power', 0) or 0) +
                                         (cache.get('solarPower', 0) or 0), 0.001)) * 100, 2)
                                     if ((cache.get('grid', {}).get('power', 0) or 0) +
                                         (cache.get('solarPower', 0) or 0)) > 0 else None,
            },
            "k3": {
                "active":          cache.get('k3Active', False),
                "direction":       cache.get('k3Direction', 'standby'),
                "reconnectOk":     cache.get('k3ReconnectOk', True),
                "stableSeconds":   cache.get('k3StableSeconds', 0),
                "requiredSeconds": K3_RECONNECT_DELAY_S,
            },
            "manualLockout": {
                "active":    _manual_lockout_active(),
                "remaining": max(0, MANUAL_LOCKOUT_S - int(time.time() - _last_manual_ts)),
            },
            "timestamp": cache.get('last_update', datetime.now().isoformat()),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  SENSOR HISTORY
# =============================================================================

@app.route("/api/sensor-data/logs", methods=["GET"])
def get_sensor_logs():
    limit = request.args.get("limit", 100, type=int)
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT * FROM sensor_logs ORDER BY id DESC LIMIT %s", (limit,))
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        result = []
        for row in rows:
            r: Dict[str, Any] = cast(Dict[str, Any], row)
            for col in ['ssr1_state', 'ssr2_state', 'ssr3_state', 'ssr4_state']:
                r[col] = bool(r.get(col, 0))
            result.append(r)
        return jsonify({"logs": result})
    except Error as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
#  ANOMALY LOGS
# =============================================================================

@app.route("/api/anomaly-logs", methods=["GET"])
def get_anomaly_logs():
    limit = request.args.get("limit", 50, type=int)
    try:
        conn   = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, timestamp,
                   detected_at     AS detectedAt,
                   action_at       AS actionAt,
                   response_time_ms AS responseTimeMs,
                   resolved_at     AS resolvedAt,
                   type, source, severity,
                   system_action   AS systemAction,
                   system_temp     AS systemTemp,
                   battery_soc     AS battery,
                   solar_power     AS solarPower,
                   grid_voltage    AS gridVoltage,
                   inverter_power  AS inverterPower,
                   panel_fault_detail AS panelFaultDetail,
                   email_status    AS emailStatus,
                   buzzer_status   AS buzzer,
                   status
            FROM anomaly_logs ORDER BY id DESC LIMIT %s
        """, (limit,))
        rows = cursor.fetchall()
        cursor.close(); conn.close()
        return jsonify({"logs": rows})
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
            "k3ReconnectOk":    _k3_reconnect_state.get('reconnect_allowed', True),
            "k3StableSeconds":  _k3_reconnect_state.get('stable_seconds', 0),
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
    # _seq_shutdown() now correctly sends just 'x'
    with arduino_sequence_lock:
        _seq_shutdown()
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
    """
    with arduino_sequence_lock:
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
    status = arduino_get_status()
    if status:
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
#  K3 RECONNECT TIMER API
# =============================================================================

@app.route("/api/k3/reconnect-status", methods=["GET"])
def get_k3_reconnect_status():
    return jsonify({
        "reconnect_allowed":  _k3_reconnect_state.get('reconnect_allowed', True),
        "grid_fault_active":  _k3_reconnect_state.get('grid_fault_active', False),
        "stable_seconds":     _k3_reconnect_state.get('stable_seconds', 0),
        "required_seconds":   K3_RECONNECT_DELAY_S,
        "remaining_seconds":  max(0, K3_RECONNECT_DELAY_S - _k3_reconnect_state.get('stable_seconds', 300)),
    })


@app.route("/api/k3/reconnect-status", methods=["POST"])
def post_k3_reconnect_status():
    if not _k3_reconnect_state.get('reconnect_allowed', True):
        remaining = max(0, K3_RECONNECT_DELAY_S - _k3_reconnect_state.get('stable_seconds', 0))
    else:
        remaining = 0
    return jsonify({
        "success": True,
        "backend_locked":    not _k3_reconnect_state.get('reconnect_allowed', True),
        "remaining_seconds": remaining,
    })


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
        # INA219 battery debug info
        "ina219": {
            "library_available":  INA219_AVAILABLE,
            "hardware_responding": ina226_data.get('available', False),
            "voltage":     ina226_data.get('voltage',     0),
            "charge_a":    ina226_data.get('charge_a',    0),
            "discharge_a": ina226_data.get('discharge_a', 0),
            "net_current": ina226_data.get('net_current', 0),
            "soc":         ina226_data.get('soc',         0),
            "b1_addr":     "0x41",
            "b1_voltage":  ina226_data.get("b1_voltage", 0),
            "b2_addr":     "0x44",
            "b2_voltage":  ina226_data.get("b2_voltage", 0),
        },
        "cooldowns": {
            k: f"{int(EMAIL_COOLDOWN_DEFAULT_S - (now - t))}s remaining"
            for k, t in _email_cooldowns.items()
            if now - t < EMAIL_COOLDOWN_DEFAULT_S
        },
        "k3_reconnect":   dict(_k3_reconnect_state),
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


@app.route("/auth/callback")
def auth_callback():
    params = request.query_string.decode()
    return redirect(f"{FRONTEND_URL}/?{params}" if params else FRONTEND_URL)


# =============================================================================
#  STARTUP
# =============================================================================

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("  HELIOGRID — UNIFIED FLASK API SERVER  (v7.1 — INA219 Battery)")
    print("=" * 70)
    print(f"  Arduino Pin Map (v6.4):")
    print(f"    RPi GPIO14 → Buzzer")
    print(f"    Pin  7 → SSR1 = K1 → Solar/Inverter line")
    print(f"    Pin  6 → SSR2 = K2 → Grid line")
    print(f"    Pin  5 → SSR3 = K3 → Battery charging (always independent)")
    print(f"    Pin  4 → SSR4 = K4 → Main contactor (dropout protection)")
    print(f"\n  Battery Sensor: INA219 I2C")
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
    # Always start background_logger if Arduino is connected —
    # voltage signals (g0/g1/i0/i1) must run every cycle even without PZEM.
    if arduino_connected or SENSORS_AVAILABLE or PZEM017_AVAILABLE or DHT_AVAILABLE:
        threading.Thread(target=background_logger, daemon=True).start()
        print("Background sensor logger started")
        if not SENSORS_AVAILABLE:
            print("  ⚠ PZEM sensors unavailable — Arduino voltage signals still active (g0/i0 sent)")
    else:
        print("Background logger disabled (no hardware detected)")
    print("\nServer starting on http://0.0.0.0:5000\n")
    app.run(host="0.0.0.0", port=5001, debug=False, use_reloader=False)
