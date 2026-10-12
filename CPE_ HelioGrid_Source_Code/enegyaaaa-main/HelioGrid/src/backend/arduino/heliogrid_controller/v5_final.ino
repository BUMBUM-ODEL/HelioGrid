// ============================================================================
// HelioGrid Arduino Controller — RELAY EXECUTOR v6.5
//
// SYNCED TO: UnifiedSSROutletCard v10 + KioskLCD v10
//
// ── ALWAYS MANUAL MODE ───────────────────────────────────────────────────────
//   System boots in manual mode — K4 ON, K1/K2 OFF.
//   Host (Flask) controls K1/K2 freely via '1'/'q' and '2'/'w'.
//   K3 is ALWAYS independent — never touched by dropout/emergency/recovery.
//   K4 is managed ONLY by dropout protection logic.
//
// ── VOLTAGE-BASED DETECTION ──────────────────────────────────────────────────
//   Flask sends g0/g1 based on GRID VOLTAGE (not watts/power)a
//   Flask sends i0/i1 based on INVERTER VOLTAGE (not watts/power)
//   0V → signal 0 (source absent)   >0V → signal 1 (source present)
//
// ── K4 (CONTACTOR) LOGIC ─────────────────────────────────────────────────────
//   K4 OFF : BOTH sources report 0V (g0 AND i0)
//            Only triggers if BOTH sources have previously confirmed voltage (g1+i1)
//            → prevents false dropout on boot before Flask sends first signals
//   K4 ON  : 15s after either source returns
//   K4 UNTOUCHED during partial dropout (one source only)
//
// ── K1 / K2 RECONNECT TIMERS ─────────────────────────────────────────────────
//   K1 ON  : 10s after inverter returns (i1), IF K4 is ON
//   K2 ON  : 10s after grid returns    (g1), IF K4 is ON
//   K1 OFF : immediate on i0 (inverter 0V)
//   K2 OFF : immediate on g0 (grid 0V)
//   K4/K3 : UNTOUCHED on K1 or K2 partial events
//
// ── FULL DROPOUT FLOW ────────────────────────────────────────────────────────
//   BOTH g0 AND i0 received → K4 OFF immediately, K1 OFF, K2 OFF. K3 untouched.
//     (requires BOTH sources to have ever sent voltage=1 first)
//   Either source returns → start 15s K4 timer → K4 ON at 15s
//   After K4 ON: K1 timer (10s) if inverter present, K2 timer (10s) if grid present
//   Other source returns later → its own 10s timer starts from that moment
//
// ── PARTIAL DROPOUT FLOW ─────────────────────────────────────────────────────
//   g0 only (grid 0V, inverter OK) → K2 OFF immediately. K4 ON. K1/K3 unchanged.
//   i0 only (inverter 0V, grid OK) → K1 OFF immediately. K4 ON. K2/K3 unchanged.
//   g1 (grid returns, K4 ON)       → K2 10s timer → K2 ON. K4/K1/K3 unchanged.
//   i1 (inverter returns, K4 ON)   → K1 10s timer → K1 ON. K4/K2/K3 unchanged.
//
// ── K3 ───────────────────────────────────────────────────────────────────────
//   ALWAYS independent. Never touched by dropout, emergency, or recovery logic.
//   Controlled only by '3' (ON) and 'e' (OFF) commands.
//
// ── EMERGENCY ('x') ──────────────────────────────────────────────────────────
//   K1 OFF, K2 OFF, K4 OFF. K3 UNTOUCHED. Saves K1/K2 state for recovery.
//
// ── RECOVERY ('r') ───────────────────────────────────────────────────────────
//   15s countdown → restore pre-emergency K1/K2, K4 ON. K3 untouched.
//
// ── NO AUTO MODE ─────────────────────────────────────────────────────────────
//   'm' command still accepted (for Flask compatibility) but system is always
//   effectively manual. No auto-switching. No 'a' command.
//
// COMMANDS:
//   '1'/'q' = K1 ON/OFF    '2'/'w' = K2 ON/OFF    '3'/'e' = K3 ON/OFF
//   'm' = Reset to manual   'x' = Emergency OFF     'r' = Recovery (15s)
//   'g'+'1'/'0' = grid voltage signal   'i'+'1'/'0' = inverter voltage signal
//   '?' = status JSON       'c' = calibration dump  'z' = auto-zero WCS
// ============================================================================

#include <EEPROM.h>

// ─── CALIBRATION ─────────────────────────────────────────────────────────────
// Zero points — bench calibrated, no load, 6-sample average
// These are overwritten by EEPROM on boot (after first 'z' command)
float wcsZero[4] = {2.5879f, 2.5286f, 2.5081f, 2.5258f};

