# Rewards, verification state machine, referral codes, name matching and
# the archive lifecycle (brief §BK).
#
# The decimal tests are the load-bearing ones: 3.5 must stay 3.5 and
# 3.5 + 3 must be exactly 6.5, never 4 or 7 (§A).
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.verification import model
from app.verification.archive_ops import (
    ArchiveError,
    ArchiveOps,
    ArchiveReceipt,
    EvidenceBlob,
    KeyProvider,
    decrypt_evidence,
    encrypt_evidence,
    generate_archive_id,
)
from app.verification.rewards import (
    RewardConfig,
    RewardState,
    apply_discount_to_fee,
    compute_personal_discount,
    format_percent,
    resolve_effective_discount,
    to_decimal_percent,
    validate_reward_config,
)

# =====================================================================
# §A -- decimal safety. These are the tests that must never be relaxed.
# =====================================================================


class TestDecimalRewards:
    def test_the_headline_formula_is_exactly_6_5(self):
        b = compute_personal_discount(RewardState(True, True, 1), RewardConfig())
        assert b.personal_discount_percent == Decimal("6.50")
        assert format_percent(b.personal_discount_percent) == "6.5"

    def test_verification_alone_is_exactly_3_5(self):
        b = compute_personal_discount(RewardState(True, True, 0), RewardConfig())
        assert b.personal_discount_percent == Decimal("3.50")
        assert format_percent(b.personal_discount_percent) == "3.5"

    @pytest.mark.parametrize(
        "value,expected",
        [(3.5, "3.5"), (6.5, "6.5"), (3, "3"), (0, "0"), ("3.50", "3.5"), (Decimal("2.35"), "2.35")],
    )
    def test_formatting_never_rounds_a_decimal_to_an_integer(self, value, expected):
        assert format_percent(to_decimal_percent(value)) == expected

    def test_a_float_config_does_not_drift(self):
        # 1.1 + 2.2 is 3.3000000000000003 in binary floating point.
        cfg = RewardConfig(
            verification_reward=to_decimal_percent(1.1),
            qualified_referral_reward=to_decimal_percent(2.2),
            maximum_personal_discount=to_decimal_percent(100),
        )
        b = compute_personal_discount(RewardState(True, True, 1), cfg)
        assert b.personal_discount_percent == Decimal("3.30")
        assert format_percent(b.personal_discount_percent) == "3.3"

    def test_repeated_recomputation_is_stable(self):
        cfg = RewardConfig()
        seen = {
            format_percent(compute_personal_discount(RewardState(True, True, 1), cfg).personal_discount_percent)
            for _ in range(50)
        }
        assert seen == {"6.5"}


class TestRewardFormula:
    def test_a_new_account_holds_zero(self):
        b = compute_personal_discount(RewardState(False, False, 0), RewardConfig())
        assert b.personal_discount_percent == Decimal("0.00")
        assert b.referral_unlocked is False

    def test_partial_verification_earns_nothing(self):
        # §I: ID verified but face not -> no partial reward.
        b = compute_personal_discount(RewardState(True, False, 0), RewardConfig())
        assert b.personal_discount_percent == Decimal("0.00")

    def test_referrals_do_not_pay_an_unverified_referrer(self):
        # §J: the referral network is locked until the user's OWN
        # identity is verified, so qualified referrals pay nothing yet.
        b = compute_personal_discount(RewardState(False, False, 9), RewardConfig())
        assert b.personal_discount_percent == Decimal("0.00")

    def test_a_pending_referral_pays_nothing(self):
        b = compute_personal_discount(RewardState(True, True, 0), RewardConfig())
        assert b.referral_reward == Decimal("0.00")
        assert b.personal_discount_percent == Decimal("3.50")

    def test_extra_referrals_do_not_stack_beyond_the_requirement(self):
        b = compute_personal_discount(RewardState(True, True, 7), RewardConfig())
        assert b.personal_discount_percent == Decimal("6.50")

    def test_the_maximum_caps_the_total(self):
        cfg = RewardConfig(maximum_personal_discount=Decimal("5"))
        b = compute_personal_discount(RewardState(True, True, 1), cfg)
        assert b.personal_discount_percent == Decimal("5.00")
        assert b.capped_by_maximum is True

    def test_revoking_the_last_referral_moves_the_reward_back_down(self):
        cfg = RewardConfig()
        before = compute_personal_discount(RewardState(True, True, 1), cfg)
        after = compute_personal_discount(RewardState(True, True, 0), cfg)
        assert format_percent(before.personal_discount_percent) == "6.5"
        assert format_percent(after.personal_discount_percent) == "3.5"

    def test_next_reward_points_at_what_is_actually_left(self):
        unverified = compute_personal_discount(RewardState(False, False, 0), RewardConfig())
        assert unverified.next_reward_percent == Decimal("3.50")
        verified = compute_personal_discount(RewardState(True, True, 0), RewardConfig())
        assert verified.next_reward_percent == Decimal("3.00")
        complete = compute_personal_discount(RewardState(True, True, 1), RewardConfig())
        assert complete.next_reward_percent == Decimal("0.00")


