"""
RTC.py — DS3231 Real-Time Clock Manager
HelioGrid Hybrid Smart Energy System

Silbi:
  1. I-sync ang RPi system clock mula sa DS3231 sa boot
  2. I-update ang DS3231 kung may NTP sync (internet available)
  3. Mag-provide ng accurate datetime kahit offline

Hardware:
  DS3231 @ I2C address 0x68
  Wiring: SDA → GPIO2 (Pin 3) | SCL → GPIO3 (Pin 5)
          VCC → 3.3V (Pin 1)  | GND → GND   (Pin 6)

Install:
  pip install adafruit-circuitpython-ds3231 adafruit-circuitpython-busdevice --break-system-packages
  # Enable I2C in /boot/config.txt: dtoverlay=i2c-rtc,ds3231
"""

from __future__ import annotations
import subprocess
from datetime import datetime, timezone
from typing import Optional
try:
    from zoneinfo import ZoneInfo          # Python 3.9+
    _PH = ZoneInfo('Asia/Manila')
except ImportError:
    try:
        from backports.zoneinfo import ZoneInfo   # pip install backports.zoneinfo
        _PH = ZoneInfo('Asia/Manila')
    except ImportError:
        _PH = None  # fallback — relies on OS timezone being set to Asia/Manila


def _now_manila() -> datetime:
    """Return current naive datetime in Asia/Manila time (for DS3231 / DB use)."""
    if _PH is not None:
        return datetime.now(tz=_PH).replace(tzinfo=None)
    return datetime.now()  # fallback: assumes OS timezone = Asia/Manila

RTC_AVAILABLE = False
_rtc_instance  = None

try:
    import board
    import busio
    import adafruit_ds3231
    RTC_AVAILABLE = True
except ImportError:
    board = None          # type: ignore[assignment]
    busio = None          # type: ignore[assignment]
    adafruit_ds3231 = None  # type: ignore[assignment]
    print("DS3231 library not found. Install: pip install adafruit-circuitpython-ds3231 --break-system-packages")


def _get_rtc():
    """Lazy init — create DS3231 instance once."""
    global _rtc_instance
    if _rtc_instance is not None:
        return _rtc_instance
    if not RTC_AVAILABLE:
        return None
    if board is None or busio is None or adafruit_ds3231 is None:
        return None
    try:
        i2c = busio.I2C(board.SCL, board.SDA)  # type: ignore[union-attr]
        _rtc_instance = adafruit_ds3231.DS3231(i2c)  # type: ignore[union-attr]
        print("✅ DS3231 RTC initialized @ I2C 0x68")
        return _rtc_instance
    except Exception as e:
        print(f"❌ DS3231 init error: {e}")
        return None





def read_rtc_time() -> Optional[datetime]:
    """
    Read current time from DS3231.
    Returns naive datetime (local time) or None if unavailable.
    """
    rtc = _get_rtc()
    if rtc is None:
        return None
    try:
        t = rtc.datetime  # struct_time
        return datetime(t.tm_year, t.tm_mon, t.tm_mday,
                        t.tm_hour, t.tm_min, t.tm_sec)
    except Exception as e:
        print(f"[RTC] Read error: {e}")
        return None


def write_rtc_time(dt: datetime) -> bool:
    """
    Write datetime to DS3231 (call this after NTP sync).
    Returns True on success.
    """
    rtc = _get_rtc()
    if rtc is None:
        return False
    try:
        import time
        rtc.datetime = time.struct_time((
            dt.year, dt.month, dt.day,
            dt.hour, dt.minute, dt.second,
            dt.weekday(), -1, -1
        ))
        print(f"[RTC] Written: {dt.strftime('%Y-%m-%d %H:%M:%S')}")
        return True
    except Exception as e:
        print(f"[RTC] Write error: {e}")
        return False


def sync_system_clock_from_rtc() -> bool:
    """
    Set RPi system clock from DS3231 (called at boot, before NTP).
    Requires sudo — works when Flask runs as root or with sudoers entry.
    Returns True on success.
    """
    dt = read_rtc_time()
    if dt is None:
        print("[RTC] Cannot sync system clock — DS3231 not available")
        return False

    # Validate — reject obviously wrong times (year < 2024)
    if dt.year < 2024:
        print(f"[RTC] Time looks invalid ({dt}) — skipping system clock sync")
        return False

    try:
        time_str = dt.strftime('%Y-%m-%d %H:%M:%S')
        # Set system clock to the RTC time (DS3231 stores Manila local time)
        result = subprocess.run(
            ['sudo', 'date', '-s', time_str],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            print(f"[RTC] System clock synced from DS3231: {time_str} (Asia/Manila)")
            # Also ensure system timezone is Asia/Manila — safe to call repeatedly
            subprocess.run(
                ['sudo', 'timedatectl', 'set-timezone', 'Asia/Manila'],
                capture_output=True, timeout=5
            )
            return True
        else:
            print(f"[RTC] date command failed: {result.stderr.strip()}")
            return False
    except Exception as e:
        print(f"[RTC] System clock sync error: {e}")
        return False


def sync_rtc_from_ntp() -> bool:
    """
    If internet/NTP is available, update DS3231 from system clock.
    Call this periodically (e.g., every 60s) in background_logger.
    Only writes if system time is valid (year >= 2024).
    Always writes Asia/Manila local time to DS3231 (no UTC).
    """
    now = _now_manila()
    if now.year < 2024:
        return False  # System clock not yet synced

    # Check if NTP is actually synced (timedatectl)
    try:
        result = subprocess.run(
            ['timedatectl', 'show', '--property=NTPSynchronized', '--value'],
            capture_output=True, text=True, timeout=3
        )
        ntp_synced = result.stdout.strip().lower() == 'yes'
    except Exception:
        ntp_synced = False

    if not ntp_synced:
        return False  # Don't write to RTC if NTP not confirmed

    success = write_rtc_time(now)
    if success:
        print(f"[RTC] DS3231 updated from NTP: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    return success


def get_timestamp() -> str:
    """
    Get current timestamp string for logging (Asia/Manila time).
    Falls back to DS3231 if system clock is invalid.
    """
    now = _now_manila()
    if now.year >= 2024:
        return now.strftime('%Y-%m-%d %H:%M:%S')

    # System clock bad — try RTC
    rtc_time = read_rtc_time()
    if rtc_time and rtc_time.year >= 2024:
        return rtc_time.strftime('%Y-%m-%d %H:%M:%S')

    return now.strftime('%Y-%m-%d %H:%M:%S')  # fallback


def get_rtc_status() -> dict:
    """Returns RTC status dict for /api/status endpoint."""
    rtc_time = read_rtc_time()
    return {
        'available':   RTC_AVAILABLE,
        'responding':  rtc_time is not None,
        'time':        rtc_time.strftime('%Y-%m-%d %H:%M:%S') if rtc_time else None,
        'address':     '0x68',
        'module':      'DS3231',
    }
