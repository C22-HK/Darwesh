# MAM-specific rate limit buckets, built entirely from the existing
# RateLimiter abstraction (InMemoryRateLimiter/FirestoreRateLimiter,
# app.auth.reset) -- no new limiting mechanism, per the explicit "use
# existing Firestore-backed rate limiting infrastructure where
# appropriate rather than introducing fragile in-memory limiters"
# instruction. Two independently-namespaced buckets, checked together on
# every turn (both must allow): an IP bucket (covers public/anonymous
# visitors, who have no other stable identity) and a uid bucket (covers
# signed-in callers, tighter per-identity abuse control that an IP-only
# limit can't provide once a caller is behind NAT/a shared proxy).
from __future__ import annotations

from dataclasses import dataclass

from app.auth.reset import RateLimiter


@dataclass
class MamRateLimiters:
    ip_limiter: RateLimiter
    uid_limiter: RateLimiter

    async def allow(self, *, client_ip: str, uid: str | None) -> bool:
        if not await self.ip_limiter.allow(client_ip):
            return False
        if uid is not None and not await self.uid_limiter.allow(uid):
            return False
        return True


def build_mam_rate_limiters(*, db, is_production: bool) -> MamRateLimiters:
    """20 requests / 5 minutes per IP, 40 / 5 minutes per signed-in uid --
    generous enough for a real back-and-forth conversation (each turn is
    one request), tight enough that a scripted loop against a real,
    metered model call is expensive to sustain. Revisit once real usage
    patterns exist, same as every other limit in this backend."""
    from app.auth.reset import FirestoreRateLimiter, InMemoryRateLimiter

    if is_production:
        return MamRateLimiters(
            ip_limiter=FirestoreRateLimiter(db, name="mam_chat_ip", limit=20, window_seconds=5 * 60),
            uid_limiter=FirestoreRateLimiter(db, name="mam_chat_uid", limit=40, window_seconds=5 * 60),
        )
    return MamRateLimiters(
        ip_limiter=InMemoryRateLimiter(limit=20, window_seconds=5 * 60),
        uid_limiter=InMemoryRateLimiter(limit=40, window_seconds=5 * 60),
    )
