"""
Grid.py — PZEM-004T AC Power Meter Reader (Base Class)
Hybrid Smart Energy System — Raspberry Pi 4

Reads AC power parameters from a PZEM-004T via UART/Modbus RTU.
Monitors: voltage, current, power, energy, frequency, power_factor.

Port:       /dev/ttyGridPZEM   (Grid unit)
Baud:       9600
Protocol:   Modbus RTU — Read Input Registers (0x04)
slave_addr: 0x01  (default, can be changed via PZEM config tool)

Inherited by Inverter.py (InverterPZEMReader) for the inverter unit.
"""

import struct
import time
from typing import Dict

import serial


class PZEM004TReader:
    """
    Reads AC power parameters from PZEM-004T via UART Modbus RTU.
    Both the Grid and Inverter PZEM units use this class (slave_addr=0x01 each,
    isolated by separate serial ports /dev/ttyGridPZEM and /dev/ttyInverterPZEM).
    """

    CMD_RIR = 0x04  # Modbus Read Input Registers

    def __init__(
        self,
        port: str = "/dev/ttyGridPZEM",
        baudrate: int = 9600,
        timeout: float = 1.0,
        slave_addr: int = 0x01,
    ):
        self.port        = port
        self.slave_addr  = slave_addr
        self.serial_connection = None

        try:
            self.serial_connection = serial.Serial(
                port=port,
                baudrate=baudrate,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                bytesize=serial.EIGHTBITS,
                timeout=timeout,
            )
            print(f"✅ [PZEM-004T] Connected to {port} @ {baudrate} baud (Addr: {hex(slave_addr)})")
        except Exception as e:
            print(f"❌ [PZEM-004T] Failed to open {port}: {e}")

    def _crc16(self, data: bytes) -> bytes:
        """Compute Modbus CRC-16 (little-endian)."""
        crc = 0xFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ 0xA001
                else:
                    crc >>= 1
        return struct.pack('<H', crc)

    # Keep legacy name for backward compatibility
    def check_crc(self, data) -> bytes:
        return self._crc16(bytes(data))

    def read_all(self) -> Dict:
        """
        Read all 10 PZEM-004T registers.

        Returns dict with keys:
            voltage      (V)
            current      (A)
            power        (W)
            energy       (Wh)
            frequency    (Hz)
            power_factor (0.00–1.00)
            alarm        (0 or 1)

        On error returns {"error": "<message>"}.
        """
        if not self.serial_connection:
            return {"error": "No serial connection"}

        # Read 10 input registers starting at address 0x0000
        cmd = bytearray([self.slave_addr, self.CMD_RIR, 0x00, 0x00, 0x00, 0x0A])
        cmd += self._crc16(bytes(cmd))

        try:
            self.serial_connection.reset_input_buffer()
            self.serial_connection.write(cmd)
            time.sleep(0.15)
            response = self.serial_connection.read(25)

            if len(response) < 25:
                return {"error": f"Incomplete response: got {len(response)}, expected 25"}

            # Validate CRC
            expected_crc = self._crc16(response[:23])
            if response[23:25] != expected_crc:
                return {"error": "CRC mismatch"}

            data = struct.unpack('>HHHHHHHHHH', response[3:23])

            return {
                "voltage":      round(data[0] * 0.1, 2),
                "current":      round((data[1] + (data[2] << 16)) * 0.001, 3),
                "power":        round((data[3] + (data[4] << 16)) * 0.1, 2),
                "energy":       round((data[5] + (data[6] << 16)) * 1.0, 2),
                "frequency":    round(data[7] * 0.1, 2),
                "power_factor": round(data[8] * 0.01, 2),
                "alarm":        data[9],
            }
        except Exception as e:
            return {"error": str(e)}

    def close(self):
        """Close the serial connection."""
        if self.serial_connection and self.serial_connection.is_open:
            self.serial_connection.close()
            print(f"✅ [PZEM-004T] {self.port} connection closed")


# =============================================================================
# TEST SCRIPT
# =============================================================================
if __name__ == "__main__":
    print("🔌 PZEM-004T Grid Power Meter Test")
    print("=" * 50)

    reader = PZEM004TReader(port='/dev/ttyGridPZEM', slave_addr=0x01)

    if reader.serial_connection:
        try:
            for i in range(5):
                print(f"\n📈 Reading #{i + 1}")
                data = reader.read_all()
                if "error" in data:
                    print(f"⚠️  {data['error']}")
                else:
                    print(f"⚡ Voltage: {data['voltage']}V  |  Power: {data['power']}W  |  Freq: {data['frequency']}Hz  |  PF: {data['power_factor']}")
                time.sleep(2)
        except KeyboardInterrupt:
            print("\n⏹️  Stopped by user")
        finally:
            reader.close()
    else:
        print("❌ Failed to connect to Grid PZEM-004T")
        print("   Check: ls /dev/ttyGridPZEM")
        print("   Verify udev rule: /etc/udev/rules.d/99-heliogrid.rules")