void saveZeroEEPROM() {
  for (int i = 0; i < 4; i++)
    EEPROM.put(i * sizeof(float), wcsZero[i]);
}

void loadZeroEEPROM() {
  for (int i = 0; i < 4; i++)
    EEPROM.get(i * sizeof(float), wcsZero[i]);
}

// Solar specs — JA Solar JAM72D40-590/MB, 2S2P
// Imp = 13.28A per panel (per string)
// Isc = 13.94A per panel (max)
const float WCS_SENSITIVITY  = 0.011f;   // 11mV/A — unchanged
const float CURRENT_FILTER_A = 1.00f;    // lowered from 1.33A → catches low morning current
const float VOLTAGE_FILTER_V = 16.9f;    // unchanged
const float VDIV_RATIO       = 38.98f;   // field calibrated
const int   ADC_SAMPLES      = 500;      // unchanged

// ─── BATTERY VOLTAGE DIVIDER ─────────────────────────────────────────────────
// 2S 12V Lead Acid (JSL 100Ah), max ~29V
// R1 = 70kΩ (upper, at battery + terminal)
// R2 = 10kΩ (lower, to GND)
// Midpoint → A5
// HARDWARE TIP: solder 100µF electrolytic + 100nF ceramic cap
//               across R2 (A5 to GND) at the divider board itself
//               to suppress EMI from long wire run to battery terminals.
// Field calibrate: BATT_VDIV_RATIO = multimeter_reading ÷ A5_raw_value
const int   PIN_BATT_V       = A5;
const float BATT_VDIV_RATIO  = 10.2f;   // field calibrate after install
const float BATT_FILTER_V    = 18.0f;   // safety floor — below = disconnected/error
// Battery averaging — 5 reads × 20ms = 100ms total
// Reduces EMI noise from long wire run between battery and Arduino
// Increase BATT_AVG_DELAY_MS if noise persists (max ~50ms before Flask polling slows)
const int   BATT_AVG_COUNT   = 5;
const int   BATT_AVG_DELAY_MS = 20;

// ─── PINS ────────────────────────────────────────────────────────────────────
const int PIN_SSR1_K1  = 7;
const int PIN_SSR2_K2  = 6;
const int PIN_SSR3_K3  = 5;
const int PIN_SSR4_K4  = 4;
const int PIN_SOLAR_I0 = A0;
const int PIN_SOLAR_I1 = A1;
const int PIN_SOLAR_I2 = A2;
const int PIN_SOLAR_I3 = A3;
const int PIN_SOLAR_V  = A4;

const float ADC_VREF   = 5.0f;
const float ADC_COUNTS = 1024.0f;

// ─── TIMING ──────────────────────────────────────────────────────────────────
const unsigned long K1_RECONNECT_MS  = 10000UL;
const unsigned long K2_RECONNECT_MS  = 10000UL;
const unsigned long K4_RECONNECT_MS  = 15000UL;
const unsigned long RECOVERY_MS      = 15000UL;
const unsigned long DROPOUT_DEBOUNCE = 200UL;

// ─── RELAY STATE ─────────────────────────────────────────────────────────────
bool stSSR1 = false;
bool stSSR2 = false;
bool stSSR3 = false;
bool stSSR4 = true;

// ─── VOLTAGE FLAGS ───────────────────────────────────────────────────────────
bool gridVoltage     = false;
bool inverterVoltage = false;
bool gridEverOn      = false;
bool inverterEverOn  = false;

// ─── DROPOUT STATE ───────────────────────────────────────────────────────────
bool          dropoutActive  = false;
unsigned long lastDropoutMs  = 0;

// ─── K4 RECONNECT TIMER ──────────────────────────────────────────────────────
bool          k4TimerPending = false;
unsigned long k4TimerStartMs = 0;

// ─── K1 RECONNECT TIMER ──────────────────────────────────────────────────────
bool          k1TimerPending = false;
unsigned long k1TimerStartMs = 0;

// ─── K2 RECONNECT TIMER ──────────────────────────────────────────────────────
bool          k2TimerPending = false;
unsigned long k2TimerStartMs = 0;

// ─── EMERGENCY / RECOVERY ────────────────────────────────────────────────────
bool          emergencyActive  = false;
bool          recoveryPending  = false;
unsigned long recoveryStartMs  = 0;
bool          preEmergencyK1   = false;
bool          preEmergencyK2   = false;

// ─── COMMAND PARSER ──────────────────────────────────────────────────────────
char pendingCmd = 0;

