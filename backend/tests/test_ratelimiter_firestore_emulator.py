# Proves FirestoreRateLimiter's actual cross-instance/concurrency
# properties against a REAL Firestore emulator -- everything InMemoryRateLimiter
# structurally cannot provide once the backend runs as more than one Cloud
# Run instance (INFRA-01, INFRASTRUCTURE_REMEDIATION.md). Skipped
# automatically when no emulator is reachable (CI has none -- same
# constraint app.otp.store.FirestoreChallengeStore already lives with;
# see docs/EMAIL_OTP.md and this module's own earlier one-off scratch
# scripts this formalizes). Run locally against a real emulator with:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_ratelimiter_firestore_emulator.py
#
# (port depends on your firebase.json / CLI flags -- match whatever the
# emulator actually reports it bound to).
from __future__ import annotations

import asyncio
import os
import time

import pytest

from app.auth.reset import FirestoreRateLimiter

pytestmark = pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"),
    reason="requires a local Firestore emulator (set FIRESTORE_EMULATOR_HOST)",
)


@pytest.fixture(scope="module")
def clients():
    # Two independently-constructed clients, standing in for two separate
    # Cloud Run instances that never share process memory -- the whole
    # property InMemoryRateLimiter cannot provide.
    from google.cloud import firestore

    return firestore.Client(project="demo-darwesh"), firestore.Client(project="demo-darwesh")


def _cleanup(client, *doc_ids: str) -> None:
    for doc_id in doc_ids:
        client.collection("rateLimits").document(doc_id).delete()


async def test_limit_is_shared_and_enforced_across_two_instances(clients):
    client_a, client_b = clients
    limiter_a = FirestoreRateLimiter(client_a, name="test-cross", limit=3, window_seconds=60)
    limiter_b = FirestoreRateLimiter(client_b, name="test-cross", limit=3, window_seconds=60)
    key = f"1.2.3.{int(time.time() * 1000) % 1000}"

    assert await limiter_a.allow(key) is True
    assert await limiter_b.allow(key) is True  # sees limiter_a's write immediately
    assert await limiter_a.allow(key) is True  # 3rd, at the limit
    assert await limiter_b.allow(key) is False  # 4th, over the limit -- seen from the OTHER instance

    _cleanup(client_a, f"test-cross__{key}")


async def test_distinct_limiter_names_never_share_state_for_the_same_key(clients):
    client_a, _client_b = clients
    key = f"same-key-{time.time()}"
    limiter_1 = FirestoreRateLimiter(client_a, name="test-ns-1", limit=1, window_seconds=60)
    limiter_2 = FirestoreRateLimiter(client_a, name="test-ns-2", limit=1, window_seconds=60)

    assert await limiter_1.allow(key) is True
    assert await limiter_1.allow(key) is False  # limiter_1 is now at its own limit
    assert await limiter_2.allow(key) is True  # limiter_2 has never seen this key -- own counter

    _cleanup(client_a, f"test-ns-1__{key}", f"test-ns-2__{key}")


async def test_entry_outside_the_window_is_pruned(clients):
    client_a, _client_b = clients
    key = f"prune-{time.time()}"
    limiter = FirestoreRateLimiter(client_a, name="test-prune", limit=1, window_seconds=0.05)

    assert await limiter.allow(key) is True
    assert await limiter.allow(key) is False
    time.sleep(0.1)
    assert await limiter.allow(key) is True  # the earlier entry aged out of the window

    _cleanup(client_a, f"test-prune__{key}")


async def test_realistic_concurrency_across_two_instances_never_false_denies_under_the_limit(clients):
    # 4 concurrent requests split across two instances, well under limit=5
    # -- contention alone (two transactions racing on the same document)
    # must never cause a false deny for a caller that's genuinely still
    # under budget.
    client_a, client_b = clients
    key = f"realistic-{time.time()}"
    limiter_a = FirestoreRateLimiter(client_a, name="test-realistic", limit=5, window_seconds=60)
    limiter_b = FirestoreRateLimiter(client_b, name="test-realistic", limit=5, window_seconds=60)

    results = await asyncio.gather(
        *[(limiter_a.allow(key) if i % 2 == 0 else limiter_b.allow(key)) for i in range(4)]
    )

    assert all(results), f"a request well under the limit was wrongly denied under contention: {results}"
    _cleanup(client_a, f"test-realistic__{key}")


async def test_extreme_contention_never_exceeds_the_limit_and_never_raises(clients):
    # 10-way concurrency against limit=5, far beyond this endpoint's real
    # production concurrency -- must degrade SAFELY: no unhandled
    # exception, and allowed count never exceeds the configured limit
    # (the FirestoreRateLimiter design fails CLOSED under transaction-
    # retry exhaustion -- see its own docstring -- so "some legitimate
    # requests denied under extreme contention" is the accepted tradeoff,
    # "more than `limit` requests let through" would be the actual bug).
    client_a, client_b = clients
    key = f"extreme-{time.time()}"
    limiter_a = FirestoreRateLimiter(client_a, name="test-extreme", limit=5, window_seconds=60)
    limiter_b = FirestoreRateLimiter(client_b, name="test-extreme", limit=5, window_seconds=60)

    results = await asyncio.gather(
        *[(limiter_a.allow(key) if i % 2 == 0 else limiter_b.allow(key)) for i in range(10)],
        return_exceptions=True,
    )

    raised = [r for r in results if isinstance(r, BaseException)]
    assert not raised, f"allow() let an exception escape under extreme contention: {raised}"
    allowed = sum(1 for r in results if r is True)
    assert allowed <= 5, f"allowed={allowed} exceeds limit=5 -- more requests got through than configured"

    _cleanup(client_a, f"test-extreme__{key}")
