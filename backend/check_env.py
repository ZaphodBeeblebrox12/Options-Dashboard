"""Environment diagnostic script. Run this before starting the server."""
import os
import sys

print("=" * 60)
print("  NIFTY Dashboard Environment Check")
print("=" * 60)

# 1. Python version
print(f"\n[1] Python: {sys.version.split()[0]}")

# 2. SmartApi availability
try:
    from SmartApi import SmartConnect
    from SmartApi.smartWebSocketV2 import SmartWebSocketV2
    print("[2] smartapi-python: ✓ INSTALLED")
except ImportError as e:
    print(f"[2] smartapi-python: ✗ MISSING — {e}")
    print("    Fix: pip install smartapi-python pyotp")

# 3. pyotp
try:
    import pyotp
    print("[3] pyotp: ✓ INSTALLED")
except ImportError:
    print("[3] pyotp: ✗ MISSING")
    print("    Fix: pip install pyotp")

# 4. Other deps
deps = ["fastapi", "uvicorn", "pydantic", "pandas", "requests", "numpy", "scipy", "dotenv"]
for dep in deps:
    try:
        __import__(dep)
        print(f"[4] {dep}: ✓")
    except ImportError:
        print(f"[4] {dep}: ✗ MISSING")

# 5. .env file
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    print(f"\n[5] .env file: ✓ FOUND at {env_path}")
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    creds = {
        "API_KEY": os.getenv("API_KEY", "").strip(),
        "CLIENT_CODE": os.getenv("CLIENT_CODE", "").strip(),
        "PASSWORD": os.getenv("PASSWORD", "").strip(),
        "TOTP_SECRET": os.getenv("TOTP_SECRET", "").strip(),
    }
    for k, v in creds.items():
        status = "✓ SET" if v else "✗ EMPTY"
        masked = v[:4] + "..." if len(v) > 4 else ("[empty]" if not v else v)
        print(f"    {k}: {status} ({masked})")
else:
    print(f"\n[5] .env file: ✗ NOT FOUND")
    print(f"    Expected: {env_path}")
    print("    Fix: cp .env.example .env  &&  edit with your credentials")

print("\n" + "=" * 60)
print("  Run this script again after fixing any ✗ items above.")
print("=" * 60)
