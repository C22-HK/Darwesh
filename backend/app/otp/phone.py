# Canonical E.164 normalization for Iraqi phone numbers -- the single
# place every phone number entering the OTP system is normalized, so the
# same physical number always maps to the same lookup key regardless of
# how a user typed it (local format, with/without country code, spaces,
# dashes).
from __future__ import annotations

import re

IRAQ_COUNTRY_CODE = "964"
_NON_DIGITS_RE = re.compile(r"\D+")
# Iraqi mobile numbers are 10 digits nationally: 7XXXXXXXXX (networks
# allocate the leading "7" to mobile ranges; landlines use other
# prefixes and aren't relevant here -- OTP delivery is to a mobile via
# WhatsApp). E.164 form is +964 followed by those 10 digits.
_NATIONAL_MOBILE_RE = re.compile(r"^7\d{9}$")


class InvalidPhoneNumber(Exception):
    """Raised when the input isn't a recognizable Iraqi mobile number.
    Callers must reject rather than guess -- silently normalizing a
    malformed number would mean the OTP is "sent" nowhere with no
    explanation to the user."""


def normalize_iraqi_phone(raw: str) -> str:
    """Accepts local format (0750 XXX XXXX), with country code
    (964750XXXXXXX or +964750XXXXXXX), and international dial-out
    (00964750XXXXXXX), with arbitrary spaces/dashes/parentheses.
    Returns the canonical +964750XXXXXXX form."""
    digits = _NON_DIGITS_RE.sub("", raw)

    if digits.startswith("00" + IRAQ_COUNTRY_CODE):
        digits = digits[2:]

    if digits.startswith(IRAQ_COUNTRY_CODE):
        national = digits[len(IRAQ_COUNTRY_CODE) :]
    elif digits.startswith("0"):
        national = digits[1:]
    else:
        national = digits

    if not _NATIONAL_MOBILE_RE.match(national):
        raise InvalidPhoneNumber(f"'{raw}' is not a recognizable Iraqi mobile number")

    return f"+{IRAQ_COUNTRY_CODE}{national}"
