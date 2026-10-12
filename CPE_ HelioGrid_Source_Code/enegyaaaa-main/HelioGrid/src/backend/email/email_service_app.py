"""
HelioGrid Email Alert Service — Port 5001  (v3 — Full Redesign)
================================================================
EMAIL TYPES & LEVELS:
  LOGIN           → login notification (always sends)
  GRID            → grid_dropout / grid_drift / grid_spike × warning|critical|normal
  INVERTER        → inverter_dropout / inverter_drift / inverter_spike × warning|critical|normal
  BATTERY         → battery_warning / battery_critical / battery_full
  SOLAR DC        → solar_dc_dropout / solar_dc_recovery
  SOLAR PANEL     → solar_panel (aging / replace)
  EMERGENCY       → immediate full-system cutoff alert

All emails include: Voltage Sources, Power Output, SSR relay states.
"""

import os
import smtplib
import traceback
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

MAIL_SERVER     = os.getenv("MAIL_SERVER",    "smtp.gmail.com")
MAIL_PORT       = int(os.getenv("MAIL_PORT",  "587"))
MAIL_USERNAME   = os.getenv("MAIL_USERNAME",  "")
MAIL_PASSWORD   = (os.getenv("MAIL_PASSWORD", "")).replace(" ", "")
EMAIL_RECIPIENT = os.getenv("EMAIL_RECIPIENT", MAIL_USERNAME)
TEST_API_KEY    = os.getenv("TEST_API_KEY", "")

VALID_EMAIL_TYPES = {
    "login", "critical", "emergency",
    "battery_full", "battery_warning", "battery_critical",
    "solar_panel", "solar_dc_dropout",
    "grid_dropout", "grid_drift", "grid_spike",
    "inverter_dropout", "inverter_drift", "inverter_spike",
}


def _debug_config():
    print(f"  MAIL_SERVER    : {MAIL_SERVER}:{MAIL_PORT}")
    print(f"  MAIL_USERNAME  : {MAIL_USERNAME}")
    print(f"  MAIL_PASSWORD  : {'SET (' + str(len(MAIL_PASSWORD)) + ' chars)' if MAIL_PASSWORD else 'NOT SET'}")
    print(f"  EMAIL_RECIPIENT: {EMAIL_RECIPIENT}")
    if not os.getenv("EMAIL_RECIPIENT"):
        print("  [WARN] EMAIL_RECIPIENT not set in .env")
    if not TEST_API_KEY:
        print("  [WARN] TEST_API_KEY not set")


# ─────────────────────────────────────────────────────────────────────────────
#  SMTP
# ─────────────────────────────────────────────────────────────────────────────

def _send_raw(to_email: str, subject: str, html: str) -> tuple[bool, str]:
    if not MAIL_USERNAME:  return False, "MAIL_USERNAME not set in .env"
    if not MAIL_PASSWORD:  return False, "MAIL_PASSWORD not set in .env"
    if not to_email:       return False, "No recipient email"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"HelioGrid Alerts <{MAIL_USERNAME}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        print(f"  [SMTP] Connecting {MAIL_SERVER}:{MAIL_PORT}...")
        with smtplib.SMTP(MAIL_SERVER, MAIL_PORT, timeout=8) as s:
            s.ehlo(); s.starttls(); s.ehlo()
            s.login(MAIL_USERNAME, MAIL_PASSWORD)
            s.sendmail(MAIL_USERNAME, [to_email], msg.as_string())
        print(f"  [SMTP] Sent to {to_email}")
        return True, ""
    except smtplib.SMTPAuthenticationError as e:
        err = f"Auth failed — use Google App Password: {e}"
        print(f"  [SMTP] {err}"); return False, err
    except Exception as e:
        print(f"  [SMTP] {e}"); traceback.print_exc(); return False, str(e)


# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _fmt_ts(ts) -> str:
    if ts is None: return "Unknown"
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.strftime("%B %d, %Y at %I:%M:%S %p")
    except Exception:
        return str(ts) if ts else "Unknown"


def _normalize(raw: dict) -> dict:
    d = dict(raw)
    # Normalize key aliases
    if "fault_type"  not in d: d["fault_type"]  = d.get("faultType", "System Alert")
    if "action"      not in d: d["action"]       = d.get("systemAction", d.get("system_action", d.get("anomalyDetail", "")))
    if "email"       not in d: d["email"]        = d.get("to_email", d.get("target_email", ""))
    d["severity"]   = d.get("severity",   "critical").lower()
    d["email_type"] = d.get("email_type", "").lower()

    def _f(val, fn="?", default=0.0):
        if isinstance(val, (int, float)): return float(val)
        try:
            return float(str(val).replace("V","").replace("Hz","").replace("W","")
                         .replace("%","").replace("°C","").replace("C","").replace("A","").strip())
        except Exception:
            if val not in (None, 0, ""):
                print(f"  [WARN] parse fail '{fn}'={val!r} → {default}")
            return default

    for nk, ok in [
        ("grid_voltage","gridVoltage"),("grid_frequency","gridFrequency"),("grid_power","gridPower"),
        ("inv_voltage","inverterVoltage"),("inv_frequency","inverterFrequency"),("inv_power","inverterPower"),
        ("solar_voltage","solarVoltage"),("solar_power","solarPower"),("solar_current","solarCurrent"),
        ("battery_voltage","batteryVoltage"),("battery_soc","batterySOC"),("temperature","deviceTemp"),
    ]:
        d[nk] = _f(d.get(nk, d.get(ok, 0)), nk)

    if "panel_condition" not in d: d["panel_condition"] = d.get("panelCondition", "No Output")
    if "active_source"   not in d: d["active_source"]   = d.get("activeSource",   "Unknown")
    if "system_status"   not in d: d["system_status"]   = d.get("systemCondition","Unknown")
    if "anomaly_source"  not in d: d["anomaly_source"]  = d.get("anomalySource",  "")
    if "anomaly_delta"   not in d: d["anomaly_delta"]   = d.get("anomalyDelta",   None)
    if "anomaly_first_seen" not in d: d["anomaly_first_seen"] = d.get("anomalyFirstSeen", d.get("first_seen", None))
    if "confirm_count"   not in d: d["confirm_count"]   = d.get("confirmCount",   None)

    def _bool(v):
        if isinstance(v, bool): return v
        if isinstance(v, int):  return bool(v)
        if isinstance(v, str):  return v.strip().upper() == "ON"
        return False

    d["k1"]     = _bool(d.get("k1", d.get("ssr1", False)))
    d["k2"]     = _bool(d.get("k2", d.get("ssr2", False)))
    d["buzzer"] = _bool(d.get("buzzer", d.get("buzzerStatus", False)))
    return d


