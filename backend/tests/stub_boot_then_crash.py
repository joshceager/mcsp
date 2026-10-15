"""A "server" that reaches readiness and then dies (e.g. OOM under load).

Reaching the readiness marker first is the point: the crash therefore counts
as a *runtime* crash, which is the path that auto-restarts (capped).
"""
import sys
import time

print("Starting minecraft server version 1.21.1", flush=True)
print('Done (1.234s)! For help, type "help"', flush=True)
time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 0.5)
print("Exception in server tick loop", flush=True)
print("java.lang.OutOfMemoryError: Java heap space", flush=True)
sys.exit(1)
