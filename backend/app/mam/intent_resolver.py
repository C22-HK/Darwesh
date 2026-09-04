# Deterministic intent resolution -- serves TWO honest, clearly-labeled
# roles, neither of which is "the AI":
#
# 1. The Fallback Mode path (section 27) when no chat provider is
#    configured, or a configured provider fails mid-request -- MAM still
#    resolves an obvious request ("open the rent map", "show me listings
#    in Erbil") to a real tool call and real data, instead of going
#    completely dead. It NEVER falls back to prose-only canned answers
#    presented as reasoning -- every branch here either dispatches a real
#    tool (real data) or returns a short, honest navigational reply
#    (greeting/thanks/goodbye) that makes no factual claim at all.
# 2. A cheap pre-router even once a provider IS configured (section 23:
#    "Do not call the LLM when deterministic navigation alone is
#    enough") -- orchestrator.py tries this FIRST for every turn; only
#    an unresolved (None) result falls through to a live model call.
#
# This is a structured intent extractor, not a bigger keyword-matching
# chatbot: its output is always (tool_name, arguments) or a fixed
# navigational reply key -- never free-form invented prose about
# property facts. The text-normalization logic (normalize_text,
# CITY_KEYWORDS, price/bedroom extraction) is a direct, deliberate port
# of the same real logic already proven in the current mam-ai.html
# (js/i18n.js-adjacent, not thrown away per the audit's "Kurdish
# normalization logic is useful and may be reused" instruction) --
# ported to Python so both the deterministic fallback AND (later) the
# live-provider prompt-building layer can share one normalization pass,
# rather than reimplementing it twice.
from __future__ import annotations

import re
from dataclasses import dataclass

_ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
_EXTENDED_ARABIC_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹"


def normalize_text(text: str) -> str:
    """Direct port of mam-ai.html's normalizeText(): strips Arabic
    diacritics, unifies letter variants common across different Kurdish/
    Arabic keyboards (ك->ک, ي/ى->ی, ة->ه, ؤ->و), strips zero-width/
    formatting marks, converts Arabic-Indic and Extended Arabic-Indic
    digits to Latin, collapses whitespace, lowercases."""
    if not text:
        return ""
    # Combining diacritics (tashkil), U+064B-U+0652, plus the standalone
    # superscript alef U+0670 -- mirrors mam-ai.html's /[ً-ْٰ]/g EXACTLY:
    # that JS character class is two disjoint pieces (a ..-U+0652 range,
    # then the single U+0670 literal), not one contiguous range. Writing
    # this as a single Python range U+064B-U+0670 (an earlier version of
    # this port did) would incorrectly swallow U+0660-U+0669 -- the
    # Arabic-Indic digits -- since they fall inside that wider span,
    # silently breaking Arabic/Kurdish digit price parsing before the
    # explicit digit-conversion step below ever sees them.
    out = re.sub(r"[ً-ْٰ]", "", text)
    out = re.sub(r"[إأآا]", "ا", out)
    out = out.replace("ك", "ک")
    out = re.sub(r"[يى]", "ی", out)
    out = out.replace("ة", "ه")
    out = out.replace("ؤ", "و")
    out = re.sub(r"[‌‎‏]", " ", out)
    out = "".join(str(_ARABIC_INDIC_DIGITS.index(c)) if c in _ARABIC_INDIC_DIGITS else c for c in out)
    out = "".join(
        (str(_EXTENDED_ARABIC_INDIC_DIGITS.index(c)) if c in _EXTENDED_ARABIC_INDIC_DIGITS else c) for c in out
    )
    out = re.sub(r"\s+", " ", out).strip()
    return out.lower()


CITY_KEYWORDS = {
    "Erbil": ["erbil", "هەولێر", "اربیل", "ھەولێر"],
    "Sulaymaniyah": ["sulaymaniyah", "slemani", "سلێمانی", "سلیمانی", "السلیمانیه"],
    "Duhok": ["duhok", "dohuk", "دهۆک", "دهوک", "دھۆک"],
    "Kirkuk": ["kirkuk", "کەرکووک", "کرکوک"],
    "Zakho": ["zakho", "زاخۆ", "زاخو"],
    "Soran": ["soran", "سۆران", "سوران"],
    "Koya": ["koya", "کۆیە", "کویه"],
    "Halabja": ["halabja", "هەڵەبجە", "حەلەبجە", "حلبجه"],
}

