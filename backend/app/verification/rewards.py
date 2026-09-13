# Darwesh Personal Network Rewards -- THE authoritative reward formula.
#
# js/rewards.js mirrors this for display and admin preview, but the
# browser is never authoritative (brief §AK): a client may ask for a
# recomputation, it may never assert a discount. Every write that could
# change a user's reward is performed here, inside a transaction, from
# component facts this module reads itself.
#
# DECIMAL SAFETY (brief §A)
# ------------------------
# 3.5% must stay 3.5% and 6.5% must stay 6.5% -- never 4% or 7%.
# Python's float has the same binary-representation problem as
# JavaScript's, so this module uses `decimal.Decimal` throughout and
# quantises to two decimal places (0.01%) only at the edges. int() and
# round()-to-integer never touch a reward value here; the parallel
# guard in js/rewards.js explains the JavaScript half.
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# The smallest percentage step the product supports.
PERCENT_QUANTUM = Decimal("0.01")

REWARD_PERCENT_MIN = Decimal("0")
REWARD_PERCENT_MAX = Decimal("100")

# Product defaults (brief §A). An admin-stored config overrides these
# field by field; they exist so a deployment with no config document
# still behaves exactly as specified rather than silently paying 0%.
DEFAULT_VERIFICATION_REWARD = Decimal("3.5")
DEFAULT_QUALIFIED_REFERRAL_REWARD = Decimal("3")
DEFAULT_REQUIRED_QUALIFIED_REFERRALS = 1
DEFAULT_MAXIMUM_PERSONAL_DISCOUNT = Decimal("6.5")

# How a personal reward interacts with a public promotional campaign
# (brief §B). The default is deliberately NOT 'stack'.
STACKING_POLICIES = frozenset({"personal_only", "campaign_only", "highest_benefit", "stack"})
DEFAULT_STACKING_POLICY = "highest_benefit"

REWARD_CONFIG_COLLECTION = "rewardConfig"
REWARD_CONFIG_DOC_ID = "current"