// =============================================================================
// CORE RELAY WRITE
// =============================================================================
void writeRelays(bool ssr1, bool ssr2, bool ssr4) {
  stSSR1 = ssr1; stSSR2 = ssr2; stSSR4 = ssr4;
  digitalWrite(PIN_SSR1_K1, stSSR1 ? HIGH : LOW);
  digitalWrite(PIN_SSR2_K2, stSSR2 ? HIGH : LOW);
  digitalWrite(PIN_SSR4_K4, stSSR4 ? HIGH : LOW);
}

// =============================================================================
// PZEM VOLTAGE UPDATE
// =============================================================================
void applyVoltageState() {
  bool bothOut = (!gridVoltage && !inverterVoltage);

  if (bothOut) {
    unsigned long now = millis();
    if (!dropoutActive && (now - lastDropoutMs) >= DROPOUT_DEBOUNCE) {
      lastDropoutMs   = now;
      dropoutActive   = true;
      k1TimerPending  = false;
      k2TimerPending  = false;
      k4TimerPending  = false;
      recoveryPending = false;
      writeRelays(false, false, false);
      Serial.println(F("{\"event\":\"full_dropout\","
                       "\"ssr4_k4\":0,\"ssr1_k1\":0,\"ssr2_k2\":0,"
                       "\"k3\":\"unchanged\",\"fn\":\"dropout\"}"));
    }
    return;
  }

  if (dropoutActive) {
    dropoutActive  = false;
    if (!emergencyActive) {
      k4TimerPending  = true;
      k4TimerStartMs  = millis();
      Serial.print(F("{\"event\":\"dropout_cleared\","
                     "\"k4_timer_started\":1,\"k4_delay_s\":15,"
                     "\"inv_v\":"));
      Serial.print(inverterVoltage ? 1 : 0);
      Serial.print(F(",\"grid_v\":"));
      Serial.print(gridVoltage ? 1 : 0);
      Serial.println(F(",\"fn\":\"k4_timer_start\"}"));
    }
    return;
  }

  if (!gridVoltage && stSSR2) {
    k2TimerPending = false;
    writeRelays(stSSR1, false, stSSR4);
    Serial.println(F("{\"event\":\"partial_dropout_grid\","
                     "\"ssr2_k2\":0,\"k4_unchanged\":1,\"k1_unchanged\":1,"
                     "\"k3\":\"unchanged\",\"fn\":\"k2_off\"}"));
  }

  if (!inverterVoltage && stSSR1) {
    k1TimerPending = false;
    writeRelays(false, stSSR2, stSSR4);
    Serial.println(F("{\"event\":\"partial_dropout_inv\","
                     "\"ssr1_k1\":0,\"k4_unchanged\":1,\"k2_unchanged\":1,"
                     "\"k3\":\"unchanged\",\"fn\":\"k1_off\"}"));
  }

  if (inverterVoltage && !stSSR1 && stSSR4
      && !k1TimerPending && !emergencyActive && !recoveryPending) {
    k1TimerPending = true;
    k1TimerStartMs = millis();
    Serial.println(F("{\"event\":\"inv_voltage_returned\","
                     "\"k1_timer_started\":1,\"delay_s\":10,"
                     "\"fn\":\"k1_timer_start\"}"));
  }

  if (gridVoltage && !stSSR2 && stSSR4
      && !k2TimerPending && !emergencyActive && !recoveryPending) {
    k2TimerPending = true;
    k2TimerStartMs = millis();
    Serial.println(F("{\"event\":\"grid_voltage_returned\","
                     "\"k2_timer_started\":1,\"delay_s\":10,"
                     "\"fn\":\"k2_timer_start\"}"));
  }
}

// =============================================================================
// K4 RECONNECT TIMER
// =============================================================================
void handleK4Timer() {
  if (!k4TimerPending) return;
  if ((millis() - k4TimerStartMs) < K4_RECONNECT_MS) return;
  k4TimerPending = false;
  if (emergencyActive) {
    Serial.println(F("{\"event\":\"k4_timer_abort\","
                     "\"reason\":\"emergency_active\",\"fn\":\"k4_abort\"}"));
    return;
  }
  writeRelays(stSSR1, stSSR2, true);
  Serial.print(F("{\"event\":\"k4_on_after_delay\","
                 "\"ssr4_k4\":1,\"delay_s\":15,\"inv_v\":"));
  Serial.print(inverterVoltage ? 1 : 0);
  Serial.print(F(",\"grid_v\":"));
  Serial.print(gridVoltage ? 1 : 0);
  Serial.println(F(",\"fn\":\"k4_timer_done\"}"));
  if (inverterVoltage && !stSSR1 && !k1TimerPending) {
    k1TimerPending = true; k1TimerStartMs = millis();
    Serial.println(F("{\"event\":\"inv_voltage_returned\","
                     "\"k1_timer_started\":1,\"delay_s\":10,\"fn\":\"k1_timer_start\"}"));
  }
  if (gridVoltage && !stSSR2 && !k2TimerPending) {
    k2TimerPending = true; k2TimerStartMs = millis();
    Serial.println(F("{\"event\":\"grid_voltage_returned\","
                     "\"k2_timer_started\":1,\"delay_s\":10,\"fn\":\"k2_timer_start\"}"));
  }
}

