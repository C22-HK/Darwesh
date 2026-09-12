# Email normalization for the OTP system -- the single place every email
# address entering it is normalized (lowercased, trimmed), so the same
# address always maps to the same challenge/rate-limit key regardless of
# how a user typed it. Deliberately not a full RFC 5322 parser -- same
# reasoning as app.auth.reset's _EMAIL_RE: this only needs to tell
# "clearly not an email" from "plausibly an email".
from __future__ import annotations

import re

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class InvalidEmailAddress(Exception):
    """Raised when the input isn't a plausible email address. Callers
    must reject rather than guess -- silently accepting a malformed
    address would mean the OTP is "sent" nowhere with no explanation."""


def normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if not _EMAIL_RE.match(email):
        raise InvalidEmailAddress(f"'{raw}' is not a valid email address")
    return email
