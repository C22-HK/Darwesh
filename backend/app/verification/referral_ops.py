# Referral codes and referral relationships -- the trusted side.
#
# Everything here runs server-side with the Admin SDK. firestore.rules
# makes `referralCodes`, `referrals` and `rewardLedger` unwritable by any
# client (see the rules file), so these transitions exist in exactly one
# place and the browser can only ask for them.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

from . import model
from .rewards import (
    REWARD_CONFIG_COLLECTION,
    REWARD_CONFIG_DOC_ID,
    RewardConfig,
    RewardState,
    compute_personal_discount,
    percent_to_float,
    validate_reward_config,
)

logger = logging.getLogger(__name__)

# How many candidate codes to try before giving up. With a 32-character
# alphabet and 5 positions the space is 33.5M, so a collision inside 8
# attempts is not a realistic outcome -- this bound exists so a
# misconfigured database cannot spin forever.
MAX_CODE_ATTEMPTS = 8

# A burst of signups all claiming one code is the classic farming
# pattern (§AJ). This flags for review; it never auto-punishes.
BURST_WINDOW = timedelta(hours=1)
BURST_THRESHOLD = 5


@dataclass(frozen=True)
class PublicReferrer:
    """The ONLY thing code validation may return about a code's owner
    (brief §N). No phone, no email, no uid, no profile detail."""

    display_name: str

    def to_dict(self) -> dict:
        return {"displayName": self.display_name}


def _now() -> datetime:
    return datetime.now(UTC)


def _safe_display_name(profile: dict | None) -> str:
    """A first name only. The full legal name on an ID is verification
    evidence and never leaves the review workspace."""
    p = profile or {}
    raw = p.get("displayName") or p.get("fullName") or ""
    if not isinstance(raw, str):
        return ""
    first = raw.strip().split(" ")[0] if raw.strip() else ""
    return first[:40]


