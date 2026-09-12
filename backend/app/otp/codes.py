# OTP generation and storage-safe hashing. Nothing in this module ever
# stores or logs a plaintext code -- callers persist only hash_otp()'s
# output, never the code itself (see app/otp/store.py).
from __future__ import annotations

import hashlib
import hmac
import secrets

OTP_LENGTH = 6


def generate_otp() -> str:
    """A cryptographically secure 6-digit numeric code -- secrets.randbelow
    uses the OS CSPRNG, unlike the `random` module, which must never be
    used for anything security-sensitive."""
    return f"{secrets.randbelow(10**OTP_LENGTH):0{OTP_LENGTH}d}"


def hash_otp(code: str, secret: str) -> str:
    """HMAC-SHA256 of the code, keyed by a server-only secret
    (OTP_HMAC_SECRET). This is what actually gets stored -- never the
    plaintext code. Keying by a secret (rather than a plain hash) means
    even a full read of the OTP store can't be turned into working codes
    without also having the secret, which never leaves the server
    process's environment."""
    return hmac.new(secret.encode("utf-8"), code.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_otp(code: str, expected_hash: str, secret: str) -> bool:
    """Constant-time comparison against the stored hash -- guards the
    comparison step itself against a timing side-channel. (The HMAC step
    already makes the code infeasible to guess from the hash; this closes
    the smaller remaining gap of comparing two known-length hex strings.)"""
    return hmac.compare_digest(hash_otp(code, secret), expected_hash)
