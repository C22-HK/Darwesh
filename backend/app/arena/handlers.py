# HTTP layer for Darwesh Arena. Same shape as app.verification.handlers,
# deliberately: authenticate (401), rate limit (429), parse the JSON body
# (400), call into ArenaOps -- which owns every authorization and
# Firestore decision -- and translate an AccessOpsError into a safe
# external response. No handler here awards a point, decides a step
# transition or reads a permission from the request body.
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate, CallerContext
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.auth.reset import RateLimiter
from app.verification.handlers import PermissionReader

from .arena_ops import ArenaOps

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
class ArenaPublicHandler:
    """Everything a signed-in participant can do, plus fully public reads
    (challenge browsing, the leaderboard, ranks) which work signed-out
    too -- Arena is a marketing/competitive surface as much as a private
    account feature."""

    ops: ArenaOps
    auth: AuthGate
    read_limiter: RateLimiter
    write_limiter: RateLimiter
    logger: logging.Logger

    async def _optional_caller(self, request: Request) -> CallerContext | None:
        return await self.auth.authenticate(request)

    async def list_challenges(self, request: Request) -> JSONResponse:
        caller = await self._optional_caller(request)
        if not await self.read_limiter.allow(caller.uid if caller else request.client.host if request.client else "anon"):
            return _RATE_LIMITED
        status_filter = request.query_params.get("status")
        try:
            rows = await self.ops.list_challenges_for_viewer(
                uid=caller.uid if caller else None, status_filter=status_filter
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena list_challenges failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"challenges": rows})

    async def get_challenge(self, request: Request) -> JSONResponse:
        caller = await self._optional_caller(request)
        challenge_id = request.path_params.get("challengeId", "")
        try:
            result = await self.ops.get_challenge(challenge_id=challenge_id, uid=caller.uid if caller else None)
        except (ValidationError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena get_challenge failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def leaderboard(self, request: Request) -> JSONResponse:
        limit = _int_query(request, "limit", 50)
        try:
            rows = await self.ops.list_leaderboard(limit=limit)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena leaderboard failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"leaderboard": rows})

    async def ranks(self, request: Request) -> JSONResponse:
        try:
            rows = await self.ops.list_ranks()
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena ranks failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"ranks": rows})

    async def activity(self, request: Request) -> JSONResponse:
        uid = request.query_params.get("uid")
        challenge_id = request.query_params.get("challengeId")
        try:
            rows = await self.ops.list_activity_feed(uid=uid, challenge_id=challenge_id, limit=_int_query(request, "limit", 40))
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena activity failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"activity": rows})

    async def my_state(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            state = await self.ops.get_user_arena_state(uid=caller.uid)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena my_state failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(state)

    async def my_ledger(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            rows = await self.ops.list_ledger_for_user(uid=caller.uid, limit=_int_query(request, "limit", 100))
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena my_ledger failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"ledger": rows})

    async def my_submissions(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            rows = await self.ops.list_my_submissions(uid=caller.uid)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena my_submissions failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"submissions": rows})

    async def join_challenge(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        challenge_id = request.path_params.get("challengeId", "")
        try:
            result = await self.ops.join_challenge(challenge_id=challenge_id, uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena join_challenge failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def attach_property(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        submission_id = request.path_params.get("submissionId", "")
        try:
            result = await self.ops.attach_property(
                submission_id=submission_id,
                step_key=body.get("stepKey") or "",
                listing_ref=body.get("listingRef") or {},
                display_fields=body.get("displayFields") or {},
                property_source=body.get("propertySource") or "",
                owner_info=body.get("ownerInfo"),
                actor_uid=caller.uid,
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena attach_property failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def create_deal(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        submission_id = request.path_params.get("submissionId", "")
        try:
            result = await self.ops.create_deal(submission_id=submission_id, actor_uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena create_deal failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def advance_deal_stage(self, request: Request) -> JSONResponse:
        """Self-report path: ArenaOps.advance_deal_stage itself refuses
        any target beyond 'lead'/'contacted' unless `actor_is_admin` is
        True, so this handler passing False is what makes it structurally
        impossible for a participant to self-qualify a buyer or
        self-close a deal, regardless of what target stage they ask
        for."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        deal_id = request.path_params.get("dealId", "")
        try:
            result = await self.ops.advance_deal_stage(
                deal_id=deal_id,
                target_stage=body.get("targetStage") or "",
                actor_uid=caller.uid,
                actor_is_admin=False,
                note=body.get("note"),
                buyer_info=body.get("buyerInfo"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena advance_deal_stage failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def advance_step(self, request: Request) -> JSONResponse:
        """Self-report path only: a step with `requiredVerificationBy ==
        'admin'` can never be moved past 'verification_pending' here --
        ArenaOps.advance_step enforces that server-side regardless of
        what this handler is asked for, so a forged request can't
        self-complete an admin-gated step."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.write_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        submission_id = request.path_params.get("submissionId", "")
        step_key = request.path_params.get("stepKey", "")
        target_status = body.get("targetStatus") or ""
        if target_status == "completed":
            # The client may never directly claim 'completed' through this
            # public endpoint -- ArenaOps would reject it anyway for an
            # admin-gated step, but a 'none'-verification step should
            # also go through this exact same call, so we let ops decide;
            # this comment documents that the refusal for admin steps is
            # enforced in ArenaOps.advance_step, not here.
            pass
        try:
            result = await self.ops.advance_step(
                submission_id=submission_id,
                step_key=step_key,
                target_status=target_status,
                actor_uid=caller.uid,
                actor_is_admin=False,
                note=body.get("note"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena advance_step failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)


@dataclass
class ArenaAdminHandler:
    ops: ArenaOps
    auth: AuthGate
    permissions: PermissionReader
    admin_limiter: RateLimiter
    logger: logging.Logger

    async def _admin_write(self, request: Request, fn, *, required_permission: str = "arena.manage") -> JSONResponse:
        """`fn`'s third argument is TRUE if the caller may act as an
        Arena admin for this action -- either a real `role=='admin'`, or
        a non-admin holder of `required_permission` (the same granular,
        delegable-permission model referral_ops.write_reward_config uses
        for 'rewards.manage', not a raw admin-role check). Computed ONCE
        here, never re-derived inside a closure."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        perms = await self.permissions.permissions_for(caller)
        authorized = caller.is_admin or required_permission in perms
        try:
            result = await fn(body, caller.uid, authorized)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena admin write failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    # -- challenges ------------------------------------------------------

    async def create_challenge(self, request: Request) -> JSONResponse:
        async def run(body, actor_uid, is_authorized):
            challenge_id = await self.ops.create_challenge(data=body, actor_uid=actor_uid, actor_is_admin=is_authorized)
            return {"challengeId": challenge_id}

        return await self._admin_write(request, run)

    async def update_challenge(self, request: Request) -> JSONResponse:
        challenge_id = request.path_params.get("challengeId", "")

        async def run(body, actor_uid, is_authorized):
            await self.ops.update_challenge(challenge_id=challenge_id, data=body, actor_uid=actor_uid, actor_is_admin=is_authorized)
            return {"challengeId": challenge_id}

        return await self._admin_write(request, run)

    async def set_challenge_status(self, request: Request) -> JSONResponse:
        challenge_id = request.path_params.get("challengeId", "")

        async def run(body, actor_uid, is_admin):
            await self.ops.set_challenge_status(challenge_id=challenge_id, status=body.get("status") or "", actor_uid=actor_uid, actor_is_admin=is_admin)
            return {"challengeId": challenge_id, "status": body.get("status")}

        return await self._admin_write(request, run)

    async def delete_challenge(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        authorized = caller.is_admin or "arena.manage" in perms
        challenge_id = request.path_params.get("challengeId", "")
        try:
            await self.ops.delete_challenge(challenge_id=challenge_id, actor_uid=caller.uid, actor_is_admin=authorized)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena delete_challenge failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"challengeId": challenge_id, "deleted": True})

    # -- submissions -------------------------------------------------------

    async def list_submissions(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if "arena.review" not in perms:
            return _FORBIDDEN
        status_filter = request.query_params.get("status")
        challenge_id = request.query_params.get("challengeId")
        try:
            rows = await self.ops.list_submissions_for_review(status_filter=status_filter, challenge_id=challenge_id)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena admin list_submissions failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"submissions": rows})

    async def get_submission(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        submission_id = request.path_params.get("submissionId", "")
        try:
            result = await self.ops.get_submission(submission_id=submission_id, actor_uid=caller.uid, actor_permissions=perms)
        except (ValidationError, ForbiddenError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena admin get_submission failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def verify_step(self, request: Request) -> JSONResponse:
        """Admin/reviewer-gated step completion -- authorized by holding
        the `arena.review` permission (not necessarily `role=='admin'`,
        same granular model as verification.review elsewhere), checked
        ONCE here before the ops call, never re-derived mid-request."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if "arena.review" not in perms:
            return _FORBIDDEN
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        submission_id = request.path_params.get("submissionId", "")
        step_key = request.path_params.get("stepKey", "")
        try:
            result = await self.ops.advance_step(
                submission_id=submission_id,
                step_key=step_key,
                target_status=body.get("targetStatus") or "completed",
                actor_uid=caller.uid,
                actor_is_admin=True,
                note=body.get("note"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena verify_step failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def disqualify(self, request: Request) -> JSONResponse:
        submission_id = request.path_params.get("submissionId", "")

        async def run(body, actor_uid, is_authorized):
            return await self.ops.disqualify_participant(submission_id=submission_id, reason=body.get("reason") or "", actor_uid=actor_uid, actor_is_admin=is_authorized)

        return await self._admin_write(request, run, required_permission="arena.review")

    async def flag_submission(self, request: Request) -> JSONResponse:
        submission_id = request.path_params.get("submissionId", "")

        async def run(body, actor_uid, _is_authorized):
            await self.ops.flag_submission(submission_id=submission_id, flag_type=body.get("flagType") or "manual", detail=body.get("detail"), actor_uid=actor_uid)
            return {"submissionId": submission_id, "flagged": True}

        return await self._admin_write(request, run, required_permission="arena.review")

    # -- ledger / points ---------------------------------------------------

    async def list_ledger(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if "arena.manage" not in perms:
            return _FORBIDDEN
        try:
            rows = await self.ops.admin_list_ledger(uid_filter=request.query_params.get("uid"), limit=_int_query(request, "limit", 100))
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena admin list_ledger failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"ledger": rows})

    async def adjust_points(self, request: Request) -> JSONResponse:
        async def run(body, actor_uid, is_admin):
            return await self.ops.manual_point_adjustment(
                uid=body.get("uid") or "",
                points_delta=body.get("pointsDelta", 0),
                note=body.get("note") or "",
                actor_uid=actor_uid,
                actor_is_admin=is_admin,
                is_reversal=bool(body.get("isReversal", False)),
            )

        return await self._admin_write(request, run)

    # -- deals / CRM (the real business engine) -----------------------------

    async def list_deals(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin or "arena.review" in perms):
            return _FORBIDDEN
        try:
            rows = await self.ops.list_deals(
                challenge_id=request.query_params.get("challengeId"),
                stage_filter=request.query_params.get("stage"),
                uid=request.query_params.get("uid"),
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena admin list_deals failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"deals": rows})

    async def verify_deal_stage(self, request: Request) -> JSONResponse:
        """Admin/reviewer path for every deal stage a participant cannot
        self-report -- qualified, matched, viewing_scheduled,
        viewing_completed, negotiating, deal_pending, closed. Same
        permission model as verify_step."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin or "arena.review" in perms):
            return _FORBIDDEN
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        deal_id = request.path_params.get("dealId", "")
        try:
            result = await self.ops.advance_deal_stage(
                deal_id=deal_id,
                target_stage=body.get("targetStage") or "",
                actor_uid=caller.uid,
                actor_is_admin=True,
                note=body.get("note"),
                buyer_info=body.get("buyerInfo"),
                sale_value=body.get("saleValue"),
                city=body.get("city"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena verify_deal_stage failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    async def set_payment_state(self, request: Request) -> JSONResponse:
        deal_id = request.path_params.get("dealId", "")

        async def run(body, actor_uid, is_authorized):
            return await self.ops.set_payment_state(
                deal_id=deal_id, payment_state=body.get("paymentState") or "",
                actual_commission=body.get("actualCommission"), actor_uid=actor_uid, actor_is_admin=is_authorized,
            )

        return await self._admin_write(request, run)

    # -- commission rules -----------------------------------------------------

    async def list_commission_rules(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin or "arena.manage" in perms):
            return _FORBIDDEN
        try:
            rows = await self.ops.list_commission_rules()
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena list_commission_rules failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse({"commissionRules": rows})

    async def set_commission_rule(self, request: Request) -> JSONResponse:
        async def run(body, actor_uid, is_authorized):
            await self.ops.set_commission_rule(
                city=body.get("city") or "", min_percent=body.get("minPercent", 0), max_percent=body.get("maxPercent", 0),
                default_percent=body.get("defaultPercent", 0), actor_uid=actor_uid, actor_is_admin=is_authorized,
            )
            return {"city": body.get("city")}

        return await self._admin_write(request, run)

    # -- commercial dashboard --------------------------------------------------

    async def commercial_summary(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.admin_limiter.allow(caller.uid):
            return _RATE_LIMITED
        perms = await self.permissions.permissions_for(caller)
        if not (caller.is_admin or "arena.manage" in perms):
            return _FORBIDDEN
        challenge_id = request.path_params.get("challengeId", "")
        try:
            result = await self.ops.challenge_commercial_summary(challenge_id=challenge_id)
        except (ValidationError, NotFoundError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("arena commercial_summary failed", extra={"error": type(exc).__name__})
            return JSONResponse({"error": "Request failed."}, status_code=400)
        return JSONResponse(result)

    # -- ranks ---------------------------------------------------------------

    async def create_rank(self, request: Request) -> JSONResponse:
        async def run(body, actor_uid, is_admin):
            rank_id = await self.ops.create_rank(data=body, actor_uid=actor_uid, actor_is_admin=is_admin)
            return {"rankId": rank_id}

        return await self._admin_write(request, run)

    async def update_rank(self, request: Request) -> JSONResponse:
        rank_id = request.path_params.get("rankId", "")

        async def run(body, actor_uid, is_admin):
            await self.ops.update_rank(rank_id=rank_id, data=body, actor_uid=actor_uid, actor_is_admin=is_admin)
            return {"rankId": rank_id}

        return await self._admin_write(request, run)
