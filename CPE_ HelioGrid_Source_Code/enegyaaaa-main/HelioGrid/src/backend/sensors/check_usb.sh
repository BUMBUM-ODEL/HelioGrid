#!/usr/bin/env python3
"""
identify_usb_ports.py — HelioGrid USB Port Identifier
======================================================
Run this to find the physical USB port path for each PZEM device.
Unplug all devices, then plug them in one at a time and note the port.

Usage:
    python3 identify_usb_ports.py

Output example:
    /dev/ttyUSB0  vendor=1a86 product=7523  path=1-1.2  (CH340 USB-TTL)
    /dev/ttyUSB1  vendor=1a86 product=7523  path=1-1.3  (CH340 USB-TTL)

Then update /etc/udev/rules.d/99-heliogrid.rules:
    Grid PZEM     → KERNELS=="*-1.2"
    Inverter PZEM → KERNELS=="*-1.3"
"""
import subprocess, os, re

def get_usb_info():
    result = subprocess.run(['ls', '/dev/'], capture_output=True, text=True)
    ttys = sorted([t for t in result.stdout.split() if t.startswith('ttyUSB')])
    if not ttys:
        print("No ttyUSB devices found. Check USB cables and power.")
        return

    print("=" * 65)
    print("HelioGrid USB Port Identifier")
    print("=" * 65)
    for tty in ttys:
        dev = f"/dev/{tty}"
        try:
            info = subprocess.run(
                ['udevadm', 'info', '--query=property', f'--name={dev}'],
                capture_output=True, text=True
            ).stdout
            vendor  = re.search(r'ID_VENDOR_ID=(.+)', info)
            product = re.search(r'ID_MODEL_ID=(.+)', info)
            path    = re.search(r'ID_PATH=(.+)', info)
            busnum  = re.search(r'BUSNUM=(.+)', info)
            devnum  = re.search(r'DEVNUM=(.+)', info)
            kernels = re.search(r'DEVPATH=.*/([^/]+)/tty', info)

            v = vendor.group(1).strip()  if vendor  else '????'
            p = product.group(1).strip() if product else '????'
            k = kernels.group(1).strip() if kernels else '?'
            u = path.group(1).strip()    if path    else '?'

            chip = 'CH340' if v == '1a86' and p == '7523' else \
                   'CP2102' if v == '10c4' and p == 'ea60' else \
                   'FTDI'   if v == '0403' and p == '6001' else f'{v}:{p}'

            print(f"{dev}  vendor={v}  product={p}  kernels_match="{k}"  ({chip})")
            print(f"         ID_PATH={u}")
            print()
        except Exception as e:
            print(f"{dev}  ERROR: {e}")

    print("=" * 65)
    print("Update /etc/udev/rules.d/99-heliogrid.rules:")
    print("  Grid PZEM     → KERNELS=="*-X.X"  (whichever port grid is on)")
    print("  Inverter PZEM → KERNELS=="*-X.X"  (whichever port inverter is on)")
    print("  Battery PZEM  → KERNELS=="*-X.X"")
    print()
    print("Then run:")
    print("  sudo udevadm control --reload-rules && sudo udevadm trigger")
    print("  ls -la /dev/ttyGridPZEM /dev/ttyInverterPZEM /dev/ttyBatteryPZEM")
    print("=" * 65)

if __name__ == '__main__':
    get_usb_info()
