"""
Inverter.py — PZEM-004T AC Power Meter Reader (Inverter)
Hybrid Smart Energy System — Raspberry Pi 4

Reads inverter AC output parameters.
Inherits all Modbus RTU read logic from Grid.PZEM004TReader.

Port:       /dev/ttyInverterPZEM
slave_addr: 0x01  — same address as Grid PZEM but isolated by separate serial port.
                    Do NOT change to 0x02 unless you physically reprogram the PZEM unit.
"""

from Grid import PZEM004TReader


class InverterPZEMReader(PZEM004TReader):
    """
    PZEM-004T reader for inverter AC output monitoring.
    Inherits read_all(), check_crc(), close() from PZEM004TReader.
    """

    def __init__(
        self,
        port: str = "/dev/ttyInverterPZEM",
        baudrate: int = 9600,
        timeout: float = 1.0,
        slave_addr: int = 0x01,  # 0x01 — isolated from Grid PZEM by separate serial port
    ):
        super().__init__(port=port, baudrate=baudrate, timeout=timeout, slave_addr=slave_addr)
        print(f"✅ [Inverter PZEM-004T] Initialized on {port} @ {baudrate} baud (Addr: {hex(slave_addr)})")


# =============================================================================
# TEST SCRIPT
# =============================================================================
if __name__ == "__main__":
    import time

    print("\n🔌 PZEM-004T Inverter Power Meter Test")
    print("=" * 50)

    reader = InverterPZEMReader(port='/dev/ttyInverterPZEM', slave_addr=0x01)

    if reader.serial_connection:
        print("✅ Connected to Inverter PZEM on /dev/ttyInverterPZEM")
        print("=" * 50)
        try:
            for i in range(5):
                print(f"\n📈 Inverter Reading #{i + 1}")
                data = reader.read_all()
                if "error" in data:
                    print(f"⚠️  Error: {data['error']}")
                else:
                    print(f"⚡ Voltage:      {data['voltage']} V")
                    print(f"⚡ Current:      {data['current']:.3f} A")
                    print(f"⚡ Power:        {data['power']} W")
                    print(f"⚡ Frequency:    {data['frequency']} Hz")
                    print(f"⚡ Power Factor: {data['power_factor']}")
                print("-" * 50)
                time.sleep(2)
        except KeyboardInterrupt:
            print("\n⏹️  Stopped by user")
        finally:
            reader.close()
            print("✅ Test completed")
    else:
        print("❌ Failed to connect to Inverter PZEM-004T")
        print("   Check: ls /dev/ttyInverterPZEM")
        print("   Verify slave_addr=0x01 matches physical PZEM (default)")