class TestRewardConfigValidation:
    def test_a_valid_config_passes(self):
        assert validate_reward_config(RewardConfig().to_dict()) == []

    def test_decimal_values_are_accepted(self):
        cfg = dict(RewardConfig().to_dict(), verificationReward=2.75)
        assert validate_reward_config(cfg) == []

    @pytest.mark.parametrize("bad", [-1, 101, "abc", None, float("nan")])
    def test_out_of_range_percentages_are_refused(self, bad):
        cfg = dict(RewardConfig().to_dict(), verificationReward=bad)
        assert "invalid_verificationReward" in validate_reward_config(cfg)

    def test_a_zero_maximum_is_flagged(self):
        cfg = dict(RewardConfig().to_dict(), maximumPersonalDiscount=0)
        assert "maximum_is_zero" in validate_reward_config(cfg)

    def test_an_unknown_stacking_policy_is_refused(self):
        cfg = dict(RewardConfig().to_dict(), stackingPolicy="always_stack")
        assert "invalid_stackingPolicy" in validate_reward_config(cfg)

    def test_a_partial_config_falls_back_field_by_field(self):
        cfg = RewardConfig.from_dict({"verificationReward": 5})
        assert cfg.verification_reward == Decimal("5.00")
        assert cfg.qualified_referral_reward == Decimal("3")  # default
        assert cfg.stacking_policy == "highest_benefit"  # default

    def test_a_malformed_config_degrades_to_the_specified_defaults(self):
        cfg = RewardConfig.from_dict({"verificationReward": "not a number", "stackingPolicy": 7})
        assert cfg.verification_reward == Decimal("3.5")
        assert cfg.stacking_policy == "highest_benefit"


class TestStackingPolicy:
    # §B: personal reward and public campaign are separate systems and
    # must not silently stack.
    def test_the_default_is_highest_benefit_not_stacking(self):
        r = resolve_effective_discount(6.5, 10, RewardConfig())
        assert r["appliedPercent"] == 10.0
        assert r["source"] == "campaign"

    def test_highest_benefit_keeps_the_personal_reward_when_it_wins(self):
        r = resolve_effective_discount(6.5, 5, RewardConfig())
        assert r["appliedPercent"] == 6.5
        assert r["source"] == "personal"

    def test_stacking_only_happens_when_an_admin_chooses_it(self):
        cfg = RewardConfig(stacking_policy="stack")
        r = resolve_effective_discount(6.5, 10, cfg)
        assert r["appliedPercent"] == 16.5

    def test_personal_only_ignores_the_campaign(self):
        cfg = RewardConfig(stacking_policy="personal_only")
        assert resolve_effective_discount(6.5, 10, cfg)["appliedPercent"] == 6.5

    def test_campaign_only_ignores_the_personal_reward(self):
        cfg = RewardConfig(stacking_policy="campaign_only")
        assert resolve_effective_discount(6.5, 10, cfg)["appliedPercent"] == 10.0


