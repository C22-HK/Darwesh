# Builds and writes accessAuditLog entries. firestore.rules makes this
# collection `allow write: if false` for every client SDK caller,
# including an authenticated admin session (Phase 1, already published)
# -- this module, called only via the Admin SDK, is the sole path an
# entry can ever be created through. No client can forge one.
#
# ATOMICITY (successful mutations): every call site in
# organization_ops.py/permission_ops.py passes an already-open Firestore
# transaction (`txn`) and adds this entry's write to it via write_audit(),
# in the SAME transaction as the actual mutation -- Firestore
# transactions are all-or-nothing, so there is no path where the
# mutation commits and the audit write doesn't, or vice versa.
#
# DENIED/FAILED ATTEMPTS (Phase 2.1): write_denied_audit() below is
# deliberately NOT part of any mutation transaction -- by definition, a
# denied attempt means the mutation's own transaction was never entered
# or was aborted before any write, so there is nothing to be atomic
# WITH (no mutation occurred, only the fact that one was attempted and
# refused). This is a separate, best-effort direct write, issued only
# for the specific security-relevant denial categories each ops method
# calls it for (see organization_ops.py/permission_ops.py) -- never for
# routine/expected outcomes (a 401, a NotFoundError, a ConflictError),
# to avoid turning ordinary traffic into audit-log noise or a write-
# amplification vector. It never raises: a failure to log a denial must
# never turn a clean, already-correct 403/400 into a 500.
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from firebase_admin import firestore as fb_firestore

AUDIT_LOG_COLLECTION = "accessAuditLog"


@dataclass(frozen=True)
class AuditEntry:
    """Every field the approved architecture specified, plus `source`
    (which endpoint/action family produced this) and `result` (did the
    mutation actually succeed -- see this module's docstring on why a
    failed/rejected mutation must never produce a fraudulent "success"
    entry). `changed_fields`/`previous_value`/`new_value` are small,
    caller-supplied semantic values (a permission key, a boolean, a uid,
    a role label) -- NEVER a secret, token, OTP, or password. Callers in
    this package only ever pass permission/role/ownership values here by
    construction; nothing in this dataclass accepts or forwards a raw
    request body."""

    actor_uid: str
    actor_role: str
    action: str
    target_type: str  # 'user' | 'organization' | 'role' | 'membership'
    target_id: str
    target_organization_id: str | None = None
    changed_fields: list[str] = field(default_factory=list)
    previous_value: object = None
    new_value: object = None
    correlation_id: str | None = None
    result: str = "success"  # 'success' | 'denied' | 'failed' -- see write_audit()'s docstring
    # Phase 2.1: a short, stable machine-readable code (e.g.
    # 'forbidden_not_owner_or_admin', 'protected_permission_escalation_attempt')
    # for a non-success entry -- NEVER a stack trace or raw exception
    # message. 'failed' (an infra-level error during a mutation attempt,
    # as opposed to a clean authorization 'denied') is a reserved value
    # this phase defines but does not yet produce -- see
    # organization_ops.py/permission_ops.py for exactly which denial
    # categories are logged and why the rest deliberately aren't.
    reason_code: str | None = None


def write_audit(txn, db, entry: AuditEntry) -> None:
    """Adds this entry's write to an already-open transaction OR write
    batch (both expose the same `.set(ref, data)` call this function
    uses, so either works interchangeably -- a plain create-only
    mutation with no read-dependent branch uses a WriteBatch, everything
    else uses a real `@firestore.transactional` transaction; see each
    ops module). Must only
    ever be called for an action that the SAME transaction is also
    performing (or has already performed) the real mutation for -- this
    function does not itself decide whether the action succeeded; the
    caller does, and encodes that in entry.result. A caller must NEVER
    call this with result='success' unless the paired mutation write is
    part of the exact same transaction (so that if the transaction
    aborts, neither the mutation nor this "success" record survives --
    there is no way for a fraudulent success entry to persist while the
    underlying change was rejected)."""
    ref = db.collection(AUDIT_LOG_COLLECTION).document()
    txn.set(
        ref,
        {
            "adminUid": entry.actor_uid,
            "actorRole": entry.actor_role,
            "action": entry.action,
            "targetType": entry.target_type,
            "targetId": entry.target_id,
            "targetOrganizationId": entry.target_organization_id,
            "changedFields": entry.changed_fields,
            "previousValue": entry.previous_value,
            "newValue": entry.new_value,
            "correlationId": entry.correlation_id,
            "reasonCode": entry.reason_code,
            "source": "backend:app.access",
            "result": entry.result,
            "timestamp": fb_firestore.SERVER_TIMESTAMP,
        },
    )


def write_denied_audit(db, entry: AuditEntry, logger: logging.Logger | None = None) -> None:
    """Best-effort, NON-transactional audit write for a denied/failed
    security-sensitive attempt -- see this module's header for why it
    can't be atomic with anything (no mutation occurred). `entry.result`
    should be 'denied' (an authorization/business-rule rejection) or
    'failed' (an infra-level error, reserved/unused this phase -- see
    AuditEntry.result's docstring); never 'success'.

    Call this ONLY for the specific, security-relevant denial categories
    documented at each call site (see organization_ops.py/
    permission_ops.py) -- never for a plain 401, a NotFoundError, or a
    ConflictError, which are routine/expected outcomes, not security
    events. Never raises: a Firestore hiccup while trying to log a
    denial must never turn an already-correct 403/400 into a 500 --
    callers rely on this, so this function swallows and logs its own
    failures instead of propagating them.

    Cost/DoS note: every call site is reached only from an endpoint
    already gated by this backend's existing per-uid rate limiters
    (Stage 5's FirestoreRateLimiter/InMemoryRateLimiter, reused
    unchanged) -- one HTTP call can produce at most one denied-audit
    write, so this adds no new amplification surface beyond what the
    existing rate limits already bound."""
    try:
        ref = db.collection(AUDIT_LOG_COLLECTION).document()
        ref.set(
            {
                "adminUid": entry.actor_uid,
                "actorRole": entry.actor_role,
                "action": entry.action,
                "targetType": entry.target_type,
                "targetId": entry.target_id,
                "targetOrganizationId": entry.target_organization_id,
                "changedFields": entry.changed_fields,
                "previousValue": entry.previous_value,
                "newValue": entry.new_value,
                "correlationId": entry.correlation_id,
                "reasonCode": entry.reason_code,
                "source": "backend:app.access",
                "result": entry.result,
                "timestamp": fb_firestore.SERVER_TIMESTAMP,
            }
        )
    except Exception as exc:  # noqa: BLE001 -- logging a denial must never itself raise
        (logger or logging.getLogger("darwesh.access.audit")).error(
            "failed to write denied-attempt audit entry", extra={"error": str(exc), "action": entry.action}
        )
