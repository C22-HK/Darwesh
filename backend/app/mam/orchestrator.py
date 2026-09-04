# The ASK -> UNDERSTAND -> TOOLS -> ACT -> STRUCTURED RESULT loop
# (section 1). This is the ONE place that decides, per turn: try the
# deterministic resolver first (cheap, no model call -- section 23),
# then a live provider if one is configured, then the honest degraded
# state if neither produced an answer. Nothing here imports a provider
# SDK -- `provider` is typed as the base.ChatProvider Protocol (or None),
# so this file is identical regardless of which adapter app.main
# constructed.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, replace
from typing import Any

from app.mam.intent_resolver import ResolvedIntent, resolve_intent
from app.mam.policy import MamCaller, ToolAuthorizationError
from app.mam.prompts import build_system_instruction
from app.mam.providers.base import ChatProvider, ChatTurn, ModelTier, ProviderNotConfiguredError
from app.mam.schemas import (
    ChatRequest,
    ChatResponse,
    MapAction,
    ProfessionalCard,
    ProjectCard,
    PropertyCard,
    SuggestedAction,
)
from app.mam.session import SessionStore
from app.mam.tools import ToolExecutionError, Tools, build_tool_specs, dispatch

# Bounds a single visitor turn's tool-call exchange with a live provider
# to a small, fixed number of real API round trips -- never an infinite
# loop chasing a model that keeps requesting tools instead of answering.
# Exhausting this without a final answer is treated as a provider
# failure (raises, caught by handle_turn's generic except below, same
# honest degraded response as any other provider error) rather than
# returning a half-finished answer.
_MAX_TOOL_ROUNDS = 4

_DEGRADED_MESSAGE = {
    "en": "MAM's AI reasoning is temporarily unavailable, but I can still help with navigation and basic lookups -- try asking to open the map, or name a city or service you're interested in.",
    "ar": "الذكاء الاصطناعي لدى MAM غير متوفر مؤقتًا، لكن يمكنني ما زلت المساعدة في التنقل والاستعلامات الأساسية -- جرّب أن تطلب فتح الخريطة، أو اذكر مدينة أو خدمة تهمك.",
    "ku": "زیرەکی دەستکردی MAM بۆ ماوەیەک بەردەست نییە، بەڵام هێشتا دەتوانم یارمەتیت بدەم بۆ ڕێنیشاندان و پرسیارە سادەکان -- هەوڵبدە داوا بکە نەخشەکە بکرێتەوە، یان ناوی شارێک یان خزمەتگوزاریەک بڵێ کە حەزت لێیەتی.",
}


