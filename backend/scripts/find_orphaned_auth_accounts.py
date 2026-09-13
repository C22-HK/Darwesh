#!/usr/bin/env python3
"""Operational tool: finds Firebase Auth users with no users/{uid}
Firestore profile document.

This is the rare state SignupCompleteHandler's compensating rollback
normally prevents (see docs/EMAIL_OTP.md's "Orphan-account rollback"):
Auth account created -> Firestore profile write fails -> the rollback
itself ALSO fails. When that happens the account is logged at error
level for manual reconciliation, but nothing automated ever deletes or
otherwise repairs it -- this script is the detection half of that
manual process.

READ-ONLY. Makes only Admin SDK reads (list Auth users, read Firestore
profile docs) -- it never creates, deletes, disables, or modifies any
account or document. Deciding what to do with a flagged account is a
deliberate human judgment call (see the guidance this script prints),
not something this script, or any automation, should do on its own:
an account flagged here could in principle be a real user whose
profile write is simply still catching up, or (once Phone + Password
login exists) could turn out not to be a signup artifact at all.

Usage:
    FIREBASE_SERVICE_ACCOUNT_JSON='<service account JSON contents>' \\
        python3 scripts/find_orphaned_auth_accounts.py [--min-age-minutes N]

Run this by hand against production when a "rollback of orphaned auth
account FAILED" log line has appeared, or periodically (e.g. a
Cloud Scheduler job that runs this and emails/logs the output) as a
safety net in case such a log line was ever missed.

--min-age-minutes (default 60): excludes Auth users created more
recently than this. A brand-new signup has a real, if normally very
short, window between create_account succeeding and create_user_profile
completing -- without an age floor, running this at the wrong instant
could flag an in-flight, entirely normal signup as an orphan.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime, timedelta

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials
from firebase_admin import firestore as fb_firestore


def mask_email(email: str) -> str:
    """Same masking shape as the frontend's OTP UI (js/otp-ui.js's
    maskEmail): "mohammed@example.com" -> "m******d@example.com". Kept
    even though whoever runs this operational script already has full
    Admin SDK access to the same data -- it just keeps this tool's
    terminal/log output consistent with how the rest of the project
    treats email addresses, and avoids printing full addresses to a
    terminal (which may itself be logged or screen-shared) by default."""
    at = email.find("@")
    if at <= 0:
        return email
    local, domain = email[:at], email[at:]
    if len(local) <= 2:
        return local[0] + "*" * max(1, len(local) - 1) + domain
    return local[0] + "*" * (len(local) - 2) + local[-1] + domain


def find_orphaned_accounts(service_account_json: str, min_age_minutes: int) -> list[dict]:
    """Returns one dict per Auth user older than min_age_minutes that
    has no corresponding users/{uid} Firestore document. Opens its own,
    uniquely-named Firebase Admin app (mirrors
    FirebaseAccountOps/FirebaseResetLinkGenerator's pattern) and tears
    it down before returning, since this runs as a one-shot script, not
    a long-lived server process."""
    cred = credentials.Certificate(json.loads(service_account_json))
    app = firebase_admin.initialize_app(cred, name=f"darwesh-reconcile-{id(cred)}")
    try:
        db = fb_firestore.client(app)
        cutoff = datetime.now(UTC) - timedelta(minutes=min_age_minutes)

        orphans: list[dict] = []
        page = fb_auth.list_users(app=app)
        while page:
            for user in page.users:
                created_at = datetime.fromtimestamp(user.user_metadata.creation_timestamp / 1000, tz=UTC)
                if created_at > cutoff:
                    continue  # too recent to safely distinguish from an in-flight, normal signup
                profile = db.collection("users").document(user.uid).get()
                if not profile.exists:
                    orphans.append(
                        {
                            "uid": user.uid,
                            "email_masked": mask_email(user.email) if user.email else "(no email on record)",
                            "created_at": created_at.isoformat(),
                        }
                    )
            page = page.get_next_page()
        return orphans
    finally:
        firebase_admin.delete_app(app)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--min-age-minutes",
        type=int,
        default=60,
        help="Exclude Auth users created more recently than this many minutes ago (default: 60).",
    )
    args = parser.parse_args()

    service_account_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not service_account_json:
        print("FIREBASE_SERVICE_ACCOUNT_JSON is not set -- nothing to authenticate with.", file=sys.stderr)
        sys.exit(1)

    orphans = find_orphaned_accounts(service_account_json, args.min_age_minutes)

    if not orphans:
        print(
            f"No orphaned Auth accounts found (0 Auth users older than {args.min_age_minutes} "
            "minutes with no users/{uid} profile)."
        )
        return

    print(f"Found {len(orphans)} orphaned Auth account(s) -- an Auth user exists with no Firestore profile:\n")
    # Only the last 6 chars of the uid are printed -- enough to look the
    # account up directly in the Firebase Console's Authentication search
    # (which matches on partial uid) without this output itself becoming
    # a bigger secret than necessary.
    for o in orphans:
        print(f"  uid ...{o['uid'][-6:]}  {o['email_masked']}  created {o['created_at']}")

    print(
        "\nThese are NOT deleted automatically -- this script only detects. To resolve each one:\n"
        "  1. Look it up in Firebase Console -> Authentication (search by the uid suffix above,\n"
        "     or cross-reference the created-at timestamp) to see the full record.\n"
        "  2. Confirm it's actually an incomplete signup artifact -- e.g. no sign-in activity\n"
        "     since creation, timestamp lines up with a logged 'profile provisioning failed' /\n"
        "     'rollback ... FAILED' error -- before doing anything to it.\n"
        "  3. Only once confirmed, either delete the orphaned Auth user (Console, or\n"
        "     firebase_admin.auth.delete_user) or backfill users/{uid} by hand if the\n"
        "     applicant's intended profile data is known.\n"
        "  4. If you can't confirm it's an artifact, leave it. Never delete an account this\n"
        "     script hasn't given you enough evidence to be sure about."
    )


if __name__ == "__main__":
    main()
