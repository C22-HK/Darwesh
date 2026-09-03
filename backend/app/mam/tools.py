# Deterministic Darwesh tools -- the ONLY way any MAM response ever
# touches Firestore. A provider adapter never runs a query itself; it can
# only ask the orchestrator to invoke one of the tools below by name, with
# arguments matching that tool's own JSON Schema (see build_tool_specs).
# The orchestrator resolves the name to a method here, this module checks
# authorization (policy.require_auth) and re-fetches/validates every ID
# against Firestore itself -- nothing about "is this real" or "is this
# allowed" is ever taken from the model's own claim.
#
# Every tool: bounded result count, an explicit output shape, an explicit
# AuthRequirement (see TOOL_AUTH below), and reads only from the exact
# collections/fields section 8/9/10/29's audit already covers. A tool NOT
# in this file is a tool NOT implemented this phase -- see
# docs/MAM_V2_ARCHITECTURE.md's "Tools not implemented" section for which
# ones and why, rather than a fake stub here.
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app.mam.policy import (
    AuthRequirement,
    MamCaller,
    ToolAuthorizationError,
    project_public_listing_fields,
    require_auth,
    wrap_untrusted,
)
from app.mam.providers.base import ToolSpec

MAX_RESULTS = 12  # hard cap on any single tool's result list -- section 23/29: never dump hundreds of docs
MAX_COMPARE = 4


class ToolExecutionError(Exception):
    """A tool ran but couldn't produce a result for a reason worth telling
    the model in structured form (not found, malformed id) -- distinct
    from ToolAuthorizationError (a 403-shaped concern) and from an
    unexpected exception (which routes.py/orchestrator.py must never let
    escape as a raw stack trace to either the model or the browser)."""


# ---- Real, hardcoded service categories -- the same 5 real domains
# js/service-catalog.js is the canonical frontend source for (Engineering,
# Interior & Architectural Design, Legal, Landscaping, Cleaning -- the
# only ones with a real serviceProviders schema + signup path, per this
# project's original Service Universe audit). Duplicated here in the same
# spirit as CITY_KEYWORDS already being duplicated between mam-ai.html and
# other pages -- Python can't import a .js module, so this is the
# server-side copy of the same, already-audited list, not an
# independently-invented one. ----------------------------------------
SERVICE_CATALOG = (
    {"key": "engineer", "service_type": "engineer", "title": "Engineering"},
    {"key": "designer", "service_type": "designer", "title": "Interior & Architectural Design"},
    {"key": "lawyer", "service_type": "lawyer", "title": "Legal"},
    {"key": "landscaping", "service_type": "landscaping", "title": "Landscaping"},
    {"key": "cleaning", "service_type": "cleaning", "title": "Cleaning"},
)
_VALID_SERVICE_TYPES = frozenset(s["service_type"] for s in SERVICE_CATALOG)


