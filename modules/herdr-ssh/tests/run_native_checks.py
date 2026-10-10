"""Run native checks only after the disposable SSH fixture is listening."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[1]
port = 22265
with tempfile.TemporaryFile(mode="w+") as log:
    fixture = subprocess.Popen(
        [sys.executable, str(root / "tests/tailscale_fixture.py"), str(port)],
        stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 10
        while True:
            if fixture.poll() is not None:
                raise RuntimeError("SSH fixture exited before becoming ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("SSH fixture did not become ready")
                time.sleep(0.05)
        subprocess.run(
            [str(root / ".build/debug/NativeChecks")], check=True, timeout=90,
            env={**os.environ, "TAILSCALE_TEST_PORT": str(port)},
        )
    finally:
        fixture.terminate()
        fixture.wait(timeout=5)
        log.seek(0)
        print(log.read())
