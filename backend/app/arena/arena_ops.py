# Trusted backend layer for Darwesh Arena: challenges, step progression,
# points, ranks and the leaderboard. Every write here goes through the
# Firebase Admin SDK, which is exactly why firestore.rules make every
# Arena collection `allow write: if false` for every client SDK caller,
# admin sessions included -- this module is the only path in.
#
# THE STEP ENGINE. A Challenge (arenaChallenges/{id}) is authored as an
# ordered `steps` array -- nothing about a specific real-estate flow is
# hardcoded anywhere in this file. `advance_step` is the one function
# that moves a participant through WHATEVER steps a challenge declares,
# reading each step's `points`/`requiredVerificationBy`/
# `unlockAfterStepKey` from the challenge document itself. A brand-new
# challenge with a completely different flow needs zero code changes --
# only new challenge data (this is the explicit "VERY IMPORTANT: do not
# hard-code every Challenge into the frontend" requirement, applied
# symmetrically to the backend).
#
# POINTS ARE RECOMPUTED, NEVER INCREMENTED. `recompute_state` sums
# arenaLedger facts on every call and is the sole writer of both
# users/{uid}/private/arenaState and arenaLeaderboardEntries/{uid} --
# exactly ReferralOps.recompute_reward's pattern, so a later
# manual_point_adjustment reversal (fraud found after the fact) always
# produces the correct total, never a drifted counter.
#
# Every method server-validates its own preconditions from data it reads
# itself inside the transaction -- never from anything the caller merely
# asserts in the request body, mirroring organization_ops.py's convention.
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import UTC, datetime, timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

from . import model

_MAX_TEXT_FIELD_LENGTH = 2000
_MAX_NAME_LENGTH = 200
_MAX_STEPS = 40

# A burst of joins/submissions from one account is the classic farming
# pattern (same principle as referral_ops.py's _is_signup_burst). Flags
# for review, never auto-punishes.
_BURST_WINDOW = timedelta(hours=1)
_BURST_THRESHOLD = 5

# ~100m at the equator, coarse enough that two submissions for genuinely
# the same address collide even with slightly different precision, fine
# enough that two different but nearby properties don't.
_LOCATION_ROUND_DECIMALS = 3


