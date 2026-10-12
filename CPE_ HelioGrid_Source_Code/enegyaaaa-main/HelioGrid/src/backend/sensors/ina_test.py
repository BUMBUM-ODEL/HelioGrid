#!/usr/bin/env python3
"""
ina_raw_reg.py — Direct I2C register read, no library abstraction
Reads INA219 registers raw to diagnose bus_voltage = 0 issue.
"""
import time
import board
import busio

i2c = busio.I2C(board.SCL, board.SDA)

# Wait for I2C lock
while not i2c.try_lock():
    pass

ADDR = 0x41

def read_reg(reg):
    buf = bytearray(2)
    i2c.writeto(ADDR, bytes([reg]))
    i2c.readfrom_into(ADDR, buf)
    return (buf[0] << 8) | buf[1]

print("INA219 @ 0x41 — Raw Register Dump")
print("=" * 45)

try:
    for _ in range(5):
        config   = read_reg(0x00)  # Config
        shunt    = read_reg(0x01)  # Shunt voltage
        bus      = read_reg(0x02)  # Bus voltage
        power    = read_reg(0x03)  # Power
        current  = read_reg(0x04)  # Current
        cal      = read_reg(0x05)  # Calibration

        # Bus voltage: bits[15:3], LSB = 4mV, bit[1] = CNVR, bit[0] = OVF
        bus_v = ((bus >> 3) * 4) / 1000.0

        # Shunt voltage: signed 16-bit, LSB = 10uV
        if shunt > 0x7FFF:
            shunt = shunt - 0x10000
        shunt_v = shunt * 10e-6

        print(f"  CONFIG=0x{config:04X}  CAL=0x{cal:04X}  "
              f"BUS_REG=0x{bus:04X}  bus_v={bus_v:.3f}V  "
              f"shunt_v={shunt_v:.4f}V")
        time.sleep(1)

except Exception as e:
    print(f"ERROR: {e}")
finally:
    i2c.unlock()
