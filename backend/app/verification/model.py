# Darwesh verification & referral domain model -- the authoritative
# vocabulary and state machines. js/verification-model.js mirrors this
# for the UI; where the two could disagree, THIS one decides.
from __future__ import annotations

import re
import secrets
import unicodedata
from dataclasses import dataclass

# ---------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------

VERIFICATION_CASES = "verificationCases"
# Evidence METADATA only. The bytes live in Cloud Storage behind a
# private path; this collection never holds an image or a durable URL.
VERIFICATION_EVIDENCE = "evidence"  # subcollection of a case
REFERRAL_CODES = "referralCodes"  # code -> owner, the uniqueness claim
REFERRALS = "referrals"
REWARD_LEDGER = "rewardLedger"
VERIFICATION_ARCHIVES = "verificationArchives"
USER_REWARD_STATE = "rewardState"  # doc under users/{uid}/private

# ---------------------------------------------------------------------
# State machines (brief §H -- two independent axes)
# ---------------------------------------------------------------------

VERIFICATION_STATUSES = frozenset(
    {"unverified", "pending", "verified", "needs_review", "needs_resubmission", "rejected"}
)
ACCOUNT_STATUSES = frozenset({"active", "restricted", "suspended", "closed"})
FACE_RESULTS = frozenset({"pending", "passed", "failed", "needs_review", "unavailable"})
NAME_MATCH_RESULTS = frozenset({"exact", "likely", "needs_review", "strong_mismatch"})
EVIDENCE_KINDS = frozenset(
    {
        "id_front",
        "id_back",
        "selfie",
        "liveness",
        "business_registration",
        "business_license",
        "professional_credential",
        "other",
    }
)
VERIFICATION_TRACKS = frozenset({"identity", "business", "professional"})

# Capture-quality findings a client may report about its OWN upload, so a
# reviewer sees why an image is hard to read. Mirrors
# js/verification-model.js::assessCaptureQuality. These are readability
# observations only -- never an authenticity score (§AA) and never a
# reason to close an account (§AB).
QUALITY_ISSUES = frozenset({"low_resolution", "blurry", "too_dark", "glare", "cropped"})

# Anything not listed is refused. A 'verified' case may only be reopened
# to 'needs_review' -- it is never silently downgraded.
VERIFICATION_TRANSITIONS: dict[str, frozenset[str]] = {
    "unverified": frozenset({"pending"}),
    "pending": frozenset({"verified", "needs_review", "needs_resubmission", "rejected"}),
    "needs_review": frozenset({"verified", "needs_resubmission", "rejected"}),
    "needs_resubmission": frozenset({"pending", "rejected"}),
    # Rejection is not a dead end: §AB prefers resubmission over closure.
    "rejected": frozenset({"needs_resubmission", "pending"}),
    "verified": frozenset({"needs_review"}),
}


def can_transition_verification(current: str, target: str) -> bool:
    if current not in VERIFICATION_STATUSES or target not in VERIFICATION_STATUSES:
        return False
    return target in VERIFICATION_TRANSITIONS.get(current, frozenset())


def is_fully_identity_verified(case: dict | None) -> bool:
    """The reward gate (brief §I): BOTH components approved. Partial
    completion earns nothing, and only this function defines "fully"."""
    c = case or {}
    return (
        c.get("verificationStatus") == "verified"
        and c.get("idVerified") is True
        and c.get("faceResult") == "passed"
    )


def is_referral_unlocked(case: dict | None) -> bool:
    """Referral features stay locked until the user's OWN identity is
    verified (brief §J)."""
    return is_fully_identity_verified(case)


# ---------------------------------------------------------------------
# Referral codes (brief §K)
# ---------------------------------------------------------------------

# No O/0 and no I/1: these codes are read aloud, printed on cards and
# typed by hand.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
REFERRAL_CODE_PREFIX = "DW-"
REFERRAL_CODE_BODY_LENGTH = 5
_CODE_RE = re.compile(r"^DW-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$")
_STRIP_RE = re.compile(r"[\s‐-―_.\-]")