class TestBrokerageFee:
    def test_the_worked_example_from_the_brief(self):
        # §BE: $1,000 fee at 6.5% -> $65 discount -> $935 payable.
        r = apply_discount_to_fee(1000, Decimal("6.5"))
        assert r == {
            "originalFee": 1000.0,
            "discountPercent": 6.5,
            "discountAmount": 65.0,
            "payableFee": 935.0,
        }

    def test_a_fractional_fee_rounds_to_cents_not_to_dollars(self):
        r = apply_discount_to_fee(1234.56, Decimal("3.5"))
        assert r["discountAmount"] == 43.21
        assert r["payableFee"] == 1191.35

    def test_a_negative_fee_is_refused(self):
        assert apply_discount_to_fee(-5, 3.5) is None


# =====================================================================
# §H / §I -- verification state machine
# =====================================================================


class TestVerificationStateMachine:
    def test_a_new_case_may_only_become_pending(self):
        assert model.can_transition_verification("unverified", "pending")
        assert not model.can_transition_verification("unverified", "verified")

    def test_a_case_cannot_jump_straight_to_verified(self):
        assert not model.can_transition_verification("unverified", "verified")
        assert not model.can_transition_verification("needs_resubmission", "verified")

    def test_rejection_is_not_a_dead_end(self):
        # §AB prefers resubmission over permanent closure.
        assert model.can_transition_verification("rejected", "needs_resubmission")

    def test_a_verified_case_is_not_silently_downgraded(self):
        assert model.can_transition_verification("verified", "needs_review")
        assert not model.can_transition_verification("verified", "rejected")

    def test_full_verification_requires_both_components(self):
        assert model.is_fully_identity_verified(
            {"verificationStatus": "verified", "idVerified": True, "faceResult": "passed"}
        )
        assert not model.is_fully_identity_verified(
            {"verificationStatus": "verified", "idVerified": True, "faceResult": "needs_review"}
        )
        assert not model.is_fully_identity_verified(
            {"verificationStatus": "pending", "idVerified": True, "faceResult": "passed"}
        )

    def test_the_referral_network_unlocks_only_on_full_verification(self):
        assert not model.is_referral_unlocked({"verificationStatus": "pending"})
        assert model.is_referral_unlocked(
            {"verificationStatus": "verified", "idVerified": True, "faceResult": "passed"}
        )

    def test_verification_status_and_account_status_are_separate_axes(self):
        # §H: "Verification: Rejected / Account: Active" must be legal.
        assert "rejected" in model.VERIFICATION_STATUSES
        assert "active" in model.ACCOUNT_STATUSES
        assert model.VERIFICATION_STATUSES.isdisjoint(model.ACCOUNT_STATUSES)


class TestReferralStateMachine:
    def test_a_pending_referral_can_qualify_or_be_rejected(self):
        assert model.can_transition_referral("pending", "qualified")
        assert model.can_transition_referral("pending", "rejected")

    def test_a_qualified_referral_can_be_revoked(self):
        assert model.can_transition_referral("qualified", "revoked")

    def test_a_revoked_referral_cannot_jump_back_to_qualified(self):
        assert not model.can_transition_referral("revoked", "qualified")


# =====================================================================
# §K -- referral codes
# =====================================================================


