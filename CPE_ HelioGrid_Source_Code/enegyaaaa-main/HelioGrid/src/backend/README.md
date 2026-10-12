# 🔧 BACKEND FOLDER STRUCTURE
## Raspberry Pi 4 - Hybrid Smart Energy System

This folder contains all **backend code** for hardware integration, sensor data acquisition, processing, control, and automation.

---

## 📁 Folder Structure

```
backend/
├── README.md                           # Ito (overview)
├── requirements.txt                    # Python dependencies
├── config/                             # Configuration files
│   ├── settings.py                     # System settings (thresholds, pins, etc.)
│   ├── sensor_config.yaml              # Sensor I2C/UART addresses
│   └── email_config.json               # Email SMTP settings
├── sensors/                            # Sensor data acquisition
│   ├── __init__.py
│   ├── ina219_reader.py                # INA219 battery monitoring (I2C)
│   ├── pzem004t_reader.py              # PZEM-004T grid monitoring (UART)
│   ├── rtc_ds3231.py                   # RTC DS3231 timestamping (I2C)
│   └── sensor_manager.py               # Unified sensor interface
├── processing/                         # Data processing & computation
│   ├── __init__.py
│   ├── soc_calculator.py               # Battery SOC calculation
│   ├── pack_voltage.py                 # 72V pack voltage summation
│   ├── anomaly_detector.py             # IEC/IEEE threshold-based detection
│   └── power_calculator.py             # Power calculations (W, kW)
├── control/                            # Hardware control & automation
│   ├── __init__.py
│   ├── ssr_controller.py               # SSR1/SSR2/SSR3 GPIO control
│   ├── mode_switcher.py                # Auto-switching logic
│   ├── buzzer_controller.py            # Buzzer alarm control
│   ├── fan_controller.py               # Cooling fan control
│   └── failsafe.py                     # Fail-safe fallback logic
├── storage/                            # Data storage & logging
│   ├── __init__.py
│   ├── db_setup.py                     # SQLite database schema
│   ├── sensor_logger.py                # Log sensor readings
│   ├── anomaly_logger.py               # Log anomaly events
│   ├── csv_exporter.py                 # Export logs to CSV
│   └── data/                           # SQLite database files
│       └── energy_system.db            # Main database
├── notifications/                      # Alert & notification system
│   ├── __init__.py
│   ├── email_service.py                # Email alerts via SMTP
│   ├── buzzer_alerts.py                # Buzzer activation
│   └── alert_manager.py                # Unified alert dispatcher
├── api/                                # API for frontend integration
│   ├── __init__.py
│   ├── flask_server.py                 # Flask/FastAPI REST API
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── sensors.py                  # GET /api/sensors
│   │   ├── battery.py                  # GET /api/battery
│   │   ├── grid.py                     # GET /api/grid
│   │   ├── solar.py                    # GET /api/solar
│   │   ├── inverter.py                 # GET /api/inverter
│   │   ├── anomalies.py                # GET /api/anomalies
│   │   ├── control.py                  # POST /api/control (SSR switching)
│   │   └── logs.py                     # GET /api/logs (CSV export)
│   └── websocket_server.py             # WebSocket for real-time data
├── services/                           # Background services
│   ├── __init__.py
│   ├── data_acquisition_service.py     # Continuous sensor polling
│   ├── anomaly_monitoring_service.py   # Continuous anomaly detection
│   ├── auto_switch_service.py          # Automatic SSR switching
│   └── lcd_display_service.py          # 7" LCD SPI TFT updates
├── utils/                              # Utility functions
│   ├── __init__.py
│   ├── logger.py                       # Logging helper
│   ├── validators.py                   # Data validation
│   ├── converters.py                   # Unit conversions
│   └── helpers.py                      # General helpers
├── tests/                              # Unit tests
│   ├── __init__.py
│   ├── test_sensors.py
│   ├── test_processing.py
│   ├── test_control.py
│   └── test_api.py
└── main.py                             # Main entry point (start all services)
```