class ReferralOps:
    """Code issuance, code resolution, relationship creation and
    qualification. Constructed with a Firestore client and a transaction
    factory so tests can drive it against the emulator or a fake."""

    def __init__(self, db, *, clock=None):
        self._db = db
        # Injectable only so tests can pin "now" for the burst window;
        # every STORED timestamp uses SERVER_TIMESTAMP so a clock skew on
        # a backend instance can never backdate an audit record.
        self._clock = clock or _now

    # -----------------------------------------------------------------
    # Code issuance (brief §K, §J)
    # -----------------------------------------------------------------

    def issue_code_for(self, uid: str, *, actor_uid: str | None = None) -> str:
        """Creates (or returns the existing) referral code for a user.

        REFUSES unless that user's own identity verification is complete
        (§J): an unverified account must not be able to activate or share
        a working referral code. This is the server-side half of the lock
        the UI also shows.
        """
        if not isinstance(uid, str) or not uid:
            raise ValidationError("uid is required")

        case = self._load_active_case(uid)
        if not model.is_referral_unlocked(case):
            raise ForbiddenError("referral network locked until identity verification is complete")

        existing = self._find_code_for_owner(uid)
        if existing:
            return existing

        for _ in range(MAX_CODE_ATTEMPTS):
            candidate = model.generate_referral_code()
            if self._claim_code(candidate, uid, actor_uid or uid):
                return candidate
        raise ConflictError("could not allocate a unique referral code")

    def _claim_code(self, code: str, owner_uid: str, actor_uid: str) -> bool:
        """Transactional claim. Firestore classifies a write to a given
        document path as `create` exactly once, so two concurrent
        issuances can never both take the same code regardless of how
        they interleave."""
        ref = self._db.collection(model.REFERRAL_CODES).document(code)
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> bool:
            snap = ref.get(transaction=txn)
            if snap.exists:
                return False
            txn.set(
                ref,
                {
                    "code": code,
                    "ownerUid": owner_uid,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                    "active": True,
                },
            )
            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="system",
                    action="referral_code_issued",
                    target_type="user",
                    target_id=owner_uid,
                    changed_fields=["referralCode"],
                ),
            )
            return True

        return bool(_txn(transaction))

    def _find_code_for_owner(self, uid: str) -> str | None:
        q = (
            self._db.collection(model.REFERRAL_CODES)
            .where("ownerUid", "==", uid)
            .where("active", "==", True)
            .limit(1)
        )
        for doc in q.stream():
            data = doc.to_dict() or {}
            return data.get("code") or doc.id
        return None

    # -----------------------------------------------------------------
    # Code resolution (brief §N, §O)
    # -----------------------------------------------------------------

    def resolve_code(self, raw_code: object) -> PublicReferrer:
        """Validates a public code and returns only a safe display name.

        Both "malformed" and "no such code" raise the SAME NotFoundError
        with the same message (§O): varying the error would turn this
        endpoint into an oracle for which codes exist.
        """
        code = model.normalize_referral_code(raw_code)
        if code is None:
            raise NotFoundError("invalid referral code")

        snap = self._db.collection(model.REFERRAL_CODES).document(code).get()
        if not getattr(snap, "exists", False):
            raise NotFoundError("invalid referral code")
        data = snap.to_dict() or {}
        if not data.get("active", False):
            raise NotFoundError("invalid referral code")

        owner_uid = data.get("ownerUid")
        if not owner_uid:
            raise NotFoundError("invalid referral code")

        profile_snap = self._db.collection("users").document(owner_uid).get()
        profile = profile_snap.to_dict() if getattr(profile_snap, "exists", False) else {}
        return PublicReferrer(display_name=_safe_display_name(profile))

    # -----------------------------------------------------------------
    # Claiming a referrer (brief §P, §Q)
    # -----------------------------------------------------------------

    def claim_referral(self, *, referred_uid: str, raw_code: object) -> dict:
        """Associates a NEW account with the owner of `raw_code`.

        Enforced here, not in the browser:
          * one referrer per account, ever (§P) -- a second claim is a
            ConflictError, not a silent overwrite;
          * no self-referral (§AJ);
          * no circular pair (A referred B, B may not then refer A).

        The relationship starts 'pending'. Typing a code grants nothing
        (§Q) -- qualification is a separate, later decision.
        """
        if not isinstance(referred_uid, str) or not referred_uid:
            raise ValidationError("referred_uid is required")
        code = model.normalize_referral_code(raw_code)
        if code is None:
            raise NotFoundError("invalid referral code")

        code_snap = self._db.collection(model.REFERRAL_CODES).document(code).get()
        if not getattr(code_snap, "exists", False):
            raise NotFoundError("invalid referral code")
        code_data = code_snap.to_dict() or {}
        if not code_data.get("active", False):
            raise NotFoundError("invalid referral code")
        referrer_uid = code_data.get("ownerUid")
        if not referrer_uid:
            raise NotFoundError("invalid referral code")

        if referrer_uid == referred_uid:
            # Self-referral: refused outright AND recorded, because a
            # deliberate attempt is a risk signal worth an admin seeing.
            self._record_risk(referred_uid, "self_referral")
            raise ValidationError("an account cannot refer itself")

        # One referrer per account, for the lifetime of the account.
        if self._existing_referral_for(referred_uid) is not None:
            raise ConflictError("this account already has a referrer")

        # Circular pair.
        reverse = (
            self._db.collection(model.REFERRALS)
            .where("referrerUid", "==", referred_uid)
            .where("referredUid", "==", referrer_uid)
            .limit(1)
        )
        if any(True for _ in reverse.stream()):
            self._record_risk(referred_uid, "circular_referral")
            raise ValidationError("circular referral is not allowed")

        risk_flags: list[str] = []
        if self._is_signup_burst(referrer_uid):
            risk_flags.append("rapid_signup_burst")

        referral_id = f"{referrer_uid}__{referred_uid}"
        ref = self._db.collection(model.REFERRALS).document(referral_id)
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> bool:
            snap = ref.get(transaction=txn)
            if snap.exists:
                raise ConflictError("this referral relationship already exists")
            txn.set(
                ref,
                {
                    "referralId": referral_id,
                    "referrerUid": referrer_uid,
                    "referredUid": referred_uid,
                    "referralCode": code,
                    "status": "suspicious" if risk_flags else "pending",
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                    "qualifiedAt": None,
                    "rewardGrantedAt": None,
                    "revokedAt": None,
                    "riskFlags": risk_flags,
                    "adminNotes": "",
                },
            )
            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=referred_uid,
                    actor_role="user",
                    action="referral_claimed",
                    target_type="referral",
                    target_id=referral_id,
                    changed_fields=["status"],
                    new_value="suspicious" if risk_flags else "pending",
                ),
            )
            return True

        _txn(transaction)
        return {
            "referralId": referral_id,
            "status": "suspicious" if risk_flags else "pending",
            "riskFlags": risk_flags,
        }

    def _existing_referral_for(self, referred_uid: str) -> dict | None:
        q = self._db.collection(model.REFERRALS).where("referredUid", "==", referred_uid).limit(1)
        for doc in q.stream():
            return doc.to_dict() or {}
        return None

    def _is_signup_burst(self, referrer_uid: str) -> bool:
        """More than BURST_THRESHOLD claims on one referrer inside an
        hour. A flag for review, never an automatic penalty (§AJ)."""
        since = self._clock() - BURST_WINDOW
        q = (
            self._db.collection(model.REFERRALS)
            .where("referrerUid", "==", referrer_uid)
            .where("createdAt", ">=", since)
            .limit(BURST_THRESHOLD + 1)
        )
        return sum(1 for _ in q.stream()) >= BURST_THRESHOLD

    def _record_risk(self, uid: str, flag: str) -> None:
        """Best-effort risk note. Never raises: a failure to record a
        signal must not block the caller's real (already correct)
        rejection path."""
        if flag not in model.RISK_FLAGS:
            return
        try:
            self._db.collection(model.VERIFICATION_CASES).document(uid).set(
                {"riskFlags": fb_firestore.ArrayUnion([flag]), "updatedAt": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )
        except Exception:  # noqa: BLE001 - deliberately non-fatal
            logger.warning("could not record risk flag %s", flag, exc_info=False)

    # -----------------------------------------------------------------
    # Qualification (brief §R)
    # -----------------------------------------------------------------

    def evaluate_qualification(self, referral_id: str, *, strict_identity: bool = False) -> dict:
        """Decides whether a pending referral now qualifies.

        Default criteria (§R): the referred account exists, has completed
        the contact verification the existing signup policy already
        requires, is not itself flagged, and the relationship carries no
        blocking risk flag.

        `strict_identity` is the configurable stricter mode §R mentions --
        requiring the REFERRED account to be fully identity-verified too.
        It is OFF by default because the brief says not to hardcode it.
        """
        snap = self._db.collection(model.REFERRALS).document(referral_id).get()
        if not getattr(snap, "exists", False):
            raise NotFoundError("referral not found")
        referral = snap.to_dict() or {}

        if referral.get("status") not in ("pending", "suspicious"):
            return {"referralId": referral_id, "status": referral.get("status"), "changed": False}

        blocking = [f for f in referral.get("riskFlags", []) if f in model.BLOCKING_RISK_FLAGS]
        if blocking:
            return {
                "referralId": referral_id,
                "status": referral.get("status"),
                "changed": False,
                "reason": "blocking_risk_flag",
            }

        referred_uid = referral.get("referredUid")
        user_snap = self._db.collection("users").document(referred_uid).get()
        if not getattr(user_snap, "exists", False):
            return {
                "referralId": referral_id,
                "status": "pending",
                "changed": False,
                "reason": "referred_account_missing",
            }
        user = user_snap.to_dict() or {}

        if user.get("accountStatus") in ("suspended", "closed"):
            return {
                "referralId": referral_id,
                "status": "pending",
                "changed": False,
                "reason": "referred_account_not_active",
            }

        contact_ok = bool(user.get("emailVerified")) or bool(user.get("phoneVerified"))
        if not contact_ok:
            return {
                "referralId": referral_id,
                "status": "pending",
                "changed": False,
                "reason": "contact_verification_incomplete",
            }

        if strict_identity:
            referred_case = self._load_active_case(referred_uid)
            if not model.is_fully_identity_verified(referred_case):
                return {
                    "referralId": referral_id,
                    "status": "pending",
                    "changed": False,
                    "reason": "referred_identity_not_verified",
                }

        self._set_referral_status(
            referral_id,
            "qualified",
            actor_uid="system",
            actor_role="system",
            reason_code="auto_qualified",
        )
        return {"referralId": referral_id, "status": "qualified", "changed": True}

    def _set_referral_status(
        self,
        referral_id: str,
        target: str,
        *,
        actor_uid: str,
        actor_role: str,
        reason: str = "",
        reason_code: str | None = None,
    ) -> None:
        ref = self._db.collection(model.REFERRALS).document(referral_id)
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> None:
            snap = ref.get(transaction=txn)
            if not snap.exists:
                raise NotFoundError("referral not found")
            current = (snap.to_dict() or {}).get("status", "pending")
            if not model.can_transition_referral(current, target):
                raise ConflictError(f"cannot move a referral from {current} to {target}")

            patch: dict = {"status": target, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
            if target == "qualified":
                patch["qualifiedAt"] = fb_firestore.SERVER_TIMESTAMP
            elif target == "revoked":
                patch["revokedAt"] = fb_firestore.SERVER_TIMESTAMP
            if reason:
                patch["adminNotes"] = reason[:500]
            txn.update(ref, patch)

            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role=actor_role,
                    action=f"referral_{target}",
                    target_type="referral",
                    target_id=referral_id,
                    changed_fields=["status"],
                    previous_value=current,
                    new_value=target,
                    reason_code=reason_code,
                ),
            )

        _txn(transaction)

        # The referrer's reward is a FUNCTION of their qualified count,
        # so it is recomputed rather than incremented -- an increment
        # would drift the moment a referral is later revoked.
        referral = ref.get().to_dict() or {}
        self.recompute_reward(referral.get("referrerUid"), actor_uid=actor_uid)

    # -----------------------------------------------------------------
    # Reward recomputation (brief §BD, §AK)
    # -----------------------------------------------------------------

    def recompute_reward(self, uid: str | None, *, actor_uid: str = "system") -> dict | None:
        """Recomputes and stores a user's personal discount from
        authoritative component facts. This is the ONLY writer of
        rewardState.personalDiscountPercent.

        Recompute-from-facts, never increment: revoking a referral has to
        be able to move the number back down, and an incremental counter
        cannot do that correctly.
        """
        if not uid:
            return None

        config = self._load_reward_config()
        case = self._load_active_case(uid)
        qualified = self._count_qualified_referrals(uid)

        breakdown = compute_personal_discount(
            RewardState(
                identity_verified=bool(case.get("idVerified")) and case.get("verificationStatus") == "verified",
                face_verified=case.get("faceResult") == "passed",
                qualified_referral_count=qualified,
            ),
            config,
        )

        state_ref = (
            self._db.collection("users").document(uid).collection("private").document(model.USER_REWARD_STATE)
        )
        previous = state_ref.get()
        previous_percent = (
            (previous.to_dict() or {}).get("personalDiscountPercent")
            if getattr(previous, "exists", False)
            else None
        )
        new_percent = percent_to_float(breakdown.personal_discount_percent)

        payload = breakdown.to_dict()
        payload["updatedAt"] = fb_firestore.SERVER_TIMESTAMP
        state_ref.set(payload, merge=True)

        if previous_percent != new_percent:
            self._append_ledger(uid, previous_percent, new_percent, actor_uid, breakdown)

        return payload

    def _append_ledger(self, uid, previous, new, actor_uid, breakdown) -> None:
        """An append-only history of every change to a user's discount
        (brief §S "Reward History", §AM). Never mutated, never deleted."""
        self._db.collection(model.REWARD_LEDGER).document().set(
            {
                "uid": uid,
                "previousPercent": previous,
                "newPercent": new,
                "verificationReward": percent_to_float(breakdown.verification_reward),
                "referralReward": percent_to_float(breakdown.referral_reward),
                "qualifiedReferralCount": breakdown.qualified_referral_count,
                "actorUid": actor_uid,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            }
        )

    def _count_qualified_referrals(self, uid: str) -> int:
        q = self._db.collection(model.REFERRALS).where("referrerUid", "==", uid).where("status", "==", "qualified")
        return sum(1 for _ in q.stream())

    def _load_reward_config(self) -> RewardConfig:
        snap = self._db.collection(REWARD_CONFIG_COLLECTION).document(REWARD_CONFIG_DOC_ID).get()
        return RewardConfig.from_dict(snap.to_dict() if getattr(snap, "exists", False) else None)

    def _load_active_case(self, uid: str) -> dict:
        snap = self._db.collection(model.VERIFICATION_CASES).document(uid).get()
        return (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}

    # -----------------------------------------------------------------
    # Reads (brief §S, §AH)
    # -----------------------------------------------------------------

    def my_network(self, uid: str) -> dict:
        """A user's own referral picture: their code (only once it is
        unlocked), the people they referred, and their current discount.

        Each referred person is reduced to a first name and a status.
        The referrer is not told the other person's uid, email, phone,
        verification evidence or exact join time -- inviting someone does
        not make you their auditor (§AN).
        """
        case = self._load_active_case(uid)
        unlocked = model.is_referral_unlocked(case)
        code = self._find_code_for_owner(uid) if unlocked else None

        rows = []
        q = self._db.collection(model.REFERRALS).where("referrerUid", "==", uid).limit(200)
        for snap in q.stream():
            data = snap.to_dict() or {}
            referred_uid = data.get("referredUid")
            profile = None
            if referred_uid:
                p = self._db.collection("users").document(referred_uid).get()
                profile = p.to_dict() if getattr(p, "exists", False) else None
            rows.append(
                {
                    "referralId": snap.id,
                    "status": data.get("status", "pending"),
                    "displayName": _safe_display_name(profile),
                }
            )

        state_snap = (
            self._db.collection("users")
            .document(uid)
            .collection("private")
            .document(model.USER_REWARD_STATE)
            .get()
        )
        state = (state_snap.to_dict() or {}) if getattr(state_snap, "exists", False) else {}

        return {
            "referralUnlocked": unlocked,
            "referralCode": code,
            "referrals": rows,
            "qualifiedCount": sum(1 for r in rows if r["status"] == "qualified"),
            "rewardState": {
                k: v
                for k, v in state.items()
                # SERVER_TIMESTAMP-backed fields are not JSON-serializable
                # and carry nothing the UI needs.
                if k != "updatedAt"
            },
        }

    def ensure_code(self, uid: str) -> str | None:
        """Returns the user's code, issuing one if verification has since
        completed but issuance was deferred (see verification_ops). Never
        raises for a locked account -- returns None, which the UI shows
        as the locked state."""
        try:
            return self.issue_code_for(uid)
        except ForbiddenError:
            return None

    def admin_referral_view(self, referral_id: str, *, actor_permissions: set[str]) -> dict:
        """One referral relationship, for the admin referral graph."""
        if "referrals.review" not in (actor_permissions or set()):
            raise ForbiddenError("missing required permission: referrals.review")
        snap = self._db.collection(model.REFERRALS).document(referral_id).get()
        if not getattr(snap, "exists", False):
            raise NotFoundError("referral not found")
        data = snap.to_dict() or {}
        return {
            "referralId": referral_id,
            "referrerUid": data.get("referrerUid"),
            "referredUid": data.get("referredUid"),
            "status": data.get("status", "pending"),
            "code": data.get("code"),
            "riskFlags": [f for f in (data.get("riskFlags") or []) if f in model.RISK_FLAGS],
            "reason": data.get("reason", "") or "",
        }

    def admin_list_referrals(
        self, *, actor_permissions: set[str], status: str | None = None, limit: int = 100
    ) -> list[dict]:
        if "referrals.review" not in (actor_permissions or set()):
            raise ForbiddenError("missing required permission: referrals.review")
        if status is not None and status not in model.REFERRAL_STATUSES:
            raise ValidationError("unknown referral status")
        q = self._db.collection(model.REFERRALS)
        if status is not None:
            q = q.where("status", "==", status)
        rows = []
        for snap in q.limit(max(1, min(int(limit or 100), 300))).stream():
            data = snap.to_dict() or {}
            rows.append(
                {
                    "referralId": snap.id,
                    "referrerUid": data.get("referrerUid"),
                    "referredUid": data.get("referredUid"),
                    "status": data.get("status", "pending"),
                    "riskFlags": [f for f in (data.get("riskFlags") or []) if f in model.RISK_FLAGS],
                }
            )
        return rows

    # -----------------------------------------------------------------
    # Reward configuration (brief §T)
    # -----------------------------------------------------------------

    def read_reward_config(self) -> dict:
        return self._load_reward_config().to_dict()

    def write_reward_config(self, data: dict, *, actor_uid: str, actor_permissions: set[str]) -> dict:
        """Admin-editable reward policy. Validated against the SAME
        rules the formula uses, so a value that would break decimal
        percentages (§A) is rejected before it is ever stored."""
        if "rewards.manage" not in (actor_permissions or set()):
            raise ForbiddenError("missing required permission: rewards.manage")
        problems = validate_reward_config(data)
        if problems:
            raise ValidationError("; ".join(problems))

        previous = self._load_reward_config().to_dict()
        config = RewardConfig.from_dict(data)
        payload = config.to_dict()
        ref = self._db.collection(REWARD_CONFIG_COLLECTION).document(REWARD_CONFIG_DOC_ID)

        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> None:
            txn.set(
                ref, {**payload, "updatedAt": fb_firestore.SERVER_TIMESTAMP, "updatedBy": actor_uid}, merge=True
            )
            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action="reward_config_updated",
                    target_type="rewardConfig",
                    target_id=REWARD_CONFIG_DOC_ID,
                    changed_fields=sorted(payload.keys()),
                    previous_value=json.dumps(previous, sort_keys=True),
                    new_value=json.dumps(payload, sort_keys=True),
                    reason_code="admin_policy_change",
                ),
            )

        _txn(transaction)
        # A policy change moves everyone's number, but recomputing every
        # user synchronously inside an admin request would time out. Each
        # user's stored discount is refreshed by recompute_reward on their
        # next reward-affecting event; the config itself is authoritative
        # for anything computed live.
        return payload

    # -----------------------------------------------------------------
    # Admin actions (brief §AI)
    # -----------------------------------------------------------------

    def admin_set_status(self, referral_id: str, target: str, *, actor_uid: str, reason: str = "") -> dict:
        if target not in model.REFERRAL_STATUSES:
            raise ValidationError("unknown referral status")
        if target in ("rejected", "revoked") and not reason.strip():
            raise ValidationError("a reason is required to reject or revoke a referral")
        self._set_referral_status(
            referral_id,
            target,
            actor_uid=actor_uid,
            actor_role="admin",
            reason=reason,
        )
        return {"referralId": referral_id, "status": target}

    def admin_correct_referrer(self, *, referred_uid: str, new_code: object, actor_uid: str, reason: str) -> dict:
        """The genuine-error correction path from §P. Requires a reason,
        is fully audited, and recomputes BOTH the old and the new
        referrer's rewards."""
        if not reason or not reason.strip():
            raise ValidationError("a reason is required to correct a referrer")
        code = model.normalize_referral_code(new_code)
        if code is None:
            raise NotFoundError("invalid referral code")

        existing = self._existing_referral_for(referred_uid)
        old_referrer = existing.get("referrerUid") if existing else None
        old_id = existing.get("referralId") if existing else None

        code_snap = self._db.collection(model.REFERRAL_CODES).document(code).get()
        if not getattr(code_snap, "exists", False):
            raise NotFoundError("invalid referral code")
        new_referrer = (code_snap.to_dict() or {}).get("ownerUid")
        if new_referrer == referred_uid:
            raise ValidationError("an account cannot refer itself")
        if new_referrer == old_referrer:
            raise ConflictError("that is already this account's referrer")

        if old_id:
            self._db.collection(model.REFERRALS).document(old_id).update(
                {
                    "status": "revoked",
                    "revokedAt": fb_firestore.SERVER_TIMESTAMP,
                    "adminNotes": f"corrected by admin: {reason}"[:500],
                }
            )

        new_id = f"{new_referrer}__{referred_uid}"
        self._db.collection(model.REFERRALS).document(new_id).set(
            {
                "referralId": new_id,
                "referrerUid": new_referrer,
                "referredUid": referred_uid,
                "referralCode": code,
                "status": "pending",
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
                "qualifiedAt": None,
                "rewardGrantedAt": None,
                "revokedAt": None,
                "riskFlags": [],
                "adminNotes": f"admin correction: {reason}"[:500],
            }
        )

        batch = self._db.batch()
        write_audit(
            batch,
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="admin",
                action="referral_referrer_corrected",
                target_type="user",
                target_id=referred_uid,
                changed_fields=["referrerUid"],
                previous_value=old_referrer,
                new_value=new_referrer,
                reason_code="admin_correction",
            ),
        )
        batch.commit()

        for uid in {old_referrer, new_referrer}:
            if uid:
                self.recompute_reward(uid, actor_uid=actor_uid)
        return {"referralId": new_id, "status": "pending"}