def generate_referral_code() -> str:
    """A well-formed random candidate (e.g. DW-M7K4P). Uniqueness is
    decided by the transactional claim in referral_ops, which
    regenerates on collision.

    `secrets`, not `random`: a guessable referral code is a
    referral-farming tool, and this value is public by design.
    """
    body = "".join(secrets.choice(CODE_ALPHABET) for _ in range(REFERRAL_CODE_BODY_LENGTH))
    return REFERRAL_CODE_PREFIX + body


def normalize_referral_code(value: object) -> str | None:
    """Canonical form for lookup and storage.

    Entry is case-insensitive (§K) and tolerant of what people actually
    type or paste: lowercase, spaces, a missing prefix, an en-dash from
    a chat message. Returns None when it cannot be read as a code.
    """
    if not isinstance(value, str):
        return None
    s = _STRIP_RE.sub("", value.strip().upper())
    if s.startswith("DW"):
        s = s[2:]
    if len(s) != REFERRAL_CODE_BODY_LENGTH:
        return None
    candidate = REFERRAL_CODE_PREFIX + s
    return candidate if _CODE_RE.match(candidate) else None


# ---------------------------------------------------------------------
# Referral relationships (brief §Q, §R)
# ---------------------------------------------------------------------

REFERRAL_STATUSES = frozenset({"pending", "qualified", "rejected", "suspicious", "revoked"})

REFERRAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"qualified", "rejected", "suspicious"}),
    "suspicious": frozenset({"qualified", "rejected"}),
    # A qualified referral can be revoked (fraud found later); revoking
    # recomputes the referrer's reward downward.
    "qualified": frozenset({"revoked", "suspicious"}),
    "rejected": frozenset({"pending"}),
    "revoked": frozenset({"pending"}),
}


def can_transition_referral(current: str, target: str) -> bool:
    if current not in REFERRAL_STATUSES or target not in REFERRAL_STATUSES:
        return False
    return target in REFERRAL_TRANSITIONS.get(current, frozenset())


# ---------------------------------------------------------------------
# Risk signals (brief §AJ)
# ---------------------------------------------------------------------

RISK_FLAGS = frozenset(
    {
        "self_referral",
        "circular_referral",
        "duplicate_relationship",
        "rapid_signup_burst",
        "reused_evidence_hash",
        "referral_farming_pattern",
        "name_strong_mismatch",
        "face_mismatch",
        "device_cluster",
    }
)

# Serious enough to hold a reward pending review -- never to close an
# account automatically (§AB).
BLOCKING_RISK_FLAGS = frozenset(
    {"self_referral", "circular_referral", "duplicate_relationship", "reused_evidence_hash"}
)

# NOTE: there is deliberately no IP-address risk flag. §AJ forbids
# treating a shared network as proof of fraud, and families, offices and
# whole buildings here legitimately share one connection.


def overall_risk(
    *,
    name_match: str | None = None,
    face_result: str | None = None,
    document_quality: str | None = None,
    risk_flags: list[str] | None = None,
) -> str:
    """Coarse Low/Medium/High for queue ordering. No fabricated
    confidence number (§AA) and no automated consequence."""
    flags = list(risk_flags or [])
    if any(f in BLOCKING_RISK_FLAGS for f in flags):
        return "high"
    if name_match == "strong_mismatch" or face_result == "failed":
        return "high"
    if name_match == "needs_review" or face_result == "needs_review":
        return "medium"
    if flags or document_quality == "needs_resubmission":
        return "medium"
    return "low"


# ---------------------------------------------------------------------
# Name matching (brief §G)
# ---------------------------------------------------------------------

_ARABIC_MARKS_RE = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ]")
_NON_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES_RE = re.compile(r"\s+")

_ARABIC_FOLD = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ة": "ه",
        "ۃ": "ه",
        "ى": "ي",
        "ې": "ي",
        "ۍ": "ي",
        "ی": "ي",
        "ۑ": "ي",
        "ک": "ك",
        "ڪ": "ك",
        "ؤ": "ء",
        "ئ": "ء",
    }
)