---

## 🚀 How Backend Works

### 1. **Startup Sequence** (`main.py`)
```python
# main.py
from services.data_acquisition_service import start_sensor_polling
from services.anomaly_monitoring_service import start_anomaly_detection
from services.auto_switch_service import start_auto_switching
from api.flask_server import start_api_server

if __name__ == "__main__":
    # Start background services
    start_sensor_polling()           # Every 2 seconds
    start_anomaly_detection()        # Every 3 seconds
    start_auto_switching()           # Continuous
    
    # Start API server for frontend
    start_api_server(port=5000)      # Flask/FastAPI
```

### 2. **Data Flow**
```
Sensors (INA219, PZEM-004T, DS3231)
    ↓
Sensor Readers (sensors/)
    ↓
Processing Engine (processing/)
    ↓
┌──────────────┬─────────────┬──────────────┐
│ Storage      │ Control     │ Notifications│
│ (storage/)   │ (control/)  │ (notify/)    │
└──────────────┴─────────────┴──────────────┘
    ↓              ↓              ↓
Database       SSR/Buzzer     Email/Buzzer
    ↓
API Server (api/)
    ↓
Frontend Dashboard (React)
```

---

## 📦 Dependencies (`requirements.txt`)

```
# Sensor Libraries
adafruit-circuitpython-ina219    # INA219 current/voltage sensor
pyserial                          # UART communication (PZEM-004T)
smbus2                            # I2C communication

# GPIO Control
RPi.GPIO                          # GPIO pins for SSR/buzzer/fan

# Database
sqlite3                           # Built-in Python (no install needed)

# API Framework
flask                             # REST API server
flask-cors                        # CORS support for React frontend
flask-socketio                    # WebSocket for real-time updates

# OR use FastAPI instead:
# fastapi
# uvicorn
# python-socketio

# Notifications
smtplib                           # Email alerts (built-in)

# Utilities
pyyaml                            # YAML config parsing
python-dotenv                     # Environment variables
schedule                          # Task scheduling
```

---

## 🔧 Configuration Files

### `config/settings.py`
```python
# System configuration
BATTERY_CONFIG = {
    "rated_capacity_ah": 3000,
    "nominal_voltage": 72,
    "num_cells": 6,
    "cell_nominal_voltage": 12
}

THRESHOLDS = {
    "grid": {
        "voltage_min": 200,
        "voltage_max": 240,
        "frequency_min": 59,
        "frequency_max": 61
    },
    "battery": {
        "voltage_critical": 63,
        "voltage_warning": 66,
        "voltage_full": 84
    },
    "temperature": {
        "warning": 45,
        "critical": 55
    }
}

GPIO_PINS = {
    "SSR1": 17,  # Grid → Battery
    "SSR2": 27,  # Grid → Outlets
    "SSR3": 22,  # Solar → Outlets
    "BUZZER": 23,
    "FAN": 24
}
```

### `config/sensor_config.yaml`
```yaml
sensors:
  ina219:
    - address: 0x40  # Battery 1
      bus: 1
    - address: 0x41  # Battery 2
      bus: 1
    - address: 0x44  # Battery 3
      bus: 1
    - address: 0x45  # Battery 4
      bus: 1
  
  pzem004t:
    port: /dev/ttyUSB0
    baudrate: 9600
  
  ds3231:
    address: 0x68
    bus: 1
```

---

## 🎯 Key Backend Modules

### **Sensor Acquisition** (`sensors/`)
- **ina219_reader.py** - Read voltage, current, power from 4 INA219 sensors
- **pzem004t_reader.py** - Read grid voltage, frequency, current, power
- **rtc_ds3231.py** - Get accurate timestamp
- **sensor_manager.py** - Unified interface to get all sensor data

### **Processing** (`processing/`)
- **soc_calculator.py** - Calculate SOC per battery and pack SOC
- **anomaly_detector.py** - Compare readings against IEC/IEEE thresholds
- **pack_voltage.py** - Sum all 6 battery voltages for 72V pack

