"""
Test Data Sender for Dashboard Demo
Sends realistic varying sensor data to Supabase for testing without hardware
"""

import requests
import time
import random
from datetime import datetime

# CONFIGURATION
SUPABASE_PROJECT_ID = "YOUR_PROJECT_ID"
SUPABASE_ANON_KEY = "YOUR_ANON_KEY"

SUPABASE_URL = f"https://{SUPABASE_PROJECT_ID}.supabase.co"
API_ENDPOINT = f"{SUPABASE_URL}/functions/v1/make-server-a935390a/api/sensors/update"
HEADERS = {
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json"
}

# Simulation state
class SimulationState:
    def __init__(self):
        self.grid_voltage = 220.0
        self.grid_frequency = 60.0
        self.solar_power = 3200  # Watts
        self.battery_voltage = 72.6
        self.battery_soc = 82.0
        self.inverter_voltage = 230.0
        self.inverter_frequency = 60.0
        self.temperature = 28.5
        self.scenario = 'normal'  # normal, grid_spike, solar_drop, low_battery, high_temp
        
    def update(self):
        """Update simulation values with realistic variations"""
        
        # Grid voltage variations
        if self.scenario == 'grid_spike':
            # Simulate voltage spike
            self.grid_voltage = min(250, self.grid_voltage + random.uniform(2, 5))
            if self.grid_voltage >= 245:
                self.scenario = 'normal'  # Recover
        elif self.scenario == 'normal':
            # Normal fluctuations (210-235V)
            self.grid_voltage += random.uniform(-3, 3)
            self.grid_voltage = max(210, min(235, self.grid_voltage))
            
            # Random chance of anomaly
            if random.random() < 0.05:  # 5% chance
                self.scenario = random.choice(['grid_spike', 'solar_drop', 'high_temp'])
        
        # Grid frequency (59-61Hz)
        self.grid_frequency += random.uniform(-0.1, 0.1)
        self.grid_frequency = max(59.5, min(60.5, self.grid_frequency))
        
        # Solar power variations
        if self.scenario == 'solar_drop':
            # Simulate solar drop (cloud cover)
            self.solar_power = max(800, self.solar_power - random.uniform(100, 300))
            if self.solar_power <= 1000:
                self.scenario = 'normal'  # Recover
        else:
            # Normal solar variations (2.8kW - 4.0kW)
            self.solar_power += random.uniform(-100, 150)
            self.solar_power = max(2800, min(4000, self.solar_power))
        
        # Battery variations
        if self.scenario == 'low_battery':
            # Simulate battery discharge
            self.battery_voltage = max(64, self.battery_voltage - 0.1)
            self.battery_soc = max(20, self.battery_soc - 0.5)
            if self.battery_voltage <= 65:
                self.scenario = 'normal'  # Start charging
        else:
            # Normal battery state (charging/discharging)
            if self.battery_voltage < 72:
                # Charging
                self.battery_voltage += random.uniform(0.05, 0.15)
                self.battery_soc += random.uniform(0.1, 0.3)
            else:
                # Slight discharge
                self.battery_voltage += random.uniform(-0.05, 0.05)
                self.battery_soc += random.uniform(-0.1, 0.1)
        
        self.battery_voltage = max(64, min(78, self.battery_voltage))
        self.battery_soc = max(20, min(100, self.battery_soc))
        
        # Inverter variations
        self.inverter_voltage += random.uniform(-1, 1)
        self.inverter_voltage = max(220, min(235, self.inverter_voltage))
        
        self.inverter_frequency += random.uniform(-0.05, 0.05)
        self.inverter_frequency = max(59.8, min(60.2, self.inverter_frequency))
        
        # Temperature variations
        if self.scenario == 'high_temp':
            # Simulate temperature rise
            self.temperature = min(75, self.temperature + random.uniform(1, 3))
            if self.temperature >= 65:
                self.scenario = 'normal'  # Cooling activated
        else:
            # Normal temperature variations
            base_temp = 28
            load_temp = (self.solar_power / 1000) * 2  # Temperature from load
            target_temp = base_temp + load_temp
            
            # Gradual change toward target
            self.temperature += (target_temp - self.temperature) * 0.1
            self.temperature += random.uniform(-0.5, 0.5)
            self.temperature = max(25, min(45, self.temperature))
        
        return self.get_sensor_data()
    
    def get_sensor_data(self):
        """Format current state as sensor data"""
        # Determine anomalies
        grid_anomaly = 'none'
        if self.grid_voltage < 200 or self.grid_voltage > 245:
            grid_anomaly = 'critical'
        elif self.grid_voltage < 210 or self.grid_voltage > 240:
            grid_anomaly = 'warning'
        
        solar_percentage = (self.solar_power / 5000) * 100
        solar_anomaly = 'critical' if solar_percentage < 20 else ('warning' if solar_percentage < 60 else 'none')
        
        battery_anomaly = 'none'
        if self.battery_voltage < 63:
            battery_anomaly = 'critical'
        elif self.battery_voltage < 66:
            battery_anomaly = 'warning'
        
        inverter_anomaly = 'none'
        if self.inverter_voltage < 198 or self.inverter_voltage > 242:
            inverter_anomaly = 'critical'
        elif self.inverter_voltage < 205 or self.inverter_voltage > 236:
            inverter_anomaly = 'warning'
        
        temp_anomaly = 'critical' if self.temperature >= 70 else ('warning' if self.temperature >= 45 else 'none')
        
        # Determine current source
        current_source = 'Inverter' if grid_anomaly == 'critical' and battery_anomaly == 'none' else 'Grid'
        
        # System condition
        if temp_anomaly == 'critical':
            system_condition = 'Shutdown'
        elif grid_anomaly == 'critical' or battery_anomaly == 'critical':
            system_condition = 'Critical'
        elif grid_anomaly == 'warning' or battery_anomaly == 'warning':
            system_condition = 'Warning'
        elif battery_voltage < 66:
            system_condition = 'Charging'
        else:
            system_condition = 'Optimal'
        
        return {
            "grid": {
                "voltage": round(self.grid_voltage, 1),
                "frequency": round(self.grid_frequency, 1),
                "status": "Critical" if grid_anomaly == 'critical' else "Warning" if grid_anomaly == 'warning' else "Stable",
                "anomaly": grid_anomaly
            },
            "solar": {
                "power": round(self.solar_power / 1000, 2),  # kW
                "voltage": 48.0,
                "current": round(self.solar_power / 48, 2),
                "efficiency": 87,
                "anomaly": solar_anomaly
            },
            "battery": {
                "soc": round(self.battery_soc, 2),
                "voltage": round(self.battery_voltage, 2),
                "current": round(random.uniform(-4, 3), 1),  # Negative = discharging
                "health": 95,
                "anomaly": battery_anomaly
            },
            "inverter": {
                "voltage": round(self.inverter_voltage, 1),
                "frequency": round(self.inverter_frequency, 1),
                "current": 3.5,
                "power": round(self.inverter_voltage * 3.5, 1),
                "anomaly": inverter_anomaly
            },
            "outlets": {
                "outlet1": {"status": True, "voltage": round(self.grid_voltage, 1), "current": 1.2},
                "outlet2": {"status": True, "voltage": round(self.grid_voltage, 1), "current": 0.8}
            },
            "system": {
                "temperature": round(self.temperature, 2),
                "tempAnomaly": temp_anomaly,
                "currentSource": current_source,
                "totalLoad": 2.0,
                "systemStatus": "Alert" if system_condition in ['Critical', 'Shutdown'] else "Normal",
                "systemCondition": system_condition
            }
        }

