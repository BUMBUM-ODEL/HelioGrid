"""
buzzer_controller.py
====================
Standalone buzzer controller for HelioGrid.

Completely decoupled from anomaly logic — the anomaly engine and Flask
background logger call fire() here; this module only cares about GPIO/Arduino.

Features:
  • GPIO BCM 14 primary (RPi); Arduino 'Z'/'z' fallback
  • Thread-safe — uses threading.Lock so multiple anomaly threads won't
    double-fire or leave the buzzer stuck ON
  • Per-call dedup is handled by the CALLER (anomaly engine buzzer_fired flag)
    so this module can always fire unconditionally when asked
  • stop() is safe to call at any time (emergency cutoff, /api/stop-buzzer)
  • set_arduino_fn(fn) injects Flask's arduino_send after app init

Usage:
    import buzzer_controller as bc

    bc.set_arduino_fn(arduino_send)   # call once after Flask init

    bc.fire("Grid Dropout — critical")   # fires for BUZZER_DURATION_MS ms
    bc.stop()                            # immediate stop

    state = bc.get_state()
    # → {'active': bool, 'duration_ms': int, 'triggered_at': str | None}
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BUZZER_GPIO_PIN:  int   = 14      # BCM GPIO 14 (physical pin 8)
BUZZER_DURATION_MS: int = 10_000  # 10 s pulse
BUZZER_ON_LEVEL: int    = 1       # HIGH = ON
BUZZER_OFF_LEVEL: int   = 0       # LOW  = OFF

# ---------------------------------------------------------------------------
# Internal state
# ---------------------------------------------------------------------------

_lock = threading.Lock()

_state: dict = {
    'active':       False,
    'duration_ms':  0,
    'triggered_at': None,
}

_gpio_mod: Optional[object]   = None
_gpio_available: bool          = False
_arduino_fn: Optional[Callable[[str], None]] = None

# ---------------------------------------------------------------------------
# One-time hardware init
# ---------------------------------------------------------------------------

def _init_gpio() -> None:
    global _gpio_mod, _gpio_available
    if _gpio_available:
        return
    try:
        import RPi.GPIO as GPIO   # type: ignore
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        GPIO.setup(BUZZER_GPIO_PIN, GPIO.OUT, initial=GPIO.HIGH if BUZZER_OFF_LEVEL else GPIO.LOW)
        _gpio_mod       = GPIO
        _gpio_available = True
        print(f"[BUZZER] GPIO initialized on BCM {BUZZER_GPIO_PIN}")
    except Exception as e:
        print(f"[BUZZER] GPIO unavailable — Arduino fallback active ({e})")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def set_arduino_fn(fn: Callable[[str], None]) -> None:
    """Inject Flask's arduino_send so this module can use it as fallback."""
    global _arduino_fn
    _arduino_fn = fn


def fire(reason: str) -> None:
    """
    Activate buzzer for BUZZER_DURATION_MS ms.
    Non-blocking — auto-off runs in a daemon thread.
    Safe to call even if already active (won't stack).
    """
    _init_gpio()
    with _lock:
        if _state['active']:
            return   # already running — caller's dedup should prevent this anyway
        _state['active']       = True
        _state['duration_ms']  = BUZZER_DURATION_MS
        _state['triggered_at'] = datetime.now().isoformat()

    _hw_on()

    def _auto_off():
        time.sleep(BUZZER_DURATION_MS / 1000)
        _hw_off()
        with _lock:
            _state['active']      = False
            _state['duration_ms'] = 0

    threading.Thread(target=_auto_off, daemon=True, name='buzzer-off').start()

    # Log to DB if Flask db function is reachable (optional — no hard dependency)
    try:
        from flask_unified_complete import get_db   # late import to avoid circular
        conn = get_db()
        cur  = conn.cursor()
        cur.execute(
            "INSERT INTO buzzer_logs (duration_ms, reason) VALUES (%s, %s)",
            (BUZZER_DURATION_MS, reason[:255])
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception:
        pass   # DB logging is best-effort

    print(f"[BUZZER] FIRED — {reason[:80]} ({BUZZER_DURATION_MS}ms)")


def stop() -> None:
    """Immediately deactivate buzzer (emergency cutoff / /api/stop-buzzer)."""
    _hw_off()
    with _lock:
        _state['active']      = False
        _state['duration_ms'] = 0
    print("[BUZZER] STOPPED")


def get_state() -> dict:
    with _lock:
        return dict(_state)


def is_active() -> bool:
    return _state['active']


# ---------------------------------------------------------------------------
# Hardware helpers
# ---------------------------------------------------------------------------

def _hw_on() -> None:
    if _gpio_available and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH if BUZZER_ON_LEVEL else _gpio_mod.LOW)
            return
        except Exception as e:
            print(f"[BUZZER] GPIO HIGH error: {e}")
    if _arduino_fn:
        _arduino_fn('Z')


def _hw_off() -> None:
    if _gpio_available and _gpio_mod is not None:
        try:
            _gpio_mod.output(BUZZER_GPIO_PIN, _gpio_mod.HIGH if BUZZER_OFF_LEVEL else _gpio_mod.LOW)
            return
        except Exception as e:
            print(f"[BUZZER] GPIO LOW error: {e}")
    if _arduino_fn:
        _arduino_fn('z')