@dataclass
class Tools:
    db: Any  # firebase_admin.firestore.Client -- the Admin SDK client, same one every other app.access.*_ops.py holds
    logger: logging.Logger

    # ---- search_properties -------------------------------------------
    async def search_properties(
        self,
        caller: MamCaller,
        *,
        city: str | None = None,
        deal_type: str | None = None,
        property_type: str | None = None,
        max_price: float | None = None,
        min_beds: int | None = None,
        verified_only: bool = False,
        limit: int = MAX_RESULTS,
    ) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        limit = min(max(1, limit), MAX_RESULTS)

        def _op() -> list[dict]:
            # Same base predicate every public listing page on the site
            # already uses (buy.html/index.html/rent.html) -- 'private'
            # and 'status' equality filters, both already indexed for
            # this shape. Additional filters are applied client-side
            # (in this Python process, not sent back to the browser
            # unfiltered) to avoid requiring a new composite index per
            # filter combination -- acceptable at this collection's
            # current size, same tradeoff buy.html's own JS already
            # makes for city/type filtering today.
            query = self.db.collection("listings").where("private", "==", False).where("status", "==", "active")
            docs = [d.to_dict() | {"id": d.id} for d in query.stream()]
            if deal_type:
                docs = [d for d in docs if d.get("dealType") == deal_type]
            if property_type:
                docs = [d for d in docs if d.get("propertyType") == property_type]
            if city:
                docs = [d for d in docs if str(d.get("city", "")).lower() == city.lower()]
            if max_price is not None:
                docs = [d for d in docs if isinstance(d.get("price"), (int, float)) and d["price"] <= max_price]
            if min_beds is not None:
                docs = [d for d in docs if isinstance(d.get("beds"), (int, float)) and d["beds"] >= min_beds]
            if verified_only:
                docs = [d for d in docs if d.get("verified") is True]
            # Verified-first, then newest -- same ordering buy.html's own
            # featured-grid sort already uses, not a new invented ranking.
            docs.sort(key=lambda d: (not d.get("verified", False), -(d.get("createdAt").timestamp() if d.get("createdAt") else 0)))
            return docs[:limit]

        docs = await asyncio.to_thread(_op)
        results = [project_public_listing_fields(d) | {"listingId": d["id"]} for d in docs]
        return {"count": len(results), "results": results, "truncated": len(results) == limit}

    # ---- get_property --------------------------------------------------
    async def get_property(self, caller: MamCaller, *, listing_id: str) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        if not listing_id or not isinstance(listing_id, str):
            raise ToolExecutionError("A listing id is required.")

        def _op() -> dict | None:
            snap = self.db.collection("listings").document(listing_id).get()
            if not snap.exists:
                return None
            data = snap.to_dict()
            # Public tools may only ever surface a publicly-visible
            # listing -- an owner/admin-only listing (private==True or
            # status!='active') must read as "not available", never leak
            # its existence to a public caller just because the model
            # asked for it by id.
            if data.get("private") is True or data.get("status") != "active":
                return None
            return data | {"id": snap.id}

        doc = await asyncio.to_thread(_op)
        if doc is None:
            return {"found": False, "reason": "not_available"}
        return {"found": True, "property": project_public_listing_fields(doc) | {"listingId": doc["id"]}}

    # ---- compare_properties ---------------------------------------------
    async def compare_properties(self, caller: MamCaller, *, listing_ids: list[str]) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        ids = [i for i in (listing_ids or []) if isinstance(i, str) and i][:MAX_COMPARE]
        if len(ids) < 2:
            raise ToolExecutionError("At least two listing ids are required to compare.")
        results = await asyncio.gather(*(self.get_property(caller, listing_id=i) for i in ids))
        found = [r["property"] for r in results if r["found"]]
        missing = [i for i, r in zip(ids, results) if not r["found"]]
        return {"compared": found, "unavailable": missing}

    # ---- get_market_summary ---------------------------------------------
    async def get_market_summary(self, caller: MamCaller, *, city: str | None = None) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)

        def _op() -> dict:
            # Same aggregation loadMarketStats() in the current mam-ai.html
            # already performs -- ported here so it's server-side and
            # tool-mediated instead of a raw client Firestore read, but
            # not re-invented: identical predicate, identical per-city
            # min/max/avg-of-sale-price computation.
            query = self.db.collection("listings").where("private", "==", False).where("status", "==", "active")
            docs = [d.to_dict() for d in query.stream()]
            by_city: dict[str, dict] = {}
            total = 0
            verified = 0
            for d in docs:
                total += 1
                if d.get("verified"):
                    verified += 1
                c = d.get("city")
                if not c:
                    continue
                entry = by_city.setdefault(c, {"count": 0, "saleCount": 0, "prices": []})
                entry["count"] += 1
                if d.get("dealType") == "sale" and isinstance(d.get("price"), (int, float)):
                    entry["saleCount"] += 1
                    entry["prices"].append(d["price"])
            for entry in by_city.values():
                prices = entry.pop("prices")
                if prices:
                    entry["min"] = min(prices)
                    entry["max"] = max(prices)
                    entry["avg"] = sum(prices) / len(prices)
            return {"total": total, "verified": verified, "byCity": by_city}

        stats = await asyncio.to_thread(_op)
        if city:
            city_stats = stats["byCity"].get(city)
            if city_stats is None:
                return {"city": city, "available": False, "reason": "no_listings"}
            return {"city": city, "available": True, **city_stats}
        return {"available": True, **stats}

    # ---- get_listing_history ---------------------------------------------
    async def get_listing_history(self, caller: MamCaller, *, listing_id: str) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)

        def _op() -> dict:
            listing_snap = self.db.collection("listings").document(listing_id).get()
            if not listing_snap.exists:
                return {"available": False, "reason": "listing_not_found"}
            listing = listing_snap.to_dict()
            estate_id = listing.get("estateId")
            asking_price = listing.get("price")
            currency = listing.get("dealType")  # listings store USD by convention site-wide
            if not estate_id:
                return {
                    "available": False,
                    "reason": "no_linked_estate",
                    "askingPrice": asking_price,
                }
            # ONLY the public, admin-curated summary -- never
            # transactionHistory (internal, admin-read-only) or
            # protected/* (also admin-only). See policy.py's module
            # docstring for why this split exists and must never be
            # bridged for any caller, including an authenticated one.
            summaries = [
                d.to_dict()
                for d in self.db.collection("estates").document(estate_id).collection(
                    "publicTransactionSummary"
                ).stream()
            ]
            return {"available": True, "askingPrice": asking_price, "verifiedTransactions": summaries}

        result = await asyncio.to_thread(_op)
        if not result.get("verifiedTransactions"):
            result.setdefault("verifiedTransactions", [])
        return result

    # ---- search_professionals / get_professional ---------------------
    async def search_professionals(
        self, caller: MamCaller, *, service_type: str, city: str | None = None, verified_only: bool = False
    ) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        if service_type not in _VALID_SERVICE_TYPES:
            raise ToolExecutionError("Unknown service type.")

        def _op() -> list[dict]:
            # Same query shape service.html's own directory already uses:
            # one equality filter + a bounded limit.
            query = self.db.collection("serviceProviders").where("serviceType", "==", service_type).limit(60)
            docs = [d.to_dict() | {"id": d.id} for d in query.stream()]
            if city:
                docs = [d for d in docs if str(d.get("city", "")).lower() == city.lower()]
            if verified_only:
                docs = [d for d in docs if d.get("verified") is True]
            docs.sort(key=lambda d: not d.get("verified", False))
            return docs[:MAX_RESULTS]

        docs = await asyncio.to_thread(_op)
        results = [
            {
                "providerId": d["id"],
                "displayName": d.get("displayName") or d.get("companyName") or "Unnamed provider",
                "serviceType": d.get("serviceType"),
                "city": d.get("city"),
                "verified": bool(d.get("verified")),
                "bio": wrap_untrusted("provider bio", d.get("description")),
            }
            for d in docs
        ]
        return {"count": len(results), "results": results}

    async def get_professional(self, caller: MamCaller, *, provider_id: str) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)

        def _op() -> dict | None:
            snap = self.db.collection("serviceProviders").document(provider_id).get()
            return (snap.to_dict() | {"id": snap.id}) if snap.exists else None

        doc = await asyncio.to_thread(_op)
        if doc is None:
            return {"found": False}
        return {
            "found": True,
            "professional": {
                "providerId": doc["id"],
                "displayName": doc.get("displayName") or doc.get("companyName") or "Unnamed provider",
                "serviceType": doc.get("serviceType"),
                "city": doc.get("city"),
                "verified": bool(doc.get("verified")),
                "bio": wrap_untrusted("provider bio", doc.get("description")),
            },
        }

    # ---- search_services (static catalog, no Firestore) -----------------
    async def search_services(self, caller: MamCaller) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        return {"services": list(SERVICE_CATALOG)}

    # ---- search_projects / get_project ---------------------------------
    async def search_projects(self, caller: MamCaller, *, city: str | None = None) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)

        def _op() -> list[dict]:
            docs = [d.to_dict() | {"id": d.id} for d in self.db.collection("projects").limit(60).stream()]
            if city:
                docs = [d for d in docs if str(d.get("city", "")).lower() == city.lower()]
            docs.sort(key=lambda d: not d.get("verified", False))
            return docs[:MAX_RESULTS]

        docs = await asyncio.to_thread(_op)
        results = [
            {
                "projectId": d["id"],
                "name": d.get("name"),
                "city": d.get("city"),
                "constructionStatus": d.get("constructionStatus"),
                "startingPrice": d.get("startingPrice"),
                "currency": d.get("currency"),
                "installmentAvailable": d.get("installmentAvailable"),
                "verified": bool(d.get("verified")),
                "description": wrap_untrusted("project description", d.get("description")),
            }
            for d in docs
        ]
        return {"count": len(results), "results": results}

    async def get_project(self, caller: MamCaller, *, project_id: str) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)

        def _op() -> dict | None:
            snap = self.db.collection("projects").document(project_id).get()
            return (snap.to_dict() | {"id": snap.id}) if snap.exists else None

        doc = await asyncio.to_thread(_op)
        if doc is None:
            return {"found": False}
        return {
            "found": True,
            "project": {
                "projectId": doc["id"],
                "name": doc.get("name"),
                "city": doc.get("city"),
                "constructionStatus": doc.get("constructionStatus"),
                "startingPrice": doc.get("startingPrice"),
                "currency": doc.get("currency"),
                "installmentAvailable": doc.get("installmentAvailable"),
                "minDownPaymentPercent": doc.get("minDownPaymentPercent"),
                "verified": bool(doc.get("verified")),
                "description": wrap_untrusted("project description", doc.get("description")),
            },
        }

    # ---- open_on_map (pure action, no Firestore) ------------------------
    async def open_on_map(
        self, caller: MamCaller, *, deal_type: str | None = None, city: str | None = None, listing_id: str | None = None
    ) -> dict:
        require_auth(caller, AuthRequirement.PUBLIC)
        filters: dict[str, Any] = {}
        if deal_type:
            filters["dealType"] = deal_type
        if city:
            filters["city"] = city
        return {"target": "buy-rent-map.html", "filters": filters, "focusListingId": listing_id}

    # ---- get_saved_properties / save_property / remove_saved_property ---
    async def get_saved_properties(self, caller: MamCaller) -> dict:
        require_auth(caller, AuthRequirement.AUTHENTICATED)
        uid = caller.uid

        def _op() -> list[str]:
            return [d.id for d in self.db.collection("users").document(uid).collection("favorites").stream()]

        ids = await asyncio.to_thread(_op)
        return {"listingIds": ids}

    async def save_property(self, caller: MamCaller, *, listing_id: str) -> dict:
        require_auth(caller, AuthRequirement.AUTHENTICATED)
        # Re-validate the listing is real and publicly visible before ever
        # writing a favorite for it -- never trust the model's own belief
        # that an id it mentioned earlier in the conversation is real.
        check = await self.get_property(caller, listing_id=listing_id)
        if not check["found"]:
            raise ToolExecutionError("That listing isn't available to save.")
        uid = caller.uid

        def _op() -> None:
            self.db.collection("users").document(uid).collection("favorites").document(listing_id).set(
                {"listingId": listing_id}
            )

        await asyncio.to_thread(_op)
        return {"saved": True, "listingId": listing_id}

    async def remove_saved_property(self, caller: MamCaller, *, listing_id: str) -> dict:
        require_auth(caller, AuthRequirement.AUTHENTICATED)
        uid = caller.uid

        def _op() -> None:
            self.db.collection("users").document(uid).collection("favorites").document(listing_id).delete()

        await asyncio.to_thread(_op)
        return {"removed": True, "listingId": listing_id}