class TestReferralCodes:
    def test_a_generated_code_matches_the_public_format(self):
        for _ in range(200):
            code = model.generate_referral_code()
            assert model.normalize_referral_code(code) == code
            assert code.startswith("DW-")
            assert len(code) == 8

    def test_codes_use_an_unambiguous_alphabet(self):
        # No O/0 or I/1: these are read aloud and typed by hand.
        for _ in range(200):
            body = model.generate_referral_code()[3:]
            assert not set(body) & set("O0I1")

    def test_codes_are_not_sequential(self):
        codes = {model.generate_referral_code() for _ in range(500)}
        assert len(codes) > 490  # essentially no collisions, no ordering

    @pytest.mark.parametrize(
        "typed",
        ["DW-M7K4P", "dw-m7k4p", "  DW-M7K4P  ", "DWM7K4P", "m7k4p", "DW M7K4P", "DW–M7K4P"],
    )
    def test_entry_is_case_insensitive_and_forgiving(self, typed):
        assert model.normalize_referral_code(typed) == "DW-M7K4P"

    @pytest.mark.parametrize("bad", ["", "DW-", "DW-TOOLONG", "DW-M7K4", None, 12345, "DW-M7K40"])
    def test_malformed_codes_are_rejected(self, bad):
        assert model.normalize_referral_code(bad) is None

    def test_a_code_is_never_a_uid_email_or_phone(self):
        code = model.generate_referral_code()
        assert "@" not in code and not code.replace("DW-", "").isdigit()


# =====================================================================
# §G -- name matching. Transliteration is not fraud.
# =====================================================================


class TestNameMatching:
    @pytest.mark.parametrize(
        "a,b",
        [
            ("Mohammed Samad", "Mohammad Samad"),
            ("Muhammad Ali", "Mohammed Ali"),
            ("Ahmed Hassan", "Ahmad Hasan"),
            ("Yousef Karim", "Yusuf Kareem"),
            ("Kawa Amin", "Kawah Amin"),
        ],
    )
    def test_transliteration_variants_are_a_likely_match_not_fraud(self, a, b):
        result = model.compare_names(a, b)
        assert result.result in ("exact", "likely"), f"{a} vs {b} -> {result.result}"

    def test_identical_names_are_an_exact_match(self):
        assert model.compare_names("Zana Aras", "Zana Aras").result == "exact"

    def test_arabic_script_variants_fold_together(self):
        assert model.compare_names("محمد سمد", "محمّد سمد").result in ("exact", "likely")

    def test_a_dropped_fathers_name_is_a_review_item_not_a_mismatch(self):
        r = model.compare_names("Mohammed Samad Ali", "Mohammed Samad")
        assert r.result == "likely"

    def test_a_genuinely_different_name_is_a_strong_mismatch(self):
        r = model.compare_names("Mohammed Samad", "Sara Zana")
        assert r.result == "strong_mismatch"

    def test_a_missing_name_routes_to_review_rather_than_mismatch(self):
        assert model.compare_names("", "Mohammed").result == "needs_review"

    def test_a_strong_mismatch_never_implies_an_account_action(self):
        # The comparison returns a signal only -- there is no status,
        # no closure and no account field anywhere in its result.
        r = model.compare_names("Mohammed Samad", "Sara Zana")
        assert set(r.to_dict()) == {"result", "reason", "matchedTokens", "totalTokens"}


class TestRiskScoring:
    def test_a_clean_case_is_low_risk(self):
        assert model.overall_risk(name_match="exact", face_result="passed") == "low"

    def test_a_face_mismatch_is_high_but_carries_no_automatic_action(self):
        assert model.overall_risk(face_result="failed") == "high"

    def test_a_blocking_flag_is_high(self):
        assert model.overall_risk(risk_flags=["self_referral"]) == "high"

    def test_transliteration_review_is_only_medium(self):
        assert model.overall_risk(name_match="needs_review") == "medium"

    def test_there_is_no_ip_address_risk_flag(self):
        # §AJ: a shared network is not proof of fraud -- families,
        # offices and whole buildings here share one connection. Matched
        # on whole name segments, because a substring test would trip
        # over the "ip" inside duplicate_relationship.
        segments = {seg for flag in model.RISK_FLAGS for seg in flag.split("_")}
        assert not segments & {"ip", "address", "subnet", "geoip"}


# =====================================================================
# §AP-§AU -- archival, and the archive-first deletion rule
# =====================================================================


class _StubKeys(KeyProvider):
    def data_key(self) -> bytes:
        return b"\x01" * 32


