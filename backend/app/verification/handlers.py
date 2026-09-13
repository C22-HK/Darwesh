# HTTP layer for the Verification, Referral and Reward endpoints.
#
# Same shape as app/access/handlers.py, deliberately: authenticate (401),
# rate limit by the caller's own uid (429), parse the JSON body (400),
# call into the ops layer -- which owns every authorization and Firestore
# decision -- and translate an AccessOpsError into a safe external
# response. No handler here computes a discount, decides a verification
# outcome or reads a permission from the request body.
#
# TWO RULES THIS MODULE EXISTS TO ENFORCE
# ---------------------------------------
#  * §AK -- the browser is never authoritative. A request may ASK for a
#    review decision; only an authenticated actor with the right
#    permission, checked in the ops layer, can cause one.
#  * §AN -- no raw evidence crosses this boundary. The only path to an
#    image is reveal_evidence's single, audited, short-lived signed URL.
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate, CallerContext
from app.access.constants import KNOWN_PERMISSIONS, PROTECTED_PERMISSIONS
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.permission_resolver import resolve_effective_permissions
from app.auth.reset import RateLimiter

from .archive_ops import ArchiveError, ArchiveOps
from .referral_ops import ReferralOps
from .verification_ops import ReviewDecision, VerificationOps

_UNAUTHENTICATED = JSONResponse({"error": "Authentication required."}, status_code=401)
_FORBIDDEN = JSONResponse({"error": "You do not have permission to perform this action."}, status_code=403)
_NOT_FOUND = JSONResponse({"error": "Not found."}, status_code=404)
_RATE_LIMITED = JSONResponse({"error": "Too many requests. Please wait a while and try again."}, status_code=429)
_BAD_BODY = JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

# Deliberately identical for a malformed code and a code that does not
# exist (§O): any difference between the two turns this endpoint into an
# oracle for which referral codes are real.
_INVALID_CODE = JSONResponse({"error": "That referral code isn't valid."}, status_code=404)


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


def _map_ops_error(exc: Exception) -> JSONResponse:
    """ValidationError/ConflictError messages in this package are
    author-written and safe to show. ForbiddenError and NotFoundError are
    flattened to fixed text -- "missing required permission:
    verification.documents.view" tells a caller exactly which capability
    to go after, and "no verification case for this user" confirms
    whether a stranger has one."""
    if isinstance(exc, ValidationError):
        return JSONResponse({"error": str(exc)}, status_code=400)
    if isinstance(exc, ConflictError):
        return JSONResponse({"error": str(exc)}, status_code=409)
    if isinstance(exc, ForbiddenError):
        return _FORBIDDEN
    if isinstance(exc, NotFoundError):
        return _NOT_FOUND
    return JSONResponse({"error": "Request failed."}, status_code=400)


def _string_field(body: dict, key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) else None


class PermissionReader:
    """Resolves the caller's effective permission NAMES for the ops layer.

    A `role == 'admin'` caller gets the full catalogue, matching
    firestore.rules' isAdmin() short-circuit -- including the PROTECTED
    keys, which is the entire point of that set: 'verification.account.close'
    can never be delegated to a non-admin through role defaults or
    per-user overrides, so a real admin account is the only thing that
    can ever hold it.

    Everyone else gets exactly what resolve_effective_permissions()
    grants, which is the same algorithm firestore.rules' hasPermission()
    is mirrored from -- so this backend can never act on a permission the
    rules layer would refuse.
    """

    _ADMIN_PERMISSIONS = frozenset(KNOWN_PERMISSIONS) | frozenset(PROTECTED_PERMISSIONS)

    def __init__(self, db) -> None:
        self._db = db

    async def permissions_for(self, caller: CallerContext) -> set[str]:
        if caller.is_admin:
            return set(self._ADMIN_PERMISSIONS)
        return await asyncio.to_thread(self._read, caller.uid)

    def _read(self, uid: str) -> set[str]:
        snap = self._db.collection("users").document(uid).get()
        if not getattr(snap, "exists", False):
            return set()
        data = snap.to_dict() or {}
        account_type = data.get("accountType")
        role_defaults = None
        if isinstance(account_type, str) and account_type:
            rd = self._db.collection("rolePermissionDefaults").document(account_type).get()
            role_defaults = rd.to_dict() if getattr(rd, "exists", False) else None
        resolved = resolve_effective_permissions(
            account_type=account_type,
            role_defaults=role_defaults,
            overrides=data.get("permissionOverrides"),
        )
        return {k for k, v in resolved.items() if v is True}