# ─────────────────────────────────────────────────────────────────────────────
#  SHARED COMPONENTS
# ─────────────────────────────────────────────────────────────────────────────

def _badge(state: bool) -> str:
    if state:
        return '<span style="display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:5px;">ON</span>'
    return '<span style="display:inline-block;background:#f1f5f9;color:#94a3b8;border:1px solid #cbd5e1;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:5px;">OFF</span>'


def _soc_bar(soc: float, color: str) -> str:
    pct = min(100, max(0, soc))
    return (f'<div style="height:5px;background:#e2e8f0;border-radius:3px;margin-top:7px;overflow:hidden;">'
            f'<div style="height:5px;width:{pct:.0f}%;background:{color};border-radius:3px;"></div></div>'
            f'<div style="font-size:10px;color:#94a3b8;margin-top:3px;">{pct:.0f}% charged</div>')


THEMES = {
    "critical": {
        "pill":   "background:rgba(239,68,68,.2);color:#f87171;border:1px solid rgba(239,68,68,.4);",
        "pill_label": "CRITICAL", "banner_bg": "#2d0a0a", "banner_border": "#ef4444",
        "tag_color": "#fca5a5", "fault_color": "#dc2626", "fault_bg": "#fef2f2", "fault_border": "#fecaca",
    },
    "warning": {
        "pill":   "background:rgba(245,158,11,.2);color:#fbbf24;border:1px solid rgba(245,158,11,.4);",
        "pill_label": "WARNING", "banner_bg": "#1c1200", "banner_border": "#f59e0b",
        "tag_color": "#fbbf24", "fault_color": "#d97706", "fault_bg": "#fffbeb", "fault_border": "#fde68a",
    },
    "normal": {
        "pill":   "background:rgba(16,185,129,.2);color:#34d399;border:1px solid rgba(16,185,129,.4);",
        "pill_label": "NORMAL", "banner_bg": "linear-gradient(135deg,#064e3b,#065f46)", "banner_border": "#10b981",
        "tag_color": "#6ee7b7", "fault_color": "#16a34a", "fault_bg": "#f0fdf4", "fault_border": "#bbf7d0",
    },
    "emergency": {
        "pill":   "background:rgba(239,68,68,.4);color:#ff6b6b;border:1px solid rgba(239,68,68,.7);",
        "pill_label": "EMERGENCY", "banner_bg": "#1a0000", "banner_border": "#dc2626",
        "tag_color": "#fca5a5", "fault_color": "#dc2626", "fault_bg": "#fef2f2", "fault_border": "#fecaca",
    },
}


def _email_wrap(content: str) -> str:
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e8edf5;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8edf5;padding:28px 12px;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;">
{content}
<tr><td style="padding:12px 4px 4px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font-size:11px;color:#94a3b8;">HelioGrid Smart Energy System · Campus Resilience</td>
    <td style="font-size:11px;color:#94a3b8;text-align:right;">Do not reply</td>
  </tr></table>
</td></tr>
</table></td></tr></table>
</body></html>"""


def _brand_bar(pill_label: str, pill_style: str) -> str:
    return f"""
  <tr><td style="background:#0f1f3d;border-radius:14px 14px 0 0;padding:15px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:middle;">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;background:#2563eb;border-radius:10px;width:38px;height:38px;text-align:center;font-size:20px;color:#fff;">&#9889;</td>
          <td style="vertical-align:middle;padding-left:10px;">
            <div style="font-size:15px;font-weight:700;color:#fff;">HelioGrid</div>
            <div style="font-size:11px;color:#7b9ccf;">Campus Resilience System</div>
          </td>
        </tr></table>
      </td>
      <td align="right" style="vertical-align:middle;">
        <span style="{pill_style}font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 14px;border-radius:20px;">{pill_label}</span>
      </td>
    </tr></table>
  </td></tr>"""


def _alert_banner(tag: str, tag_color: str, title: str, subtitle: str, bg: str, border_color: str) -> str:
    return f"""
  <tr><td style="background:{bg};padding:22px 20px;border-bottom:3px solid {border_color};">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:{tag_color};margin-bottom:10px;">{tag}</div>
    <div style="font-size:19px;font-weight:700;color:#fff;line-height:1.35;margin-bottom:8px;">{title}</div>
    <div style="font-size:13px;color:{tag_color};opacity:0.9;line-height:1.7;">{subtitle}</div>
  </td></tr>"""


def _anomaly_detail(data: dict, fc: str, fb: str, fbd: str) -> str:
    src       = str(data.get("anomaly_source", "")).strip()
    delta_raw = data.get("anomaly_delta", None)
    first     = data.get("anomaly_first_seen", None)
    count     = data.get("confirm_count", None)
    ft        = data.get("fault_type", "")
    if not any([src, delta_raw is not None, first, count]):
        return ""
    rows = f"""<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;width:42%;">Fault Type</td>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:700;color:{fc};text-align:right;">{ft}</td></tr>"""
    if src:
        rows += f"""<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;">Source</td>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;text-align:right;">
        <span style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:5px;padding:2px 10px;font-size:12px;font-weight:700;">{src.upper()}</span></td></tr>"""
    if delta_raw is not None:
        try:
            dv = float(delta_raw); sign = "+" if dv >= 0 else ""; ds = f"{sign}{dv:.2f} V"; dc = "#dc2626" if dv < 0 else "#16a34a"
        except Exception:
            ds = str(delta_raw); dc = fc
        rows += f"""<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;">Voltage Delta (ΔV)</td>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:700;color:{dc};text-align:right;font-family:monospace;">{ds}</td></tr>"""
    if count is not None:
        rows += f"""<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;">Confirm Count</td>
      <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:700;text-align:right;font-family:monospace;">{count}x consecutive</td></tr>"""
    if first:
        rows += f"""<tr>
      <td style="padding:7px 0;font-size:12px;color:#64748b;">First Detected</td>
      <td style="padding:7px 0;font-size:12px;font-weight:600;text-align:right;">{_fmt_ts(first)}</td></tr>"""
    return f"""
  <tr><td style="background:{fb};padding:14px 20px;border-left:4px solid {fc};border-right:1px solid {fbd};border-bottom:1px solid {fbd};">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:{fc};margin-bottom:10px;">&#128203; Anomaly Classification</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
  </td></tr>"""