@dataclass
class Orchestrator:
    tools: Tools
    sessions: SessionStore
    provider: ChatProvider | None
    logger: logging.Logger

    async def handle_turn(self, *, caller: MamCaller, request: ChatRequest) -> ChatResponse:
        session = self.sessions.get_or_create(request.session_id or None)
        session.append("user", request.message)

        resolved = resolve_intent(request.message)
        if resolved is not None:
            response = await self._respond_from_intent(caller, resolved, request.language)
            session.append("assistant", response.message)
            return replace(response, session_id=session.session_id)

        if self.provider is not None:
            try:
                response = await self._respond_from_provider(caller, request, session_id=session.session_id)
                session.append("assistant", response.message)
                return response
            except ProviderNotConfiguredError:
                pass  # falls through to the degraded response below -- expected this phase
            except Exception as exc:  # noqa: BLE001 -- a provider failure must never crash the request
                self.logger.error("mam: provider call failed, degrading", extra={"error": str(exc)})

        degraded_text = _DEGRADED_MESSAGE.get(request.language, _DEGRADED_MESSAGE["en"])
        session.append("assistant", degraded_text)
        return ChatResponse(
            message=degraded_text, language=request.language, degraded=True, session_id=session.session_id
        )

    async def _respond_from_intent(
        self, caller: MamCaller, resolved: ResolvedIntent, language: str
    ) -> ChatResponse:
        if resolved.tool_name is None:
            return ChatResponse(message=resolved.reply_fallback or "", language=language)
        try:
            result = await dispatch(self.tools, caller, resolved.tool_name, resolved.arguments)
        except ToolAuthorizationError:
            return ChatResponse(
                message={
                    "en": "You'll need to sign in for that.",
                    "ar": "يجب تسجيل الدخول لهذا الإجراء.",
                    "ku": "پێویستە بچیتە ژوورەوە بۆ ئەم کردارە.",
                }.get(language, "You'll need to sign in for that."),
                language=language,
            )
        except ToolExecutionError as exc:
            return ChatResponse(message=str(exc), language=language)
        return _build_response(resolved.tool_name, resolved.arguments, result, language)

    async def _respond_from_provider(
        self, caller: MamCaller, request: ChatRequest, *, session_id: str
    ) -> ChatResponse:
        # ASK -> UNDERSTAND -> TOOLS -> ACT -> STRUCTURED RESULT, with a
        # live provider: each round asks the model for a turn; if it
        # requests tools, EVERY call goes through the exact same
        # authorized, policy-checked app.mam.tools.dispatch() path
        # _respond_from_intent uses above -- the model never touches
        # Firestore, never decides authorization, and never sees a tool
        # result the caller wasn't allowed to receive (a denied/failed
        # call is fed back as a small {"error": ...} result, not raised
        # past this method, so the model can react in its own final
        # answer rather than the whole turn crashing over one bad call).
        # Bounded by _MAX_TOOL_ROUNDS -- see its own docstring.
        #
        # This is a text-only response path today: it returns the
        # model's final prose, not structured cards -- the deterministic
        # path above remains the only source of card/comparison/map-
        # action data. Populating those for an AI-driven answer too is a
        # reasonable later enhancement, not implemented this pass.
        system_instruction = build_system_instruction(language=request.language)
        history = [ChatTurn(role=t.role, content=t.text) for t in self.sessions.get_or_create(session_id).turns]
        tool_specs = build_tool_specs()

        for _round in range(_MAX_TOOL_ROUNDS):
            provider_response = await self.provider.generate(  # type: ignore[union-attr]
                system_instruction=system_instruction,
                history=history,
                tools=tool_specs,
                tier=ModelTier.FAST,
                max_output_tokens=800,
            )
            if not provider_response.tool_calls:
                return ChatResponse(message=provider_response.text or "", language=request.language)

            history.append(ChatTurn(role="assistant", content="", tool_calls=tuple(provider_response.tool_calls)))
            for call in provider_response.tool_calls:
                try:
                    result: dict[str, Any] = await dispatch(self.tools, caller, call.tool_name, call.arguments)
                except ToolAuthorizationError:
                    result = {"error": "not_authorized"}
                except ToolExecutionError as exc:
                    result = {"error": str(exc)}
                history.append(
                    ChatTurn(
                        role="tool",
                        content=json.dumps(result),
                        tool_name=call.tool_name,
                        tool_call_id=call.call_id,
                    )
                )

        raise RuntimeError(
            f"mam: provider did not produce a final answer within {_MAX_TOOL_ROUNDS} tool-call rounds"
        )


