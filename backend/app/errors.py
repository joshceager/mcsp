"""Typed API errors with stable machine codes."""


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def bad_request(message: str, code: str = "bad_request", **details) -> ApiError:
    return ApiError(400, code, message, details)


def not_found(message: str, code: str = "not_found", **details) -> ApiError:
    return ApiError(404, code, message, details)


def conflict(message: str, code: str = "conflict", **details) -> ApiError:
    return ApiError(409, code, message, details)


def admin_disabled() -> ApiError:
    """Fail closed: no admin key configured -> all admin ops disabled."""
    return ApiError(
        503,
        "admin_disabled",
        "Administration is disabled because no admin API key is configured on the server. "
        "The owner must set MCSP_ADMIN_KEY to enable management operations.",
    )


def unauthorized() -> ApiError:
    return ApiError(401, "unauthorized", "Invalid or missing admin key.")


def unavailable(message: str, code: str = "unavailable", **details) -> ApiError:
    return ApiError(503, code, message, details)


def internal(message: str, code: str = "internal_error", **details) -> ApiError:
    return ApiError(500, code, message, details)