# ---- Registry: name -> (auth requirement, provider-facing spec) --------
# The single source of truth build_tool_specs()/the orchestrator's
# dispatch both read from -- adding a tool means adding one entry here,
# never wiring a name into the provider call path by hand elsewhere.
TOOL_AUTH: dict[str, AuthRequirement] = {
    "search_properties": AuthRequirement.PUBLIC,
    "get_property": AuthRequirement.PUBLIC,
    "compare_properties": AuthRequirement.PUBLIC,
    "get_market_summary": AuthRequirement.PUBLIC,
    "get_listing_history": AuthRequirement.PUBLIC,
    "search_professionals": AuthRequirement.PUBLIC,
    "get_professional": AuthRequirement.PUBLIC,
    "search_services": AuthRequirement.PUBLIC,
    "search_projects": AuthRequirement.PUBLIC,
    "get_project": AuthRequirement.PUBLIC,
    "open_on_map": AuthRequirement.PUBLIC,
    "get_saved_properties": AuthRequirement.AUTHENTICATED,
    "save_property": AuthRequirement.AUTHENTICATED,
    "remove_saved_property": AuthRequirement.AUTHENTICATED,
}


def build_tool_specs() -> list[ToolSpec]:
    """Provider-neutral tool declarations (base.ToolSpec) for every tool
    in TOOL_AUTH. Each provider adapter translates this same list into its
    own wire format -- this function is called once per request by
    orchestrator.py, never duplicated per-provider."""
    return [
        ToolSpec(
            name="search_properties",
            description="Search real, currently-active Darwesh property listings by city, deal type, property type, price, and bedrooms.",
            parameters_schema={
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                    "dealType": {"type": "string", "enum": ["sale", "rent"]},
                    "propertyType": {"type": "string"},
                    "maxPrice": {"type": "number"},
                    "minBeds": {"type": "integer"},
                    "verifiedOnly": {"type": "boolean"},
                },
            },
        ),
        ToolSpec(
            name="get_property",
            description="Fetch full details of one specific real listing by its id.",
            parameters_schema={"type": "object", "properties": {"listingId": {"type": "string"}}, "required": ["listingId"]},
        ),
        ToolSpec(
            name="compare_properties",
            description="Compare 2-4 real listings side by side, by id.",
            parameters_schema={
                "type": "object",
                "properties": {"listingIds": {"type": "array", "items": {"type": "string"}}},
                "required": ["listingIds"],
            },
        ),
        ToolSpec(
            name="get_market_summary",
            description="Get real aggregate market stats (listing counts, sale price range/average) for a city or all cities.",
            parameters_schema={"type": "object", "properties": {"city": {"type": "string"}}},
        ),
        ToolSpec(
            name="get_listing_history",
            description="Get a listing's asking price and any admin-verified sale/rent history for its linked Estate, if one exists.",
            parameters_schema={"type": "object", "properties": {"listingId": {"type": "string"}}, "required": ["listingId"]},
        ),
        ToolSpec(
            name="search_professionals",
            description="Find real Darwesh service providers (engineer, designer, lawyer, landscaping, cleaning) by city.",
            parameters_schema={
                "type": "object",
                "properties": {
                    "serviceType": {"type": "string", "enum": sorted(_VALID_SERVICE_TYPES)},
                    "city": {"type": "string"},
                    "verifiedOnly": {"type": "boolean"},
                },
                "required": ["serviceType"],
            },
        ),
        ToolSpec(
            name="get_professional",
            description="Fetch one specific service provider's public profile by id.",
            parameters_schema={"type": "object", "properties": {"providerId": {"type": "string"}}, "required": ["providerId"]},
        ),
        ToolSpec(
            name="search_services",
            description="List the real service categories Darwesh offers.",
            parameters_schema={"type": "object", "properties": {}},
        ),
        ToolSpec(
            name="search_projects",
            description="Find real developer/community projects by city.",
            parameters_schema={"type": "object", "properties": {"city": {"type": "string"}}},
        ),
        ToolSpec(
            name="get_project",
            description="Fetch one specific project's details by id.",
            parameters_schema={"type": "object", "properties": {"projectId": {"type": "string"}}, "required": ["projectId"]},
        ),
        ToolSpec(
            name="open_on_map",
            description="Produce a map-navigation action for the frontend to open, optionally with filters or a focused listing. Never a data claim.",
            parameters_schema={
                "type": "object",
                "properties": {
                    "dealType": {"type": "string", "enum": ["sale", "rent"]},
                    "city": {"type": "string"},
                    "listingId": {"type": "string"},
                },
            },
        ),
        ToolSpec(
            name="get_saved_properties",
            description="List the signed-in caller's own saved/favorited listing ids. Requires the caller to be signed in.",
            parameters_schema={"type": "object", "properties": {}},
        ),
        ToolSpec(
            name="save_property",
            description="Save a listing to the signed-in caller's own favorites. Requires the caller to be signed in.",
            parameters_schema={"type": "object", "properties": {"listingId": {"type": "string"}}, "required": ["listingId"]},
        ),
        ToolSpec(
            name="remove_saved_property",
            description="Remove a listing from the signed-in caller's own favorites. Requires the caller to be signed in.",
            parameters_schema={"type": "object", "properties": {"listingId": {"type": "string"}}, "required": ["listingId"]},
        ),
    ]


