# Verification cases and Admin KYC review -- the trusted side.
#
# firestore.rules makes `verificationCases` and its `evidence`
# subcollection unwritable by any client except for the narrow
# "submit my own case" path, so every status transition, every reward
# consequence and every evidence reveal happens here.
#
# WHAT THIS MODULE NEVER DOES
# ---------------------------
#   * It never stores an image. Evidence bytes live in Cloud Storage
#     behind a private path; only metadata and a content hash are
#     recorded here (§AN).
#   * It never returns a durable URL. Admin evidence access mints a
#     short-lived signed URL per explicit click and audits it (§Z, §AV).
#   * It never closes an account automatically from a name mismatch, a
#     face mismatch, OCR or image quality (§AB). Those produce review
#     signals; a human decides.
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

from . import model
from .referral_ops import ReferralOps

logger = logging.getLogger(__name__)

# Admin evidence retrieval is a temporary grant, never a permanent link.
EVIDENCE_URL_TTL = timedelta(minutes=10)

# Private Storage prefix. Deliberately keyed by uid + case + opaque
# evidence id -- NEVER by the person's name (§AQ).
EVIDENCE_STORAGE_PREFIX = "verification-evidence"

MAX_REASON_LENGTH = 1000


@dataclass(frozen=True)
class ReviewDecision:
    status: str
    account_status: str | None = None
    reason: str = ""