def fold_name(value: object) -> str:
    """Folds a name to a comparable form: case, Latin/Arabic diacritics,
    Arabic and Kurdish/Persian letter variants, punctuation, whitespace."""
    if not isinstance(value, str):
        return ""
    s = unicodedata.normalize("NFKD", value)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = _ARABIC_MARKS_RE.sub("", s)
    s = s.translate(_ARABIC_FOLD)
    s = _NON_WORD_RE.sub(" ", s)
    s = _SPACES_RE.sub(" ", s).strip().lower()
    return s


# Latin transliteration families that are the SAME name in this market.
# "Mohammed" on a profile against "Muhammad" on an ID is ordinary here,
# and §G is explicit that it must never auto-escalate to fraud.
_TRANSLITERATION_GROUPS = [
    ["mohammed", "mohammad", "muhammad", "mohamed", "muhammed", "mehmet", "mohammd"],
    ["ahmed", "ahmad", "ahmet"],
    ["ali", "aly"],
    ["hussein", "husain", "hussain", "huseyin", "husein"],
    ["hassan", "hasan"],
    ["omar", "umar", "omer"],
    ["othman", "osman", "uthman"],
    ["ibrahim", "ibraheem", "brahim"],
    ["yousef", "yusuf", "yousif", "youssef", "yusif"],
    ["abdullah", "abdallah", "abdulla"],
    ["karim", "kareem"],
    ["rashid", "rasheed"],
    ["sami", "samy"],
    ["salah", "salih", "saleh"],
    ["jamal", "jamil", "jameel"],
    ["zana", "zanaa"],
    ["kawa", "kawah"],
    ["aras", "araz"],
    ["dilan", "dylan", "delan"],
    ["rezan", "rezhan"],
]
_TRANSLITERATION_LOOKUP: dict[str, int] = {
    name: i for i, group in enumerate(_TRANSLITERATION_GROUPS) for name in group
}


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ca == cb else 1)))
        prev = cur
    return prev[len(b)]


def _tokens_equivalent(a: str, b: str) -> bool:
    if a == b:
        return True
    ga = _TRANSLITERATION_LOOKUP.get(a)
    gb = _TRANSLITERATION_LOOKUP.get(b)
    if ga is not None and ga == gb:
        return True
    # A one-character difference in a long token (Kareem/Karim) is a
    # transliteration artefact, not a different person.
    if abs(len(a) - len(b)) <= 2 and min(len(a), len(b)) >= 4:
        return levenshtein(a, b) <= 1
    return False


@dataclass(frozen=True)
class NameComparison:
    result: str
    reason: str
    matched_tokens: int
    total_tokens: int

    def to_dict(self) -> dict:
        return {
            "result": self.result,
            "reason": self.reason,
            "matchedTokens": self.matched_tokens,
            "totalTokens": self.total_tokens,
        }


def compare_names(profile_name: object, id_name: object) -> NameComparison:
    """Compares a profile name against an ID name.

    This is a REVIEW SIGNAL only. Even 'strong_mismatch' raises a flag
    and routes to a human -- §G and §AB forbid auto-closing an account
    on this basis. No invented confidence percentage is returned (§AA).
    """
    a = fold_name(profile_name)
    b = fold_name(id_name)
    if not a or not b:
        return NameComparison("needs_review", "missing_name", 0, 0)
    if a == b:
        n = len(a.split(" "))
        return NameComparison("exact", "identical_after_folding", n, n)

    ta = [t for t in a.split(" ") if t]
    tb = [t for t in b.split(" ") if t]
    unmatched = list(tb)
    matched = 0
    for tok in ta:
        for i, other in enumerate(unmatched):
            if _tokens_equivalent(tok, other):
                matched += 1
                unmatched.pop(i)
                break

    total = max(len(ta), len(tb))
    ratio = 0.0 if total == 0 else matched / total

    if matched == len(ta) == len(tb):
        return NameComparison("likely", "transliteration_variant", matched, total)
    if ratio >= 0.5:
        # Commonly a dropped middle/father's name -- extremely common
        # here, and a review item rather than fraud.
        return NameComparison("likely", "partial_name_overlap", matched, total)
    if matched > 0:
        return NameComparison("needs_review", "weak_overlap", matched, total)
    return NameComparison("strong_mismatch", "no_token_overlap", 0, total)