PROPERTY_TYPE_KEYWORDS = {
    "house": ["house", "خانوو", "خانووی", "منزل", "بیت"],
    "villa": ["villa", "ڤیلا", "فيلا"],
    # "شوقه" (Arabic-script heh, U+0647) and "شوقە" (native Sorani AE,
    # U+06D5) are two real spellings of the same word -- ه/ە are distinct
    # Kurdish letters (a consonant vs. a vowel), not a keyboard variant
    # normalize_text() can safely conflate the way it already does ك->ک
    # or ي/ى->ی (that would risk mismatching unrelated words), so both
    # spellings are listed explicitly here instead. Only "شوقه" was
    # present before -- a live Sorani speaker typing the native "شوقە"
    # spelling (see backend/tests/test_mam_sorani_benchmark.py) never
    # matched, so propertyType silently stayed unset for a real, common
    # apartment-rental phrase.
    "apartment": ["apartment", "flat", "ئاپارتمان", "شوقه", "شوقە", "شقه"],
    "land": ["land", "plot", "زەوی", "قطعه ارض", "أرض", "ارض"],
    "building": ["building", "بینا", "بنایە", "مبنى", "عمارة"],
    "office": ["office", "ofîs", "ئۆفیس", "فەرمانگە", "مکتب"],
    "shop": ["shop", "store", "دوکان", "محل تجاري", "متجر"],
}
DEAL_TYPE_RENT_KEYWORDS = [
    "rent",
    "rental",
    "renting",
    "بەکرێدان",
    "بکرێ",
    "کرێ",
    "ایجار",
    "استئجار",
]
DEAL_TYPE_SALE_KEYWORDS = [
    "buy",
    "purchase",
    "بکڕم",
    "بۆ فرۆشتن",
    "فرۆشتن",
    "بیع",
    "شراء",
]
MAX_PRICE_WORDS = [
    "less than",
    "under",
    "below",
    "up to",
    "کەمتر",
    "خوارتر",
    "اقل من",
    "أقل من",
]
MIN_PRICE_WORDS = [
    "more than",
    "over",
    "above",
    "at least",
    "زیاتر",
    "بەرزتر",
    "لە سەر",
    "اکثر من",
    "أکثر من",
]
IQD_PER_USD = 1310  # approximate conversion only, for interpreting a spoken IQD amount -- never for pricing itself

MAP_KEYWORDS = [
    "map",
    "neighborhood",
    "area",
    "location",
    "نەخشە",
    "گەڕەک",
    "ناوچە",
    "خریطه",
    "منطقه",
]
GREETING_KEYWORDS = ["hello", "hi", "hey", "سڵاو", "چۆنیت", "مرحبا", "السلام علیکم"]
THANKS_KEYWORDS = ["thank", "سوپاس", "شکرا"]
BYE_KEYWORDS = ["bye", "goodbye", "بەخاترت", "خوات لەگەڵ", "مع السلامه"]
SERVICE_KEYWORDS = [
    "engineer",
    "designer",
    "lawyer",
    "landscap",
    "cleaning",
    "پیشەگەر",
    "مهندس",
    "محامي",
    "دیزاین",
]


def detect_city(text_norm: str) -> str | None:
    for city, keywords in CITY_KEYWORDS.items():
        if any(k in text_norm for k in keywords):
            return city
    return None


def detect_property_type(text_norm: str) -> str | None:
    for ptype, keywords in PROPERTY_TYPE_KEYWORDS.items():
        if any(k in text_norm for k in keywords):
            return ptype
    return None


def detect_deal_type(text_norm: str) -> str | None:
    if any(k in text_norm for k in DEAL_TYPE_RENT_KEYWORDS):
        return "rent"
    if any(k in text_norm for k in DEAL_TYPE_SALE_KEYWORDS):
        return "sale"
    return None


def extract_price(text_norm: str) -> dict | None:
    magnitude_match = re.search(
        r"(\d+(?:\.\d+)?)\s*(ملیۆن|میلیون|مليون|million|هەزار|الف|ألف|thousand)",
        text_norm,
    )
    value: float | None = None
    if magnitude_match:
        multiplier = 1_000_000 if re.search(r"ملیۆن|میلیون|مليون|million", magnitude_match.group(2)) else 1_000
        value = float(magnitude_match.group(1)) * multiplier
    else:
        has_currency_context = (
            re.search(r"\$|dollar|دۆلار|دولار|usd|دینار|iqd|دينار", text_norm)
            or any(w in text_norm for w in MAX_PRICE_WORDS)
            or any(w in text_norm for w in MIN_PRICE_WORDS)
        )
        if has_currency_context:
            bare_match = re.search(r"\b(\d{4,})\b", text_norm)
            if bare_match:
                value = float(bare_match.group(1))
    if value is None:
        return None
    mentions_dollars = bool(re.search(r"\$|dollar|دۆلار|دولار|usd", text_norm))
    mentions_arabic_script = bool(re.search(r"[؀-ۿ]", text_norm))
    usd_value = value / IQD_PER_USD if (not mentions_dollars and mentions_arabic_script) else value
    is_max = any(w in text_norm for w in MAX_PRICE_WORDS)
    is_min = (not is_max) and any(w in text_norm for w in MIN_PRICE_WORDS)
    return {"usdValue": usd_value, "isMax": is_max, "isMin": is_min}


