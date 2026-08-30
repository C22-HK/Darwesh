# Builds and writes accessAuditLog entries. firestore.rules makes this
# collection `allow write: if false` for every client SDK caller,
# including an authenticated admin session (Phase 1, already published)
# -- this module, called only via the Admin SDK, is the sole path an
# entry can ever be created through. No client can forge one.
#
# ATOMICITY: every call site in organization_ops.py/permission_ops.py
# passes an already-open Firestore transaction (`txn`) and adds this
# entry's write to it via write_audit(), in the SAME transaction as the
# actual mutation -- Firestore transactions are all-or-nothing, so there
# is no path where the mutation commits and the audit write doesn't, or
# vice versa. See each ops module for the transactional wrapper.
from __future__ import annotations

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
    result: str = "success"  # 'success' | 'denied' | 'error' -- see write_audit()'s docstring


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
            "source": "backend:app.access",
            "result": entry.result,
            "timestamp": fb_firestore.SERVER_TIMESTAMP,
        },
    )