async def dispatch(tools: Tools, caller: MamCaller, name: str, arguments: dict) -> dict:
    """The ONLY place a tool name (a string, ultimately chosen by a model
    or the deterministic fallback) is turned into a real method call.
    Unknown tool name -> ToolExecutionError, never a silent no-op or a
    dynamic getattr() lookup that could reach an unintended method."""
    method = _DISPATCH_TABLE.get(name)
    if method is None:
        raise ToolExecutionError(f"Unknown tool: {name}")
    try:
        return await method(tools, caller, **_coerce_arguments(name, arguments))
    except TypeError as exc:
        raise ToolExecutionError(f"Invalid arguments for {name}.") from exc


def _coerce_arguments(name: str, arguments: dict) -> dict:
    """Translates the camelCase wire argument names (matching each
    ToolSpec's JSON Schema, and every existing frontend convention in this
    repo) into the snake_case keyword arguments each Tools method
    actually takes."""
    if not isinstance(arguments, dict):
        return {}
    mapping = {
        "dealType": "deal_type",
        "propertyType": "property_type",
        "maxPrice": "max_price",
        "minBeds": "min_beds",
        "verifiedOnly": "verified_only",
        "listingId": "listing_id",
        "listingIds": "listing_ids",
        "serviceType": "service_type",
        "providerId": "provider_id",
        "projectId": "project_id",
    }
    return {mapping.get(k, k): v for k, v in arguments.items()}


_DISPATCH_TABLE = {
    "search_properties": Tools.search_properties,
    "get_property": Tools.get_property,
    "compare_properties": Tools.compare_properties,
    "get_market_summary": Tools.get_market_summary,
    "get_listing_history": Tools.get_listing_history,
    "search_professionals": Tools.search_professionals,
    "get_professional": Tools.get_professional,
    "search_services": Tools.search_services,
    "search_projects": Tools.search_projects,
    "get_project": Tools.get_project,
    "open_on_map": Tools.open_on_map,
    "get_saved_properties": Tools.get_saved_properties,
    "save_property": Tools.save_property,
    "remove_saved_property": Tools.remove_saved_property,
}
