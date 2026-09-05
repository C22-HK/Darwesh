# HTTP layer for POST /api/v1/mam/chat -- the ONE endpoint MAM V2 exposes
# (section 6: "a single endpoint, not a REST surface per feature"). Same
# authenticate/rate-limit/parse/call/map-errors shape as
# app.access.handlers, with one deliberate difference: MAM is explicitly a
# PUBLIC feature (section 2 -- visitors chat with MAM before ever signing
# in), so a missing or invalid bearer token is never a 401 here. It simply
# means the caller proceeds as policy.PUBLIC_CALLER, same as any other
# anonymous visitor to buy.html/rent.html today. Only a caller who
# specifically tries an AUTHENTICATED-only tool (save_property etc.)
# without a valid token gets an explicit, honest "you need to sign in for
# that" response -- produced by orchestrator.py catching
# ToolAuthorizationError, not by this route layer rejecting the request
# up front.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate
from app.mam.orchestrator import Orchestrator
from app.mam.policy import PUBLIC_CALLER, MamCaller
from app.mam.rate_limit import MamRateLimiters
from app.mam.schemas import (
    ChatRequestError,
    ChatResponse,
    MapAction,
    ProfessionalCard,
    ProjectCard,
    PropertyCard,
    parse_chat_request,
)

_BAD_BODY = JSONResponse({"error": "Please provide a valid request body."}, status_code=400)
_RATE_LIMITED = JSONResponse({"error": "Too many requests. Please wait a moment and try again."}, status_code=429)


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


@dataclass
class MamHandler:
    orchestrator: Orchestrator
    auth: AuthGate  # never None -- MAM only needs SOME way to identify a returning signed-in caller optionally; see app.main.build_mam_handler for the "no Firebase credential at all" case (route not registered)
    rate_limiters: MamRateLimiters
    logger: logging.Logger

    async def chat(self, request: Request) -> JSONResponse:
        caller = await self._resolve_caller(request)

        client_ip = request.client.host if request.client else "unknown"
        if not await self.rate_limiters.allow(client_ip=client_ip, uid=caller.uid):
            return _RATE_LIMITED

        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY

        # A client-supplied session id is only ever a lookup key into this
        # backend's OWN session store (session.py) -- never itself trusted
        # data, and a guessed/foreign id at worst resolves to a fresh empty
        # session (see schemas.parse_chat_request's docstring).
        session_id_from_client = body.get("sessionId") if isinstance(body.get("sessionId"), str) else None
        parsed = parse_chat_request(body, session_id_from_client=session_id_from_client)
        if isinstance(parsed, ChatRequestError):
            return JSONResponse({"error": parsed.message}, status_code=400)

        try:
            response = await self.orchestrator.handle_turn(caller=caller, request=parsed)
        except Exception as exc:  # noqa: BLE001 -- must never crash the request or leak internals
            self.logger.error("mam: chat turn failed", extra={"error": str(exc)})
            return JSONResponse(
                {"error": "MAM couldn't process that just now. Please try again."}, status_code=500
            )

        return JSONResponse(_serialize_response(response), status_code=200)

    async def _resolve_caller(self, request: Request) -> MamCaller:
        """Missing/invalid token -> the public caller, never a 401 (see
        module docstring). A valid token -> a real MamCaller carrying the
        SAME verified uid/role app.access.caller_context.AuthGate already
        establishes for every other backend feature -- never re-derived
        from anything the client claims."""
        try:
            caller_ctx = await self.auth.authenticate(request)
        except Exception as exc:  # noqa: BLE001 -- an auth-layer hiccup must degrade to public, not break chat
            self.logger.warning("mam: auth check failed, treating as public caller", extra={"error": str(exc)})
            return PUBLIC_CALLER
        if caller_ctx is None:
            return PUBLIC_CALLER
        return MamCaller(uid=caller_ctx.uid, role=caller_ctx.role)


def _serialize_response(response: ChatResponse) -> dict[str, Any]:
    return {
        "message": response.message,
        "language": response.language,
        "cards": [_serialize_card(c) for c in response.cards],
        "comparison": response.comparison,
        "mapAction": _serialize_map_action(response.map_action),
        "suggestedActions": [
            {
                "labelKey": a.label_key,
                "labelFallback": a.label_fallback,
                "action": a.action,
                "payload": a.payload,
            }
            for a in response.suggested_actions
        ],
        "degraded": response.degraded,
        "sessionId": response.session_id,
    }


def _serialize_card(card: PropertyCard | ProjectCard | ProfessionalCard) -> dict[str, Any]:
    if isinstance(card, PropertyCard):
        return {
            "kind": card.kind,
            "listingId": card.listing_id,
            "title": card.title,
            "city": card.city,
            "price": card.price,
            "currency": card.currency,
            "dealType": card.deal_type,
            "propertyType": card.property_type,
            "beds": card.beds,
            "verified": card.verified,
            "imageUrl": card.image_url,
        }
    if isinstance(card, ProjectCard):
        return {
            "kind": card.kind,
            "projectId": card.project_id,
            "name": card.name,
            "city": card.city,
            "constructionStatus": card.construction_status,
            "startingPrice": card.starting_price,
            "currency": card.currency,
            "verified": card.verified,
        }
    return {
        "kind": card.kind,
        "providerId": card.provider_id,
        "displayName": card.display_name,
        "serviceType": card.service_type,
        "city": card.city,
        "verified": card.verified,
    }


def _serialize_map_action(action: MapAction | None) -> dict[str, Any] | None:
    if action is None:
        return None
    return {"target": action.target, "filters": action.filters, "focusListingId": action.focus_listing_id}