def extract_bedrooms(text_norm: str) -> int | None:
    match = re.search(r"(\d+)\s*(bedroom|bed|ژووری نوستن|ژوور|غرفه نوم|غرفه)", text_norm)
    return int(match.group(1)) if match else None


@dataclass(frozen=True)
class ResolvedIntent:
    """Either dispatch `tool_name` with `arguments` (real data path), or --
    when tool_name is None -- send `reply_key`/`reply_fallback` verbatim
    as a short navigational courtesy reply that carries no factual claim
    (greeting/thanks/goodbye only)."""

    tool_name: str | None
    arguments: dict
    reply_key: str | None = None
    reply_fallback: str | None = None


def resolve_intent(message: str) -> ResolvedIntent | None:
    """Returns None when the message doesn't match any deterministic
    pattern confidently enough -- the caller (orchestrator.py) must then
    either try a live model or, if none is configured, return the
    explicit "AI temporarily unavailable" state (section 26/27), never
    guess."""
    norm = normalize_text(message)
    if not norm:
        return None

    city = detect_city(norm)
    property_type = detect_property_type(norm)
    deal_type = detect_deal_type(norm)
    price = extract_price(norm)
    bedrooms = extract_bedrooms(norm)

    # A specific enough search goes straight to search_properties -- the
    # same "only treat as a real search when specific enough" rule
    # mam-ai.html's extractSearchCriteria already used, extended to also
    # cover a message with NO city but at least two other real
    # constraints (e.g. "شوقەی ٢ ژوور بۆ کرێ" -- apartment + rent +
    # bedrooms, a completely ordinary real query with no location filter).
    # City alone was standing in for "specific enough" before; requiring
    # two signals in its absence keeps the same specificity bar rather
    # than resolving on a single loose keyword.
    other_signal_count = sum(1 for s in (property_type, deal_type, price, bedrooms) if s)
    if (city and other_signal_count >= 1) or (not city and other_signal_count >= 2):
        args: dict = {}
        if city:
            args["city"] = city
        if property_type:
            args["propertyType"] = property_type
        if deal_type:
            args["dealType"] = deal_type
        if price and price["isMax"]:
            args["maxPrice"] = price["usdValue"]
        elif price and price["isMin"]:
            args["minPrice"] = price["usdValue"]
        if bedrooms:
            args["minBeds"] = bedrooms
        return ResolvedIntent(tool_name="search_properties", arguments=args)

    if re.search(r"worth|value|valuation|نرخی خانوو|هەڵسەنگاندن|بەهای خانوو|تقییم|قیمه", norm):
        return ResolvedIntent(tool_name="get_market_summary", arguments={"city": city} if city else {})

    if any(k in norm for k in SERVICE_KEYWORDS):
        return ResolvedIntent(tool_name="search_services", arguments={})

    if any(k in norm for k in MAP_KEYWORDS):
        return ResolvedIntent(tool_name="open_on_map", arguments={"city": city} if city else {})

    if city:
        return ResolvedIntent(tool_name="get_market_summary", arguments={"city": city})

    if any(k in norm for k in GREETING_KEYWORDS):
        return ResolvedIntent(
            tool_name=None,
            arguments={},
            reply_key="mamai.reply10",
            reply_fallback="Hello! Ask me about property values, neighborhoods, or whether buying or renting makes more sense for your situation.",
        )
    if any(k in norm for k in THANKS_KEYWORDS):
        return ResolvedIntent(
            tool_name=None,
            arguments={},
            reply_key="mamai.replyThanks",
            reply_fallback="You're welcome!",
        )
    if any(k in norm for k in BYE_KEYWORDS):
        return ResolvedIntent(
            tool_name=None,
            arguments={},
            reply_key="mamai.replyBye",
            reply_fallback="Take care!",
        )

    return None
