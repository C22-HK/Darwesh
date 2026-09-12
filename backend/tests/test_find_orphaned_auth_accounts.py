from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from find_orphaned_auth_accounts import mask_email  # noqa: E402


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("mohammed@example.com", "m******d@example.com"),
        ("ab@example.com", "a*@example.com"),
        ("a@example.com", "a*@example.com"),
        ("alice@example.com", "a***e@example.com"),
    ],
)
def test_mask_email_matches_the_frontend_algorithm(raw, expected):
    assert mask_email(raw) == expected


def test_mask_email_never_returns_the_full_local_part_for_a_normal_address():
    masked = mask_email("someone.longer@example.com")
    assert "someone.longer" not in masked
    assert masked.startswith("s")
    assert masked.endswith("r@example.com")