// =============================================================================
// K1 RECONNECT TIMER
// =============================================================================
void handleK1Timer() {
  if (!k1TimerPending) return;
  if ((millis() - k1TimerStartMs) < K1_RECONNECT_MS) return;
  k1TimerPending = false;
  if (!inverterVoltage) {
    Serial.println(F("{\"event\":\"k1_timer_abort\","
                     "\"reason\":\"inverter_0v\",\"fn\":\"k1_abort\"}"));
    return;
  }
  if (!stSSR4) {
    Serial.println(F("{\"event\":\"k1_timer_abort\","
                     "\"reason\":\"k4_open\",\"fn\":\"k1_abort\"}"));
    return;
  }
  writeRelays(true, stSSR2, stSSR4);
  Serial.println(F("{\"event\":\"k1_on_after_delay\","
                   "\"ssr1_k1\":1,\"delay_s\":10,\"fn\":\"k1_timer_done\"}"));
}

// =============================================================================
// K2 RECONNECT TIMER
// =============================================================================
void handleK2Timer() {
  if (!k2TimerPending) return;
  if ((millis() - k2TimerStartMs) < K2_RECONNECT_MS) return;
  k2TimerPending = false;
  if (!gridVoltage) {
    Serial.println(F("{\"event\":\"k2_timer_abort\","
                     "\"reason\":\"grid_0v\",\"fn\":\"k2_abort\"}"));
    return;
  }
  if (!stSSR4) {
    Serial.println(F("{\"event\":\"k2_timer_abort\","
                     "\"reason\":\"k4_open\",\"fn\":\"k2_abort\"}"));
    return;
  }
  writeRelays(stSSR1, true, stSSR4);
  Serial.println(F("{\"event\":\"k2_on_after_delay\","
                   "\"ssr2_k2\":1,\"delay_s\":10,\"fn\":\"k2_timer_done\"}"));
}

// =============================================================================
// RECOVERY SEQUENCER
// =============================================================================
void handleRecoverySequencer() {
  if (!recoveryPending) return;
  if ((millis() - recoveryStartMs) < RECOVERY_MS) return;
  recoveryPending = false;
  emergencyActive = false;
  writeRelays(preEmergencyK1, preEmergencyK2, true);
  Serial.print(F("{\"event\":\"recovery_complete\","
                 "\"ssr4_k4\":1,\"ssr1_k1\":"));
  Serial.print(preEmergencyK1 ? 1 : 0);
  Serial.print(F(",\"ssr2_k2\":"));
  Serial.print(preEmergencyK2 ? 1 : 0);
  Serial.println(F(",\"k3\":\"unchanged\",\"fn\":\"recovery_done\"}"));
}

// =============================================================================
// MANUAL MODE
// =============================================================================
void setManualMode() {
  k1TimerPending  = false; k2TimerPending  = false;
  k4TimerPending  = false; dropoutActive   = false;
  emergencyActive = false; recoveryPending = false;
  writeRelays(false, false, true);
  // [FIX-MANUAL] Do NOT reset gridEverOn/inverterEverOn — managed only by handleVoltageSignal()
  // Resetting to true here caused false dropout after 'm' command if voltages were still 0
  Serial.println(F("{\"event\":\"manual_mode\","
                   "\"ssr1_k1\":0,\"ssr2_k2\":0,\"ssr4_k4\":1,"
                   "\"k3\":\"unchanged\",\"fn\":\"manual_mode\"}"));
}

// =============================================================================
// EMERGENCY OFF
// =============================================================================
void emergencyOff() {
  preEmergencyK1  = stSSR1; preEmergencyK2  = stSSR2;
  emergencyActive = true;   k1TimerPending  = false;
  k2TimerPending  = false;  k4TimerPending  = false;
  dropoutActive   = false;  recoveryPending = false;
  writeRelays(false, false, false);
  Serial.print(F("{\"event\":\"emergency_off\","
                 "\"ssr1_k1\":0,\"ssr2_k2\":0,\"ssr4_k4\":0,"
                 "\"k3\":\"unchanged\",\"saved_k1\":"));
  Serial.print(preEmergencyK1 ? 1 : 0);
  Serial.print(F(",\"saved_k2\":"));
  Serial.print(preEmergencyK2 ? 1 : 0);
  Serial.println(F(",\"fn\":\"emergency_off\"}"));
}

