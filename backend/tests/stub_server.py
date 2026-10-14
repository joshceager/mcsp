"""Stub Minecraft server used by the test suite.

Mimics the observable behavior the supervisor relies on:
- prints startup lines, then 'Done (...s)! For help, type "help"' when ready
- responds to stdin console commands
- graceful exit on 'stop'
- exits non-zero if MCSP_STUB_FAIL=1 (startup failure tests)
- --installforcereloading flag accepted for the java-check invocation
"""

import os
import sys
import time

if "--installforcereloading" in sys.argv:  # supervisor's java presence check
    sys.exit(0)

if os.environ.get("MCSP_STUB_FAIL") == "1":
    print("Exception in server tick loop", flush=True)
    print("java.lang.OutOfMemoryError", flush=True)
    sys.exit(1)

print("Starting minecraft server version 1.21.1", flush=True)
print("Loading properties", flush=True)
print("Preparing level \"world\"", flush=True)
print("Done (1.234s)! For help, type \"help\"", flush=True)

for line in sys.stdin:
    cmd = line.strip()
    if cmd.lower() == "stop":
        print("Stopping server", flush=True)
        break
    if cmd:
        print(f"[server] ran: {cmd}", flush=True)

print("Server stopped", flush=True)