def _recommendations(items: list, fc: str, fb: str, fbd: str, title: str = "Recommended Actions") -> str:
    rows = "".join(
        f'<tr><td style="padding:5px 0 5px 22px;font-size:12px;color:#334155;line-height:1.65;position:relative;">'
        f'<span style="position:absolute;left:6px;color:{fc};">&#8226;</span>{r}</td></tr>'
        for r in items
    )
    return f"""
  <tr><td style="background:{fb};padding:14px 20px;border-left:4px solid {fc};border-right:1px solid {fbd};border-bottom:1px solid {fbd};">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:{fc};margin-bottom:10px;">&#128203; {title}</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
  </td></tr>"""


def _system_snapshot(data: dict) -> str:
    gv  = data.get("grid_voltage",    0.0); ghz = data.get("grid_frequency",  0.0); gw  = data.get("grid_power",     0.0)
    iv  = data.get("inv_voltage",     0.0); ihz = data.get("inv_frequency",   0.0); iw  = data.get("inv_power",      0.0)
    sv  = data.get("solar_voltage",   0.0); sa  = data.get("solar_current",   0.0); sw  = data.get("solar_power",    0.0)
    bv  = data.get("battery_voltage", 0.0); soc = data.get("battery_soc",     0.0)
    tmp = data.get("temperature",     0.0); act = data.get("active_source",   "Unknown")
    k1  = data.get("k1",  False); k2 = data.get("k2", False); buz = data.get("buzzer", False)

    sp  = min(100, max(0, soc))
    sc  = "#10b981" if sp > 60 else "#f59e0b" if sp > 30 else "#ef4444"
    ac  = "#f59e0b" if "Solar" in act else "#2563eb" if "Grid" in act else "#64748b"

    def vc(label, val, sub, tc, right=False):
        p = "0 0 8px 4px" if right else "0 4px 8px 0"
        return (f'<td style="width:50%;padding:{p};vertical-align:top;">'
                f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {tc};border-radius:10px;">'
                f'<tr><td style="padding:13px 12px;">'
                f'<div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">{label}</div>'
                f'<div style="font-size:21px;font-weight:700;color:#0f172a;line-height:1;font-family:monospace;">{val}</div>'
                f'<div style="font-size:11px;color:#94a3b8;margin-top:4px;font-family:monospace;">{sub}</div>'
                f'</td></tr></table></td>')

    bat_cell = (f'<td style="width:50%;padding:0 0 8px 4px;vertical-align:top;">'
                f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {sc};border-radius:10px;">'
                f'<tr><td style="padding:13px 12px;">'
                f'<div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">Battery</div>'
                f'<div style="font-size:21px;font-weight:700;color:#0f172a;line-height:1;font-family:monospace;">{bv:.2f} V</div>'
                f'{_soc_bar(sp, sc)}</td></tr></table></td>')

    def pw(label, val, sub, tc, pad):
        return (f'<td style="width:50%;padding:{pad};vertical-align:top;">'
                f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border:1px solid #e2e8f0;border-top:3px solid {tc};border-radius:9px;">'
                f'<tr><td style="padding:11px 10px;">'
                f'<div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">{label}</div>'
                f'<div style="font-size:18px;font-weight:700;color:#0f172a;line-height:1;font-family:monospace;">{val}</div>'
                f'<div style="font-size:10px;color:#94a3b8;margin-top:4px;">{sub}</div>'
                f'</td></tr></table></td>')

    def rc(rid, name, desc, state, right=False):
        p = "0 0 6px 4px" if right else "0 4px 6px 0"
        return (f'<td style="width:50%;padding:{p};vertical-align:top;">'
                f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;">'
                f'<tr><td style="padding:10px 13px;vertical-align:middle;">'
                f'<div style="font-size:10px;font-weight:700;color:#2563eb;letter-spacing:1px;text-transform:uppercase;">{rid}</div>'
                f'<div style="font-size:12px;font-weight:600;color:#334155;margin-top:2px;">{name}</div>'
                f'<div style="font-size:10px;color:#94a3b8;">{desc}</div>'
                f'</td><td style="padding:10px 13px;text-align:right;vertical-align:middle;">{_badge(state)}</td>'
                f'</tr></table></td>')

    return f"""
  <!-- STATUS CHIPS -->
  <tr><td style="background:#f1f5fb;padding:10px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #dde3ee;">
    <table cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:8px;"><span style="background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:600;color:#334155;">
        <span style="display:inline-block;width:6px;height:6px;background:{ac};border-radius:50%;vertical-align:middle;margin-right:4px;"></span>Active: {act}</span></td>
      <td><span style="background:#f0fdf4;color:#166534;border:1px solid #86efac;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:600;">&#127777; {tmp:.1f} °C</span></td>
    </tr></table>
  </td></tr>

  <!-- VOLTAGE SOURCES -->
  <tr><td style="background:#fff;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #eef2f8;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">&#9889; Voltage Sources</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>{vc("Grid Voltage",    f"{gv:.1f} V", f"{ghz:.2f} Hz",   "#2563eb", False)}{vc("Inverter Voltage", f"{iv:.1f} V", f"{ihz:.2f} Hz", "#8b5cf6", True)}</tr>
      <tr>{vc("Solar Voltage",   f"{sv:.1f} V", f"I: {sa:.2f} A",  "#f59e0b", False)}{bat_cell}</tr>
    </table>
  </td></tr>

  <!-- POWER OUTPUT -->
  <tr><td style="background:#f0fdf4;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #bbf7d0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#166534;margin-bottom:12px;">&#9889; Power Output</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      {pw("Grid Power",    f"{gw:.0f} W",  "AC Input",  "#2563eb", "0 4px 0 0")}
      {pw("Inverter Power",f"{iw:.0f} W",  "AC Output", "#8b5cf6", "0 0 0 0")}
    </tr></table>
  </td></tr>

  <!-- SSR MANAGEMENT -->
  <tr><td style="background:#fff;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #eef2f8;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">&#128268; SSR Management</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>{rc("K1","Solar Path (SSR)","Inverter → ATS-A → Load",k1,False)}{rc("K2","Grid Bypass (SSR)","Grid → ATS-B → Load",k2,True)}</tr>
      <tr><td colspan="2">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;">
          <tr><td style="padding:10px 13px;vertical-align:middle;">
            <div style="font-size:10px;font-weight:700;color:#ef4444;letter-spacing:1px;text-transform:uppercase;">Buzzer</div>
            <div style="font-size:12px;font-weight:600;color:#334155;margin-top:2px;">Alert Sound (10s pulse)</div>
          </td><td style="padding:10px 13px;text-align:right;vertical-align:middle;">{_badge(buz)}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>"""