@dataclass
class ReferralPublicHandler:
    """The one unauthenticated endpoint in this package: "is this code
    real?", asked during signup before a Firebase account exists.

    Rate limited by client address rather than uid because there is no
    uid yet. That is a throttle, never evidence of fraud -- §AJ forbids
    treating a shared network as proof, and nothing here records or acts
    on the address beyond counting requests in a window.
    """

    ops: ReferralOps
    limiter: RateLimiter
    logger: logging.Logger

    async def check_code(self, request: Request) -> JSONResponse:
        client_key = request.client.host if request.client else "unknown"
        if not await self.limiter.allow(f"referral_check:{client_key}"):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        try:
            referrer = await asyncio.to_thread(self.ops.resolve_code, body.get("code"))
        except (NotFoundError, ValidationError):
            return _INVALID_CODE
        except Exception as exc:  # noqa: BLE001
            self.logger.error("referral code check failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"valid": True, **referrer.to_dict()})


@dataclass
class VerificationHandler:
    """Everything a signed-in person can do about their OWN verification
    and referral state, plus the admin review surface."""

    verification: VerificationOps
    referrals: ReferralOps
    archives: ArchiveOps
    auth: AuthGate
    permissions: PermissionReader
    submit_limiter: RateLimiter
    read_limiter: RateLimiter
    admin_limiter: RateLimiter
    reveal_limiter: RateLimiter
    logger: logging.Logger

    # -- self-service -------------------------------------------------

    async def me(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            case = await asyncio.to_thread(self.verification.own_case_view, caller.uid)
            network = await asyncio.to_thread(self.referrals.my_network, caller.uid)
            config = await asyncio.to_thread(self.referrals.read_reward_config)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("verification self-read failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"case": case, "network": network, "rewardConfig": config})

    async def submit(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.submit_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        evidence = body.get("evidence")
        if evidence is not None and not isinstance(evidence, list):
            return JSONResponse({"error": "'evidence' must be a list."}, status_code=400)
        try:
            result = await asyncio.to_thread(
                lambda: self.verification.submit_case(
                    uid=caller.uid,
                    track=_string_field(body, "track") or "identity",
                    evidence=evidence,
                    id_name=_string_field(body, "idName"),
                    consent_version=_string_field(body, "consentVersion"),
                )
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("verification submit failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def claim_referral(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.submit_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        try:
            result = await asyncio.to_thread(
                lambda: self.referrals.claim_referral(referred_uid=caller.uid, raw_code=body.get("code"))
            )
        except NotFoundError:
            return _INVALID_CODE
        except (ValidationError, ForbiddenError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("referral claim failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    # -- admin review -------------------------------------------------

    async def admin_metrics(self, request: Request) -> JSONResponse:
        return await self._admin_read(
            request, lambda perms, _body: self.verification.dashboard_metrics(actor_permissions=perms)
        )

    async def admin_list_cases(self, request: Request) -> JSONResponse:
        status = request.query_params.get("status")
        return await self._admin_read(
            request,
            lambda perms, _body: {
                "cases": self.verification.list_cases(actor_permissions=perms, status=status or None)
            },
        )

    async def admin_case_detail(self, request: Request) -> JSONResponse:
        uid = request.path_params.get("uid", "")
        return await self._admin_read(
            request, lambda perms, _body: self.verification.case_detail(uid=uid, actor_permissions=perms)
        )

    async def admin_list_referrals(self, request: Request) -> JSONResponse:
        status = request.query_params.get("status")
        return await self._admin_read(
            request,
            lambda perms, _body: {
                "referrals": self.referrals.admin_list_referrals(actor_permissions=perms, status=status or None)
            },
        )

    async def admin_reward_config(self, request: Request) -> JSONResponse:
        return await self._admin_read(request, lambda _perms, _body: self.referrals.read_reward_config())

    async def admin_review_case(self, request: Request) -> JSONResponse:
        uid = request.path_params.get("uid", "")

        def run(perms: set[str], body: dict, actor_uid: str):
            account_status = body.get("accountStatus")
            return self.verification.review_case(
                uid=uid,
                decision=ReviewDecision(
                    status=_string_field(body, "status") or "",
                    account_status=account_status if isinstance(account_status, str) else None,
                    reason=_string_field(body, "reason") or "",
                ),
                actor_uid=actor_uid,
                actor_permissions=perms,
            )

        return await self._admin_write(request, run)

    async def admin_set_face_result(self, request: Request) -> JSONResponse:
        uid = request.path_params.get("uid", "")

        def run(perms: set[str], body: dict, actor_uid: str):
            return self.verification.set_face_result(
                uid=uid,
                result=_string_field(body, "result") or "",
                actor_uid=actor_uid,
                actor_permissions=perms,
            )

        return await self._admin_write(request, run)

    async def admin_reveal_evidence(self, request: Request) -> JSONResponse:
        """Its own, much tighter rate limiter: this is the single most
        sensitive action in the package, and a burst of reveals is worth
        stopping even when each one individually is authorized."""
        uid = request.path_params.get("uid", "")

        def run(perms: set[str], body: dict, actor_uid: str):
            return self.verification.reveal_evidence(
                uid=uid,
                evidence_id=_string_field(body, "evidenceId") or "",
                actor_uid=actor_uid,
                actor_permissions=perms,
            )

        return await self._admin_write(request, run, limiter=self.reveal_limiter)

    async def admin_set_referral_status(self, request: Request) -> JSONResponse:
        referral_id = request.path_params.get("referralId", "")

        def run(perms: set[str], body: dict, actor_uid: str):
            if "referrals.review" not in perms:
                raise ForbiddenError("missing required permission: referrals.review")
            return self.referrals.admin_set_status(
                referral_id,
                _string_field(body, "status") or "",
                actor_uid=actor_uid,
                reason=_string_field(body, "reason") or "",
            )

        return await self._admin_write(request, run)

    async def admin_correct_referrer(self, request: Request) -> JSONResponse:
        def run(perms: set[str], body: dict, actor_uid: str):
            if "referrals.review" not in perms:
                raise ForbiddenError("missing required permission: referrals.review")
            return self.referrals.admin_correct_referrer(
                referred_uid=_string_field(body, "referredUid") or "",
                new_code=body.get("code"),
                actor_uid=actor_uid,
                reason=_string_field(body, "reason") or "",
            )

        return await self._admin_write(request, run)

    async def admin_save_reward_config(self, request: Request) -> JSONResponse:
        def run(perms: set[str], body: dict, actor_uid: str):
            return self.referrals.write_reward_config(body, actor_uid=actor_uid, actor_permissions=perms)

        return await self._admin_write(request, run)

    async def admin_archive_case(self, request: Request) -> JSONResponse:
        """§AT. The ops layer refuses to delete live evidence without a
        receipt proving all six archive checks passed; an ArchiveError
        here means it stopped rather than deleted, which is the correct
        and only acceptable outcome of a failed archive."""
        uid = request.path_params.get("uid", "")

        def run(perms: set[str], body: dict, actor_uid: str):
            if "archives.view" not in perms:
                raise ForbiddenError("missing required permission: archives.view")
            # Evidence bytes are read from live storage inside the ops
            # layer -- they never travel through this request.
            return self.archives.archive_case(uid, actor_uid=actor_uid)

        return await self._admin_write(request, run)

    # -- shared plumbing ----------------------------------------------

    async def _admin_read(self, request: Request, fn) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        try:
            result = await asyncio.to_thread(lambda: fn(perms, {}))
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("verification admin read failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def _admin_write(self, request: Request, fn, *, limiter: RateLimiter | None = None) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await (limiter or self.admin_limiter).allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        perms = await self.permissions.permissions_for(caller)
        try:
            result = await asyncio.to_thread(lambda: fn(perms, body, caller.uid))
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except ArchiveError as exc:
            # Surfaced verbatim and as a 409: an archive that did not
            # verify must read as a refusal to proceed, never as a
            # generic failure the caller might retry blindly.
            return JSONResponse({"error": str(exc)}, status_code=409)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("verification admin write failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)