class _StubBlob:
    def __init__(self, store, path):
        self._store = store
        self._path = path

    def upload_from_string(self, data):
        self._store[self._path] = data if isinstance(data, bytes) else data.encode()

    def download_as_bytes(self):
        return self._store[self._path]

    def exists(self):
        return self._path in self._store

    def delete(self):
        self._store.pop(self._path, None)


class _StubBucket:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def blob(self, path):
        return _StubBlob(self.store, path)


class TestEncryption:
    def test_round_trip(self):
        key = b"\x02" * 32
        nonce, ct = encrypt_evidence(b"national id bytes", key)
        assert decrypt_evidence(nonce, ct, key) == b"national id bytes"

    def test_tampering_is_detected_not_silently_decrypted(self):
        key = b"\x03" * 32
        nonce, ct = encrypt_evidence(b"payload", key)
        tampered = bytearray(ct)
        tampered[0] ^= 0xFF
        with pytest.raises(ArchiveError):
            decrypt_evidence(nonce, bytes(tampered), key)

    def test_the_wrong_key_fails_loudly(self):
        nonce, ct = encrypt_evidence(b"payload", b"\x04" * 32)
        with pytest.raises(ArchiveError):
            decrypt_evidence(nonce, ct, b"\x05" * 32)

    def test_an_archive_id_carries_no_personal_name(self):
        aid = generate_archive_id()
        assert aid.startswith("VFY-DW-")
        assert len(aid) == len("VFY-DW-") + 5


class TestArchiveFirstDeletion:
    """§AT -- the rule this whole module exists to enforce."""

    def test_delete_requires_a_receipt_it_cannot_fabricate(self):
        ops = ArchiveOps(db=None, key_provider=_StubKeys())
        for bogus in ["VFY-DW-AAAAA", {"archiveId": "x"}, None, 42]:
            with pytest.raises(ArchiveError):
                ops.delete_live_evidence(bogus)

    def test_an_incomplete_receipt_is_refused(self):
        ops = ArchiveOps(db=None, key_provider=_StubKeys())
        empty = ArchiveReceipt(archive_id="", uid="u1", verified_at=datetime.now(UTC), evidence_ids=[])
        with pytest.raises(ArchiveError):
            ops.delete_live_evidence(empty)

    def test_there_is_no_force_parameter_on_deletion(self):
        import inspect

        params = set(inspect.signature(ArchiveOps.delete_live_evidence).parameters)
        assert params == {"self", "receipt", "actor_uid"}

    def test_upload_without_a_vault_refuses_rather_than_pretending(self):
        ops = ArchiveOps(db=None, key_provider=_StubKeys())
        blobs = [EvidenceBlob("e1", "id_front", "p/e1", b"bytes")]
        pkg = ops.build_package("u1", {"verificationStatus": "verified"}, blobs)
        with pytest.raises(ArchiveError):
            ops.upload_package(pkg)

    def test_a_missing_vault_object_fails_the_integrity_check(self):
        vault = _StubBucket()
        ops = ArchiveOps(db=None, vault=vault, key_provider=_StubKeys())
        blobs = [EvidenceBlob("e1", "id_front", "p/e1", b"bytes")]
        pkg = ops.build_package("u1", {"verificationStatus": "verified"}, blobs)
        paths = ops.upload_package(pkg)
        del vault.store[paths["evidence.enc"]]  # simulate a lost object
        with pytest.raises(ArchiveError, match="does not exist"):
            ops.verify_archive("u1", pkg, paths)

    def test_a_corrupted_archive_fails_the_integrity_check(self):
        vault = _StubBucket()
        ops = ArchiveOps(db=None, vault=vault, key_provider=_StubKeys())
        blobs = [EvidenceBlob("e1", "id_front", "p/e1", b"bytes")]
        pkg = ops.build_package("u1", {"verificationStatus": "verified"}, blobs)
        paths = ops.upload_package(pkg)
        vault.store[paths["evidence.enc"]] = b"corrupted"
        with pytest.raises(ArchiveError):
            ops.verify_archive("u1", pkg, paths)

    def test_a_tampered_manifest_fails_the_integrity_check(self):
        vault = _StubBucket()
        ops = ArchiveOps(db=None, vault=vault, key_provider=_StubKeys())
        blobs = [EvidenceBlob("e1", "id_front", "p/e1", b"bytes")]
        pkg = ops.build_package("u1", {"verificationStatus": "verified"}, blobs)
        paths = ops.upload_package(pkg)
        vault.store[paths["manifest.json"]] = b'{"archiveId":"forged"}'
        with pytest.raises(ArchiveError, match="manifest"):
            ops.verify_archive("u1", pkg, paths)

    def test_a_good_archive_verifies_and_yields_a_receipt(self):
        vault = _StubBucket()
        ops = ArchiveOps(db=None, vault=vault, key_provider=_StubKeys())
        blobs = [
            EvidenceBlob("e1", "id_front", "p/e1", b"front bytes"),
            EvidenceBlob("e2", "selfie", "p/e2", b"selfie bytes"),
        ]
        pkg = ops.build_package("u1", {"verificationStatus": "verified"}, blobs)
        paths = ops.upload_package(pkg)
        receipt = ops.verify_archive("u1", pkg, paths)
        assert receipt.uid == "u1"
        assert sorted(receipt.evidence_ids) == ["e1", "e2"]
        assert receipt.archive_id.startswith("VFY-DW-")

    def test_encryption_failure_prevents_any_archive_from_existing(self):
        class _BadKeys(KeyProvider):
            def data_key(self):
                raise ArchiveError("no key configured")

        ops = ArchiveOps(db=None, vault=_StubBucket(), key_provider=_BadKeys())
        with pytest.raises(ArchiveError):
            ops.build_package("u1", {}, [EvidenceBlob("e1", "id_front", "p/e1", b"x")])

    def test_refuses_to_archive_nothing(self):
        ops = ArchiveOps(db=None, vault=_StubBucket(), key_provider=_StubKeys())
        with pytest.raises(ArchiveError):
            ops.build_package("u1", {}, [])