def _clean_text(value: object, *, field: str, max_length: int, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ValidationError(f"'{field}' is required")
        return None
    if not isinstance(value, str):
        raise ValidationError(f"'{field}' must be a string")
    stripped = value.strip()
    if required and not stripped:
        raise ValidationError(f"'{field}' is required")
    if len(stripped) > max_length:
        raise ValidationError(f"'{field}' must be at most {max_length} characters")
    return stripped or None


def _clean_points(value: object, *, field: str) -> int:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValidationError(f"'{field}' must be a number")
    n = int(value)
    if abs(n) > 100000:
        raise ValidationError(f"'{field}' is out of range")
    return n


def _normalize_phone(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    digits = re.sub(r"\D", "", raw)
    return digits or None


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _round_coord(value: object) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    return round(float(value), _LOCATION_ROUND_DECIMALS)


def _validate_steps(steps: object) -> list[dict]:
    if not isinstance(steps, list) or not steps:
        raise ValidationError("'steps' must be a non-empty list")
    if len(steps) > _MAX_STEPS:
        raise ValidationError(f"a challenge may have at most {_MAX_STEPS} steps")
    seen_keys: set[str] = set()
    first_step_seen = False
    cleaned: list[dict] = []
    for raw in steps:
        if not isinstance(raw, dict):
            raise ValidationError("each step must be an object")
        key = _clean_text(raw.get("key"), field="step.key", max_length=80, required=True)
        if key in seen_keys:
            raise ValidationError(f"duplicate step key '{key}'")
        seen_keys.add(key)
        verification_by = raw.get("requiredVerificationBy")
        if verification_by not in model.REQUIRED_VERIFICATION_BY:
            raise ValidationError(f"step '{key}': 'requiredVerificationBy' must be 'none' or 'admin'")
        unlock_after = raw.get("unlockAfterStepKey")
        if unlock_after is not None and not isinstance(unlock_after, str):
            raise ValidationError(f"step '{key}': 'unlockAfterStepKey' must be a string or null")
        if unlock_after is None:
            first_step_seen = True
        cleaned.append(
            {
                "key": key,
                "name": _clean_text(
                    raw.get("name"), field="step.name", max_length=_MAX_NAME_LENGTH, required=True
                ),
                "description": _clean_text(
                    raw.get("description"), field="step.description", max_length=_MAX_TEXT_FIELD_LENGTH
                )
                or "",
                "requiredAction": _clean_text(
                    raw.get("requiredAction"), field="step.requiredAction", max_length=_MAX_TEXT_FIELD_LENGTH
                )
                or "",
                "requiredVerificationBy": verification_by,
                "requiredPropertyState": _clean_text(
                    raw.get("requiredPropertyState"), field="step.requiredPropertyState", max_length=60
                ),
                "points": _clean_points(raw.get("points", 0), field="step.points"),
                "optional": bool(raw.get("optional", False)),
                "unlockAfterStepKey": unlock_after,
                "hint": {
                    "enabled": bool((raw.get("hint") or {}).get("enabled", False)),
                    "text": _clean_text(
                        (raw.get("hint") or {}).get("text"),
                        field="step.hint.text",
                        max_length=_MAX_TEXT_FIELD_LENGTH,
                    )
                    or "",
                },
                "reward": _clean_text(raw.get("reward"), field="step.reward", max_length=400) or "",
            }
        )
    if not first_step_seen:
        raise ValidationError("exactly one step must have no 'unlockAfterStepKey' (the first step)")
    for step in cleaned:
        if step["unlockAfterStepKey"] and step["unlockAfterStepKey"] not in seen_keys:
            raise ValidationError(f"step '{step['key']}': unlockAfterStepKey references an unknown step")
    return cleaned


class ArenaOps:
    def __init__(self, db, logger: logging.Logger | None = None, *, clock=None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.arena")
        self._clock = clock or (lambda: datetime.now(UTC))

    # ---- challenge CRUD (admin-only) -----------------------------------

    async def create_challenge(self, *, data: dict, actor_uid: str, actor_is_admin: bool) -> str:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may create a challenge")
        payload = self._clean_challenge_payload(data)

        def _write() -> str:
            ref = self._db.collection(model.ARENA_CHALLENGES).document()
            batch = self._db.batch()
            batch.set(
                ref,
                {
                    **payload,
                    "participantCount": 0,
                    "completedCount": 0,
                    "createdBy": actor_uid,
                    "updatedBy": actor_uid,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action="arena_challenge_created",
                    target_type="arenaChallenge",
                    target_id=ref.id,
                    new_value=payload.get("name"),
                ),
            )
            batch.commit()
            return ref.id

        return await asyncio.to_thread(_write)

    async def update_challenge(
        self, *, challenge_id: str, data: dict, actor_uid: str, actor_is_admin: bool
    ) -> None:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may edit a challenge")
        payload = self._clean_challenge_payload(data)
        ref = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"challenge '{challenge_id}' does not exist")
                txn.update(ref, {**payload, "updatedBy": actor_uid, "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_challenge_updated",
                        target_type="arenaChallenge",
                        target_id=challenge_id,
                        changed_fields=sorted(payload.keys()),
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def set_challenge_status(
        self, *, challenge_id: str, status: str, actor_uid: str, actor_is_admin: bool
    ) -> None:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may change a challenge's status")
        if status not in model.CHALLENGE_STATUSES:
            raise ValidationError(f"'{status}' is not a valid challenge status")
        ref = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"challenge '{challenge_id}' does not exist")
                previous = snap.get("status")
                txn.update(
                    ref, {"status": status, "updatedBy": actor_uid, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_challenge_status_changed",
                        target_type="arenaChallenge",
                        target_id=challenge_id,
                        previous_value=previous,
                        new_value=status,
                        changed_fields=["status"],
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def delete_challenge(self, *, challenge_id: str, actor_uid: str, actor_is_admin: bool) -> None:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may delete a challenge")
        ref = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"challenge '{challenge_id}' does not exist")
                if int(snap.get("participantCount") or 0) > 0:
                    raise ConflictError("cannot delete a challenge that already has participants")
                txn.delete(ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_challenge_deleted",
                        target_type="arenaChallenge",
                        target_id=challenge_id,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    def _clean_challenge_payload(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise ValidationError("request body must be an object")
        category = data.get("category")
        if category is not None and category not in model.CATEGORIES:
            raise ValidationError(f"'{category}' is not a valid category")
        difficulty = data.get("difficulty")
        if difficulty is not None and difficulty not in model.DIFFICULTIES:
            raise ValidationError(f"'{difficulty}' is not a valid difficulty")
        status = data.get("status", "draft")
        if status not in model.CHALLENGE_STATUSES:
            raise ValidationError(f"'{status}' is not a valid challenge status")
        eligibility = data.get("eligibility") or {}
        visibility = eligibility.get("visibility", "public")
        if visibility not in model.VISIBILITIES:
            raise ValidationError(f"'{visibility}' is not a valid eligibility visibility")

        completion_reward = data.get("completionReward") or {}
        unlock_requirements = data.get("unlockRequirements") or {}

        return {
            "name": _clean_text(data.get("name"), field="name", max_length=_MAX_NAME_LENGTH, required=True),
            "description": _clean_text(
                data.get("description"), field="description", max_length=_MAX_TEXT_FIELD_LENGTH
            )
            or "",
            "artworkUrl": _clean_text(data.get("artworkUrl"), field="artworkUrl", max_length=1000) or "",
            "category": category,
            "difficulty": difficulty,
            "status": status,
            "startDate": data.get("startDate"),
            "endDate": data.get("endDate"),
            "steps": _validate_steps(data.get("steps")),
            "completionReward": {
                "points": _clean_points(completion_reward.get("points", 0), field="completionReward.points"),
                "badge": completion_reward.get("badge")
                if isinstance(completion_reward.get("badge"), dict)
                else None,
                "certificate": bool(completion_reward.get("certificate", False)),
                "rankBonusXp": _clean_points(
                    completion_reward.get("rankBonusXp", 0), field="completionReward.rankBonusXp"
                ),
            },
            "unlockRequirements": {
                "minXp": unlock_requirements.get("minXp"),
                "minRankOrder": unlock_requirements.get("minRankOrder"),
                "prerequisiteChallengeIds": [
                    c for c in (unlock_requirements.get("prerequisiteChallengeIds") or []) if isinstance(c, str)
                ],
                "verifiedAccountRequired": bool(unlock_requirements.get("verifiedAccountRequired", False)),
                "cities": [c for c in (unlock_requirements.get("cities") or []) if isinstance(c, str)],
                "accountTypes": [c for c in (unlock_requirements.get("accountTypes") or []) if isinstance(c, str)],
                "minPreviousSales": unlock_requirements.get("minPreviousSales"),
            },
            "maxParticipants": data.get("maxParticipants"),
            "eligibility": {
                "visibility": visibility,
                "cities": [c for c in (eligibility.get("cities") or []) if isinstance(c, str)],
                "propertyTypes": [c for c in (eligibility.get("propertyTypes") or []) if isinstance(c, str)],
            },
            "mainPrize": _clean_text(data.get("mainPrize"), field="mainPrize", max_length=400) or "",
            "bonusReward": _clean_text(data.get("bonusReward"), field="bonusReward", max_length=400) or "",
            "rewardsPreview": _clean_text(data.get("rewardsPreview"), field="rewardsPreview", max_length=400)
            or "",
            # Business targets (brief: "90-day acquisition and sales
            # engine" -- these are planning targets an admin sets and the
            # commercial dashboard tracks progress against, never a
            # hardcoded assumption baked into code).
            "durationDays": data.get("durationDays")
            if isinstance(data.get("durationDays"), (int, float))
            else None,
            "prizePool": data.get("prizePool") if isinstance(data.get("prizePool"), (int, float)) else None,
            "revenueTarget": data.get("revenueTarget")
            if isinstance(data.get("revenueTarget"), (int, float))
            else None,
            "closedSalesTarget": data.get("closedSalesTarget")
            if isinstance(data.get("closedSalesTarget"), (int, float))
            else None,
            "closedVolumeTarget": data.get("closedVolumeTarget")
            if isinstance(data.get("closedVolumeTarget"), (int, float))
            else None,
            # Display-only in Phase 1 (see model.py's docstring on the
            # Step Engine) -- a named timeline shown on the challenge
            # page; does not itself gate step unlocking yet.
            "phases": [
                {
                    "name": _clean_text(p.get("name"), field="phase.name", max_length=200, required=True),
                    "startDay": p.get("startDay") if isinstance(p.get("startDay"), (int, float)) else None,
                    "endDay": p.get("endDay") if isinstance(p.get("endDay"), (int, float)) else None,
                    "description": _clean_text(p.get("description"), field="phase.description", max_length=400)
                    or "",
                }
                for p in (data.get("phases") or [])
                if isinstance(p, dict)
            ][:20],
        }

    # ---- participation: join + step progression ------------------------

    async def join_challenge(self, *, challenge_id: str, uid: str) -> dict:
        challenge_ref = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id)
        submission_ref = self._db.collection(model.ARENA_SUBMISSIONS).document(f"{challenge_id}__{uid}")
        state_ref = (
            self._db.collection("users").document(uid).collection("private").document(model.USER_ARENA_STATE)
        )
        user_ref = self._db.collection("users").document(uid)

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                challenge_snap = challenge_ref.get(transaction=txn)
                if not challenge_snap.exists:
                    raise NotFoundError(f"challenge '{challenge_id}' does not exist")
                challenge = challenge_snap.to_dict() or {}
                now_ms = int(self._clock().timestamp() * 1000)
                effective = model.effective_challenge_state(challenge, now_ms=now_ms)
                if effective not in ("live", "ending_soon"):
                    raise ConflictError(f"this challenge is not currently joinable (status: {effective})")

                if submission_ref.get(transaction=txn).exists:
                    raise ConflictError("you have already joined this challenge")

                max_participants = challenge.get("maxParticipants")
                if (
                    isinstance(max_participants, (int, float))
                    and int(challenge.get("participantCount") or 0) >= max_participants
                ):
                    raise ConflictError("this challenge has reached its participant limit")

                state_snap = state_ref.get(transaction=txn)
                arena_state = state_snap.to_dict() if state_snap.exists else {}
                user_snap = user_ref.get(transaction=txn)
                user_data = user_snap.to_dict() if user_snap.exists else {}
                facts = {
                    "currentRankOrder": arena_state.get("currentRankOrder"),
                    "completedChallengeIds": arena_state.get("completedChallengeIds") or [],
                    "isVerifiedAccount": bool(user_data.get("verified")) or bool(user_data.get("emailVerified")),
                    "city": user_data.get("city"),
                    "accountType": user_data.get("accountType"),
                    "soldPropertiesCount": arena_state.get("soldPropertiesCount") or 0,
                }
                check = model.evaluate_unlock_requirements(
                    challenge.get("unlockRequirements"), user_arena_state=arena_state, user_facts=facts
                )
                if check.locked:
                    raise ForbiddenError(f"challenge requirements not met: {check.reason}")

                steps = challenge.get("steps") or []
                txn.set(
                    submission_ref,
                    {
                        "challengeId": challenge_id,
                        "participantUid": uid,
                        "listingRef": None,
                        "propertyType": None,
                        "city": None,
                        "district": None,
                        "mapLocation": None,
                        "priceDisplay": None,
                        "areaSqm": None,
                        "coverImageUrl": None,
                        "stepProgress": model.initial_step_progress(steps),
                        "currentStepKey": next((s["key"] for s in steps if not s.get("unlockAfterStepKey")), None),
                        "propertySource": None,
                        "buyerInfo": {"status": "searching", "buyerSource": None, "dealRef": None},
                        "overallStatus": "joined",
                        "fraudFlags": [],
                        "rejectionReason": None,
                        "adminNote": None,
                        "createdAt": fb_firestore.SERVER_TIMESTAMP,
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    },
                )
                txn.update(challenge_ref, {"participantCount": fb_firestore.Increment(1)})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=uid,
                        actor_role="user",
                        action="arena_challenge_joined",
                        target_type="arenaSubmission",
                        target_id=submission_ref.id,
                        new_value=challenge_id,
                    ),
                )
                return {"submissionId": submission_ref.id}

            return _txn(transaction)

        result = await asyncio.to_thread(_op)
        await self.recompute_state(uid)
        return result

    async def attach_property(
        self,
        *,
        submission_id: str,
        step_key: str,
        listing_ref: dict,
        display_fields: dict,
        property_source: str,
        owner_info: dict | None,
        actor_uid: str,
    ) -> dict:
        """The Property Submission step's action: attaches a REAL
        listing/submission by reference (never duplicates it), records
        who may act on the owner's behalf, and files private owner info
        in the reviewer-only subcollection. Hard-rejects a `listingRef`
        that is already attached to any OTHER arenaSubmission -- the one
        non-negotiable fraud check (brief: "never duplicate them")."""
        if (
            not isinstance(listing_ref, dict)
            or not isinstance(listing_ref.get("id"), str)
            or not listing_ref.get("id")
        ):
            raise ValidationError("'listingRef' must include a real 'id'")
        if listing_ref.get("collection") not in ("listings", "submissions"):
            raise ValidationError("'listingRef.collection' must be 'listings' or 'submissions'")
        if property_source not in model.PROPERTY_SOURCES:
            raise ValidationError(f"'{property_source}' is not a valid property source")

        submission_ref = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id)
        real_property_ref = self._db.collection(listing_ref["collection"]).document(listing_ref["id"])

        dup_query = (
            self._db.collection(model.ARENA_SUBMISSIONS)
            .where("listingRef.collection", "==", listing_ref["collection"])
            .where("listingRef.id", "==", listing_ref["id"])
            .limit(2)
        )

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                sub_snap = submission_ref.get(transaction=txn)
                if not sub_snap.exists:
                    raise NotFoundError("submission not found")
                submission = sub_snap.to_dict() or {}
                if submission.get("participantUid") != actor_uid:
                    raise ForbiddenError("this is not your submission")
                if submission.get("listingRef"):
                    raise ConflictError("a property is already attached to this submission")
                if not real_property_ref.get(transaction=txn).exists:
                    raise NotFoundError("the referenced property does not exist")

                for dup in dup_query.get(transaction=txn):
                    if dup.id != submission_id:
                        raise ConflictError(
                            "this property has already been submitted to a challenge -- properties cannot be "
                            "submitted more than once"
                        )

                clean_display = {
                    "propertyType": _clean_text(
                        display_fields.get("propertyType"), field="propertyType", max_length=60
                    ),
                    "city": _clean_text(display_fields.get("city"), field="city", max_length=200),
                    "district": _clean_text(display_fields.get("district"), field="district", max_length=200),
                    "mapLocation": display_fields.get("mapLocation")
                    if isinstance(display_fields.get("mapLocation"), dict)
                    else None,
                    "priceDisplay": _clean_text(
                        str(display_fields.get("priceDisplay", "")), field="priceDisplay", max_length=60
                    ),
                    "areaSqm": display_fields.get("areaSqm")
                    if isinstance(display_fields.get("areaSqm"), (int, float))
                    else None,
                    "coverImageUrl": _clean_text(
                        display_fields.get("coverImageUrl"), field="coverImageUrl", max_length=1000
                    ),
                }
                patch = {
                    "listingRef": listing_ref,
                    "propertySource": property_source,
                    **clean_display,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                }
                if owner_info:
                    phone_hash = _hash(_normalize_phone(owner_info.get("ownerPhone")) or "")
                    lat = _round_coord((clean_display.get("mapLocation") or {}).get("lat"))
                    lng = _round_coord((clean_display.get("mapLocation") or {}).get("lng"))
                    location_hash = _hash(
                        f"{clean_display.get('city')}|{clean_display.get('district')}|{lat}|{lng}"
                    )
                    patch["ownerPhoneHash"] = (
                        phone_hash if _normalize_phone(owner_info.get("ownerPhone")) else None
                    )
                    patch["locationHash"] = location_hash
                txn.update(submission_ref, patch)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="user",
                        action="arena_property_attached",
                        target_type="arenaSubmission",
                        target_id=submission_id,
                        new_value=listing_ref,
                    ),
                )
                return {"submissionId": submission_id}

            return _txn(transaction)

        result = await asyncio.to_thread(_op)

        if owner_info:
            await asyncio.to_thread(self._write_owner_info, submission_id, owner_info, actor_uid)
            await asyncio.to_thread(self._run_fraud_heuristics, submission_id, actor_uid)

        await self.advance_step(
            submission_id=submission_id,
            step_key=step_key,
            target_status="verification_pending",
            actor_uid=actor_uid,
            actor_is_admin=False,
            note=None,
        )
        return result

    def _write_owner_info(self, submission_id: str, owner_info: dict, actor_uid: str) -> None:
        ref = (
            self._db.collection(model.ARENA_SUBMISSIONS)
            .document(submission_id)
            .collection(model.ARENA_SUBMISSION_PRIVATE)
            .document("ownerInfo")
        )
        ref.set(
            {
                "ownerFullName": _clean_text(
                    owner_info.get("ownerFullName"), field="ownerFullName", max_length=_MAX_NAME_LENGTH
                )
                or "",
                "ownerPhone": _clean_text(owner_info.get("ownerPhone"), field="ownerPhone", max_length=40) or "",
                "ownershipDocUrls": [u for u in (owner_info.get("ownershipDocUrls") or []) if isinstance(u, str)][
                    :20
                ],
                "submittedBy": actor_uid,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    def _run_fraud_heuristics(self, submission_id: str, actor_uid: str) -> None:
        """Non-blocking. Duplicate phone / duplicate location(+owner) /
        submission burst -- flags for admin review, never rejects (the
        one blocking check, duplicate listingRef, already happened in
        attach_property's transaction)."""
        try:
            snap = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id).get()
            if not snap.exists:
                return
            data = snap.to_dict() or {}
            flags: list[str] = []

            phone_hash = data.get("ownerPhoneHash")
            if phone_hash:
                q = self._db.collection(model.ARENA_SUBMISSIONS).where("ownerPhoneHash", "==", phone_hash).limit(3)
                if sum(1 for d in q.stream() if d.id != submission_id) > 0:
                    flags.append("duplicate_phone")

            location_hash = data.get("locationHash")
            if location_hash:
                q = (
                    self._db.collection(model.ARENA_SUBMISSIONS)
                    .where("locationHash", "==", location_hash)
                    .limit(3)
                )
                if sum(1 for d in q.stream() if d.id != submission_id) > 0:
                    flags.append("duplicate_location")

            since = self._clock() - _BURST_WINDOW
            burst_q = (
                self._db.collection(model.ARENA_SUBMISSIONS)
                .where("participantUid", "==", actor_uid)
                .where("createdAt", ">=", since)
                .limit(_BURST_THRESHOLD + 1)
            )
            if sum(1 for _ in burst_q.stream()) >= _BURST_THRESHOLD:
                flags.append("submission_burst")

            if flags:
                # SERVER_TIMESTAMP is rejected inside an array element --
                # use the ops instance's own clock (see the same fix in
                # _apply_completion_bonus).
                now = self._clock()
                self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id).update(
                    {"fraudFlags": fb_firestore.ArrayUnion([{"type": f, "flaggedAt": now} for f in flags])}
                )
        except Exception:  # noqa: BLE001 -- best-effort, must never block the real request
            self._logger.warning("arena fraud heuristics failed for %s", submission_id, exc_info=False)

    async def advance_step(
        self,
        *,
        submission_id: str,
        step_key: str,
        target_status: str,
        actor_uid: str,
        actor_is_admin: bool,
        note: str | None = None,
    ) -> dict:
        """The Step Engine's core transition. A step whose
        `requiredVerificationBy=='admin'` may only be moved to 'completed'
        by an admin; a non-admin caller may move it only as far as
        'verification_pending'. A step whose `requiredVerificationBy=='none'`
        may be moved straight to 'completed' by its own participant."""
        if target_status not in model.STEP_STATUSES:
            raise ValidationError(f"'{target_status}' is not a valid step status")
        clean_note = _clean_text(note, field="note", max_length=_MAX_TEXT_FIELD_LENGTH)

        submission_ref = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id)
        challenge_id_holder: dict = {}

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                sub_snap = submission_ref.get(transaction=txn)
                if not sub_snap.exists:
                    raise NotFoundError("submission not found")
                submission = sub_snap.to_dict() or {}
                participant_uid = submission.get("participantUid")
                if not actor_is_admin and participant_uid != actor_uid:
                    raise ForbiddenError("this is not your submission")

                challenge_ref = self._db.collection(model.ARENA_CHALLENGES).document(submission["challengeId"])
                challenge_snap = challenge_ref.get(transaction=txn)
                if not challenge_snap.exists:
                    raise NotFoundError("challenge not found")
                challenge = challenge_snap.to_dict() or {}
                challenge_id_holder["id"] = submission["challengeId"]

                steps = challenge.get("steps") or []
                step = model.find_step(steps, step_key)
                if step is None:
                    raise ValidationError(f"'{step_key}' is not a step of this challenge")

                step_progress = submission.get("stepProgress") or {}
                current = (step_progress.get(step_key) or {}).get("status", "locked")

                if current == "locked" and not model.can_unlock_step(step, step_progress):
                    raise ConflictError("this step is not yet unlocked")

                if not model.is_valid_step_transition(
                    "available" if current == "locked" else current, target_status
                ):
                    raise ConflictError(f"cannot move step '{step_key}' from '{current}' to '{target_status}'")

                if (
                    target_status == "completed"
                    and step.get("requiredVerificationBy") == "admin"
                    and not actor_is_admin
                ):
                    raise ForbiddenError("this step requires admin verification")

                already_awarded = (step_progress.get(step_key) or {}).get("pointsAwarded", False)
                patch_progress = dict(step_progress)
                patch_progress[step_key] = {
                    "status": target_status,
                    "completedAt": fb_firestore.SERVER_TIMESTAMP if target_status == "completed" else None,
                    "pointsAwarded": already_awarded,
                    "ledgerEntryId": (step_progress.get(step_key) or {}).get("ledgerEntryId"),
                }

                award_points = 0
                ledger_entry_id = None
                if target_status == "completed" and not already_awarded and step.get("points"):
                    award_points = int(step["points"])
                    ledger_ref = self._db.collection(model.ARENA_LEDGER).document()
                    ledger_entry_id = ledger_ref.id
                    patch_progress[step_key]["pointsAwarded"] = True
                    patch_progress[step_key]["ledgerEntryId"] = ledger_entry_id
                    txn.set(
                        ledger_ref,
                        {
                            "uid": participant_uid,
                            "challengeId": submission["challengeId"],
                            "submissionId": submission_id,
                            "stepKey": step_key,
                            "pointsDelta": award_points,
                            "pointType": "lifetimeXp",
                            "reason": "step_completed",
                            "source": "admin_review" if actor_is_admin else "system",
                            "adminResponsibleUid": actor_uid if actor_is_admin else None,
                            "note": clean_note,
                            "verificationStatus": target_status,
                            "createdAt": fb_firestore.SERVER_TIMESTAMP,
                        },
                    )

                if target_status == "completed":
                    successor = model.next_step_after(steps, step_key)
                    if successor is not None:
                        prev = patch_progress.get(
                            successor["key"],
                            {
                                "status": "locked",
                                "completedAt": None,
                                "pointsAwarded": False,
                                "ledgerEntryId": None,
                            },
                        )
                        if prev.get("status") == "locked":
                            patch_progress[successor["key"]] = {**prev, "status": "available"}

                overall = submission.get("overallStatus", "joined")
                if target_status == "verification_pending":
                    overall = "verification_pending"
                elif target_status in ("in_progress", "completed") and overall in (
                    "joined",
                    "verification_pending",
                ):
                    overall = "in_progress"

                update_patch: dict = {
                    "stepProgress": patch_progress,
                    "currentStepKey": step_key
                    if target_status != "completed"
                    else (model.next_step_after(steps, step_key) or {}).get("key", step_key),
                    "overallStatus": overall,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                }
                if clean_note:
                    update_patch["adminNote"] = clean_note
                txn.update(submission_ref, update_patch)

                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin" if actor_is_admin else "user",
                        action="arena_step_advanced",
                        target_type="arenaSubmission",
                        target_id=submission_id,
                        previous_value=current,
                        new_value=target_status,
                        changed_fields=[step_key],
                    ),
                )

                if ledger_entry_id:
                    self._write_activity(
                        txn,
                        uid=participant_uid,
                        challenge_id=submission["challengeId"],
                        submission_id=submission_id,
                        activity_type="property_verified"
                        if step_key not in ("sale", "buyer")
                        else "deal_completed",
                        points_delta=award_points,
                    )

                completion_bonus = None
                if (
                    model.all_required_steps_complete(steps, patch_progress)
                    and submission.get("overallStatus") != "completed"
                ):
                    completion_bonus = self._apply_completion_bonus(
                        txn,
                        submission_ref=submission_ref,
                        challenge_ref=challenge_ref,
                        challenge=challenge,
                        participant_uid=participant_uid,
                        submission_id=submission_id,
                        actor_uid=actor_uid,
                        actor_is_admin=actor_is_admin,
                    )

                return {
                    "submissionId": submission_id,
                    "stepKey": step_key,
                    "status": target_status,
                    "pointsAwarded": award_points,
                    "completionBonus": completion_bonus,
                }

            return _txn(transaction)

        result = await asyncio.to_thread(_op)
        participant_uid = None
        try:
            sub = await asyncio.to_thread(lambda: submission_ref.get())
            participant_uid = (sub.to_dict() or {}).get("participantUid")
        except Exception:  # noqa: BLE001
            pass
        if participant_uid:
            await self.recompute_state(participant_uid)
        return result

    def _apply_completion_bonus(
        self,
        txn,
        *,
        submission_ref,
        challenge_ref,
        challenge,
        participant_uid,
        submission_id,
        actor_uid,
        actor_is_admin,
    ) -> dict:
        """Called from inside advance_step's own transaction, once every
        required step is complete. Awards the challenge's
        `completionReward`, tags the badge, and marks the submission
        'completed' -- a challenge cannot complete itself twice, guarded
        by the caller checking `overallStatus != 'completed'` first."""
        reward = challenge.get("completionReward") or {}
        bonus_points = int(reward.get("points") or 0)
        if bonus_points:
            ledger_ref = self._db.collection(model.ARENA_LEDGER).document()
            txn.set(
                ledger_ref,
                {
                    "uid": participant_uid,
                    "challengeId": challenge_ref.id,
                    "submissionId": submission_id,
                    "stepKey": None,
                    "pointsDelta": bonus_points,
                    "pointType": "lifetimeXp",
                    "reason": "challenge_completion_bonus",
                    "source": "admin_review" if actor_is_admin else "system",
                    "adminResponsibleUid": actor_uid if actor_is_admin else None,
                    "note": None,
                    "verificationStatus": "completed",
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
        badge = reward.get("badge")
        if isinstance(badge, dict) and badge.get("id"):
            # Firestore rejects SERVER_TIMESTAMP inside an array element
            # (ArrayUnion entries must be concrete values) -- use the ops
            # instance's own clock instead, same as everywhere else a
            # wall-clock "now" is needed outside a plain document field.
            txn.update(
                self._db.collection("users")
                .document(participant_uid)
                .collection("private")
                .document(model.USER_ARENA_STATE),
                {
                    "badgesEarned": fb_firestore.ArrayUnion(
                        [{**badge, "earnedAt": self._clock(), "challengeId": challenge_ref.id}]
                    )
                },
            )
        txn.update(submission_ref, {"overallStatus": "completed", "updatedAt": fb_firestore.SERVER_TIMESTAMP})
        txn.update(challenge_ref, {"completedCount": fb_firestore.Increment(1)})
        self._write_activity(
            txn,
            uid=participant_uid,
            challenge_id=challenge_ref.id,
            submission_id=submission_id,
            activity_type="challenge_completed",
            points_delta=bonus_points,
        )
        if isinstance(badge, dict) and badge.get("id"):
            self._write_activity(
                txn,
                uid=participant_uid,
                challenge_id=challenge_ref.id,
                submission_id=submission_id,
                activity_type="badge_unlocked",
                points_delta=None,
            )
        return {"points": bonus_points, "badge": badge}

    def _write_activity(self, txn, *, uid, challenge_id, submission_id, activity_type, points_delta) -> None:
        if activity_type not in model.ACTIVITY_TYPES:
            return
        ref = self._db.collection(model.ARENA_ACTIVITY_FEED).document()
        txn.set(
            ref,
            {
                "uid": uid,
                "challengeId": challenge_id,
                "submissionId": submission_id,
                "type": activity_type,
                "pointsDelta": points_delta,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            },
        )

    # ---- points: recompute + manual adjustment -------------------------

    async def recompute_state(self, uid: str) -> dict:
        """The ONLY writer of users/{uid}/private/arenaState and
        arenaLeaderboardEntries/{uid}. Recomputes from arenaLedger facts
        on every call -- never increments -- so a later
        manual_point_adjustment reversal always lands on the correct
        total (mirrors ReferralOps.recompute_reward exactly)."""

        def _read_and_write() -> dict:
            lifetime_xp = 0
            for entry in self._db.collection(model.ARENA_LEDGER).where("uid", "==", uid).stream():
                data = entry.to_dict() or {}
                if data.get("pointType") == "lifetimeXp":
                    lifetime_xp += int(data.get("pointsDelta") or 0)
            lifetime_xp = max(0, lifetime_xp)

            ranks = [{**(r.to_dict() or {}), "id": r.id} for r in self._db.collection(model.ARENA_RANKS).stream()]
            rank_progress = model.compute_rank(lifetime_xp, ranks)
            current_rank_order = None
            for r in ranks:
                if r.get("id") == rank_progress.current_rank_id:
                    current_rank_order = r.get("order")
                    break

            verified_count = 0
            sold_count = 0
            joined_count = 0
            completed_count = 0
            for sub in self._db.collection(model.ARENA_SUBMISSIONS).where("participantUid", "==", uid).stream():
                data = sub.to_dict() or {}
                joined_count += 1
                if data.get("overallStatus") == "completed":
                    completed_count += 1
                step_progress = data.get("stepProgress") or {}
                for key, prog in step_progress.items():
                    if not isinstance(prog, dict):
                        continue
                    if prog.get("status") == "completed" and "verif" in key.lower():
                        verified_count += 1
                    if prog.get("status") == "completed" and "sale" in key.lower():
                        sold_count += 1

            existing_state_ref = (
                self._db.collection("users").document(uid).collection("private").document(model.USER_ARENA_STATE)
            )
            existing_snap = existing_state_ref.get()
            existing = existing_snap.to_dict() if existing_snap.exists else {}

            payload = {
                "lifetimeXp": lifetime_xp,
                "seasonPoints": 0,
                **rank_progress.to_dict(),
                "currentRankOrder": current_rank_order,
                "verifiedPropertiesCount": verified_count,
                "soldPropertiesCount": sold_count,
                "challengesJoined": joined_count,
                "challengesCompleted": completed_count,
                "badgesEarned": existing.get("badgesEarned") or [],
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }
            existing_state_ref.set(payload, merge=True)

            user_snap = self._db.collection("users").document(uid).get()
            user_data = user_snap.to_dict() if user_snap.exists else {}
            badges_earned = existing.get("badgesEarned") or []
            # Public-safe projection: id + name only. badgesEarned itself
            # (in the PRIVATE arenaState doc above) also carries earnedAt/
            # challengeId -- neither is sensitive, but this mirror only
            # ever needs to answer "which badges", so that's all it copies.
            public_badges = [
                {"id": b.get("id"), "name": b.get("name")}
                for b in badges_earned
                if isinstance(b, dict) and b.get("id")
            ]
            leaderboard_payload = {
                "uid": uid,
                "displayName": user_data.get("displayName") or "",
                "avatarUrl": user_data.get("photoURL") or "",
                "city": user_data.get("city") or "",
                "lifetimeXp": lifetime_xp,
                "seasonPoints": 0,
                "rankId": rank_progress.current_rank_id,
                "rankName": rank_progress.current_rank_name,
                "verifiedPropertiesCount": verified_count,
                "soldPropertiesCount": sold_count,
                "badgeCount": len(badges_earned),
                "badges": public_badges,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }
            self._db.collection(model.ARENA_LEADERBOARD_ENTRIES).document(uid).set(leaderboard_payload, merge=True)
            return payload

        return await asyncio.to_thread(_read_and_write)

    async def manual_point_adjustment(
        self,
        *,
        uid: str,
        points_delta: int,
        note: str,
        actor_uid: str,
        actor_is_admin: bool,
        is_reversal: bool = False,
    ) -> dict:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may adjust points manually")
        clean_note = _clean_text(note, field="note", max_length=_MAX_TEXT_FIELD_LENGTH, required=True)
        delta = _clean_points(points_delta, field="pointsDelta")
        if delta == 0:
            raise ValidationError("'pointsDelta' must not be zero")

        def _write() -> None:
            ref = self._db.collection(model.ARENA_LEDGER).document()
            batch = self._db.batch()
            batch.set(
                ref,
                {
                    "uid": uid,
                    "challengeId": None,
                    "submissionId": None,
                    "stepKey": None,
                    "pointsDelta": delta,
                    "pointType": "lifetimeXp",
                    "reason": "fraud_reversal" if is_reversal else "manual_adjustment",
                    "source": "admin_manual",
                    "adminResponsibleUid": actor_uid,
                    "note": clean_note,
                    "verificationStatus": None,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action="arena_points_adjusted",
                    target_type="user",
                    target_id=uid,
                    new_value=delta,
                    reason_code="fraud_reversal" if is_reversal else "admin_manual_adjustment",
                ),
            )
            batch.commit()

        await asyncio.to_thread(_write)
        return await self.recompute_state(uid)

    async def flag_submission(
        self, *, submission_id: str, flag_type: str, detail: str | None, actor_uid: str
    ) -> None:
        """Best-effort. Never raises -- a failure to record a flag must
        never block the caller's real, already-correct action."""

        def _write() -> None:
            try:
                # SERVER_TIMESTAMP is rejected inside an array element --
                # use the ops instance's own clock (see the same fix in
                # _apply_completion_bonus / _run_fraud_heuristics).
                self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id).update(
                    {
                        "fraudFlags": fb_firestore.ArrayUnion(
                            [
                                {
                                    "type": flag_type[:60],
                                    "detail": (detail or "")[:500],
                                    "flaggedAt": self._clock(),
                                    "flaggedBy": actor_uid,
                                }
                            ]
                        )
                    }
                )
            except Exception:  # noqa: BLE001
                self._logger.warning("failed to flag arena submission %s", submission_id, exc_info=False)

        await asyncio.to_thread(_write)

    async def disqualify_participant(
        self, *, submission_id: str, reason: str, actor_uid: str, actor_is_admin: bool
    ) -> dict:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may disqualify a participant")
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_TEXT_FIELD_LENGTH, required=True)
        ref = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id)

        def _op() -> str:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> str:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError("submission not found")
                participant_uid = snap.get("participantUid")
                txn.update(
                    ref,
                    {
                        "overallStatus": "rejected",
                        "rejectionReason": clean_reason,
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_participant_disqualified",
                        target_type="arenaSubmission",
                        target_id=submission_id,
                        reason_code="admin_disqualification",
                    ),
                )
                return participant_uid

            return _txn(transaction)

        participant_uid = await asyncio.to_thread(_op)
        return await self.recompute_state(participant_uid)

    # ---- ranks (admin CRUD) ---------------------------------------------

    async def create_rank(self, *, data: dict, actor_uid: str, actor_is_admin: bool) -> str:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may create a rank")
        payload = self._clean_rank_payload(data)

        def _write() -> str:
            ref = self._db.collection(model.ARENA_RANKS).document()
            batch = self._db.batch()
            batch.set(ref, payload)
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action="arena_rank_created",
                    target_type="arenaRank",
                    target_id=ref.id,
                    new_value=payload.get("name"),
                ),
            )
            batch.commit()
            return ref.id

        return await asyncio.to_thread(_write)

    async def update_rank(self, *, rank_id: str, data: dict, actor_uid: str, actor_is_admin: bool) -> None:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may edit a rank")
        payload = self._clean_rank_payload(data)
        ref = self._db.collection(model.ARENA_RANKS).document(rank_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"rank '{rank_id}' does not exist")
                txn.update(ref, payload)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_rank_updated",
                        target_type="arenaRank",
                        target_id=rank_id,
                        changed_fields=sorted(payload.keys()),
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    def _clean_rank_payload(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise ValidationError("request body must be an object")
        min_xp = data.get("minXp")
        if not isinstance(min_xp, (int, float)):
            raise ValidationError("'minXp' must be a number")
        max_xp = data.get("maxXp")
        if max_xp is not None and not isinstance(max_xp, (int, float)):
            raise ValidationError("'maxXp' must be a number or null")
        order = data.get("order")
        if not isinstance(order, (int, float)):
            raise ValidationError("'order' must be a number")
        return {
            "name": _clean_text(data.get("name"), field="name", max_length=_MAX_NAME_LENGTH, required=True),
            "iconUrl": _clean_text(data.get("iconUrl"), field="iconUrl", max_length=1000) or "",
            "badgeUrl": _clean_text(data.get("badgeUrl"), field="badgeUrl", max_length=1000) or "",
            "minXp": int(min_xp),
            "maxXp": int(max_xp) if max_xp is not None else None,
            "order": int(order),
            "description": _clean_text(
                data.get("description"), field="description", max_length=_MAX_TEXT_FIELD_LENGTH
            )
            or "",
            "privileges": [p for p in (data.get("privileges") or []) if isinstance(p, str)][:20],
            "visualTreatment": data.get("visualTreatment")
            if isinstance(data.get("visualTreatment"), dict)
            else {},
            "enabled": bool(data.get("enabled", True)),
        }

    # ---- buyer / deal CRM (the real business engine) --------------------
    # Kept deliberately separate from the Step Engine's step statuses: a
    # Challenge step like "Find a Buyer" is still config-driven data (see
    # model.py's module docstring), but a deal can outlive any single
    # step transition (a buyer found on day 40 might not close until day
    # 70) and carries its own privacy domain (buyer PII, never the
    # owner's). advance_deal_stage is the ONE function that moves a deal
    # forward; a Challenge's own admin-gated steps (e.g. "Sale
    # Verification") are completed via advance_step/verify_step
    # separately, informed by having reviewed the deal here -- the two
    # are deliberately not the same call, since a deal can be closed
    # without a matching Challenge (Phase 2+ use), and vice versa a
    # step's admin can choose not to award points even on a closed deal
    # if something looks wrong.

    async def create_deal(self, *, submission_id: str, actor_uid: str) -> dict:
        submission_ref = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id)

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                sub_snap = submission_ref.get(transaction=txn)
                if not sub_snap.exists:
                    raise NotFoundError("submission not found")
                submission = sub_snap.to_dict() or {}
                if submission.get("participantUid") != actor_uid:
                    raise ForbiddenError("this is not your submission")
                if not submission.get("listingRef"):
                    raise ConflictError("a property must be attached before a buyer can be sought")

                deal_ref = self._db.collection(model.ARENA_DEALS).document()
                txn.set(
                    deal_ref,
                    {
                        "challengeId": submission["challengeId"],
                        "submissionId": submission_id,
                        "participantUid": actor_uid,
                        "stage": "lead",
                        "buyerSource": None,
                        "viewing": {"scheduledAt": None, "completedAt": None, "notes": None},
                        "saleValue": None,
                        "city": submission.get("city"),
                        "commissionPercent": None,
                        "expectedCommission": None,
                        "actualCommission": None,
                        "paymentState": None,
                        "closeDate": None,
                        "adminVerified": False,
                        "createdAt": fb_firestore.SERVER_TIMESTAMP,
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="user",
                        action="arena_deal_created",
                        target_type="arenaDeal",
                        target_id=deal_ref.id,
                        new_value=submission_id,
                    ),
                )
                return {"dealId": deal_ref.id}

            return _txn(transaction)

        return await asyncio.to_thread(_op)

    async def advance_deal_stage(
        self,
        *,
        deal_id: str,
        target_stage: str,
        actor_uid: str,
        actor_is_admin: bool,
        note: str | None = None,
        buyer_info: dict | None = None,
        sale_value: float | None = None,
        city: str | None = None,
    ) -> dict:
        """Self-reportable stages ('lead'/'contacted') may be advanced by
        the deal's own participant. Every stage from 'qualified' onward
        -- including the money-adjacent 'closed' -- requires
        `actor_is_admin` (real admin role or a caller holding
        `arena.review`, decided by the handler exactly like advance_step).
        This is the server-side half of "buyer qualification must be
        server/admin controlled" and "closed-sale achievements must
        carry substantially more value than upload farming"."""
        if target_stage not in model.DEAL_STAGES:
            raise ValidationError(f"'{target_stage}' is not a valid deal stage")
        clean_note = _clean_text(note, field="note", max_length=_MAX_TEXT_FIELD_LENGTH)
        if target_stage not in model.SELF_REPORTABLE_DEAL_STAGES and not actor_is_admin:
            raise ForbiddenError(f"moving a deal to '{target_stage}' requires admin review")

        deal_ref = self._db.collection(model.ARENA_DEALS).document(deal_id)
        commission_rule_snap = None
        if target_stage == "closed":
            if not isinstance(sale_value, (int, float)) or sale_value <= 0:
                raise ValidationError("'saleValue' is required to close a deal")
            clean_city = _clean_text(city, field="city", max_length=200, required=True)
            commission_rule_snap = self._db.collection(model.ARENA_COMMISSION_RULES).document(clean_city).get()

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                snap = deal_ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError("deal not found")
                deal = snap.to_dict() or {}
                if not actor_is_admin and deal.get("participantUid") != actor_uid:
                    raise ForbiddenError("this is not your deal")
                current = deal.get("stage", "lead")
                if not model.is_valid_deal_transition(current, target_stage):
                    raise ConflictError(f"cannot move a deal from '{current}' to '{target_stage}'")

                patch: dict = {"stage": target_stage, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
                if clean_note:
                    patch["adminNote"] = clean_note
                if target_stage == "viewing_scheduled":
                    patch["viewing.scheduledAt"] = fb_firestore.SERVER_TIMESTAMP
                if target_stage == "viewing_completed":
                    patch["viewing.completedAt"] = fb_firestore.SERVER_TIMESTAMP
                if target_stage == "closed":
                    rule = (
                        commission_rule_snap.to_dict()
                        if commission_rule_snap and commission_rule_snap.exists
                        else {}
                    )
                    commission_percent = (
                        rule.get("defaultPercent") if isinstance(rule.get("defaultPercent"), (int, float)) else 0
                    )
                    expected = model.compute_expected_commission(sale_value, commission_percent)
                    patch.update(
                        {
                            "saleValue": float(sale_value),
                            "city": city,
                            "commissionPercent": commission_percent,
                            "expectedCommission": expected,
                            "paymentState": "pending",
                            "closeDate": fb_firestore.SERVER_TIMESTAMP,
                            "adminVerified": bool(actor_is_admin),
                        }
                    )
                txn.update(deal_ref, patch)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin" if actor_is_admin else "user",
                        action="arena_deal_stage_advanced",
                        target_type="arenaDeal",
                        target_id=deal_id,
                        previous_value=current,
                        new_value=target_stage,
                    ),
                )
                return {"dealId": deal_id, "stage": target_stage, "participantUid": deal.get("participantUid")}

            return _txn(transaction)

        result = await asyncio.to_thread(_op)
        if buyer_info:
            await asyncio.to_thread(self._write_buyer_info, deal_id, buyer_info, actor_uid)
        return result

    def _write_buyer_info(self, deal_id: str, buyer_info: dict, actor_uid: str) -> None:
        ref = (
            self._db.collection(model.ARENA_DEALS)
            .document(deal_id)
            .collection(model.ARENA_DEAL_PRIVATE)
            .document("buyerInfo")
        )
        ref.set(
            {
                "buyerName": _clean_text(
                    buyer_info.get("buyerName"), field="buyerName", max_length=_MAX_NAME_LENGTH
                )
                or "",
                "buyerPhone": _clean_text(buyer_info.get("buyerPhone"), field="buyerPhone", max_length=40) or "",
                "buyerSource": buyer_info.get("buyerSource")
                if buyer_info.get("buyerSource") in model.BUYER_SOURCES
                else None,
                "submittedBy": actor_uid,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    async def set_payment_state(
        self,
        *,
        deal_id: str,
        payment_state: str,
        actual_commission: float | None,
        actor_uid: str,
        actor_is_admin: bool,
    ) -> dict:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may record payment state")
        if payment_state not in model.PAYMENT_STATES:
            raise ValidationError(f"'{payment_state}' is not a valid payment state")
        ref = self._db.collection(model.ARENA_DEALS).document(deal_id)

        def _op() -> dict:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> dict:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError("deal not found")
                if snap.get("stage") != "closed":
                    raise ConflictError("payment state can only be recorded on a closed deal")
                patch: dict = {"paymentState": payment_state, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
                if (
                    payment_state == "received"
                    and isinstance(actual_commission, (int, float))
                    and actual_commission >= 0
                ):
                    patch["actualCommission"] = float(actual_commission)
                txn.update(ref, patch)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=actor_uid,
                        actor_role="admin",
                        action="arena_deal_payment_recorded",
                        target_type="arenaDeal",
                        target_id=deal_id,
                        new_value=payment_state,
                    ),
                )
                return {"dealId": deal_id, "paymentState": payment_state}

            return _txn(transaction)

        return await asyncio.to_thread(_op)

    async def list_deals(
        self, *, challenge_id: str | None, stage_filter: str | None, uid: str | None, limit: int = 100
    ) -> list[dict]:
        def _read() -> list[dict]:
            q = self._db.collection(model.ARENA_DEALS)
            if challenge_id:
                q = q.where("challengeId", "==", challenge_id)
            if stage_filter:
                q = q.where("stage", "==", stage_filter)
            if uid:
                q = q.where("participantUid", "==", uid)
            return [
                {"id": s.id, **(s.to_dict() or {})} for s in q.limit(max(1, min(int(limit or 100), 300))).stream()
            ]

        return await asyncio.to_thread(_read)

    # ---- commission rules (admin CRUD) -----------------------------------

    async def set_commission_rule(
        self,
        *,
        city: str,
        min_percent: float,
        max_percent: float,
        default_percent: float,
        actor_uid: str,
        actor_is_admin: bool,
    ) -> None:
        if not actor_is_admin:
            raise ForbiddenError("only an admin may configure commission rules")
        clean_city = _clean_text(city, field="city", max_length=200, required=True)
        for label, value in (
            ("minPercent", min_percent),
            ("maxPercent", max_percent),
            ("defaultPercent", default_percent),
        ):
            if not isinstance(value, (int, float)) or value < 0 or value > 100:
                raise ValidationError(f"'{label}' must be a number between 0 and 100")
        if not (min_percent <= default_percent <= max_percent):
            raise ValidationError("'defaultPercent' must be between 'minPercent' and 'maxPercent'")

        def _write() -> None:
            ref = self._db.collection(model.ARENA_COMMISSION_RULES).document(clean_city)
            batch = self._db.batch()
            batch.set(
                ref,
                {
                    "city": clean_city,
                    "minPercent": min_percent,
                    "maxPercent": max_percent,
                    "defaultPercent": default_percent,
                    "updatedBy": actor_uid,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=actor_uid,
                    actor_role="admin",
                    action="arena_commission_rule_set",
                    target_type="arenaCommissionRule",
                    target_id=clean_city,
                    new_value=default_percent,
                ),
            )
            batch.commit()

        await asyncio.to_thread(_write)

    async def list_commission_rules(self) -> list[dict]:
        def _read() -> list[dict]:
            return [
                {"id": s.id, **(s.to_dict() or {})}
                for s in self._db.collection(model.ARENA_COMMISSION_RULES).stream()
            ]

        return await asyncio.to_thread(_read)

    # ---- commercial summary (the admin dashboard's real numbers) --------

    async def challenge_commercial_summary(self, *, challenge_id: str) -> dict:
        """Every number here is computed live from real documents --
        never a cached/estimated figure -- so the dashboard can never
        show a target as "met" before the underlying, admin-verified
        records actually support it."""

        def _read() -> dict:
            challenge_snap = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id).get()
            if not challenge_snap.exists:
                raise NotFoundError(f"challenge '{challenge_id}' does not exist")
            challenge = challenge_snap.to_dict() or {}

            submissions = [
                s.to_dict() or {}
                for s in self._db.collection(model.ARENA_SUBMISSIONS)
                .where("challengeId", "==", challenge_id)
                .stream()
            ]
            total_submissions = len(submissions)
            verified = sum(
                1
                for s in submissions
                if s.get("overallStatus") in ("in_progress", "verification_pending", "completed")
                and s.get("listingRef")
            )
            rejected = sum(1 for s in submissions if s.get("overallStatus") == "rejected")
            fraud_flagged = sum(1 for s in submissions if s.get("fraudFlags"))

            deals = [
                d.to_dict() or {}
                for d in self._db.collection(model.ARENA_DEALS).where("challengeId", "==", challenge_id).stream()
            ]
            stage_counts: dict[str, int] = {}
            for d in deals:
                stage_counts[d.get("stage", "lead")] = stage_counts.get(d.get("stage", "lead"), 0) + 1
            closed_deals = [d for d in deals if d.get("stage") == "closed"]
            closed_volume = sum(float(d.get("saleValue") or 0) for d in closed_deals)
            expected_commission = sum(float(d.get("expectedCommission") or 0) for d in closed_deals)
            actual_commission = sum(
                float(d.get("actualCommission") or 0) for d in closed_deals if d.get("paymentState") == "received"
            )

            top_participants: dict[str, dict] = {}
            for s in submissions:
                uid = s.get("participantUid")
                if not uid:
                    continue
                top_participants.setdefault(uid, {"uid": uid, "submissions": 0, "closedDeals": 0})
                top_participants[uid]["submissions"] += 1
            for d in closed_deals:
                uid = d.get("participantUid")
                if uid and uid in top_participants:
                    top_participants[uid]["closedDeals"] += 1
            top_participants_list = sorted(
                top_participants.values(), key=lambda r: (r["closedDeals"], r["submissions"]), reverse=True
            )[:20]

            top_cities: dict[str, int] = {}
            for s in submissions:
                city = s.get("city")
                if city:
                    top_cities[city] = top_cities.get(city, 0) + 1

            return {
                "challengeId": challenge_id,
                "participantCount": challenge.get("participantCount") or 0,
                "totalSubmissions": total_submissions,
                "verifiedProperties": verified,
                "rejectedProperties": rejected,
                "fraudFlaggedSubmissions": fraud_flagged,
                "dealStageCounts": stage_counts,
                "closedDeals": len(closed_deals),
                "closedVolume": round(closed_volume, 2),
                "expectedCommission": round(expected_commission, 2),
                "actualCommission": round(actual_commission, 2),
                "prizePool": challenge.get("prizePool"),
                "revenueTarget": challenge.get("revenueTarget"),
                "closedSalesTarget": challenge.get("closedSalesTarget"),
                "closedVolumeTarget": challenge.get("closedVolumeTarget"),
                "durationDays": challenge.get("durationDays"),
                "topParticipants": top_participants_list,
                "topCities": sorted(top_cities.items(), key=lambda kv: kv[1], reverse=True)[:20],
            }

        return await asyncio.to_thread(_read)

    # ---- reads -----------------------------------------------------------

    async def list_challenges_for_viewer(
        self, *, uid: str | None, status_filter: str | None, limit: int = 60
    ) -> list[dict]:
        def _read() -> list[dict]:
            arena_state = {}
            facts: dict = {}
            if uid:
                state_snap = (
                    self._db.collection("users")
                    .document(uid)
                    .collection("private")
                    .document(model.USER_ARENA_STATE)
                    .get()
                )
                arena_state = state_snap.to_dict() if state_snap.exists else {}
                user_snap = self._db.collection("users").document(uid).get()
                user_data = user_snap.to_dict() if user_snap.exists else {}
                completed_ids = [
                    s.get("challengeId")
                    for s in self._db.collection(model.ARENA_SUBMISSIONS)
                    .where("participantUid", "==", uid)
                    .where("overallStatus", "==", "completed")
                    .stream()
                ]
                facts = {
                    "currentRankOrder": arena_state.get("currentRankOrder"),
                    "completedChallengeIds": completed_ids,
                    "isVerifiedAccount": bool(user_data.get("verified")) or bool(user_data.get("emailVerified")),
                    "city": user_data.get("city"),
                    "accountType": user_data.get("accountType"),
                    "soldPropertiesCount": arena_state.get("soldPropertiesCount") or 0,
                }

            now_ms = int(self._clock().timestamp() * 1000)
            results = []
            for snap in (
                self._db.collection(model.ARENA_CHALLENGES).limit(max(1, min(int(limit or 60), 200))).stream()
            ):
                data = snap.to_dict() or {}
                effective = model.effective_challenge_state(data, now_ms=now_ms)
                if status_filter and effective != status_filter:
                    continue
                check = (
                    model.evaluate_unlock_requirements(
                        data.get("unlockRequirements"), user_arena_state=arena_state, user_facts=facts
                    )
                    if uid
                    else model.UnlockCheck(False, None)
                )
                my_submission = None
                if uid:
                    sub_snap = self._db.collection(model.ARENA_SUBMISSIONS).document(f"{snap.id}__{uid}").get()
                    if sub_snap.exists:
                        sub = sub_snap.to_dict() or {}
                        my_submission = {
                            "overallStatus": sub.get("overallStatus"),
                            "currentStepKey": sub.get("currentStepKey"),
                        }
                results.append(
                    {
                        "id": snap.id,
                        **data,
                        "effectiveState": effective,
                        "locked": check.locked,
                        "lockedReason": check.reason,
                        "mySubmission": my_submission,
                    }
                )
            return results

        return await asyncio.to_thread(_read)

    async def get_challenge(self, *, challenge_id: str, uid: str | None) -> dict:
        def _read() -> dict:
            snap = self._db.collection(model.ARENA_CHALLENGES).document(challenge_id).get()
            if not snap.exists:
                raise NotFoundError(f"challenge '{challenge_id}' does not exist")
            data = snap.to_dict() or {}
            now_ms = int(self._clock().timestamp() * 1000)
            my_submission = None
            if uid:
                sub_snap = self._db.collection(model.ARENA_SUBMISSIONS).document(f"{challenge_id}__{uid}").get()
                if sub_snap.exists:
                    my_submission = {**(sub_snap.to_dict() or {}), "id": sub_snap.id}
            return {
                "id": snap.id,
                **data,
                "effectiveState": model.effective_challenge_state(data, now_ms=now_ms),
                "mySubmission": my_submission,
            }

        return await asyncio.to_thread(_read)

    async def list_submissions_for_review(
        self, *, status_filter: str | None, challenge_id: str | None, limit: int = 60
    ) -> list[dict]:
        def _read() -> list[dict]:
            q = self._db.collection(model.ARENA_SUBMISSIONS)
            if challenge_id:
                q = q.where("challengeId", "==", challenge_id)
            if status_filter:
                q = q.where("overallStatus", "==", status_filter)
            rows = []
            for snap in q.limit(max(1, min(int(limit or 60), 200))).stream():
                data = snap.to_dict() or {}
                rows.append({"id": snap.id, **{k: v for k, v in data.items() if k not in ()}})
            return rows

        return await asyncio.to_thread(_read)

    async def get_submission(self, *, submission_id: str, actor_uid: str, actor_permissions: set[str]) -> dict:
        def _read() -> dict:
            snap = self._db.collection(model.ARENA_SUBMISSIONS).document(submission_id).get()
            if not snap.exists:
                raise NotFoundError("submission not found")
            data = snap.to_dict() or {}
            is_owner = data.get("participantUid") == actor_uid
            is_reviewer = "arena.review" in (actor_permissions or set())
            if not is_owner and not is_reviewer:
                raise ForbiddenError("you do not have access to this submission")
            result = {"id": snap.id, **data}
            if is_reviewer:
                priv_snap = snap.reference.collection(model.ARENA_SUBMISSION_PRIVATE).document("ownerInfo").get()
                result["ownerInfo"] = priv_snap.to_dict() if priv_snap.exists else None
            return result

        return await asyncio.to_thread(_read)

    async def list_leaderboard(self, *, limit: int = 50) -> list[dict]:
        def _read() -> list[dict]:
            q = (
                self._db.collection(model.ARENA_LEADERBOARD_ENTRIES)
                .order_by("lifetimeXp", direction=fb_firestore.Query.DESCENDING)
                .limit(max(1, min(int(limit or 50), 200)))
            )
            return [s.to_dict() or {} for s in q.stream()]

        return await asyncio.to_thread(_read)

    async def list_ranks(self) -> list[dict]:
        def _read() -> list[dict]:
            rows = [{**(s.to_dict() or {}), "id": s.id} for s in self._db.collection(model.ARENA_RANKS).stream()]
            rows.sort(key=lambda r: r.get("order") if isinstance(r.get("order"), (int, float)) else 0)
            return rows

        return await asyncio.to_thread(_read)

    async def get_user_arena_state(self, *, uid: str) -> dict:
        def _read() -> dict:
            snap = (
                self._db.collection("users")
                .document(uid)
                .collection("private")
                .document(model.USER_ARENA_STATE)
                .get()
            )
            return (
                snap.to_dict()
                if snap.exists
                else {
                    "lifetimeXp": 0,
                    "seasonPoints": 0,
                    "currentRankId": None,
                    "currentRankName": None,
                    "nextRankId": None,
                    "nextRankName": None,
                    "xpToNextRank": None,
                    "verifiedPropertiesCount": 0,
                    "soldPropertiesCount": 0,
                    "challengesJoined": 0,
                    "challengesCompleted": 0,
                    "badgesEarned": [],
                }
            )

        return await asyncio.to_thread(_read)

    async def list_ledger_for_user(self, *, uid: str, limit: int = 100) -> list[dict]:
        def _read() -> list[dict]:
            q = (
                self._db.collection(model.ARENA_LEDGER)
                .where("uid", "==", uid)
                .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
                .limit(max(1, min(int(limit or 100), 300)))
            )
            return [{**(s.to_dict() or {}), "id": s.id} for s in q.stream()]

        return await asyncio.to_thread(_read)

    async def list_my_submissions(self, *, uid: str, limit: int = 60) -> list[dict]:
        def _read() -> list[dict]:
            q = (
                self._db.collection(model.ARENA_SUBMISSIONS)
                .where("participantUid", "==", uid)
                .limit(max(1, min(int(limit or 60), 200)))
            )
            return [{"id": s.id, **(s.to_dict() or {})} for s in q.stream()]

        return await asyncio.to_thread(_read)

    async def admin_list_ledger(self, *, uid_filter: str | None, limit: int = 100) -> list[dict]:
        def _read() -> list[dict]:
            q = self._db.collection(model.ARENA_LEDGER)
            if uid_filter:
                q = q.where("uid", "==", uid_filter)
            q = q.order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(
                max(1, min(int(limit or 100), 300))
            )
            return [{**(s.to_dict() or {}), "id": s.id} for s in q.stream()]

        return await asyncio.to_thread(_read)

    async def list_activity_feed(
        self, *, uid: str | None, challenge_id: str | None, limit: int = 40
    ) -> list[dict]:
        def _read() -> list[dict]:
            q = self._db.collection(model.ARENA_ACTIVITY_FEED)
            if uid:
                q = q.where("uid", "==", uid)
            elif challenge_id:
                q = q.where("challengeId", "==", challenge_id)
            q = q.order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(
                max(1, min(int(limit or 40), 100))
            )
            return [{**(s.to_dict() or {}), "id": s.id} for s in q.stream()]

        return await asyncio.to_thread(_read)