// =============================================================================
// RECOVERY START
// =============================================================================
void startRecovery() {
  if (!emergencyActive) {
    Serial.println(F("{\"warn\":\"NOT_IN_EMERGENCY\",\"fn\":\"recovery_ignored\"}"));
    return;
  }
  recoveryPending = true;
  recoveryStartMs = millis();
  Serial.print(F("{\"event\":\"recovery_started\",\"delay_s\":15,"
                 "\"will_restore_k1\":"));
  Serial.print(preEmergencyK1 ? 1 : 0);
  Serial.print(F(",\"will_restore_k2\":"));
  Serial.print(preEmergencyK2 ? 1 : 0);
  Serial.println(F(",\"fn\":\"recovery_countdown\"}"));
}

// =============================================================================
// MANUAL K1 CONTROL
// =============================================================================
void ssr1On() {
  if (k1TimerPending || k4TimerPending) {
    Serial.println(F("{\"warn\":\"TIMER_PENDING\",\"action\":\"ignore_k1_on\"}"));
    return;
  }
  if (emergencyActive || recoveryPending) {
    Serial.println(F("{\"warn\":\"EMERGENCY_OR_RECOVERY\",\"action\":\"ignore_k1_on\"}"));
    return;
  }
  writeRelays(true, stSSR2, stSSR4);
  Serial.println(F("{\"ssr1_k1\":1,\"fn\":\"k1_on\"}"));
}

void ssr1Off() {
  k1TimerPending = false;
  writeRelays(false, stSSR2, stSSR4);
  Serial.println(F("{\"ssr1_k1\":0,\"fn\":\"k1_off\"}"));
}

// =============================================================================
// MANUAL K2 CONTROL
// =============================================================================
void ssr2On() {
  if (k2TimerPending || k4TimerPending) {
    Serial.println(F("{\"warn\":\"TIMER_PENDING\",\"action\":\"ignore_k2_on\"}"));
    return;
  }
  if (emergencyActive || recoveryPending) {
    Serial.println(F("{\"warn\":\"EMERGENCY_OR_RECOVERY\",\"action\":\"ignore_k2_on\"}"));
    return;
  }
  writeRelays(stSSR1, true, stSSR4);
  Serial.println(F("{\"ssr2_k2\":1,\"fn\":\"k2_on\"}"));
}

void ssr2Off() {
  k2TimerPending = false;
  writeRelays(stSSR1, false, stSSR4);
  Serial.println(F("{\"ssr2_k2\":0,\"fn\":\"k2_off\"}"));
}

// =============================================================================
// K3 — ALWAYS INDEPENDENT
// =============================================================================
void ssr3ChargingOn() {
  stSSR3 = true;
  digitalWrite(PIN_SSR3_K3, HIGH);
  Serial.println(F("{\"ssr3_k3\":1,\"fn\":\"k3_on\"}"));
}

void ssr3ChargingOff() {
  stSSR3 = false;
  digitalWrite(PIN_SSR3_K3, LOW);
  Serial.println(F("{\"ssr3_k3\":0,\"fn\":\"k3_off\"}"));
}

// =============================================================================
// VOLTAGE SIGNAL HANDLER
// =============================================================================
void handleVoltageSignal(char source, char val) {
  bool hasVoltage = (val == '1');
  if (source == 'g') {
    gridVoltage = hasVoltage;
    if (hasVoltage) gridEverOn = true;
    Serial.print(F("{\"pzem\":\"grid\",\"voltage\":"));
    Serial.print(hasVoltage ? 1 : 0);
    Serial.println(F(",\"fn\":\"pzem_grid\"}"));
  } else {
    inverterVoltage = hasVoltage;
    if (hasVoltage) inverterEverOn = true;
    Serial.print(F("{\"pzem\":\"inverter\",\"voltage\":"));
    Serial.print(hasVoltage ? 1 : 0);
    Serial.println(F(",\"fn\":\"pzem_inv\"}"));
  }
  applyVoltageState();
}

// =============================================================================
// SENSOR READS
// =============================================================================
float readAdcVoltage(int pin) {
  long sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) { sum += analogRead(pin); delayMicroseconds(200); }
  return (sum / (float)ADC_SAMPLES) * (ADC_VREF / ADC_COUNTS);
}

