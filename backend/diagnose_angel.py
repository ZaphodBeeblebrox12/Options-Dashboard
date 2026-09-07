"""Standalone Angel One REST-auth diagnostic (AG8004 triage).

Usage (from backend/):
    python diagnose_angel.py [EXPIRY]
    python diagnose_angel.py 09SEP2026        # optional: expiry for optionGreek

WHAT IT DOES
  Logs in with your backend/.env credentials, then fires two read-only probes:
    1. ordinary REST market data  (getLtpData, RELIANCE-EQ)
    2. optionGreek                (NIFTY, same request the Tier-4 feed sends)
  and prints a Case A / B / C verdict. No secrets are printed.

  Case A: LTP ok, optionGreek AG8004 -> optionGreek-SPECIFIC entitlement.
  Case B: LTP also AG8004            -> ALL REST market data unauthorized for
          this app (portal migration / static-IP binding / app entitlement) —
          NOT the key string.
  Case C: both ok                    -> request-specific failure; the feed
          will recover on its own.

IMPORTANT: run this while the BACKEND IS STOPPED. A fresh generateSession
invalidates the running app's session tokens (Angel single-session behavior).
"""
import json
import os
import sys

from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env1")
if os.path.exists(env_path):
    load_dotenv(env_path, override=True)
else:
    sys.exit(f".env not found at {env_path}")

API_KEY = os.getenv("API_KEY", "").strip()
CLIENT_CODE = os.getenv("CLIENT_CODE", "").strip()
PASSWORD = os.getenv("PASSWORD", "").strip()
TOTP_SECRET = os.getenv("TOTP_SECRET", "").strip()

missing = [k for k, v in [("API_KEY", API_KEY), ("CLIENT_CODE", CLIENT_CODE),
                          ("PASSWORD", PASSWORD), ("TOTP_SECRET", TOTP_SECRET)] if not v]
if missing:
    sys.exit(f"Missing in .env: {', '.join(missing)}")

try:
    import pyotp
    import requests
    from SmartApi import SmartConnect
except ImportError as e:
    sys.exit(f"smartapi-python/pyotp/requests not installed: {e}")

expiry = sys.argv[1].strip().upper() if len(sys.argv) > 1 else None
if not expiry:
    try:
        from scrip_master import scrip_master
        expiry = scrip_master.get_nearest_weekly_expiry("NIFTY")
    except Exception as e:
        print(f"[warn] could not resolve NIFTY expiry from scrip master: {e}")
        print("[warn] pass it manually, e.g.: python diagnose_angel.py 09SEP2026")

print("login ...")
api = SmartConnect(API_KEY)
data = api.generateSession(clientCode=CLIENT_CODE, password=PASSWORD,
                           totp=pyotp.TOTP(TOTP_SECRET).now())
if not data.get("status"):
    sys.exit(f"LOGIN FAILED: {data.get('message')} {data.get('errorcode')}")
jwt = data["data"]["jwtToken"]
print("login OK (client credentials valid)")


def mask(s):
    return (s[:4] + "..." + s[-4:]) if len(s) > 12 else (s[:2] + "..." if s else "(empty)")


print(f"api key fingerprint: len={len(API_KEY)} {mask(API_KEY)}")
print(f"jwt fingerprint:     len={len(jwt)} {mask(jwt)}")

HEADERS = {
    "Content-Type": "application/json", "Accept": "application/json",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": os.getenv("CLIENT_LOCAL_IP", "192.168.1.1"),
    "X-MACAddress": os.getenv("CLIENT_MAC", "aa:bb:cc:dd:ee:ff"),
    "X-UserType": "USER", "Authorization": jwt, "X-PrivateKey": API_KEY,
}

print("\n--- probe 1: ordinary REST market data (getLtpData) ---")
ltp = {}
try:
    fn = getattr(api, "getLtpData", None) or getattr(api, "ltpData", None)
    if fn is None:
        print("SDK has no LTP method - skipping")
    else:
        r = fn("NSE", "RELIANCE-EQ", "2885")
        ltp = {"ok": bool(isinstance(r, dict) and r.get("status")),
               "message": str(r.get("message", ""))[:160] if isinstance(r, dict) else str(r)[:160],
               "errorcode": str(r.get("errorcode", "")) if isinstance(r, dict) else ""}
except Exception as e:
    ltp = {"ok": False, "message": f"exception: {e}"}
print(ltp)

print("\n--- probe 2: optionGreek (NIFTY" + (f", {expiry})" if expiry else ") ---"))
grk = {}
if not expiry:
    print("no expiry available - skipping (pass as argv[1])")
else:
    try:
        resp = requests.post(
            "https://apiconnect.angelone.in/rest/secure/angelbroking/marketData/v1/optionGreek",
            headers=HEADERS, data=json.dumps({"name": "NIFTY", "expirydate": expiry}), timeout=15)
        d = resp.json()
        grk = {"http_status": resp.status_code,
               "ok": bool(d.get("status")),
               "message": str(d.get("message", ""))[:160],
               "errorcode": str(d.get("errorcode", "")),
               "rows": len(d.get("data") or []) if d.get("status") else 0}
    except Exception as e:
        grk = {"ok": False, "message": f"exception: {e}"}
print(grk)

print("\n================ VERDICT ================")
if ltp.get("ok") and grk.get("ok"):
    print("CASE_C: both REST probes work - the AG8004 was request-specific;")
    print("        the Tier-4 feed recovers on its own next probe. Nothing to do.")
elif ltp.get("ok") and not grk.get("ok"):
    print("CASE_A: ordinary REST works, optionGreek specifically rejected (AG8004).")
    print("        optionGreek-SPECIFIC authorization/entitlement. Check the app's")
    print("        service permissions on the Angel portal or raise with Angel support.")
elif not ltp.get("ok"):
    print("CASE_B: ALL REST market data rejected (AG8004) while login+WS work.")
    print("        App-level REST authorization issue (portal migration / static-IP")
    print("        binding / app entitlement) - NOT the API-key string. Check the")
    print("        app's registered static IP and permissions on the Angel portal.")