def _build_response(tool_name: str, arguments: dict, result: dict, language: str) -> ChatResponse:
    if tool_name == "search_properties":
        cards = tuple(_property_card(r) for r in result.get("results", []))
        msg = _count_message(len(cards), language)
        return ChatResponse(
            message=msg, language=language, cards=cards, map_action=_search_filters_action(arguments)
        )

    if tool_name == "get_property":
        if not result.get("found"):
            return ChatResponse(message=_not_available_message(language), language=language)
        return ChatResponse(message="", language=language, cards=(_property_card(result["property"]),))

    if tool_name == "compare_properties":
        cards = tuple(_property_card(r) for r in result.get("compared", []))
        return ChatResponse(
            message="", language=language, cards=cards, comparison={"items": [c.listing_id for c in cards]}
        )

    if tool_name == "get_market_summary":
        return ChatResponse(message="", language=language, comparison={"marketSummary": result})

    if tool_name == "search_professionals":
        cards = tuple(
            ProfessionalCard(
                provider_id=r["providerId"],
                display_name=r["displayName"],
                service_type=r["serviceType"],
                city=r.get("city"),
                verified=r["verified"],
            )
            for r in result.get("results", [])
        )
        return ChatResponse(message=_count_message(len(cards), language), language=language, cards=cards)

    if tool_name == "search_projects":
        cards = tuple(
            ProjectCard(
                project_id=r["projectId"],
                name=r.get("name") or "",
                city=r.get("city") or "",
                construction_status=r.get("constructionStatus"),
                starting_price=r.get("startingPrice"),
                currency=r.get("currency") or "USD",
                verified=r["verified"],
            )
            for r in result.get("results", [])
        )
        return ChatResponse(message=_count_message(len(cards), language), language=language, cards=cards)

    if tool_name == "open_on_map":
        action = MapAction(
            target=result["target"],
            filters=result.get("filters", {}),
            focus_listing_id=result.get("focusListingId"),
        )
        return ChatResponse(message="", language=language, map_action=action)

    # Generic fallback for tools without a dedicated card type (get_listing_history,
    # get_professional, get_project, search_services, get_saved_properties,
    # save_property, remove_saved_property) -- still real data, just returned
    # via `comparison` (a generic structured-data slot) rather than a card,
    # since these don't map to a listing/project/professional card shape.
    return ChatResponse(message="", language=language, comparison={tool_name: result})


# Translates a resolved search_properties call's own arguments -- never a
# fresh guess at the user's words -- into the exact filter keys map.html's
# own client-side state already uses (activeType/citySearch/selectedHome
# Types/priceMax/bedsMin). Reuses the existing MapAction shape (section 4:
# "a deterministic navigation instruction... MAM only ever tells it where
# to go and with what filters") rather than inventing a second
# structured-filter field -- map.html's own frontend script decides
# whether "target" means "navigate there" or, when already on that page,
# "apply these filters to the live view in place." Only ever built from
# arguments the deterministic resolver (or a provider's own tool call)
# already used to run the REAL query -- so the filters shown always match
# the cards actually returned. Same deal/q/types/minPrice/maxPrice/beds/
# verified vocabulary Tools.open_on_map's own filters use -- the two tools that can
# ever produce a MapAction agree on one shape, not two.
def _search_filters_action(arguments: dict) -> MapAction | None:
    filters: dict[str, Any] = {}
    if arguments.get("dealType") == "rent":
        filters["deal"] = "rent"
    if arguments.get("city"):
        filters["q"] = arguments["city"]
    if arguments.get("propertyType"):
        filters["types"] = [arguments["propertyType"]]
    if arguments.get("maxPrice") is not None:
        filters["maxPrice"] = arguments["maxPrice"]
    if arguments.get("minPrice") is not None:
        filters["minPrice"] = arguments["minPrice"]
    if arguments.get("minBeds") is not None:
        filters["beds"] = arguments["minBeds"]
    if arguments.get("verifiedOnly"):
        filters["verified"] = True
    if not filters:
        return None
    return MapAction(target="map.html", filters=filters)


def _property_card(r: dict) -> PropertyCard:
    return PropertyCard(
        listing_id=r.get("listingId", ""),
        title=r.get("title", ""),
        city=r.get("city", ""),
        price=r.get("price"),
        deal_type=r.get("dealType", ""),
        property_type=r.get("propertyType", ""),
        beds=r.get("beds"),
        verified=bool(r.get("verified")),
        image_url=r.get("img"),
    )


def _count_message(n: int, language: str) -> str:
    if n == 0:
        return {
            "en": "I don't see any matches right now.",
            "ar": "لا توجد نتائج مطابقة حاليًا.",
            "ku": "هیچ ئەنجامێکی گونجاو ئێستا نییە.",
        }.get(language, "No matches right now.")
    return {"en": f"Found {n} result(s):", "ar": f"تم العثور على {n} نتيجة:", "ku": f"{n} ئەنجام دۆزرایەوە:"}.get(
        language, f"Found {n} result(s):"
    )


def _not_available_message(language: str) -> str:
    return {
        "en": "That listing isn't available right now.",
        "ar": "هذا العقار غير متاح حاليًا.",
        "ku": "ئەم خانووە ئێستا بەردەست نییە.",
    }.get(language, "Not available.")