def to_decimal_percent(value: object) -> Decimal | None:
    """Coerces a stored/submitted value to a quantised Decimal percent.

    Accepts int, float, Decimal and numeric strings. A float arrives
    already imprecise, so it is routed through `repr` -- Decimal(3.5)
    from a float is exact here (3.5 is a dyadic rational) but
    Decimal(2.35) would not be, and str() gives the value the author
    meant rather than its binary expansion.

    Returns None for anything unusable, so a caller can distinguish
    "not a number" from a legitimate zero.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, Decimal):
            d = value
        elif isinstance(value, int):
            d = Decimal(value)
        elif isinstance(value, float):
            d = Decimal(str(value))
        elif isinstance(value, str):
            s = value.strip()
            if not s:
                return None
            d = Decimal(s)
        else:
            return None
    except (InvalidOperation, ValueError, ArithmeticError):
        return None
    if not d.is_finite():
        return None
    return d.quantize(PERCENT_QUANTUM, rounding=ROUND_HALF_UP)


def is_valid_reward_percent(value: object) -> bool:
    d = to_decimal_percent(value)
    return d is not None and REWARD_PERCENT_MIN <= d <= REWARD_PERCENT_MAX


def percent_to_float(value: Decimal) -> float:
    """Edge conversion for JSON/Firestore. Firestore has no decimal type,
    so a percent is stored as a double -- safe because every value here
    is already quantised to 0.01 and doubles represent 2-dp decimals in
    this range without visible error. All ARITHMETIC stays in Decimal."""
    return float(value)


def format_percent(value: Decimal) -> str:
    """3.5 -> '3.5', 6.5 -> '6.5', 3 -> '3'. Never renders as an
    integer when a fraction is present."""
    d = to_decimal_percent(value)
    if d is None:
        return "0"
    normalized = d.normalize()
    # normalize() turns 3.00 into 3, but also 350 into 3.5E+2 -- undo the
    # exponent form so the string is always plain.
    if normalized == normalized.to_integral_value():
        return str(normalized.quantize(Decimal("1")))
    return str(normalized)


@dataclass(frozen=True)
class RewardConfig:
    """One authoritative configuration (brief §T). Percentages are
    Decimal internally; `to_dict` converts at the storage edge."""

    verification_reward: Decimal = DEFAULT_VERIFICATION_REWARD
    qualified_referral_reward: Decimal = DEFAULT_QUALIFIED_REFERRAL_REWARD
    required_qualified_referrals: int = DEFAULT_REQUIRED_QUALIFIED_REFERRALS
    maximum_personal_discount: Decimal = DEFAULT_MAXIMUM_PERSONAL_DISCOUNT
    stacking_policy: str = DEFAULT_STACKING_POLICY

    @staticmethod
    def from_dict(data: dict | None) -> RewardConfig:
        """Falls back to the product default FIELD BY FIELD, so a partial
        or malformed config degrades to the specified behaviour rather
        than to zero."""
        d = data or {}

        def pick(key: str, default: Decimal) -> Decimal:
            v = to_decimal_percent(d.get(key))
            if v is None or not (REWARD_PERCENT_MIN <= v <= REWARD_PERCENT_MAX):
                return default
            return v

        required = d.get("requiredQualifiedReferrals")
        if not isinstance(required, int) or isinstance(required, bool) or not 0 <= required <= 100:
            required = DEFAULT_REQUIRED_QUALIFIED_REFERRALS

        policy = d.get("stackingPolicy")
        if policy not in STACKING_POLICIES:
            policy = DEFAULT_STACKING_POLICY

        return RewardConfig(
            verification_reward=pick("verificationReward", DEFAULT_VERIFICATION_REWARD),
            qualified_referral_reward=pick("qualifiedReferralReward", DEFAULT_QUALIFIED_REFERRAL_REWARD),
            required_qualified_referrals=required,
            maximum_personal_discount=pick("maximumPersonalDiscount", DEFAULT_MAXIMUM_PERSONAL_DISCOUNT),
            stacking_policy=policy,
        )

    def to_dict(self) -> dict:
        return {
            "verificationReward": percent_to_float(self.verification_reward),
            "qualifiedReferralReward": percent_to_float(self.qualified_referral_reward),
            "requiredQualifiedReferrals": self.required_qualified_referrals,
            "maximumPersonalDiscount": percent_to_float(self.maximum_personal_discount),
            "stackingPolicy": self.stacking_policy,
        }


def validate_reward_config(data: dict) -> list[str]:
    """Returns machine-readable problem codes; empty means valid. The
    admin editor runs the identical check in js/rewards.js, but THIS is
    the one that decides."""
    problems: list[str] = []
    for key in ("verificationReward", "qualifiedReferralReward", "maximumPersonalDiscount"):
        if not is_valid_reward_percent(data.get(key)):
            problems.append(f"invalid_{key}")
    required = data.get("requiredQualifiedReferrals")
    if not isinstance(required, int) or isinstance(required, bool) or not 0 <= required <= 100:
        problems.append("invalid_requiredQualifiedReferrals")
    if data.get("stackingPolicy") not in STACKING_POLICIES:
        problems.append("invalid_stackingPolicy")
    if not problems:
        maximum = to_decimal_percent(data.get("maximumPersonalDiscount"))
        if maximum == Decimal("0"):
            # Legal but almost certainly a typo -- a zero cap silently
            # disables every reward in the system.
            problems.append("maximum_is_zero")
    return problems


@dataclass(frozen=True)
class RewardState:
    """The authoritative component facts. Every field here is read from
    the server's own documents -- none is accepted from a request body."""

    identity_verified: bool = False
    face_verified: bool = False
    qualified_referral_count: int = 0


@dataclass(frozen=True)
class RewardBreakdown:
    fully_verified: bool
    referral_unlocked: bool
    qualified_referral_count: int
    required_qualified_referrals: int
    referrals_met: bool
    verification_reward: Decimal
    referral_reward: Decimal
    personal_discount_percent: Decimal
    potential_discount_percent: Decimal
    next_reward_percent: Decimal
    capped_by_maximum: bool

    def to_dict(self) -> dict:
        return {
            "fullyVerified": self.fully_verified,
            "referralUnlocked": self.referral_unlocked,
            "qualifiedReferralCount": self.qualified_referral_count,
            "requiredQualifiedReferrals": self.required_qualified_referrals,
            "referralsMet": self.referrals_met,
            "verificationReward": percent_to_float(self.verification_reward),
            "referralReward": percent_to_float(self.referral_reward),
            "personalDiscountPercent": percent_to_float(self.personal_discount_percent),
            "potentialDiscountPercent": percent_to_float(self.potential_discount_percent),
            "nextRewardPercent": percent_to_float(self.next_reward_percent),
            "cappedByMaximum": self.capped_by_maximum,
        }