### **Control** (`control/`)
- **ssr_controller.py** - Turn SSR1/SSR2/SSR3 ON/OFF via GPIO
- **mode_switcher.py** - Auto-switch between Solar/Grid/Assist/Shutdown modes
- **buzzer_controller.py** - Activate buzzer for critical alerts
- **failsafe.py** - Default to Grid (SSR2) on system fault

### **Storage** (`storage/`)
- **db_setup.py** - Create SQLite tables (sensor_logs, anomaly_logs)
- **sensor_logger.py** - Insert sensor readings every 5 seconds
- **anomaly_logger.py** - Insert anomaly events with details
- **csv_exporter.py** - Export logs to CSV for download

### **API** (`api/`)
- **flask_server.py** - Main REST API server
- **routes/sensors.py** - GET /api/sensors (all current readings)
- **routes/control.py** - POST /api/control (manual SSR switching)
- **websocket_server.py** - Real-time data push to frontend

### **Services** (`services/`)
- **data_acquisition_service.py** - Background thread polling sensors
- **anomaly_monitoring_service.py** - Continuous anomaly checking
- **auto_switch_service.py** - Automatic SSR mode changes
- **lcd_display_service.py** - Update 7" touchscreen every 1 second

---

## 🔗 Frontend ↔ Backend Integration

### Option 1: REST API (Simple)
```typescript
// Frontend (React)
useEffect(() => {
  const fetchData = async () => {
    const response = await fetch('http://localhost:5000/api/sensors');
    const data = await response.json();
    setGridVoltage(data.grid.voltage);
    setBatterySOC(data.battery.soc);
  };
  const interval = setInterval(fetchData, 3000);
  return () => clearInterval(interval);
}, []);
```

### Option 2: WebSocket (Real-Time)
```typescript
// Frontend (React)
useEffect(() => {
  const socket = io('http://localhost:5000');
  socket.on('sensor_update', (data) => {
    setGridVoltage(data.grid.voltage);
    setBatterySOC(data.battery.soc);
  });
  return () => socket.disconnect();
}, []);
```

---

## 📊 Database Schema (SQLite)

### `sensor_logs` table
```sql
CREATE TABLE sensor_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    grid_voltage REAL,
    grid_frequency REAL,
    grid_power REAL,
    solar_dc_voltage REAL,
    solar_ac_power REAL,
    battery_voltage REAL,
    battery_soc REAL,
    battery_current REAL,
    inverter_voltage REAL,
    inverter_frequency REAL,
    system_temp REAL
);
```

### `anomaly_logs` table
```sql
CREATE TABLE anomaly_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    system_action TEXT,
    battery_soc REAL,
    solar_power REAL,
    grid_voltage REAL,
    email_status TEXT,
    buzzer_status TEXT,
    status TEXT
);
```

---

## 🎓 Next Steps for Implementation

1. **Setup Raspberry Pi OS** - Install Python 3.9+
2. **Install Dependencies** - `pip install -r requirements.txt`
3. **Configure Sensors** - Edit `config/sensor_config.yaml`
4. **Test Sensors** - Run individual sensor readers
5. **Setup Database** - Run `python storage/db_setup.py`
6. **Start Services** - Run `python main.py`
7. **Test API** - `curl http://localhost:5000/api/sensors`
8. **Connect Frontend** - Update React API calls to Pi's IP

---

## ✅ Summary

| Backend Component | Responsibility |
|-------------------|----------------|
| **sensors/** | Read INA219, PZEM-004T, RTC DS3231 |
| **processing/** | Calculate SOC, detect anomalies |
| **control/** | Switch SSR1/SSR2/SSR3, activate buzzer/fan |
| **storage/** | Log to SQLite, export CSV |
| **api/** | Serve data to React frontend |
| **services/** | Background threads for automation |
| **notifications/** | Send email alerts |

---

**Ikaw na bahala sa implementation, organized na ang structure! 🚀**
