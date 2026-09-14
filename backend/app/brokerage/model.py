# Brokerage Fee Discount domain model -- pure vocabulary and arithmetic,
# no I/O. Every write goes through brokerage_ops.py, which imports only
# this module for its rules (same split as app.alerts.model / app.arena.model).
#
# SCOPE: this discount applies ONLY to the Darwesh brokerage/service fee --
# the commission Darwesh itself charges on a deal. It never touches a
# property's own sale/rent/land/unit/project price; nothing in this
# package (or any caller of it) ever reads or writes a price field.
from __future__ import annotations

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
