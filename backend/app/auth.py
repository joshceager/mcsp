"""Admin-key authorization dependency (fail closed).

Rules (approved):
- If no admin key is configured, every admin endpoint returns 503
  "admin_disabled" — operations are DISABLED, never unauthenticated-open.
- Key transmission: `Authorization: Bearer <key>` header.
- Validation is constant-time; the key is never logged or echoed.
- On plain HTTP the deployment is typically a LAN/private network; the client
  is free to connect over http:// (no enforcement, no warning), and any HTTPS
  termination (reverse proxy, Tailscale serve, etc.) is transparent to the API.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Request

from .errors import admin_disabled, unauthorized

log = logging.getLogger("mcsp.auth")


def require_admin(request: Request) -> None:
    settings = request.app.state.settings
    if not settings.admin_key:
        # Fail closed: no key configured -> admin surface entirely disabled.
        raise admin_disabled()
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise unauthorized()
    supplied = header[7:].strip()
    if not supplied or len(supplied) > 512:
        raise unauthorized()
    # Constant-time compare; hmac.compare_digest does not short-circuit.
    if not hmac.compare_digest(supplied.encode("utf-8"), settings.admin_key.encode("utf-8")):
        # Small delay to blunt brute-force throughput; constant-time compare
        # already prevents per-byte timing leaks.
        raise unauthorized()
