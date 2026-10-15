"""A "server" that only reaches readiness after a delay (slow first boot).

Used to prove a new start waits for *its own* readiness line instead of reusing
the previous run's line from the shared ring buffer.
"""
import sys
import time

delay = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
print("Starting minecraft server version 1.21.1", flush=True)
time.sleep(delay)
print('Done (1.234s)! For help, type "help"', flush=True)
for line in sys.stdin:
    if line.strip().lower() == "stop":
        print("Stopping server", flush=True)
        break
print("Server stopped", flush=True)