float readWCS1500(int pin, float zeroV) {
  float v = readAdcVoltage(pin);
  float i = (v - zeroV) / WCS_SENSITIVITY;
  if (i < CURRENT_FILTER_A && i > -CURRENT_FILTER_A) return 0.0f;
  return max(0.0f, i);
}

void autoZeroWCS() {
  for (int ch = 0; ch < 4; ch++) {
    int pin = (ch == 0) ? PIN_SOLAR_I0 :
              (ch == 1) ? PIN_SOLAR_I1 :
              (ch == 2) ? PIN_SOLAR_I2 : PIN_SOLAR_I3;
    float sum = 0;
    for (int n = 0; n < 10; n++) { sum += readAdcVoltage(pin); delay(50); }
    wcsZero[ch] = sum / 10.0f;
  }
  saveZeroEEPROM();
  Serial.print(F("{\"zeroed\":1,\"A0\":")); Serial.print(wcsZero[0], 4);
  Serial.print(F(",\"A1\":")); Serial.print(wcsZero[1], 4);
  Serial.print(F(",\"A2\":")); Serial.print(wcsZero[2], 4);
  Serial.print(F(",\"A3\":")); Serial.print(wcsZero[3], 4);
  Serial.println(F("}"));
}

float readSolarVoltage(int pin) {
  float sv = readAdcVoltage(pin) * VDIV_RATIO;
  return (sv < VOLTAGE_FILTER_V) ? 0.0f : sv;
}

// ─── BATTERY VOLTAGE ─────────────────────────────────────────────────────────
// Multi-sample averaging to suppress EMI noise from long wire run
// (battery terminals → A5 divider → Arduino)
// Each readAdcVoltage() already averages 500 ADC samples internally.
// This outer loop adds time-domain averaging across BATT_AVG_COUNT readings
// spaced BATT_AVG_DELAY_MS apart — total added latency = 5×20ms = 100ms.
// Hardware fix: solder 100µF + 100nF caps across R2 at the divider board.
float readBattVoltage() {
  // 3 warm-up reads — discarded. Lets ADC sample-and-hold cap fully charge
  // from 80kOhm source before actual measurement. Without this, first reads
  // after sampling other pins (A0-A4) return stale charge (~20V ghost).
  for (int w = 0; w < 3; w++) { readAdcVoltage(PIN_BATT_V); delay(BATT_AVG_DELAY_MS); }
  float sum = 0.0f;
  for (int n = 0; n < BATT_AVG_COUNT; n++) {
    sum += readAdcVoltage(PIN_BATT_V);
    if (n < BATT_AVG_COUNT - 1) delay(BATT_AVG_DELAY_MS);
  }
  float bv = (sum / (float)BATT_AVG_COUNT) * BATT_VDIV_RATIO;
  return (bv < BATT_FILTER_V) ? 0.0f : bv;
}

// ─── BATTERY SOC — JSL II 24V VRLA ───────────────────────────────────────────
// Reference table (resting voltage, no load, no charge):
//   100% ≥25.70V  80%=24.90V  60%=24.10V  50%=23.76V
//   40%=23.44V    20%=22.70V  10%=22.00V  0% ≤21.00V
int battSoc(float v) {
  if (v >= 25.70f) return 100;
  if (v >= 24.90f) return 80 + (int)((v - 24.90f) / (25.70f - 24.90f) * 20.0f);
  if (v >= 24.10f) return 60 + (int)((v - 24.10f) / (24.90f - 24.10f) * 20.0f);
  if (v >= 23.76f) return 50 + (int)((v - 23.76f) / (24.10f - 23.76f) * 10.0f);
  if (v >= 23.44f) return 40 + (int)((v - 23.44f) / (23.76f - 23.44f) * 10.0f);
  if (v >= 22.70f) return 20 + (int)((v - 22.70f) / (23.44f - 22.70f) * 20.0f);
  if (v >= 22.00f) return 10 + (int)((v - 22.00f) / (22.70f - 22.00f) * 10.0f);
  if (v >= 21.00f) return  0 + (int)((v - 21.00f) / (22.00f - 21.00f) * 10.0f);
  return 0;
}