def _ts_footer(timestamp: str) -> str:
    return f"""
  <tr><td style="background:#f8fafc;border:1px solid #dde3ee;border-top:none;padding:11px 20px;border-radius:0 0 14px 14px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-size:10px;color:#64748b;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Alert Timestamp</td>
      <td style="text-align:right;font-size:11px;color:#334155;font-family:monospace;">{timestamp}</td>
    </tr></table>
  </td></tr>"""


# ─────────────────────────────────────────────────────────────────────────────
#  LOGIN EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_login_email(data: dict) -> str:
    email  = data.get("email", "Unknown")
    name   = data.get("name", email.split("@")[0].capitalize() if "@" in email else email)
    source = str(data.get("source", "Web Login"))
    ts     = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    method = "Google OAuth" if "Google" in source else "Email / Password"

    content = f"""
  {_brand_bar("LOGIN", "background:rgba(56,189,248,.2);color:#38bdf8;border:1px solid rgba(56,189,248,.4);")}
  {_alert_banner("&#128272; Successful Authentication", "#7dd3fc",
                 "Dashboard Access Granted",
                 f"A new session was authenticated for <strong style='color:#fff;'>{email}</strong>.",
                 "linear-gradient(135deg,#0f1f3d,#1e3a72)", "#2563eb")}

  <tr><td style="background:#fff;padding:18px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:14px;">Session Details</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;width:42%;">Email Address</td>
          <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#2563eb;font-weight:600;text-align:right;word-break:break-all;">{email}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;">Display Name</td>
          <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a;font-weight:600;text-align:right;">{name}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;">Sign-in Method</td>
          <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;text-align:right;">
            <span style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:5px;padding:3px 10px;font-size:12px;font-weight:700;">{method}</span></td></tr>
      <tr><td style="padding:9px 0;font-size:13px;color:#64748b;">Timestamp</td>
          <td style="padding:9px 0;font-size:12px;color:#0f172a;font-weight:600;text-align:right;font-family:monospace;">{ts}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
      <tr><td style="padding:12px 14px;font-size:12px;color:#92400e;line-height:1.7;">
        <strong style="color:#d97706;">&#9888;&#65039; Not you?</strong> Change your password immediately and revoke all active sessions.
      </td></tr>
    </table>
  </td></tr>
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  GRID EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_grid_email(data: dict) -> str:
    fault_type = data.get("fault_type", "Grid Anomaly")
    action     = data.get("action", "")
    severity   = data.get("severity", "critical").lower()
    email_type = data.get("email_type", "grid_dropout")
    ts         = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    _ft        = fault_type.lower()

    is_rec = "recover" in _ft or severity == "normal"
    if is_rec:
        severity = "normal"
        icon = "&#9989;"
    elif "spike" in email_type or "spike" in _ft:
        icon = "&#128200;"
    elif "drift" in email_type or "drift" in _ft:
        icon = "&#128201;"
    else:
        icon = "&#9889;"

    if   severity == "normal":  theme = THEMES["normal"];   pill = "GRID NORMAL"
    elif severity == "warning": theme = THEMES["warning"];  pill = "GRID WARNING"
    else:                       theme = THEMES["critical"]; pill = "GRID CRITICAL"

    tag = f"{icon} {'Grid Voltage Recovered' if is_rec else 'Grid Fault Detected'}"
    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    recs = {
        "normal":   ["Grid voltage returned to nominal range.",
                     "K2 (Grid Bypass) relay re-evaluating reconnection window.",
                     "Monitor for sustained stability before relying on grid."],
        "warning":  ["Grid voltage deviated — approaching threshold, not yet critical.",
                     "System remains on current source. Monitor closely.",
                     "Verify grid upstream supply and feeder cable integrity."],
        "critical": ["K2 (Grid Bypass) isolated — load on alternative source.",
                     "Inspect incoming grid supply, main breaker, and feeder cable.",
                     "Check upstream utility and contact provider if persistent.",
                     "5-minute stability window required before manual reconnect."],
    }[severity]

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], fault_type, action, theme["banner_bg"], theme["banner_border"])}
  {_anomaly_detail(data, fc, fb, fbd)}
  {_system_snapshot(data)}
  {_recommendations(recs, fc, fb, fbd)}
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  INVERTER EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_inverter_email(data: dict) -> str:
    fault_type = data.get("fault_type", "Inverter Anomaly")
    action     = data.get("action", "")
    severity   = data.get("severity", "critical").lower()
    email_type = data.get("email_type", "inverter_dropout")
    ts         = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    _ft        = fault_type.lower()

    is_rec = "recover" in _ft or severity == "normal"
    if is_rec:
        severity = "normal"
        icon = "&#9989;"
    elif "spike" in email_type or "spike" in _ft:
        icon = "&#128200;"
    elif "drift" in email_type or "drift" in _ft:
        icon = "&#128201;"
    else:
        icon = "&#9889;"

    if   severity == "normal":  theme = THEMES["normal"];   pill = "INVERTER NORMAL"
    elif severity == "warning": theme = THEMES["warning"];  pill = "INVERTER WARNING"
    else:                       theme = THEMES["critical"]; pill = "INVERTER CRITICAL"

    tag = f"{icon} {'Inverter Output Recovered' if is_rec else 'Inverter Fault Detected'}"
    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    recs = {
        "normal":   ["Inverter output voltage returned to normal range.",
                     "K1 (Solar Path) relay available for reconnection.",
                     "Review load conditions for any overcurrent events."],
        "warning":  ["Inverter output voltage deviating — not yet critical.",
                     "Check DC input (solar/battery) for supply issues.",
                     "Monitor inverter temperature and fan operation."],
        "critical": ["K1 (Solar Path) isolated — load switched to backup source.",
                     "Check DC input: battery bank voltage and solar array output.",
                     "Inspect inverter DC link fuses and IGBT protection.",
                     "Allow inverter to cool before attempting restart."],
    }[severity]

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], fault_type, action, theme["banner_bg"], theme["banner_border"])}
  {_anomaly_detail(data, fc, fb, fbd)}
  {_system_snapshot(data)}
  {_recommendations(recs, fc, fb, fbd)}
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  BATTERY EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_battery_email(data: dict) -> str:
    fault_type = data.get("fault_type",  "Battery Alert")
    action     = data.get("action",      "")
    email_type = data.get("email_type",  "battery_warning").lower()
    severity   = data.get("severity",    "warning").lower()
    ts         = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    bv         = float(data.get("battery_voltage", 0))
    bsoc       = float(data.get("battery_soc",     0))
    sp         = min(100, max(0, bsoc))

    is_full = (email_type == "battery_full") or sp >= 95
    is_crit = (email_type == "battery_critical") or severity == "critical"

    if is_full:
        theme = THEMES["normal"]; pill = "BATTERY FULL"; tag = "&#128267; Battery Fully Charged"
        fault_type = fault_type if fault_type != "Battery Alert" else "Battery Pack at 100% SOC"
        action = action or "Battery has reached full charge. Float charging mode active."
        recs   = ["Battery reached full SOC — solar charger entering float mode.",
                  "System operating normally. No action required.",
                  "Monitor for next charge cycle after significant load discharge."]
        sc     = "#10b981"; mccb = ""
    elif is_crit:
        theme = THEMES["critical"]; pill = "BATTERY CRITICAL"; tag = "&#128680; Battery Deep Discharge"
        recs  = ["Battery critically low — inverter protection may have activated.",
                 "&#9888; If inverter fails to disconnect: trip MCCB on battery bank MANUALLY.",
                 "Restore grid feed or start backup generator immediately.",
                 "Do not restart until voltage exceeds 22V (>10% SOC)."]
        sc    = "#ef4444"
        mccb  = f"""
  <tr><td style="background:#7f1d1d;padding:14px 20px;border-left:4px solid #dc2626;">
    <div style="font-size:11px;font-weight:700;color:#fca5a5;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">&#9888; ADMIN ACTION REQUIRED — MCCB CHECK</div>
    <div style="font-size:12px;color:#fecaca;line-height:1.7;">Battery at {sp:.0f}% SOC ({bv:.2f}V). If inverter does not auto-disconnect, <strong>trip MCCB manually</strong> to prevent cell damage.</div>
  </td></tr>"""
    else:
        theme = THEMES["warning"]; pill = "BATTERY LOW"; tag = "&#9888;&#65039; Battery Low Warning"
        recs  = ["Battery voltage below 23V — approximately 50% state of charge.",
                 "Reduce non-essential loads to extend battery runtime.",
                 "Ensure solar panels are unobstructed and charge controller is active.",
                 "Consider switching to grid feed if available and stable."]
        sc    = "#f59e0b"; mccb = ""

    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    bat_cards = f"""
  <tr><td style="background:#fff;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #eef2f8;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">&#128267; Battery Status</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="width:50%;padding:0 4px 0 0;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {sc};border-radius:10px;">
          <tr><td style="padding:14px 12px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">Battery Voltage</div>
            <div style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;font-family:monospace;">{bv:.2f} V</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:6px;">Nominal 24V · Full 26.4V</div>
          </td></tr>
        </table>
      </td>
      <td style="width:50%;padding:0 0 0 4px;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {sc};border-radius:10px;">
          <tr><td style="padding:14px 12px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">State of Charge</div>
            <div style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;font-family:monospace;">{sp:.0f}%</div>
            {_soc_bar(sp, sc)}
          </td></tr>
        </table>
      </td>
    </tr></table>
  </td></tr>"""

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], fault_type, action, theme["banner_bg"], theme["banner_border"])}
  {mccb}
  {bat_cards}
  {_system_snapshot(data)}
  {_recommendations(recs, fc, fb, fbd, "Status Notes")}
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  SOLAR DC EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_solar_dc_email(data: dict) -> str:
    fault_type = data.get("fault_type", "Solar DC Alert")
    action     = data.get("action", "")
    severity   = data.get("severity", "critical").lower()
    ts         = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    sv = float(data.get("solar_voltage", 0))
    sa = float(data.get("solar_current", 0))
    sw = float(data.get("solar_power",   0))

    is_rec = "recover" in fault_type.lower() or severity == "normal"

    if is_rec:
        theme = THEMES["normal"]; pill = "SOLAR RECOVERED"; tag = "&#9728;&#65039; Solar DC Recovered"
        recs = [f"Solar DC voltage restored to {sv:.1f}V — above operating threshold.",
                "System resuming normal solar-fed operation.",
                "Monitor output for 10 min to confirm sustained stability."]
        sc = "#16a34a"
    elif severity == "warning":
        theme = THEMES["warning"]; pill = "SOLAR WARNING"; tag = "&#9888;&#65039; Solar DC Low"
        recs = ["Solar voltage low but above dropout threshold.",
                "Check for partial shading, soiling, or high-resistance MC4 connections.",
                "Monitor charge controller input and string current."]
        sc = "#f59e0b"
    else:
        theme = THEMES["critical"]; pill = "SOLAR DROPOUT"; tag = "&#9889; Solar DC Dropout Detected"
        recs = ["Solar DC voltage dropped below minimum operating threshold.",
                "Inspect MC4 connectors, combiner box fuses, and array wiring.",
                "Check charge controller bypass diodes and DC circuit breaker.",
                "System may be switching to grid or battery backup automatically."]
        sc = "#ef4444" if sv < 30 else "#f59e0b"

    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    solar_cards = f"""
  <tr><td style="background:#fff;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #eef2f8;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">&#9728;&#65039; Solar Array Status</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="width:33%;padding:0 4px 0 0;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {sc};border-radius:10px;">
          <tr><td style="padding:13px 10px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">DC Voltage</div>
            <div style="font-size:22px;font-weight:700;color:{sc};font-family:monospace;">{sv:.1f} V</div>
          </td></tr>
        </table>
      </td>
      <td style="width:33%;padding:0 4px;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid #f59e0b;border-radius:10px;">
          <tr><td style="padding:13px 10px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">DC Current</div>
            <div style="font-size:22px;font-weight:700;color:#78350f;font-family:monospace;">{sa:.2f} A</div>
          </td></tr>
        </table>
      </td>
      <td style="width:33%;padding:0 0 0 4px;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid #f59e0b;border-radius:10px;">
          <tr><td style="padding:13px 10px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:5px;">DC Power</div>
            <div style="font-size:22px;font-weight:700;color:#78350f;font-family:monospace;">{sw:.0f} W</div>
          </td></tr>
        </table>
      </td>
    </tr></table>
  </td></tr>"""

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], fault_type, action, theme["banner_bg"], theme["banner_border"])}
  {solar_cards}
  {_system_snapshot(data)}
  {_recommendations(recs, fc, fb, fbd)}
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  SOLAR PANEL HEALTH EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_solar_panel_email(data: dict) -> str:
    panel_id  = str(data.get("panel_id",    "Panel"))
    health    = float(data.get("health_pct", 0))
    label     = str(data.get("health_label","Aging"))
    string_id = str(data.get("string_id",   "Unknown"))
    curr_a    = float(data.get("current_a",  0))
    rated_imp = float(data.get("rated_imp",  0))
    confirms  = data.get("confirm_count", 3)
    ts        = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))
    action    = data.get("action", f"{panel_id} health at {health:.0f}%.")

    is_replace = health < 20
    theme = THEMES["critical"] if is_replace else THEMES["warning"]
    pill  = f"PANEL {'REPLACE' if is_replace else 'AGING'}"
    tag   = f"&#9728;&#65039; Panel Health Alert — {panel_id}"
    hc    = "#ef4444" if is_replace else "#f59e0b"
    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    hbar = (f'<div style="height:8px;background:#e2e8f0;border-radius:4px;margin-top:8px;overflow:hidden;">'
            f'<div style="height:8px;width:{min(100,health):.0f}%;background:{hc};border-radius:4px;"></div></div>'
            f'<div style="font-size:10px;color:#94a3b8;margin-top:3px;">{health:.0f}% health remaining</div>')

    panel_cards = f"""
  <tr><td style="background:#fff;padding:16px 20px;border-left:1px solid #dde3ee;border-right:1px solid #dde3ee;border-bottom:1px solid #eef2f8;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">&#9728;&#65039; Panel Health Details</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="width:50%;padding:0 4px 0 0;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid {hc};border-radius:10px;">
          <tr><td style="padding:14px 12px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:5px;">Health Score</div>
            <div style="font-size:26px;font-weight:700;color:{hc};font-family:monospace;">{health:.0f}%</div>
            {hbar}
          </td></tr>
        </table>
      </td>
      <td style="width:50%;padding:0 0 0 4px;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid #2563eb;border-radius:10px;">
          <tr><td style="padding:14px 12px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Panel Info</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="font-size:12px;color:#64748b;padding:3px 0;">Panel ID</td><td style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;">{panel_id}</td></tr>
              <tr><td style="font-size:12px;color:#64748b;padding:3px 0;">String</td><td style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;">{string_id}</td></tr>
              <tr><td style="font-size:12px;color:#64748b;padding:3px 0;">Actual Isc</td><td style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;">{curr_a:.2f} A</td></tr>
              <tr><td style="font-size:12px;color:#64748b;padding:3px 0;">Rated Imp</td><td style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;">{rated_imp:.2f} A</td></tr>
              <tr><td style="font-size:12px;color:#64748b;padding:3px 0;">Confirms</td><td style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;">{confirms}x</td></tr>
            </table>
          </td></tr>
        </table>
      </td>
    </tr></table>
  </td></tr>"""

    note = ("Panel replacement is recommended. Health below 20% indicates significant cell degradation "
            "affecting efficiency and output. Schedule replacement immediately."
            if is_replace else
            f"Panel health at {health:.0f}% — performance degrading. Schedule inspection for soiling, "
            "micro-cracks, or cell delamination. Clean surface and re-test output current.")

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], f"Panel {panel_id} — {label}", action, theme["banner_bg"], theme["banner_border"])}
  {panel_cards}
  {_system_snapshot(data)}
  <tr><td style="background:{fb};padding:14px 20px;border-left:4px solid {hc};border-right:1px solid {fbd};border-bottom:1px solid {fbd};">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:{hc};margin-bottom:8px;">&#128203; {'Replacement Required' if is_replace else 'Maintenance Advisory'}</div>
    <div style="font-size:12px;color:#334155;line-height:1.7;">{note}</div>
  </td></tr>
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  GENERAL / EMERGENCY EMAIL
# ─────────────────────────────────────────────────────────────────────────────

def _build_anomaly_email(data: dict) -> str:
    fault_type = data.get("fault_type",  "System Alert")
    action     = data.get("action",      "")
    email_type = data.get("email_type",  "").lower()
    severity   = data.get("severity",    "critical").lower()
    ts         = _fmt_ts(data.get("timestamp", datetime.now().isoformat()))

    is_emergency = (email_type == "emergency")
    is_recovery  = "recover" in fault_type.lower() or "reconnect" in fault_type.lower() or severity == "normal"

    if   is_recovery:  theme = THEMES["normal"];    pill = "RECOVERED";  tag = "&#9989; System Recovered"; mccb = ""
    elif is_emergency: theme = THEMES["emergency"]; pill = "EMERGENCY";  tag = "&#128680;&#128680; EMERGENCY CUTOFF"; mccb = ""
    else:              theme = THEMES["critical"];  pill = "CRITICAL";   tag = "&#128680; Critical Fault Detected"; mccb = ""

    if is_emergency:
        mccb = """
  <tr><td style="background:#7f1d1d;padding:14px 20px;border-left:4px solid #dc2626;">
    <div style="font-size:11px;font-weight:700;color:#fca5a5;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">&#9888; EMERGENCY — ALL RELAYS OFF</div>
    <div style="font-size:12px;color:#fecaca;line-height:1.7;">All relays have been turned OFF. Inspect system before restarting.</div>
  </td></tr>"""

    fc, fb, fbd = theme["fault_color"], theme["fault_bg"], theme["fault_border"]

    content = f"""
  {_brand_bar(pill, theme["pill"])}
  {_alert_banner(tag, theme["tag_color"], fault_type, action, theme["banner_bg"], theme["banner_border"])}
  {mccb}
  {_anomaly_detail(data, fc, fb, fbd)}
  {_system_snapshot(data)}
  {_ts_footer(ts)}"""

    return _email_wrap(content)


# ─────────────────────────────────────────────────────────────────────────────
#  ROUTE: /api/send-alert
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/send-alert", methods=["POST"])
def send_alert():
    raw  = request.get_json(force=True) or {}
    data = _normalize(raw)

    email_type = data.get("email_type", "").lower()
    severity   = data.get("severity",   "critical").lower()
    fault_type = data.get("fault_type", "")
    to_email   = data.get("email") or EMAIL_RECIPIENT

    print(f"\n[ALERT] type={email_type!r} sev={severity!r} fault={fault_type!r}")

    if not to_email:
        return jsonify({"success": False, "error": "No recipient — set EMAIL_RECIPIENT in .env"}), 400

    if email_type and email_type not in VALID_EMAIL_TYPES:
        print(f"  [WARN] Unknown email_type={email_type!r} → treating as 'critical'")
        email_type = "critical"
        data["email_type"] = "critical"

    # ── Route by email_type ──────────────────────────────────────────────────
    _ft = fault_type.lower()

    if   email_type == "login":
        subject = "HelioGrid — Login Notification"
        html    = _build_login_email(data)
        label   = "LOGIN"

    elif email_type == "battery_full":
        subject = "HelioGrid — Battery Fully Charged ✅"
        html    = _build_battery_email(data)
        label   = "BATTERY_FULL"

    elif email_type == "battery_warning":
        subject = "HelioGrid — Battery Low Warning ⚠️"
        html    = _build_battery_email(data)
        label   = "BATTERY_WARNING"

    elif email_type == "battery_critical":
        subject = "[HelioGrid CRITICAL] Battery Deep Discharge"
        html    = _build_battery_email(data)
        label   = "BATTERY_CRITICAL"

    elif email_type == "solar_panel":
        subject = f"HelioGrid — Solar Panel: {data.get('panel_id','?')} {data.get('health_label','Alert')} ☀️"
        html    = _build_solar_panel_email(data)
        label   = "SOLAR_PANEL"

    elif email_type == "solar_dc_dropout":
        is_rec  = "recover" in _ft or severity == "normal"
        subject = "HelioGrid — Solar DC Recovered ✅" if is_rec else f"HelioGrid — Solar DC Dropout ⚡ {fault_type}"
        html    = _build_solar_dc_email(data)
        label   = "SOLAR_DC_RECOVERY" if is_rec else "SOLAR_DC_DROPOUT"

    elif email_type in ("grid_dropout", "grid_drift", "grid_spike"):
        sev_label = severity.upper()
        subject = f"[HelioGrid {sev_label}] Grid — {fault_type}"
        html    = _build_grid_email(data)
        label   = f"GRID_{sev_label}"

    elif email_type in ("inverter_dropout", "inverter_drift", "inverter_spike"):
        sev_label = severity.upper()
        subject = f"[HelioGrid {sev_label}] Inverter — {fault_type}"
        html    = _build_inverter_email(data)
        label   = f"INVERTER_{sev_label}"

    elif email_type == "emergency":
        subject = f"[HelioGrid EMERGENCY] {fault_type}"
        html    = _build_anomaly_email(data)
        label   = "EMERGENCY"

    else:
        # Legacy fallback — critical with fault_type keyword gate
        _valid = any(k in _ft for k in ("drift","spike","dropout","recovered","recovery","aging","double fault"))
        if severity == "warning" and not _valid:
            print(f"  [SUPPRESSED] warning without typed email_type: {fault_type}")
            return jsonify({"success": True, "suppressed": True, "reason": "warning — use typed email_type"})
        if not _valid and severity not in ("critical", "normal"):
            print(f"  [BLOCKED] unrecognized fault without typed email_type: {fault_type}")
            return jsonify({"success": False, "reason": "unrecognized_fault", "fault_type": fault_type})
        is_rec = "recover" in _ft or severity == "normal"
        subject = f"[HelioGrid {'RECOVERED' if is_rec else 'CRITICAL'}] {fault_type}"
        html    = _build_anomaly_email(data)
        label   = "RECOVERED" if is_rec else "CRITICAL"

    ok, err = _send_raw(to_email, subject, html)
    if ok:
        print(f"[EMAIL OK] {label} → {to_email}")
        return jsonify({"success": True, "type": label.lower()})
    print(f"[EMAIL FAIL] {err}")
    return jsonify({"success": False, "error": err}), 500


# ─────────────────────────────────────────────────────────────────────────────
#  ROUTE: /api/test-email
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/test-email", methods=["POST"])
def test_email():
    if TEST_API_KEY and request.headers.get("X-Api-Key","") != TEST_API_KEY:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    raw      = request.get_json(force=True) or {}
    to_email = raw.get("email") or EMAIL_RECIPIENT
    mode     = raw.get("mode", "grid_critical")
    if not to_email:
        return jsonify({"success": False, "error": "No recipient"}), 400

    print(f"\n[TEST] mode={mode} to={to_email}")
    now_ts = datetime.now().isoformat()

    BASE = {
        "timestamp": now_ts, "to_email": to_email,
        "grid_voltage": 229.8, "grid_frequency": 60.01, "grid_power": 850.0,
        "inv_voltage":  228.5, "inv_frequency":  60.00, "inv_power":  720.0,
        "solar_voltage": 86.2, "solar_current":  10.45, "solar_power": 980.0,
        "battery_voltage": 24.8, "battery_soc": 62.0, "temperature": 38.5,
        "active_source": "Solar", "system_status": "Normal",
        "k1": True, "k2": False, "buzzer": False,
        "anomaly_source": "AnomalyEngine(grid)", "anomaly_delta": -14.6,
        "anomaly_first_seen": now_ts, "confirm_count": 3,
    }

    modes = {
        "login":             ("HelioGrid — Login Test",
                              lambda: _build_login_email({"email": to_email, "name": to_email.split("@")[0].capitalize(), "source": "Google OAuth", "timestamp": now_ts})),
        "grid_critical":     ("[HelioGrid CRITICAL] Grid Drift Low",
                              lambda: _build_grid_email({**BASE, "fault_type":"Grid Drift Low","email_type":"grid_drift","severity":"critical","action":"Grid 195.4V below threshold. K2 isolated.","grid_voltage":195.4,"k2":False,"buzzer":True})),
        "grid_warning":      ("[HelioGrid WARNING] Grid Drift Low",
                              lambda: _build_grid_email({**BASE, "fault_type":"Grid Drift Low (Warning)","email_type":"grid_drift","severity":"warning","action":"Grid 208V approaching threshold.","grid_voltage":208.0})),
        "grid_spike":        ("[HelioGrid CRITICAL] Grid Voltage Spike",
                              lambda: _build_grid_email({**BASE, "fault_type":"Grid Voltage Spike","email_type":"grid_spike","severity":"critical","action":"Grid 265V above 250V. K2 isolated.","grid_voltage":265.0,"anomaly_delta":25.0,"k2":False,"buzzer":True})),
        "grid_dropout":      ("[HelioGrid CRITICAL] Grid Dropout",
                              lambda: _build_grid_email({**BASE, "fault_type":"Grid Dropout","email_type":"grid_dropout","severity":"critical","action":"Grid collapsed. K2 isolated.","grid_voltage":0.0,"grid_power":0.0,"anomaly_delta":-229.0,"k2":False,"buzzer":True})),
        "grid_normal":       ("HelioGrid — Grid Recovered ✅",
                              lambda: _build_grid_email({**BASE, "fault_type":"Grid Voltage Recovered","email_type":"grid_dropout","severity":"normal","action":"Grid 228.5V restored.","grid_voltage":228.5})),
        "inverter_critical": ("[HelioGrid CRITICAL] Inverter Drift Low",
                              lambda: _build_inverter_email({**BASE, "fault_type":"Inverter Drift Low","email_type":"inverter_drift","severity":"critical","action":"Inverter 185V below threshold. K1 isolated.","inv_voltage":185.0,"k1":False,"k2":True,"buzzer":True,"anomaly_source":"AnomalyEngine(inverter)","anomaly_delta":-43.0})),
        "inverter_warning":  ("[HelioGrid WARNING] Inverter Drift Low",
                              lambda: _build_inverter_email({**BASE, "fault_type":"Inverter Drift Low (Warning)","email_type":"inverter_drift","severity":"warning","action":"Inverter 210V approaching threshold.","inv_voltage":210.0,"anomaly_delta":-18.0})),
        "inverter_spike":    ("[HelioGrid CRITICAL] Inverter Output Spike",
                              lambda: _build_inverter_email({**BASE, "fault_type":"Inverter Output Spike","email_type":"inverter_spike","severity":"critical","action":"Inverter 258V above threshold. K1 isolated.","inv_voltage":258.0,"anomaly_delta":30.0,"k1":False,"k2":True,"buzzer":True})),
        "inverter_dropout":  ("[HelioGrid CRITICAL] Inverter Dropout",
                              lambda: _build_inverter_email({**BASE, "fault_type":"Inverter Dropout","email_type":"inverter_dropout","severity":"critical","action":"Inverter output lost. K1 isolated.","inv_voltage":0.0,"inv_power":0.0,"anomaly_delta":-228.5,"k1":False,"k2":True,"buzzer":True})),
        "inverter_normal":   ("HelioGrid — Inverter Recovered ✅",
                              lambda: _build_inverter_email({**BASE, "fault_type":"Inverter Output Recovered","email_type":"inverter_dropout","severity":"normal","action":"Inverter 228V nominal.","inv_voltage":228.0})),
        "battery_full":      ("HelioGrid — Battery Fully Charged ✅",
                              lambda: _build_battery_email({**BASE, "fault_type":"Battery Fully Charged","email_type":"battery_full","battery_voltage":26.4,"battery_soc":100.0})),
        "battery_warning":   ("HelioGrid — Battery Low Warning ⚠️",
                              lambda: _build_battery_email({**BASE, "fault_type":"Battery Low","email_type":"battery_warning","severity":"warning","action":"Battery 22.8V (~48% SOC). Reduce loads.","battery_voltage":22.8,"battery_soc":48.0})),
        "battery_critical":  ("[HelioGrid CRITICAL] Battery Deep Discharge",
                              lambda: _build_battery_email({**BASE, "fault_type":"Battery Deep Discharge","email_type":"battery_critical","severity":"critical","action":"Battery 21.1V (3.5% SOC). MCCB check.","battery_voltage":21.1,"battery_soc":3.5,"k1":False,"k2":False,"buzzer":True})),
        "solar_dc_dropout":  ("HelioGrid — Solar DC Dropout ⚡",
                              lambda: _build_solar_dc_email({**BASE, "fault_type":"Solar DC Dropout","email_type":"solar_dc_dropout","severity":"critical","action":"Solar DC 8.3V — below threshold.","solar_voltage":8.3,"solar_power":0.0,"solar_current":0.0})),
        "solar_dc_recovery": ("HelioGrid — Solar DC Recovered ✅",
                              lambda: _build_solar_dc_email({**BASE, "fault_type":"Solar DC Recovered","email_type":"solar_dc_dropout","severity":"normal","action":"Solar DC 87.4V restored.","solar_voltage":87.4,"solar_power":1420.0,"solar_current":16.4})),
        "solar_panel":       ("HelioGrid — Solar Panel Health: PV-03 Aging ☀️",
                              lambda: _build_solar_panel_email({**BASE, "panel_id":"PV-03","health_pct":35.0,"health_label":"Aging","string_id":"String B","current_a":4.65,"rated_imp":13.28,"confirm_count":3,"fault_type":"Solar Panel Aging — PV-03","email_type":"solar_panel","action":"PV-03 health at 35%."})),
        "solar_panel_replace":("HelioGrid — Solar Panel: PV-07 REPLACE ☀️",
                              lambda: _build_solar_panel_email({**BASE, "panel_id":"PV-07","health_pct":14.0,"health_label":"Replace","string_id":"String A","current_a":2.1,"rated_imp":13.28,"confirm_count":5,"fault_type":"Solar Panel Degraded — PV-07 Replacement Required","email_type":"solar_panel","action":"PV-07 health at 14%."})),
        "emergency":         ("[HelioGrid EMERGENCY] Emergency System Shutdown",
                              lambda: _build_anomaly_email({**BASE, "fault_type":"Emergency System Shutdown","email_type":"emergency","severity":"critical","action":"All relays OFF. Inspect before restart.","k1":False,"k2":False,"buzzer":True,"grid_power":0.0,"inv_power":0.0,"solar_power":0.0,"active_source":"None"})),
    }

    if mode in modes:
        subject, builder = modes[mode]
        html = builder()
    else:
        subject = f"[HelioGrid TEST] {mode}"
        html    = _build_anomaly_email({**BASE, "fault_type": f"Test — {mode}", "email_type": "critical", "severity": "critical", "action": f"Test mode: {mode}"})

    ok, err = _send_raw(to_email, subject, html)
    return jsonify({"success": ok, "to": to_email, "mode": mode, "error": err if not ok else None})


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "email_types": sorted(VALID_EMAIL_TYPES),
        "smtp": MAIL_SERVER,
        "user": MAIL_USERNAME,
        "password": "SET" if MAIL_PASSWORD else "NOT SET",
    })


# ─────────────────────────────────────────────────────────────────────────────
#  STARTUP
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  HelioGrid Email Service — port 5001  (v3)")
    print("  Types: Grid | Inverter | Battery | Solar | Login | Emergency")
    print("  Levels: critical | warning | normal (per source)")
    print("  All emails include: Voltage Sources, Power Output, SSR States")
    _debug_config()
    print("=" * 60)
    app.run(host="0.0.0.0", port=5001, debug=False)
