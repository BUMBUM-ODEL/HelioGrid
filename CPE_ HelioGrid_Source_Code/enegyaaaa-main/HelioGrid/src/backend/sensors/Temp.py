"""
Temp.py — DHT Temperature & Humidity Sensor Reader
Hybrid Smart Energy System — Raspberry Pi 4
Library:  adafruit-circuitpython-dht  (CircuitPython — matches flask_unified_complete.py)
          pip install adafruit-circuitpython-dht --break-system-packages
          ⚠️  Do NOT use legacy 'Adafruit_DHT' — incompatible API
Sensor:   DHT22 — change sensor_type to match physical sensor if using DHT11
GPIO:     BCM 27 (board.D27) — matches flask_unified_complete.py DHT_PIN = 27
"""
import board
import adafruit_dht
import subprocess
import sys


class DHTReader:
    """
    Reads temperature and humidity from a DHT11 or DHT22 sensor.
    API and behavior match flask_unified_complete.py read_dht22().

    Uses subprocess isolation to avoid GPIO kernel locks
    ([Errno 22] / 'unsigned short' corruption) that occur when
    adafruit_dht leaves a stale file descriptor after an error.
    """

    def __init__(self, pin: int = 27, sensor_type: str = "DHT22"):
        """
        Args:
            pin:         RPi GPIO BCM pin number. Default 27 (board.D27).
            sensor_type: "DHT11" or "DHT22". Must match physical sensor.
        """
        self.sensor_type = sensor_type.upper()
        self.pin         = pin
        self._device     = None
        self._init_device()

    def _init_device(self):
        """Initialize (or reinitialize) the DHT device object."""
        try:
            if self._device is not None:
                try:
                    self._device.exit()
                except Exception:
                    pass
            board_pin    = getattr(board, f"D{self.pin}")
            if self.sensor_type == "DHT22":
                self._device = adafruit_dht.DHT22(board_pin, use_pulseio=False)
            else:
                self._device = adafruit_dht.DHT11(board_pin, use_pulseio=False)
            print(f"✅ [{self.sensor_type}] Initialized on GPIO BCM {self.pin}")
        except Exception as e:
            print(f"[{self.sensor_type}] Init error: {e}")
            self._device = None

    def _read_via_subprocess(self) -> dict:
        """
        Read sensor in a fully isolated subprocess.
        This guarantees GPIO kernel file descriptors are released
        between reads — prevents [Errno 22] cascade after corruption.
        """
        script = f"""
import sys
try:
    import board, adafruit_dht
    d = adafruit_dht.{self.sensor_type}(board.D{self.pin}, use_pulseio=False)
    t = d.temperature
    h = d.humidity
    d.exit()
    if t is not None and h is not None:
        print(f"{{t}},{{h}},Online")
    else:
        print("0.0,0.0,Offline")
except RuntimeError as e:
    print(f"0.0,0.0,Read Error")
except Exception as e:
    print(f"0.0,0.0,Offline")
"""
        try:
            result = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True, text=True, timeout=6
            )
            out = result.stdout.strip()
            if out:
                parts = out.split(",")
                if len(parts) == 3:
                    return {
                        "temperature": round(float(parts[0]), 2),
                        "humidity":    round(float(parts[1]), 2),
                        "status":      parts[2],
                    }
        except Exception as e:
            print(f"[{self.sensor_type}] Subprocess error: {e}")

        return {"temperature": 0.0, "humidity": 0.0, "status": "Offline"}

    def read_data(self) -> dict:
        """
        Read temperature and humidity.
        Returns:
            temperature (float): °C
            humidity    (float): %
            status      (str):  "Online" | "Read Error" | "Offline"
        """
        # Primary: subprocess isolation (avoids GPIO lock entirely)
        result = self._read_via_subprocess()
        if result["status"] == "Online":
            return result

        # Fallback: in-process read (if subprocess can't spawn)
        if self._device is None:
            self._init_device()
        if self._device is None:
            return {"temperature": 0.0, "humidity": 0.0, "status": "Offline"}

        try:
            temperature = self._device.temperature
            humidity    = self._device.humidity
            if temperature is not None and humidity is not None:
                return {
                    "temperature": round(float(temperature), 2),
                    "humidity":    round(float(humidity), 2),
                    "status":      "Online",
                }
            return {"temperature": 0.0, "humidity": 0.0, "status": "Offline"}
        except RuntimeError as e:
            print(f"[{self.sensor_type}] Read error (retry next cycle): {e}")
            return {"temperature": 0.0, "humidity": 0.0, "status": "Read Error"}
        except Exception as e:
            print(f"[{self.sensor_type}] Unexpected error: {e} — reinitializing")
            self._init_device()
            return {"temperature": 0.0, "humidity": 0.0, "status": "Offline"}

    def read_temperature(self) -> float:
        """Return temperature only — matches flask read_dht22() behavior."""
        return self.read_data()["temperature"]

    def exit(self):
        """Release DHT sensor resources."""
        if self._device is not None:
            try:
                self._device.exit()
            except Exception:
                pass


# =============================================================================
# TEST SCRIPT
# =============================================================================
if __name__ == "__main__":
    import time
    print("🌡️  DHT Sensor Test")
    print("=" * 45)
    print("  Change sensor_type='DHT11' if using a DHT11")
    print("=" * 45)
    sensor = DHTReader(pin=27, sensor_type="DHT22")
    try:
        while True:
            data = sensor.read_data()
            status_icon = "✅" if data["status"] == "Online" else "⚠️ "
            print(f"{status_icon} Temp: {data['temperature']:.1f}°C  |  Humidity: {data['humidity']:.1f}%  |  {data['status']}")
            time.sleep(5)
    except KeyboardInterrupt:
        print("\n⏹️  Stopped by user")
    finally:
        sensor.exit()
        print("✅ Sensor released")