// =============================================================================
// STATUS JSON — '?'
// =============================================================================
void sendStatus() {
  float i0  = readWCS1500(PIN_SOLAR_I0, wcsZero[0]);
  float i1t = readWCS1500(PIN_SOLAR_I1, wcsZero[1]);
  float i2  = readWCS1500(PIN_SOLAR_I2, wcsZero[2]);
  float i3  = readWCS1500(PIN_SOLAR_I3, wcsZero[3]);
  float sv  = readSolarVoltage(PIN_SOLAR_V);
  float bv  = readBattVoltage();
  int   soc = (bv > 0.0f) ? battSoc(bv) : -1;

  float string1 = (i0  + i1t) / 2.0f;
  float string2 = (i2  + i3)  / 2.0f;
  float totalI  = string1 + string2;

  unsigned long now = millis();

  Serial.print(F("{\"ssr1_k1\":")); Serial.print(stSSR1 ? 1 : 0);
  Serial.print(F(",\"ssr2_k2\":")); Serial.print(stSSR2 ? 1 : 0);
  Serial.print(F(",\"ssr3_k3\":")); Serial.print(stSSR3 ? 1 : 0);
  Serial.print(F(",\"ssr4_k4\":")); Serial.print(stSSR4 ? 1 : 0);
  Serial.print(F(",\"contactor\":")); Serial.print(stSSR4 ? F("\"on\"") : F("\"off\""));
  Serial.print(F(",\"dropout\":")); Serial.print(dropoutActive ? 1 : 0);
  Serial.print(F(",\"emergency\":")); Serial.print(emergencyActive ? 1 : 0);
  Serial.print(F(",\"k1_timer\":")); Serial.print(k1TimerPending ? 1 : 0);
  Serial.print(F(",\"k2_timer\":")); Serial.print(k2TimerPending ? 1 : 0);
  Serial.print(F(",\"k4_timer\":")); Serial.print(k4TimerPending ? 1 : 0);
  Serial.print(F(",\"recovery\":")); Serial.print(recoveryPending ? 1 : 0);
  Serial.print(F(",\"grid_v\":")); Serial.print(gridVoltage ? 1 : 0);
  Serial.print(F(",\"inv_v\":")); Serial.print(inverterVoltage ? 1 : 0);
  Serial.print(F(",\"grid_ever_on\":")); Serial.print(gridEverOn ? 1 : 0);
  Serial.print(F(",\"inv_ever_on\":")); Serial.print(inverterEverOn ? 1 : 0);

  if (k4TimerPending) {
    long l = (long)K4_RECONNECT_MS - (long)(now - k4TimerStartMs);
    Serial.print(F(",\"k4_left_s\":")); Serial.print(l > 0 ? (int)(l / 1000) : 0);
  }
  if (k1TimerPending) {
    long l = (long)K1_RECONNECT_MS - (long)(now - k1TimerStartMs);
    Serial.print(F(",\"k1_left_s\":")); Serial.print(l > 0 ? (int)(l / 1000) : 0);
  }
  if (k2TimerPending) {
    long l = (long)K2_RECONNECT_MS - (long)(now - k2TimerStartMs);
    Serial.print(F(",\"k2_left_s\":")); Serial.print(l > 0 ? (int)(l / 1000) : 0);
  }
  if (recoveryPending) {
    long l = (long)RECOVERY_MS - (long)(now - recoveryStartMs);
    Serial.print(F(",\"recovery_left_s\":")); Serial.print(l > 0 ? (int)(l / 1000) : 0);
  }

  Serial.print(F(",\"solar\":{\"v\":")); Serial.print(sv, 2);
  Serial.print(F(",\"i0\":")); Serial.print(i0, 3);
  Serial.print(F(",\"i1\":")); Serial.print(i1t, 3);
  Serial.print(F(",\"i2\":")); Serial.print(i2, 3);
  Serial.print(F(",\"i3\":")); Serial.print(i3, 3);
  Serial.print(F(",\"i_total\":")); Serial.print(totalI, 3);
  Serial.print(F(",\"p_total\":")); Serial.print(sv * totalI, 1);
  Serial.print(F("},\"battery\":{\"v\":")); Serial.print(bv, 2);
  Serial.print(F(",\"soc\":")); Serial.print(soc);
  Serial.println(F("}}"));
}

