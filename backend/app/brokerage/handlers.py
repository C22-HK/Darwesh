# HTTP layer for the Brokerage Fee Discount system (Phase 1). Same shape
# as app.alerts.handlers: authenticate (401), rate limit (429), require
# admin + 'brokerage.manage' (403) -- every single route here is
# admin-only by design. There is no public/self-service handler: a normal
# user must never see or edit their own brokerage discount (explicit
# requirement), so unlike Alerts there is nothing here for a plain
# authenticated caller to reach at all.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate
from app.access.errors import NotFoundError, ValidationError
from app.auth.reset import RateLimiter
from app.verification.handlers import PermissionReader

from .brokerage_ops import BrokerageOps

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


def _float_query(request: Request, key: str) -> float | None:
    raw = request.query_params.get(key)
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _bool_query(request: Request, key: str) -> bool:
    return (request.query_params.get(key) or "").strip().lower() in ("1", "true", "yes")


@dataclass
class BrokerageAdminHandler:
    ops: BrokerageOps
    auth: AuthGate
    permissions: PermissionReader
    admin_limiter: RateLimiter
    logger: logging.Logger

    async def _admin_caller(self, request: Request):
        caller = await self.auth.authenticate(request)
        if caller is None:
            return None, _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return None, _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin and "brokerage.manage" in perms):
            return None, _FORBIDDEN
        return caller, None

    async def list_accounts(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        try:
            result = await self.ops.list_accounts(
                search=request.query_params.get("search"),
                account_type=request.query_params.get("accountType"),
                city=request.query_params.get("city"),
                discount_min=_float_query(request, "discountMin"),
                discount_max=_float_query(request, "discountMax"),
                no_discount_only=_bool_query(request, "noDiscountOnly"),
                cursor=request.query_params.get("cursor"),
                limit=_int_query(request, "limit", 50),
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage list_accounts failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def get_account(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        uid = request.path_params.get("uid", "")
        try:
            result = await self.ops.get_account_discount(uid=uid)
        except (ValidationError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage get_account failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def set_discount(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        uid = request.path_params.get("uid", "")
        op = body.get("op") or "set"
        try:
            if op == "disable":
                result = await self.ops.disable_discount(
                    admin_uid=caller.uid,
                    admin_role=caller.role or "admin",
                    target_uid=uid,
                    reason=body.get("reason"),
                )
            elif op == "enable":
                result = await self.ops.enable_discount(
                    admin_uid=caller.uid,
                    admin_role=caller.role or "admin",
                    target_uid=uid,
                    reason=body.get("reason"),
                )
            elif op == "remove":
                result = await self.ops.remove_discount(
                    admin_uid=caller.uid,
                    admin_role=caller.role or "admin",
                    target_uid=uid,
                    reason=body.get("reason"),
                )
            else:
                result = await self.ops.set_discount(
                    admin_uid=caller.uid,
                    admin_role=caller.role or "admin",
                    target_uid=uid,
                    percent=body.get("percent"),
                    active=body.get("active", True),
                    reason=body.get("reason"),
                )
        except (ValidationError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage set_discount failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def bulk_set_discount(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        try:
            result = await self.ops.bulk_set_discount(
                admin_uid=caller.uid,
                admin_role=caller.role or "admin",
                target_uids=body.get("accountIds"),
                percent=body.get("percent"),
                active=body.get("active", True),
                reason=body.get("reason"),
            )
        except ValidationError as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage bulk_set_discount failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def list_history(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        try:
            rows = await self.ops.list_history(
                uid=request.query_params.get("uid"), limit=_int_query(request, "limit", 50)
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage list_history failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"history": rows})

    async def compute_fee(self, request: Request) -> JSONResponse:
        caller, err = await self._admin_caller(request)
        if err is not None:
            return err
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        uid = body.get("uid")
        if not isinstance(uid, str) or not uid.strip():
            return JSONResponse({"error": "'uid' is required."}, status_code=400)
        try:
            result = await self.ops.compute_fee(
                admin_uid=caller.uid,
                target_uid=uid.strip(),
                original_fee=body.get("originalFee"),
                currency=body.get("currency") or "USD",
                record=bool(body.get("record", False)),
                note=body.get("note"),
            )
        except (ValidationError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("brokerage compute_fee failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)