def send_data(sensor_data):
    """Send sensor data to Supabase"""
    try:
        response = requests.post(API_ENDPOINT, json=sensor_data, headers=HEADERS, timeout=10)
        if response.status_code == 200:
            return True, "Success"
        else:
            return False, f"HTTP {response.status_code}: {response.text}"
    except Exception as e:
        return False, str(e)

def main():
    print("=" * 70)
    print(" Test Data Sender - Dashboard Demo Mode")
    print("=" * 70)
    print(f" Supabase URL: {SUPABASE_URL}")
    print(" Status: Sending realistic varying sensor data...")
    print("=" * 70)
    print()
    
    if "YOUR_" in SUPABASE_PROJECT_ID or "YOUR_" in SUPABASE_ANON_KEY:
        print("⚠️  ERROR: Please update SUPABASE_PROJECT_ID and SUPABASE_ANON_KEY")
        print("    Edit this file and add your Supabase credentials")
        return
    
    sim = SimulationState()
    iteration = 0
    
    print("Press Ctrl+C to stop\n")
    
    try:
        while True:
            iteration += 1
            
            # Update simulation
            sensor_data = sim.update()
            
            # Send to backend
            success, message = send_data(sensor_data)
            
            # Display status
            timestamp = datetime.now().strftime("%H:%M:%S")
            status_icon = "✓" if success else "✗"
            
            print(f"[{timestamp}] {status_icon} Iteration {iteration:4d} | "
                  f"Grid: {sensor_data['grid']['voltage']:5.1f}V | "
                  f"Solar: {sensor_data['solar']['power']:4.2f}kW | "
                  f"Battery: {sensor_data['battery']['voltage']:5.2f}V ({sensor_data['battery']['soc']:5.2f}%) | "
                  f"Temp: {sensor_data['system']['temperature']:5.2f}°C | "
                  f"Scenario: {sim.scenario:12s}")
            
            if not success:
                print(f"    Error: {message}")
            
            # Check for anomalies
            anomalies = []
            if sensor_data['grid']['anomaly'] != 'none':
                anomalies.append(f"Grid {sensor_data['grid']['anomaly']}")
            if sensor_data['solar']['anomaly'] != 'none':
                anomalies.append(f"Solar {sensor_data['solar']['anomaly']}")
            if sensor_data['battery']['anomaly'] != 'none':
                anomalies.append(f"Battery {sensor_data['battery']['anomaly']}")
            if sensor_data['system']['tempAnomaly'] != 'none':
                anomalies.append(f"Temp {sensor_data['system']['tempAnomaly']}")
            
            if anomalies:
                print(f"    ⚠️  Anomalies: {', '.join(anomalies)}")
            
            time.sleep(3)  # Update every 3 seconds
            
    except KeyboardInterrupt:
        print("\n\n" + "=" * 70)
        print(f" Stopped after {iteration} iterations")
        print("=" * 70)

if __name__ == "__main__":
    main()