class VerificationOps:
    def __init__(self, db, *, bucket=None, referral_ops: ReferralOps | None = None):
        self._db = db
        self._bucket = bucket
        self._referrals = referral_ops or ReferralOps(db)

    # -----------------------------------------------------------------
    # User-side submission (brief §D, §E, §F)
    # -----------------------------------------------------------------

    def submit_case(
        self,
        *,
        uid: str,
        track: str = "identity",
        evidence: list[dict] | None = None,
        id_name: str | None = None,
        consent_version: str | None = None,
    ) -> dict:
        """Moves a user's case to 'pending' review.

        The caller supplies evidence METADATA for objects it has already
        uploaded to its own private Storage prefix (the Storage rules let
        a user write only under their own uid). This never accepts image
        bytes and never accepts a verification RESULT -- a client cannot
        declare itself verified (§AK).
        """
        if not uid:
            raise ValidationError("uid is required")
        if track not in model.VERIFICATION_TRACKS:
            raise ValidationError("unknown verification track")
        if not consent_version:
            # §AO: evidence may not be submitted without recorded consent.
            raise ValidationError("consent is required before submitting identity evidence")

        items = self._normalize_evidence(evidence or [], uid)
        if track == "identity" and not any(i["kind"] == "id_front" for i in items):
            raise ValidationError("an ID front image is required")

        case_ref = self._db.collection(model.VERIFICATION_CASES).document(uid)
        user_ref = self._db.collection("users").document(uid)
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> dict:
            snap = case_ref.get(transaction=txn)
            current = (
                (snap.to_dict() or {}).get("verificationStatus", "unverified") if snap.exists else "unverified"
            )
            if not model.can_transition_verification(current, "pending"):
                raise ConflictError(f"a case in '{current}' cannot be submitted for review")

            user_snap = user_ref.get(transaction=txn)
            profile = (user_snap.to_dict() or {}) if user_snap.exists else {}
            if profile.get("accountStatus") in ("suspended", "closed"):
                raise ForbiddenError("this account cannot submit verification")

            comparison = model.compare_names(profile.get("displayName") or profile.get("fullName"), id_name)

            payload = {
                "uid": uid,
                "track": track,
                "verificationStatus": "pending",
                "idVerified": False,
                "faceResult": "pending",
                # The ID name is review evidence, not public profile data.
                # It is stored on the case (admin-readable only), never
                # mirrored onto users/{uid}.
                "idName": (id_name or "")[:200],
                "nameMatch": comparison.result,
                "nameMatchReason": comparison.reason,
                "documentQuality": "pending",
                "consentVersion": consent_version,
                "consentAt": fb_firestore.SERVER_TIMESTAMP,
                "submittedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                "evidenceCount": len(items),
                "archiveStatus": "none",
            }
            if comparison.result == "strong_mismatch":
                # A flag for the reviewer -- explicitly NOT a closure.
                payload["riskFlags"] = fb_firestore.ArrayUnion(["name_strong_mismatch"])

            txn.set(case_ref, payload, merge=True)

            for item in items:
                ev_ref = case_ref.collection(model.VERIFICATION_EVIDENCE).document(item["evidenceId"])
                txn.set(ev_ref, item, merge=True)

            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=uid,
                    actor_role="user",
                    action="verification_submitted",
                    target_type="verificationCase",
                    target_id=uid,
                    changed_fields=["verificationStatus"],
                    previous_value=current,
                    new_value="pending",
                ),
            )
            return {"verificationStatus": "pending", "nameMatch": comparison.result}

        return _txn(transaction)

    def _normalize_evidence(self, evidence: list[dict], uid: str) -> list[dict]:
        """Shapes client-declared evidence metadata into exactly the
        fields we store. Anything else in the request body is dropped --
        a client cannot smuggle a status, a result or a URL in here.

        `storagePath` is REBUILT from the uid rather than trusted, so a
        caller cannot point a case at another user's evidence.
        """
        out: list[dict] = []
        seen: set[str] = set()
        for raw in evidence[:12]:
            if not isinstance(raw, dict):
                continue
            kind = raw.get("kind")
            if kind not in model.EVIDENCE_KINDS:
                raise ValidationError(f"unknown evidence kind: {kind!r}")
            object_id = raw.get("objectId")
            if not isinstance(object_id, str) or not object_id or "/" in object_id or ".." in object_id:
                raise ValidationError("each evidence item needs a simple objectId")
            if object_id in seen:
                raise ValidationError("duplicate evidence objectId")
            seen.add(object_id)

            content_hash = raw.get("contentHash")
            if content_hash is not None and (
                not isinstance(content_hash, str) or not _is_sha256_hex(content_hash)
            ):
                raise ValidationError("contentHash must be a sha256 hex digest")

            quality = raw.get("quality")
            issues = []
            if isinstance(quality, dict):
                issues = [i for i in (quality.get("issues") or []) if i in model.QUALITY_ISSUES]

            out.append(
                {
                    "evidenceId": object_id,
                    "kind": kind,
                    # Rebuilt server-side, never taken from the request.
                    "storagePath": f"{EVIDENCE_STORAGE_PREFIX}/{uid}/{object_id}",
                    "contentHash": content_hash or "",
                    "qualityIssues": issues,
                    "uploadedAt": fb_firestore.SERVER_TIMESTAMP,
                    "liveEvidenceDeleted": False,
                }
            )
        return out

    # -----------------------------------------------------------------
    # Admin review (brief §AB)
    # -----------------------------------------------------------------

    def review_case(
        self,
        *,
        uid: str,
        decision: ReviewDecision,
        actor_uid: str,
        actor_permissions: set[str],
    ) -> dict:
        """Applies an admin decision and, when it results in full
        identity verification, recomputes the user's reward.

        Verification status and ACCOUNT status move independently (§H):
        a rejected verification does not by itself restrict an account,
        and the caller must ask for that separately.
        """
        _require(actor_permissions, "verification.review")
        if decision.status not in model.VERIFICATION_STATUSES:
            raise ValidationError("unknown verification status")
        if decision.account_status is not None:
            if decision.account_status not in model.ACCOUNT_STATUSES:
                raise ValidationError("unknown account status")
            needed = {
                "restricted": "verification.account.restrict",
                "suspended": "verification.account.suspend",
                "closed": "verification.account.close",
            }.get(decision.account_status)
            if needed:
                _require(actor_permissions, needed)
            if decision.account_status == "closed" and not decision.reason.strip():
                # §AB: permanent closure always needs a reason.
                raise ValidationError("closing an account requires a reason")

        if decision.status in ("rejected", "needs_resubmission") and not decision.reason.strip():
            raise ValidationError("a reason is required for this decision")

        reason = decision.reason.strip()[:MAX_REASON_LENGTH]
        case_ref = self._db.collection(model.VERIFICATION_CASES).document(uid)
        user_ref = self._db.collection("users").document(uid)
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> dict:
            snap = case_ref.get(transaction=txn)
            if not snap.exists:
                raise NotFoundError("no verification case for this user")
            case = snap.to_dict() or {}
            current = case.get("verificationStatus", "unverified")
            if not model.can_transition_verification(current, decision.status):
                raise ConflictError(f"cannot move a case from {current} to {decision.status}")

            patch: dict = {
                "verificationStatus": decision.status,
                "reviewedBy": actor_uid,
                "reviewedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                "reviewReason": reason,
            }
            if decision.status == "verified":
                patch["idVerified"] = True
                patch["verifiedAt"] = fb_firestore.SERVER_TIMESTAMP
            txn.update(case_ref, patch)

            if decision.account_status is not None:
                txn.set(
                    user_ref,
                    {
                        "accountStatus": decision.account_status,
                        "accountStatusReason": reason,
                        "accountStatusUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
                        "accountStatusUpdatedBy": actor_uid,
                    },
                    merge=True,
                )

            write_audit(
                txn,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action=f"verification_{decision.status}",
                    target_type="verificationCase",
                    target_id=uid,
                    changed_fields=["verificationStatus"],
                    previous_value=current,
                    new_value=decision.status,
                    reason_code="admin_review",
                ),
            )
            if decision.account_status is not None:
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action=f"account_{decision.account_status}",
                        target_type="user",
                        target_id=uid,
                        changed_fields=["accountStatus"],
                        new_value=decision.account_status,
                        reason_code="admin_review",
                    ),
                )
            return {"verificationStatus": decision.status}

        result = _txn(transaction)

        # Full verification unlocks the referral network and the +3.5%.
        # Recomputed from facts, never asserted.
        self._referrals.recompute_reward(uid, actor_uid=actor_uid)
        if decision.status == "verified":
            case = case_ref.get().to_dict() or {}
            if model.is_fully_identity_verified(case):
                try:
                    self._referrals.issue_code_for(uid, actor_uid=actor_uid)
                except Exception:  # noqa: BLE001
                    # A code-issuance hiccup must not undo an approved
                    # verification; the code is issued lazily on next read.
                    logger.warning("deferred referral code issuance for %s", uid)
            # A newly verified referred account may now qualify its
            # referrer's pending relationship.
            self._maybe_qualify_inbound(uid)
        return result

    def set_face_result(self, *, uid: str, result: str, actor_uid: str, actor_permissions: set[str]) -> dict:
        """Records a face/liveness outcome.

        'failed' routes to manual review -- it never closes an account
        and never by itself rejects the case (§F, §AB).
        """
        _require(actor_permissions, "verification.review")
        if result not in model.FACE_RESULTS:
            raise ValidationError("unknown face result")

        case_ref = self._db.collection(model.VERIFICATION_CASES).document(uid)
        patch = {
            "faceResult": result,
            "faceResultAt": fb_firestore.SERVER_TIMESTAMP,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        if result in ("failed", "needs_review"):
            patch["riskFlags"] = fb_firestore.ArrayUnion(["face_mismatch"])
            # Explicitly routed to a human rather than auto-rejected.
            patch["verificationStatus"] = "needs_review"
        case_ref.set(patch, merge=True)

        batch = self._db.batch()
        write_audit(
            batch,
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="admin",
                action="verification_face_result",
                target_type="verificationCase",
                target_id=uid,
                changed_fields=["faceResult"],
                new_value=result,
            ),
        )
        batch.commit()
        self._referrals.recompute_reward(uid, actor_uid=actor_uid)
        return {"faceResult": result}

    def _maybe_qualify_inbound(self, referred_uid: str) -> None:
        q = self._db.collection(model.REFERRALS).where("referredUid", "==", referred_uid).limit(1)
        for doc in q.stream():
            try:
                self._referrals.evaluate_qualification(doc.id)
            except Exception:  # noqa: BLE001
                logger.warning("qualification check failed for %s", doc.id)

    # -----------------------------------------------------------------
    # Reads (brief §C, §U, §V)
    # -----------------------------------------------------------------

    def own_case_view(self, uid: str) -> dict:
        """What a user is allowed to know about their OWN case.

        Deliberately narrower than the stored document: no storagePath,
        no reviewer uid, no risk flags. A person should be told what to
        DO next, not handed the internal review file (§AN), and a
        fraud-risk flag shown back to the person it describes is a
        recipe for teaching them how to evade it.
        """
        snap = self._db.collection(model.VERIFICATION_CASES).document(uid).get()
        case = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
        return {
            "verificationStatus": case.get("verificationStatus", "unverified"),
            "track": case.get("track", "identity"),
            "idVerified": case.get("idVerified") is True,
            "faceResult": case.get("faceResult", "pending"),
            "fullyVerified": model.is_fully_identity_verified(case),
            "referralUnlocked": model.is_referral_unlocked(case),
            # The reason is author-written by a reviewer and is meant to
            # be read by this person -- that is the whole point of
            # needs_resubmission (§AC).
            "reviewReason": case.get("reviewReason", "") or "",
            "submittedAt": _iso_or_none(case.get("submittedAt")),
            "reviewedAt": _iso_or_none(case.get("reviewedAt")),
        }

    def list_cases(
        self,
        *,
        actor_permissions: set[str],
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """Review-queue summaries. No evidence, no storage paths, no
        signed URLs -- opening a document is always its own audited,
        one-object call (§Z)."""
        _require(actor_permissions, "verification.view")
        if status is not None and status not in model.VERIFICATION_STATUSES:
            raise ValidationError("unknown verification status")

        q = self._db.collection(model.VERIFICATION_CASES)
        if status is not None:
            q = q.where("verificationStatus", "==", status)
        limit = max(1, min(int(limit or 50), 200))

        rows = []
        for snap in q.limit(limit).stream():
            case = snap.to_dict() or {}
            rows.append(
                {
                    "uid": snap.id,
                    "verificationStatus": case.get("verificationStatus", "unverified"),
                    "track": case.get("track", "identity"),
                    "faceResult": case.get("faceResult", "pending"),
                    "nameMatch": case.get("nameMatch"),
                    "riskFlags": [f for f in (case.get("riskFlags") or []) if f in model.RISK_FLAGS],
                    "risk": model.overall_risk(
                        name_match=case.get("nameMatch"),
                        face_result=case.get("faceResult"),
                        risk_flags=case.get("riskFlags") or [],
                    ),
                    "submittedAt": _iso_or_none(case.get("submittedAt")),
                }
            )
        # Oldest submission first: a review queue is a queue, and sorting
        # here rather than with an orderBy keeps this working without a
        # composite index having to be deployed first.
        rows.sort(key=lambda r: r["submittedAt"] or "")
        return rows

    def case_detail(self, *, uid: str, actor_permissions: set[str]) -> dict:
        """One case plus its evidence METADATA. Never a URL: a reviewer
        who wants to see an image calls reveal_evidence for exactly that
        one object, and that call is audited before the URL exists."""
        _require(actor_permissions, "verification.view")
        snap = self._db.collection(model.VERIFICATION_CASES).document(uid).get()
        if not getattr(snap, "exists", False):
            raise NotFoundError("no verification case for this user")
        case = snap.to_dict() or {}

        may_see_documents = "verification.documents.view" in (actor_permissions or set())
        evidence = []
        if may_see_documents:
            ev_col = (
                self._db.collection(model.VERIFICATION_CASES).document(uid).collection(model.VERIFICATION_EVIDENCE)
            )
            for ev in ev_col.stream():
                item = ev.to_dict() or {}
                evidence.append(
                    {
                        "evidenceId": ev.id,
                        "kind": item.get("kind"),
                        "qualityIssues": item.get("qualityIssues") or [],
                        "liveEvidenceDeleted": item.get("liveEvidenceDeleted") is True,
                        "uploadedAt": _iso_or_none(item.get("uploadedAt")),
                        # The hash proves two submissions are the same
                        # file. It is not the file.
                        "contentHash": item.get("contentHash") or "",
                    }
                )

        user_snap = self._db.collection("users").document(uid).get()
        user = (user_snap.to_dict() or {}) if getattr(user_snap, "exists", False) else {}

        return {
            "uid": uid,
            "verificationStatus": case.get("verificationStatus", "unverified"),
            "track": case.get("track", "identity"),
            "idVerified": case.get("idVerified") is True,
            "faceResult": case.get("faceResult", "pending"),
            "nameMatch": case.get("nameMatch"),
            "nameMatchReason": case.get("nameMatchReason"),
            "riskFlags": [f for f in (case.get("riskFlags") or []) if f in model.RISK_FLAGS],
            "risk": model.overall_risk(
                name_match=case.get("nameMatch"),
                face_result=case.get("faceResult"),
                risk_flags=case.get("riskFlags") or [],
            ),
            "consentVersion": case.get("consentVersion"),
            "reviewReason": case.get("reviewReason", "") or "",
            "reviewedBy": case.get("reviewedBy"),
            "submittedAt": _iso_or_none(case.get("submittedAt")),
            "reviewedAt": _iso_or_none(case.get("reviewedAt")),
            "displayName": user.get("displayName") or user.get("fullName") or "",
            "accountType": user.get("accountType"),
            "accountStatus": user.get("accountStatus", "active"),
            "evidence": evidence,
            "evidenceVisible": may_see_documents,
        }

    def dashboard_metrics(self, *, actor_permissions: set[str]) -> dict:
        """Real counts only (§U). Every number here is a count of
        documents that exist -- there are no modelled or projected
        figures, and a collection that is empty reports zero rather than
        a placeholder."""
        _require(actor_permissions, "verification.view")
        counts = {}
        for status in sorted(model.VERIFICATION_STATUSES):
            q = self._db.collection(model.VERIFICATION_CASES).where("verificationStatus", "==", status)
            counts[status] = sum(1 for _ in q.stream())
        referrals = {}
        for status in sorted(model.REFERRAL_STATUSES):
            q = self._db.collection(model.REFERRALS).where("status", "==", status)
            referrals[status] = sum(1 for _ in q.stream())
        return {"cases": counts, "referrals": referrals}

    # -----------------------------------------------------------------
    # Evidence access (brief §Z, §AV)
    # -----------------------------------------------------------------

    def reveal_evidence(self, *, uid: str, evidence_id: str, actor_uid: str, actor_permissions: set[str]) -> dict:
        """Mints a SHORT-LIVED signed URL for ONE evidence object.

        Deliberately one object per call: §Z forbids bulk-loading
        evidence, so there is no endpoint that returns many. Every call
        is audited as a sensitive reveal (§AM) BEFORE the URL is minted,
        so an access cannot happen without a record.
        """
        _require(actor_permissions, "verification.documents.view")

        ev_ref = (
            self._db.collection(model.VERIFICATION_CASES)
            .document(uid)
            .collection(model.VERIFICATION_EVIDENCE)
            .document(evidence_id)
        )
        snap = ev_ref.get()
        if not snap.exists:
            raise NotFoundError("evidence not found")
        item = snap.to_dict() or {}
        if item.get("liveEvidenceDeleted"):
            raise ConflictError("live evidence has been archived and deleted")

        batch = self._db.batch()
        write_audit(
            batch,
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="admin",
                action="verification_evidence_revealed",
                target_type="verificationEvidence",
                target_id=f"{uid}/{evidence_id}",
                changed_fields=[],
                new_value=item.get("kind"),
                reason_code="sensitive_reveal",
            ),
        )
        batch.commit()

        if self._bucket is None:
            # Honest failure: the storage binding is not configured in
            # this environment, so say so rather than returning nothing
            # that looks like success (§BI).
            raise ConflictError("evidence storage is not configured in this environment")

        blob = self._bucket.blob(item["storagePath"])
        url = blob.generate_signed_url(version="v4", expiration=EVIDENCE_URL_TTL, method="GET")
        return {
            "kind": item.get("kind"),
            "url": url,
            "expiresInSeconds": int(EVIDENCE_URL_TTL.total_seconds()),
        }


def _iso_or_none(value) -> str | None:
    """Firestore hands back a datetime for a timestamp field, but an
    unflushed SERVER_TIMESTAMP sentinel or a fake in tests may not have
    isoformat() -- so this never assumes a type it hasn't checked."""
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else None


def _is_sha256_hex(value: str) -> bool:
    return len(value) == 64 and all(c in "0123456789abcdef" for c in value.lower())


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require(permissions: set[str], needed: str) -> None:
    """Fail-closed permission check (§AL). An admin without the specific
    capability is refused even though they are an admin -- not every
    future admin should be able to open identity documents."""
    if needed not in (permissions or set()):
        raise ForbiddenError(f"missing required permission: {needed}")
