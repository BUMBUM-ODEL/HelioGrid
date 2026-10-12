"""
rpi_data_sender.py — RPi to Flask MySQL Data Sender
Hybrid Smart Energy System — Raspberry Pi 4

Sends real sensor data from the RPi hardware directly to the
local Flask API (port 5000) which stores it in MySQL.

This replaces the old Supabase-based test_data_sender.py.
Flask handles all DB writes — this script is for external
hardware nodes or testing without the full backend running.

Usage:
    python3 rpi_data_sender.py

Requirements:
    pip3 install requests --break-system-packages
"""

import requests
import time
import json
from datetime import datetime

# ── Configuration ─────────────────────────────────────────────────────────────
FLASK_API_URL  = "http://localhost:5000"           # Local Flask API
POLL_INTERVAL  = 5                                 # Seconds between reads
TIMEOUT        = 5                                 # Request timeout (s)

HEADERS = {"Content-Type": "application/json"}


def get_current_sensor_data() -> dict:
    """Fetch current sensor data from Flask API."""
    try:
        resp = requests.get(
            f"{FLASK_API_URL}/api/sensor-data/current",
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            return resp.json()
        print(f"[FETCH] HTTP {resp.status_code}: {resp.text[:100]}")
    except requests.exceptions.ConnectionError:
        print(f"[FETCH] Cannot connect to Flask at {FLASK_API_URL} — is it running?")
    except Exception as e:
        print(f"[FETCH] Error: {e}")
    return {}


def get_system_health() -> dict:
    """Fetch system health / sensor status from Flask API."""
    try:
        resp = requests.get(
            f"{FLASK_API_URL}/api/system/health",
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        print(f"[HEALTH] Error: {e}")
    return {}


def print_status(data: dict, health: dict):
    """Print a formatted status line."""
    ts      = datetime.now().strftime("%H:%M:%S")
    grid    = data.get("grid",    {})
    solar   = data.get("solar",   {})
    battery = data.get("battery", {})
    inv     = data.get("inverter",{})
    system  = data.get("system",  {})

    print(
        f"[{ts}] "
        f"Grid:{grid.get('voltage',0):.1f}V/{grid.get('frequency',0):.1f}Hz  "
        f"Solar:{solar.get('power',0):.1f}W/{solar.get('voltage',0):.1f}V  "
        f"Bat:{battery.get('voltage',0):.2f}V({battery.get('soc',0):.1f}%)  "
        f"Inv:{inv.get('voltage',0):.1f}V  "
        f"Temp:{system.get('temperature',0):.1f}°C  "
        f"Src:{system.get('currentSource','?')}"
    )

    # Show anomalies if any
    anomalies = []
    for key in ("gridAnomaly","solarAnomaly","batteryAnomaly","inverterAnomaly"):
        val = data.get(key)
        if val and val != "none":
            anomalies.append(f"{key.replace('Anomaly','')}={val}")
    if anomalies:
        print(f"         ⚠️  Anomalies: {', '.join(anomalies)}")

    # Show sensor connectivity
    sensors = health.get("sensors", {})
    if sensors:
        connected = [k for k, v in sensors.items() if v in ("connected", "available")]
        disconnected = [k for k, v in sensors.items() if "disconnected" in str(v) or "not" in str(v)]
        if disconnected:
            print(f"         ❌ Disconnected: {', '.join(disconnected)}")


def main():
    print("=" * 65)
    print("  HelioGrid — RPi Data Monitor (MySQL backend)")
    print(f"  Flask API : {FLASK_API_URL}")
    print(f"  Interval  : {POLL_INTERVAL}s")
    print("=" * 65)
    print("Press Ctrl+C to stop\n")

    iteration = 0
    try:
        while True:
            iteration += 1
            data   = get_current_sensor_data()
            health = get_system_health() if iteration % 6 == 1 else {}  # health every ~30s

            if data:
                print_status(data, health)
            else:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] No data from Flask API")

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        print(f"\n\nStopped after {iteration} iterations.")


if __name__ == "__main__":
    main()