// =============================================================================
// CALIBRATION — 'c'
// =============================================================================
void sendCalibration() {
  float v0 = readAdcVoltage(PIN_SOLAR_I0), v1 = readAdcVoltage(PIN_SOLAR_I1);
  float v2 = readAdcVoltage(PIN_SOLAR_I2), v3 = readAdcVoltage(PIN_SOLAR_I3);
  float v4 = readAdcVoltage(PIN_SOLAR_V);
  float v5 = readAdcVoltage(PIN_BATT_V);
  Serial.print(F("{\"cal\":{\"A0\":")); Serial.print(v0, 4);
  Serial.print(F(",\"A1\":")); Serial.print(v1, 4);
  Serial.print(F(",\"A2\":")); Serial.print(v2, 4);
  Serial.print(F(",\"A3\":")); Serial.print(v3, 4);
  Serial.print(F(",\"A4\":")); Serial.print(v4, 4);
  Serial.print(F(",\"v\":")); Serial.print(v4 * VDIV_RATIO, 2);
  Serial.print(F(",\"ratio\":")); Serial.print(VDIV_RATIO, 1);
  Serial.print(F(",\"A5\":")); Serial.print(v5, 4);
  Serial.print(F(",\"batt_v\":")); Serial.print(v5 * BATT_VDIV_RATIO, 2);
  Serial.print(F(",\"batt_ratio\":")); Serial.print(BATT_VDIV_RATIO, 1);
  Serial.println(F("}}"));
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(9600);
  pinMode(PIN_SSR1_K1, OUTPUT); digitalWrite(PIN_SSR1_K1, LOW);
  pinMode(PIN_SSR2_K2, OUTPUT); digitalWrite(PIN_SSR2_K2, LOW);
  pinMode(PIN_SSR3_K3, OUTPUT); digitalWrite(PIN_SSR3_K3, LOW);
  pinMode(PIN_SSR4_K4, OUTPUT); digitalWrite(PIN_SSR4_K4, HIGH);
  delay(200);
  while (Serial.available()) Serial.read();
  stSSR1 = false; stSSR2 = false; stSSR3 = false; stSSR4 = true;
  dropoutActive = false; emergencyActive = false;
  k1TimerPending = false; k2TimerPending = false;
  k4TimerPending = false; recoveryPending = false;
  gridVoltage = false; inverterVoltage = false;   // [FIX-BOOT] wait for real g1/i1 from Flask
  gridEverOn  = false; inverterEverOn  = false;  // [FIX-BOOT] prevent false dropout on init
  pendingCmd = 0;
  loadZeroEEPROM();
  Serial.println(F(
    "{\"boot\":\"heliogrid_v6.5\","
    "\"pins\":{\"SSR1_K1\":7,\"SSR2_K2\":6,\"SSR3_K3\":5,\"SSR4_K4\":4},"
    "\"logic\":{"
      "\"ssr1\":\"inverter_line_manual\","
      "\"ssr2\":\"grid_line_manual\","
      "\"ssr3\":\"charging_always_independent\","
      "\"ssr4\":\"contactor_dropout_protection\""
    "},"
    "\"detection\":\"voltage_based_not_power\","
    "\"dropout_trigger\":\"both_0v_after_both_ever_confirmed\","
    "\"k4_reconnect\":\"15s_after_either_source_returns\","
    "\"k1_reconnect\":\"10s_after_inv_voltage_signal\","
    "\"k2_reconnect\":\"10s_after_grid_voltage_signal\","
    "\"recovery\":\"15s_countdown_then_restore\","
    "\"k3_policy\":\"always_independent_never_touched_by_system\","
    "\"boot_state\":\"SSR4_ON_manual_ready\","
    "\"zero_source\":\"eeprom\","
    "\"status\":\"ready\"}"
  ));
}

// =============================================================================
// COMMAND HANDLER
// =============================================================================
void handleCommand(char cmd) {
  if (pendingCmd == 'g' || pendingCmd == 'i') {
    if (cmd == '0' || cmd == '1') {
      handleVoltageSignal(pendingCmd, cmd);
    } else {
      Serial.print(F("{\"warn\":\"bad_voltage_val\",\"got\":\""));
      Serial.print(cmd);
      Serial.println(F("\"}"));
    }
    pendingCmd = 0;
    return;
  }
  switch (cmd) {
    case '1': ssr1On();           break;
    case 'q': ssr1Off();          break;
    case '2': ssr2On();           break;
    case 'w': ssr2Off();          break;
    case '3': ssr3ChargingOn();   break;
    case 'e': ssr3ChargingOff();  break;
    case 'm': setManualMode();    break;
    case 'x': emergencyOff();     break;
    case 'r': startRecovery();    break;
    case 'g': pendingCmd = 'g';   break;
    case 'i': pendingCmd = 'i';   break;
    case '?': sendStatus();       break;
    case 'c': sendCalibration();  break;
    case 'z': autoZeroWCS();      break;
    default:
      if (cmd >= 32 && cmd <= 126) {
        Serial.print(F("{\"warn\":\"unknown_cmd\",\"char\":\""));
        Serial.print(cmd);
        Serial.println(F("\"}"));
      }
      break;
  }
}

// =============================================================================
// LOOP
// =============================================================================
void loop() {
  if (Serial.available() > 0) handleCommand((char)Serial.read());
  handleK4Timer();
  handleK1Timer();
  handleK2Timer();
  handleRecoverySequencer();
}
