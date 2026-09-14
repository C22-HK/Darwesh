# HTTP layer for Property Watch / Area Alerts. Same shape as
# app.arena.handlers: authenticate (401), rate limit (429), parse the JSON
# body (400), call into AlertsOps -- which owns every authorization and
# Firestore decision -- and translate an AccessOpsError into a safe
# external response. No handler here decides a match or writes a
# notification.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate, CallerContext
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.auth.reset import RateLimiter
from app.verification.handlers import PermissionReader

from .alerts_ops import AlertsOps

_UNAUTHENTICATED = JSONResponse({"error": "Authentication required."}, status_code=401)
_FORBIDDEN = JSONResponse({"error": "You do not have permission to perform this action."}, status_code=403)
_NOT_FOUND = JSONResponse({"error": "Not found."}, status_code=404)
_RATE_LIMITED = JSONResponse({"error": "Too many requests. Please wait a while and try again."}, status_code=429)
_BAD_BODY = JSONResponse({"error": "Please provide a valid request body."}, status_code=400)


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


def _map_ops_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, ValidationError):
        return JSONResponse({"error": str(exc)}, status_code=400)
    if isinstance(exc, ConflictError):
        return JSONResponse({"error": str(exc)}, status_code=409)
    if isinstance(exc, ForbiddenError):
        return _FORBIDDEN
    if isinstance(exc, NotFoundError):
        return _NOT_FOUND
    return JSONResponse({"error": "Request failed."}, status_code=400)


def _int_query(request: Request, key: str, default: int) -> int:
    raw = request.query_params.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass
class AlertsPublicHandler:
    """Every route here requires a signed-in caller -- unlike Arena, an
    Area Alert is never a signed-out-readable surface (it IS someone's
    saved search)."""

    ops: AlertsOps
    auth: AuthGate
    read_limiter: RateLimiter
    write_limiter: RateLimiter
    logger: logging.Logger

    async def _caller(self, request: Request) -> CallerContext | None:
        return await self.auth.authenticate(request)

    async def create_alert(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        try:
            result = await self.ops.create_alert(
                uid=caller.uid,
                name=body.get("name"),
                area=body.get("area"),
                filters=body.get("filters"),
                notify_mode=body.get("notifyMode") or "instant",
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts create_alert failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def list_my_alerts(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            rows = await self.ops.list_my_alerts(uid=caller.uid)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts list_my_alerts failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"alerts": rows})

    async def update_alert(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        alert_id = request.path_params.get("alertId", "")
        try:
            result = await self.ops.update_alert(
                alert_id=alert_id,
                uid=caller.uid,
                name=body.get("name"),
                area=body.get("area"),
                filters=body.get("filters"),
                notify_mode=body.get("notifyMode"),
                status=body.get("status"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts update_alert failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def delete_alert(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        alert_id = request.path_params.get("alertId", "")
        try:
            await self.ops.delete_alert(alert_id=alert_id, uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts delete_alert failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"alertId": alert_id, "deleted": True})

    async def list_matches(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        alert_id = request.path_params.get("alertId", "")
        try:
            rows = await self.ops.list_matches(
                alert_id=alert_id,
                uid=caller.uid,
                actor_is_admin=caller.is_admin,
                limit=_int_query(request, "limit", 50),
            )
        except (ValidationError, ForbiddenError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts list_matches failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"matches": rows})

    async def mark_match_viewed(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        match_id = request.path_params.get("matchId", "")
        try:
            await self.ops.mark_match_viewed(match_id=match_id, uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts mark_match_viewed failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"matchId": match_id, "viewed": True})

    async def notify_listing(self, request: Request) -> JSONResponse:
        """The publish-time hook. Any authenticated caller may call this
        -- it carries nothing but a listing id, and AlertsOps re-fetches
        and re-validates that listing itself before doing anything, so a
        caller can never force a match/notification through this route
        for a listing that isn't genuinely public/active/verified."""
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        listing_id = body.get("listingId")
        if not isinstance(listing_id, str) or not listing_id.strip():
            return JSONResponse({"error": "'listingId' is required."}, status_code=400)
        try:
            result = await self.ops.notify_new_listing(listing_id=listing_id.strip())
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts notify_listing failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def list_notifications(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            rows = await self.ops.list_notifications(uid=caller.uid, limit=_int_query(request, "limit", 40))
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts list_notifications failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"notifications": rows})

    async def mark_notification_read(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        notification_id = request.path_params.get("notificationId", "")
        try:
            await self.ops.mark_notification_read(notification_id=notification_id, uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts mark_notification_read failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"notificationId": notification_id, "read": True})

    async def mark_all_notifications_read(self, request: Request) -> JSONResponse:
        caller = await self._caller(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            await self.ops.mark_all_notifications_read(uid=caller.uid)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts mark_all_notifications_read failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"read": True})


@dataclass
class AlertsAdminHandler:
    ops: AlertsOps
    auth: AuthGate
    permissions: PermissionReader
    admin_limiter: RateLimiter
    logger: logging.Logger

    async def summary(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin or "alerts.review" in perms):
            return _FORBIDDEN
        try:
            result = await self.ops.admin_summary()
        except Exception as exc:  # noqa: BLE001
            self.logger.error("alerts admin summary failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)