class TestArchivePackage:
    def test_the_summary_pdf_contains_no_raw_evidence(self):
        # §AQ: the readable summary must not duplicate the ID images.
        ops = ArchiveOps(db=None, vault=_StubBucket(), key_provider=_StubKeys())
        secret = b"RAW-NATIONAL-ID-IMAGE-BYTES"
        pkg = ops.build_package(
            "u1",
            {"verificationStatus": "verified"},
            [EvidenceBlob("e1", "id_front", "p/e1", secret)],
        )
        assert secret not in pkg.verification_pdf
        # ... but it IS inside the encrypted blob.
        plaintext = decrypt_evidence(pkg.nonce, pkg.evidence_enc, _StubKeys().data_key())
        assert hashlib.sha256(secret).hexdigest().encode() in plaintext

    def test_the_manifest_records_digests_for_re_verification(self):
        ops = ArchiveOps(db=None, vault=_StubBucket(), key_provider=_StubKeys())
        pkg = ops.build_package(
            "u1",
            {"verificationStatus": "verified"},
            [EvidenceBlob("e1", "id_front", "p/e1", b"bytes")],
        )
        assert pkg.manifest["algorithm"] == "AES-256-GCM"
        assert len(pkg.manifest["evidenceSha256"]) == 64
        assert pkg.manifest["items"][0]["sha256"] == hashlib.sha256(b"bytes").hexdigest()

    def test_the_manifest_carries_a_retention_policy(self):
        # §AX: raw identity evidence is not retained forever by default.
        ops = ArchiveOps(db=None, vault=_StubBucket(), key_provider=_StubKeys())
        pkg = ops.build_package("u1", {}, [EvidenceBlob("e1", "id_front", "p/e1", b"b")])
        assert pkg.manifest["retentionDays"] > 0
