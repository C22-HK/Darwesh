# Brokerage Fee Discount domain model -- pure vocabulary and arithmetic,
# no I/O. Every write goes through brokerage_ops.py, which imports only
# this module for its rules (same split as app.alerts.model / app.arena.model).
#
# SCOPE: this discount applies ONLY to the Darwesh brokerage/service fee --
# the commission Darwesh itself charges on a deal. It never touches a
# property's own sale/rent/land/unit/project price; nothing in this
# package (or any caller of it) ever reads or writes a price field.
#
# PHASE 2 (policy engine): brokerageDiscountPolicies are admin-defined
# DEFAULT rules ("agents get 10% off", "Erbil gets 15% this month") that
# only ever apply to an account with NO per-account override configured --
# the moment an admin sets an explicit override on an account (via
# set_discount/disable_discount/enable_discount/remove_discount, Phase 1,
# unchanged), that override is the permanent final word for that account
# and every policy is ignored for it. This module never decides that
# precedence itself (brokerage_ops.py does, at read time); it only
# supplies the pure vocabulary a policy is built from, mirroring
# js/offers.js's stored-intent + derived-effective-state split exactly --
# see effective_policy_state() below.
from __future__ import annotations

from datetime import UTC, datetime

ROUND_DIGITS = 2

# users/{uid}/privateProfile/main -- the four new admin-write-only fields
# added by this feature, siblings of the existing owner-writable
# `commissionRate` field on that same document. Deliberately NOT reusing
# the generic `updatedAt` the owner's commissionRate write already uses --
# a dedicated pair keeps "when was the discount itself last touched" and
# "who touched it" unambiguous for the admin table's own columns, never
# conflated with an unrelated owner self-edit to the same document.
FIELD_PERCENT = "brokerageDiscountPercent"
FIELD_ACTIVE = "brokerageDiscountActive"
FIELD_UPDATED_AT = "brokerageDiscountUpdatedAt"
FIELD_UPDATED_BY = "brokerageDiscountUpdatedBy"
BROKERAGE_DISCOUNT_FIELDS: tuple[str, ...] = (FIELD_PERCENT, FIELD_ACTIVE, FIELD_UPDATED_AT, FIELD_UPDATED_BY)

BROKERAGE_DISCOUNT_HISTORY = "brokerageDiscountHistory"
BROKERAGE_FEE_SNAPSHOTS = "brokerageFeeSnapshots"

# Phase 1 ships these as plain fixed UI values (quick preset buttons), NOT
# tied to any policy document -- there is no role/city policy engine yet
# (see the Phase 1 plan's "Phasing" decision). 0% is included on purpose:
# it is how an admin explicitly records "considered, no discount" as
# distinct from "never configured" (percent absent entirely).
PRESET_PERCENTS: tuple[int, ...] = (0, 5, 10, 20, 30)

HISTORY_ACTIONS = frozenset({"set", "bulk_set", "disable", "enable", "remove"})

CURRENCIES = frozenset({"USD", "IQD"})


def is_valid_percent(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return 0 <= value <= 100


def effective_percent(percent: object, active: object) -> float:
    """The percent that actually applies right now. A disabled discount
    (`active is False`) always computes as 0 -- disabling PRESERVES the
    stored percent (re-enabling restores it exactly) without it affecting
    any fee calculated while disabled. An absent/invalid percent is
    likewise 0 -- "never configured" and "explicitly 0%" both charge the
    full fee, the only difference is whether a percent value exists to
    show/restore in the admin UI."""
    if not is_valid_percent(percent):
        return 0
    return 0 if active is False else percent


def compute_discount(original_fee: float, percent: float) -> tuple[float, float]:
    """Pure arithmetic, unit-tested against the spec's own worked example:
    $1,000 @ 30% -> $300 discount, $700 final. Both figures are rounded to
    ROUND_DIGITS -- a fee amount is always presented at currency precision,
    never a long float tail."""
    discount_amount = round(original_fee * (percent / 100.0), ROUND_DIGITS)
    final_fee = round(original_fee - discount_amount, ROUND_DIGITS)
    return discount_amount, final_fee


# ---- Phase 2: policy engine ------------------------------------------------
#
# brokerageDiscountPolicies/{id} -- what Admin can store. Deliberately the
# SAME shape as js/offers.js's OFFER_STATUSES: no 'scheduled'/'expired' is
# ever stored, because this codebase has no scheduler anywhere (confirmed
# by exhaustive grep before this feature was designed) that could flip a
# stored status at the right moment. effective_policy_state() below derives
# the real state on every read instead, exactly mirroring offers.js's own
# effectiveState() -- an "active" policy with startAt in the future or
# endAt in the past behaves as scheduled/expired with zero moving parts.
POLICY_STATUSES: tuple[str, ...] = ("draft", "active", "paused", "archived")

# What a human (or match_best_policy) is shown / tested against.
EFFECTIVE_POLICY_STATES: tuple[str, ...] = ("draft", "scheduled", "active", "paused", "expired", "archived")

POLICY_HISTORY_ACTIONS = frozenset({"create", "update", "status_change"})

BROKERAGE_DISCOUNT_POLICIES = "brokerageDiscountPolicies"
BROKERAGE_DISCOUNT_POLICY_HISTORY = "brokerageDiscountPolicyHistory"

_EPOCH = datetime.min.replace(tzinfo=UTC)


def effective_policy_state(policy: dict | None, now: datetime) -> str:
    """The policy's real state right now. `now` is injectable so tests and
    the admin preview can ask "what will this look like on Friday?"
    without touching the clock -- identical contract to js/offers.js's
    effectiveState(offer, now)."""
    if not policy:
        return "archived"
    stored = policy.get("status")
    stored = stored if stored in POLICY_STATUSES else "draft"
    if stored != "active":
        return stored
    start = policy.get("startAt")
    end = policy.get("endAt")
    if isinstance(start, datetime) and now < start:
        return "scheduled"
    # endAt is exclusive: a policy ending "at 18:00" is over the instant
    # the clock reads 18:00, not a millisecond later -- same convention
    # as js/offers.js's effectiveState().
    if isinstance(end, datetime) and now >= end:
        return "expired"
    return "active"


def match_best_policy(
    policies: list[dict], *, account_type: str | None, city: str | None, now: datetime
) -> dict | None:
    """The single best-matching, currently-active policy for an account,
    or None. Per the user's explicit decision there is no stacking: this
    always returns at most one policy, never a sum of several.

    A policy's accountType/city constraints are wildcards when unset. A
    city-scoped policy NEVER matches an account whose city can't be
    resolved (also an explicit user decision) -- `city=None` only ever
    satisfies a wildcard (cityless) policy, never a city-scoped one.

    Ties are broken by specificity first (both accountType and city set
    beats one set beats neither), then by the most recently updated
    policy -- deterministic, and requires no separate admin-set priority
    field."""
    best: dict | None = None
    best_specificity = -1
    best_updated = _EPOCH
    for policy in policies:
        if effective_policy_state(policy, now) != "active":
            continue
        p_type = policy.get("accountType")
        p_city = policy.get("city")
        if p_type and p_type != account_type:
            continue
        if p_city and (not city or p_city != city):
            continue
        specificity = (1 if p_type else 0) + (1 if p_city else 0)
        updated = policy.get("updatedAt")
        updated = updated if isinstance(updated, datetime) else _EPOCH
        if (
            best is None
            or specificity > best_specificity
            or (specificity == best_specificity and updated > best_updated)
        ):
            best, best_specificity, best_updated = policy, specificity, updated
    return best
