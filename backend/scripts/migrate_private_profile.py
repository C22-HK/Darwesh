#!/usr/bin/env python3
"""U1 migration: move each user's private fields off the public users/{uid}
document into users/{uid}/privateProfile/main.

WHY. users/{uid} is world-readable whenever role == 'agent' (public agent
profiles), and a Firestore read is document-level -- so email, phone, the
verification flags and commissionRate on that document were public for every
agent. firestore.rules, the backend signup writer and every frontend
reader/writer now use users/{uid}/privateProfile/main instead; this tool
moves the documents that already exist.

SAFETY. This script REFUSES to run against a real project unless
--allow-production is given together with an explicit --project. Without
that flag it only runs when FIRESTORE_EMULATOR_HOST is set. Every mode is
idempotent and re-runnable; nothing is deleted except the exact private
fields that were copied (apply) or the private document (rollback with
--delete-private).

MODES
  dry-run   (default) reads everything, writes nothing, prints + saves a
            JSON report of what apply WOULD change.
  apply     copies the private fields into privateProfile/main (merge) and
            removes them from the public document, in batches.
  verify    fails (exit 1) if any public users document still carries a
            private field; reports how many private documents exist.
  rollback  copies the fields from privateProfile/main back onto the public
            document (only documents this tool migrated, unless --all);
            add --delete-private to also remove the private documents.
  seed-demo (emulator only) writes a handful of sample users so the whole
            cycle can be exercised end to end -- see
            scripts/verify-private-profile-migration.sh.

EXAMPLES
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 python3 backend/scripts/migrate_private_profile.py --project demo-darwesh --mode dry-run
  # production (deliberate, two flags, after a Firestore export/backup):
  GOOGLE_APPLICATION_CREDENTIALS=... python3 backend/scripts/migrate_private_profile.py --project <real-project-id> --allow-production --mode dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime

PRIVATE_FIELDS = ("email", "phone", "phoneVerified", "phoneVerifiedAt", "emailVerified", "commissionRate")
PRIVATE_COLLECTION = "privateProfile"
PRIVATE_DOC = "main"
MIGRATION_MARKER = "migratedFrom"
MIGRATION_MARKER_VALUE = "users"


def mask_email(email: object) -> str:
    if not isinstance(email, str) or "@" not in email:
        return "-" if not email else "***"
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}"


def build_client(project: str, allow_production: bool):
    emulator = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
    if not emulator and not allow_production:
        print(
            "REFUSING to run: FIRESTORE_EMULATOR_HOST is not set and --allow-production was not given.\n"
            "This tool never touches a real project by accident. For production, take a Firestore export first,\n"
            "then re-run with --allow-production --project <id> --mode dry-run before --mode apply.",
            file=sys.stderr,
        )
        sys.exit(2)
    from google.cloud import firestore  # local import so --help works without the dependency

    if emulator:
        from google.auth.credentials import AnonymousCredentials

        return firestore.Client(project=project, credentials=AnonymousCredentials()), f"emulator {emulator}"
    return firestore.Client(project=project), f"PRODUCTION project {project}"


def iter_users(db, page_size: int):
    """Streams users/{uid} documents in stable __name__ order, page by page."""
    from google.cloud import firestore

    coll = db.collection("users")
    last = None
    while True:
        q = coll.order_by("__name__").limit(page_size)
        if last is not None:
            q = q.start_after(last)
        docs = list(q.stream())
        if not docs:
            return
        yield from docs
        last = docs[-1]
        del firestore  # noqa: F821 -- keep the import local to this function's scope


def private_fields_of(data: dict) -> dict:
    return {k: data[k] for k in PRIVATE_FIELDS if k in data}


def plan(db, page_size: int) -> dict:
    """Read-only pass shared by dry-run and apply: which documents need work."""
    report = {
        "scannedUsers": 0,
        "needingMigration": 0,
        "byRole": {},
        "byField": {k: 0 for k in PRIVATE_FIELDS},
        "privateDocsAlreadyPresent": 0,
        "samples": [],
        "uids": [],
    }
    for snap in iter_users(db, page_size):
        report["scannedUsers"] += 1
        data = snap.to_dict() or {}
        fields = private_fields_of(data)
        if not fields:
            continue
        report["needingMigration"] += 1
        role = data.get("role") or "(none)"
        report["byRole"][role] = report["byRole"].get(role, 0) + 1
        for k in fields:
            report["byField"][k] += 1
        report["uids"].append(snap.id)
        if len(report["samples"]) < 10:
            report["samples"].append(
                {"uid": snap.id, "role": role, "email": mask_email(fields.get("email")), "fields": sorted(fields)}
            )
        if snap.reference.collection(PRIVATE_COLLECTION).document(PRIVATE_DOC).get().exists:
            report["privateDocsAlreadyPresent"] += 1
    return report


def apply(db, page_size: int, batch_size: int) -> dict:
    from google.cloud import firestore

    stats = {"migrated": 0, "skipped": 0, "batches": 0}
    batch = db.batch()
    pending = 0
    for snap in iter_users(db, page_size):
        data = snap.to_dict() or {}
        fields = private_fields_of(data)
        if not fields:
            stats["skipped"] += 1
            continue
        private_ref = snap.reference.collection(PRIVATE_COLLECTION).document(PRIVATE_DOC)
        private_payload = dict(fields)
        private_payload[MIGRATION_MARKER] = MIGRATION_MARKER_VALUE
        private_payload["migratedAt"] = firestore.SERVER_TIMESTAMP
        batch.set(private_ref, private_payload, merge=True)
        batch.update(snap.reference, {k: firestore.DELETE_FIELD for k in fields})
        pending += 2
        stats["migrated"] += 1
        if pending >= batch_size:
            batch.commit()
            stats["batches"] += 1
            batch = db.batch()
            pending = 0
    if pending:
        batch.commit()
        stats["batches"] += 1
    return stats


def verify(db, page_size: int) -> dict:
    result = {"scannedUsers": 0, "publicDocsStillPrivate": [], "privateDocs": 0}
    for snap in iter_users(db, page_size):
        result["scannedUsers"] += 1
        data = snap.to_dict() or {}
        leftover = sorted(private_fields_of(data))
        if leftover:
            result["publicDocsStillPrivate"].append({"uid": snap.id, "fields": leftover})
        if snap.reference.collection(PRIVATE_COLLECTION).document(PRIVATE_DOC).get().exists:
            result["privateDocs"] += 1
    return result


def rollback(db, page_size: int, batch_size: int, delete_private: bool, everything: bool) -> dict:
    stats = {"restored": 0, "skipped": 0, "privateDeleted": 0, "batches": 0}
    batch = db.batch()
    pending = 0
    for snap in iter_users(db, page_size):
        private_ref = snap.reference.collection(PRIVATE_COLLECTION).document(PRIVATE_DOC)
        private_snap = private_ref.get()
        if not private_snap.exists:
            stats["skipped"] += 1
            continue
        pdata = private_snap.to_dict() or {}
        if not everything and pdata.get(MIGRATION_MARKER) != MIGRATION_MARKER_VALUE:
            stats["skipped"] += 1
            continue
        fields = private_fields_of(pdata)
        if fields:
            batch.update(snap.reference, fields)
            pending += 1
            stats["restored"] += 1
        if delete_private:
            batch.delete(private_ref)
            pending += 1
            stats["privateDeleted"] += 1
        if pending >= batch_size:
            batch.commit()
            stats["batches"] += 1
            batch = db.batch()
            pending = 0
    if pending:
        batch.commit()
        stats["batches"] += 1
    return stats


def seed_demo(db) -> None:
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        print("seed-demo is emulator-only", file=sys.stderr)
        sys.exit(2)
    now = time.time()
    demo = {
        "agent-legacy-1": {
            "displayName": "Legacy Agent",
            "role": "agent",
            "companyId": "co-1",
            "email": "agent1@example.com",
            "phone": "+9647500000001",
            "phoneVerified": True,
            "emailVerified": True,
            "commissionRate": 2.5,
            "createdAt": now,
        },
        "agent-legacy-2": {
            "displayName": "Second Agent",
            "role": "agent",
            "companyId": "co-1",
            "email": "agent2@example.com",
            "phone": "+9647500000002",
            "createdAt": now,
        },
        "customer-legacy-1": {
            "displayName": "Customer",
            "role": "customer",
            "accountType": "individual_customer",
            "email": "customer@example.com",
            "phone": "+9647500000003",
            "createdAt": now,
        },
        "already-clean-1": {"displayName": "Clean Profile", "role": "customer", "createdAt": now},
        "admin-1": {"displayName": "Admin", "role": "admin", "email": "admin@example.com", "createdAt": now},
    }
    for uid, data in demo.items():
        db.collection("users").document(uid).set(data)
    # A user created by the NEW backend writer already has the split shape.
    db.collection("users").document("new-shape-1").set(
        {"displayName": "New Shape", "role": "customer", "createdAt": now}
    )
    db.collection("users").document("new-shape-1").collection(PRIVATE_COLLECTION).document(PRIVATE_DOC).set(
        {"email": "new@example.com", "phone": "+9647500000009", "createdAt": now}
    )
    print(f"seeded {len(demo) + 1} demo users into the emulator")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="Firebase project id (demo-darwesh for the emulator)")
    parser.add_argument(
        "--mode", choices=["dry-run", "apply", "verify", "rollback", "seed-demo"], default="dry-run"
    )
    parser.add_argument(
        "--allow-production", action="store_true", help="required to run without FIRESTORE_EMULATOR_HOST"
    )
    parser.add_argument("--page-size", type=int, default=300)
    parser.add_argument(
        "--batch-size", type=int, default=400, help="max writes per committed batch (Firestore limit 500)"
    )
    parser.add_argument("--report", help="write the JSON report/stats to this file")
    parser.add_argument("--delete-private", action="store_true", help="rollback: also delete privateProfile/main")
    parser.add_argument(
        "--all", action="store_true", help="rollback: restore every private doc, not only migrated ones"
    )
    args = parser.parse_args()
    if args.batch_size > 480 or args.batch_size < 2:
        parser.error("--batch-size must be between 2 and 480")

    db, target = build_client(args.project, args.allow_production)
    started = datetime.now(UTC).isoformat()
    print(f"[migrate_private_profile] mode={args.mode} target={target} started={started}")

    if args.mode == "seed-demo":
        seed_demo(db)
        return

    if args.mode == "dry-run":
        report = plan(db, args.page_size)
        summary = {k: v for k, v in report.items() if k != "uids"}
        print(json.dumps({"mode": "dry-run", "wouldWrite": report["needingMigration"] * 2, **summary}, indent=2))
        out = {"mode": "dry-run", "target": target, "started": started, **report}
    elif args.mode == "apply":
        before = plan(db, args.page_size)
        stats = apply(db, args.page_size, args.batch_size)
        after = verify(db, args.page_size)
        ok = not after["publicDocsStillPrivate"]
        print(
            json.dumps(
                {
                    "mode": "apply",
                    "planned": before["needingMigration"],
                    **stats,
                    "verifiedClean": ok,
                    "leftover": len(after["publicDocsStillPrivate"]),
                },
                indent=2,
            )
        )
        out = {
            "mode": "apply",
            "target": target,
            "started": started,
            "planned": before["needingMigration"],
            "stats": stats,
            "verify": after,
        }
        if not ok:
            sys.exit(1)
    elif args.mode == "verify":
        result = verify(db, args.page_size)
        print(
            json.dumps(
                {
                    "mode": "verify",
                    "scannedUsers": result["scannedUsers"],
                    "privateDocs": result["privateDocs"],
                    "publicDocsStillPrivate": len(result["publicDocsStillPrivate"]),
                    "examples": result["publicDocsStillPrivate"][:10],
                },
                indent=2,
            )
        )
        out = {"mode": "verify", "target": target, "started": started, **result}
        if result["publicDocsStillPrivate"]:
            if args.report:
                with open(args.report, "w", encoding="utf-8") as fh:
                    json.dump(out, fh, indent=2, default=str)
            sys.exit(1)
    else:  # rollback
        stats = rollback(db, args.page_size, args.batch_size, args.delete_private, args.all)
        print(json.dumps({"mode": "rollback", **stats}, indent=2))
        out = {"mode": "rollback", "target": target, "started": started, "stats": stats}

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2, default=str)
        print(f"report written to {args.report}")


if __name__ == "__main__":
    main()