def compute_personal_discount(state: RewardState, config: RewardConfig) -> RewardBreakdown:
    """The formula from brief §BD.

        verification = fully_verified ? config.verification_reward : 0
        referral     = qualified >= required ? config.referral_reward : 0
        total        = min(verification + referral, config.maximum)

    Default path: 3.5 + 3 = 6.5, computed in Decimal so it is exactly
    6.5 and renders as "6.5".

    The referral component additionally requires full verification: the
    referral network is locked until the user's own identity is verified
    (§J), so an unverified account cannot hold a referral reward even if
    a relationship somehow reached 'qualified'.
    """
    fully_verified = bool(state.identity_verified and state.face_verified)
    qualified = max(0, int(state.qualified_referral_count or 0))
    referrals_met = qualified >= config.required_qualified_referrals

    verification_part = config.verification_reward if fully_verified else Decimal("0")
    referral_part = config.qualified_referral_reward if (fully_verified and referrals_met) else Decimal("0")

    raw_total = verification_part + referral_part
    capped = min(raw_total, config.maximum_personal_discount)

    potential = min(
        config.verification_reward + config.qualified_referral_reward,
        config.maximum_personal_discount,
    )
    if not fully_verified:
        next_reward = config.verification_reward
    elif not referrals_met:
        next_reward = config.qualified_referral_reward
    else:
        next_reward = Decimal("0")

    return RewardBreakdown(
        fully_verified=fully_verified,
        referral_unlocked=fully_verified,
        qualified_referral_count=qualified,
        required_qualified_referrals=config.required_qualified_referrals,
        referrals_met=referrals_met,
        verification_reward=verification_part.quantize(PERCENT_QUANTUM),
        referral_reward=referral_part.quantize(PERCENT_QUANTUM),
        personal_discount_percent=capped.quantize(PERCENT_QUANTUM),
        potential_discount_percent=potential.quantize(PERCENT_QUANTUM),
        next_reward_percent=next_reward.quantize(PERCENT_QUANTUM),
        capped_by_maximum=raw_total > config.maximum_personal_discount,
    )


def resolve_effective_discount(
    personal_percent: object,
    campaign_percent: object,
    config: RewardConfig,
) -> dict:
    """Resolves a personal reward against a public campaign (brief §B).

    These are two independent systems. They do NOT silently stack; the
    policy is an admin decision defaulting to 'highest_benefit'.
    """
    personal = to_decimal_percent(personal_percent) or Decimal("0")
    campaign = to_decimal_percent(campaign_percent) or Decimal("0")

    policy = config.stacking_policy
    if policy == "personal_only":
        applied, source = personal, "personal"
    elif policy == "campaign_only":
        applied, source = campaign, "campaign"
    elif policy == "stack":
        applied, source = min(personal + campaign, REWARD_PERCENT_MAX), "stacked"
    else:  # highest_benefit
        if campaign > personal:
            applied, source = campaign, "campaign"
        else:
            applied, source = personal, "personal"

    return {
        "policy": policy,
        "source": source,
        "personalPercent": percent_to_float(personal.quantize(PERCENT_QUANTUM)),
        "campaignPercent": percent_to_float(campaign.quantize(PERCENT_QUANTUM)),
        "appliedPercent": percent_to_float(applied.quantize(PERCENT_QUANTUM)),
    }


def apply_discount_to_fee(fee_amount: object, discount_percent: object) -> dict | None:
    """Applies a discount to an eligible Darwesh brokerage/service fee
    (brief §BE). Never touches a property's listed price -- the caller
    passes the FEE and receives the discounted FEE.

    $1,000 at 6.5% -> $65 discount, $935 payable.
    """
    try:
        fee = Decimal(str(fee_amount))
    except (InvalidOperation, ValueError, TypeError, ArithmeticError):
        return None
    if not fee.is_finite() or fee < 0:
        return None
    pct = to_decimal_percent(discount_percent)
    if pct is None or pct < 0:
        return None

    cents = Decimal("0.01")
    fee_q = fee.quantize(cents, rounding=ROUND_HALF_UP)
    discount = (fee_q * pct / Decimal("100")).quantize(cents, rounding=ROUND_HALF_UP)
    payable = max(Decimal("0"), fee_q - discount)
    return {
        "originalFee": float(fee_q),
        "discountPercent": percent_to_float(pct),
        "discountAmount": float(discount),
        "payableFee": float(payable),
    }
