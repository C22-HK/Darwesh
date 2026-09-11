# Secure weekly archival of verification evidence (brief §AP-§AX).
#
# THE ONE RULE THIS MODULE EXISTS TO ENFORCE (§AT)
# -----------------------------------------------
# Live identity evidence is NEVER deleted until every one of these has
# succeeded and been verified:
#
#     1. archive package built
#     2. encryption succeeded
#     3. upload succeeded
#     4. archive object exists in the vault
#     5. manifest exists
#     6. integrity digests re-read from the vault and match
#
# If ANY check fails the run STOPS for that case and the live evidence
# stays exactly where it is. `delete_live_evidence` is physically unable
# to run without an ArchiveReceipt that only `verify_archive` can
# produce, so "delete anyway" is not an expressible state in this code.
#
# NOTHING HERE IS SCHEDULED OR DEPLOYED. There is no Cloud Scheduler
# trigger, no KMS key and no vault bucket provisioned -- see the
# completion report's undeployed list. `run_weekly_archival` is a plain
# function an operator or a future scheduler calls.
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import ConflictError, ForbiddenError, ValidationError

from . import model

logger = logging.getLogger(__name__)

ARCHIVE_ID_PREFIX = "VFY-DW-"
ARCHIVE_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ARCHIVE_ID_LENGTH = 5

# AES-256-GCM (§AR). Not ZIP passwords -- a ZIP password is neither
# authenticated nor modern, so a tampered archive would decrypt to
# garbage silently instead of failing loudly.
ENCRYPTION_ALGORITHM = "AES-256-GCM"
KEY_BYTES = 32
NONCE_BYTES = 12

# Default retention (§AX). Configurable; biometric/raw ID evidence is
# deliberately NOT retained forever.
DEFAULT_RETENTION_DAYS = 365 * 2


class ArchiveError(Exception):
    """Any failure in the archive pipeline. Raising this ALWAYS means
    live evidence was left intact."""


@dataclass(frozen=True)
class EvidenceBlob:
    evidence_id: str
    kind: str
    storage_path: str
    data: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(frozen=True)
class ArchivePackage:
    """The three-part package from §AQ.

    `verification_pdf` is a human-readable SUMMARY -- it deliberately
    does not embed the raw identity images, because an unencrypted PDF
    full of ID photographs would defeat the entire point of encrypting
    `evidence_enc` next to it.
    """

    archive_id: str
    verification_pdf: bytes
    evidence_enc: bytes
    manifest: dict
    nonce: bytes

    @property
    def manifest_bytes(self) -> bytes:
        return json.dumps(self.manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")


@dataclass(frozen=True)
class ArchiveReceipt:
    """Proof that all six §AT checks passed. Only `verify_archive`
    constructs one, and `delete_live_evidence` requires one -- that
    coupling is what makes "delete without a verified archive"
    unreachable rather than merely discouraged."""

    archive_id: str
    uid: str
    verified_at: datetime
    evidence_ids: list[str] = field(default_factory=list)
    manifest_sha256: str = ""
    evidence_sha256: str = ""


class KeyProvider:
    """Where the archive encryption key comes from.

    §AR requires the key to live apart from source code, GitHub, the
    Firebase client config, the archive storage and the frontend. In
    production this is backed by Cloud KMS / Secret Manager. NO
    PRODUCTION KEY IS CREATED HERE.
    """

    def data_key(self) -> bytes:  # pragma: no cover - interface
        raise NotImplementedError


class EnvKeyProvider(KeyProvider):
    """Reads a base64 key from the environment. Intended for local
    development and tests ONLY -- production must use KMS, and this
    provider refuses to invent a key rather than silently encrypting
    with something predictable."""

    ENV_VAR = "DARWESH_ARCHIVE_KEY_B64"

    def data_key(self) -> bytes:
        import base64

        raw = os.environ.get(self.ENV_VAR)
        if not raw:
            raise ArchiveError("no archive encryption key configured; refusing to archive without one")
        try:
            key = base64.b64decode(raw, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ArchiveError("archive encryption key is not valid base64") from exc
        if len(key) != KEY_BYTES:
            raise ArchiveError(f"archive encryption key must be {KEY_BYTES} bytes")
        return key


def generate_archive_id(rand=None) -> str:
    """VFY-DW-8F72K. Opaque on purpose: §AQ forbids putting a person's
    name into an archive filename."""
    import secrets

    picker = rand or (lambda seq: secrets.choice(seq))
    return ARCHIVE_ID_PREFIX + "".join(picker(ARCHIVE_ID_ALPHABET) for _ in range(ARCHIVE_ID_LENGTH))


def encrypt_evidence(plaintext: bytes, key: bytes) -> tuple[bytes, bytes]:
    """AES-256-GCM. Returns (nonce, ciphertext||tag).

    Authenticated encryption, so tampering is DETECTED at decrypt time
    rather than producing plausible garbage.
    """
    if len(key) != KEY_BYTES:
        raise ArchiveError("invalid key length")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover
        raise ArchiveError("the cryptography package is required for archive encryption") from exc
    import secrets

    nonce = secrets.token_bytes(NONCE_BYTES)
    return nonce, AESGCM(key).encrypt(nonce, plaintext, None)


def decrypt_evidence(nonce: bytes, ciphertext: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover
        raise ArchiveError("the cryptography package is required") from exc
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, None)
    except Exception as exc:  # noqa: BLE001
        raise ArchiveError("archive failed authentication -- it may be corrupt or tampered") from exc


def build_verification_summary(case: dict, evidence: list[EvidenceBlob]) -> bytes:
    """The human-readable summary (§AQ).

    A minimal, dependency-free PDF. It records WHAT was verified and
    WHEN -- never the raw images, and never the full ID number.
    """
    lines = [
        "Darwesh Group - Verification Record",
        "",
        f"Archive ID: {case.get('archiveId', '')}",
        f"Account: {case.get('uid', '')}",
        f"Track: {case.get('track', 'identity')}",
        f"Verification status: {case.get('verificationStatus', '')}",
        f"Verified at: {_iso(case.get('verifiedAt'))}",
        f"Reviewed by: {case.get('reviewedBy', '')}",
        f"Name match: {case.get('nameMatch', '')}",
        f"Face result: {case.get('faceResult', '')}",
        "",
        "Evidence items (content digests only):",
    ]
    for blob in evidence:
        lines.append(f"  - {blob.kind}: sha256 {blob.sha256}")
    lines += [
        "",
        "Raw evidence is stored encrypted alongside this summary.",
        "This document intentionally contains no identity images.",
    ]
    return _simple_pdf(lines)


def _iso(value) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:  # noqa: BLE001
            return ""
    return str(value or "")


def _simple_pdf(lines: list[str]) -> bytes:
    """A valid single-page PDF with no third-party dependency. Small and
    auditable beats pulling a reporting library into the trusted path."""

    def esc(s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    content = "BT /F1 11 Tf 54 760 Td 15 TL\n"
    for line in lines[:52]:
        content += f"({esc(line[:110])}) Tj T*\n"
    content += "ET"
    stream = content.encode("latin-1", "replace")

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class ArchiveOps:
    """The weekly pipeline. `vault` is a SEPARATE storage boundary from
    the public site bucket (§AS): no public URL, no client access, no
    browser listing."""

    def __init__(self, db, *, vault=None, live_bucket=None, key_provider: KeyProvider | None = None):
        self._db = db
        self._vault = vault
        self._live = live_bucket
        self._keys = key_provider or EnvKeyProvider()

    # -- 1-3: build, encrypt, upload ----------------------------------

    def build_package(self, uid: str, case: dict, evidence: list[EvidenceBlob]) -> ArchivePackage:
        if not evidence:
            raise ArchiveError("refusing to build an archive with no evidence")
        archive_id = case.get("archiveId") or generate_archive_id()
        enriched = dict(case)
        enriched["archiveId"] = archive_id
        enriched["uid"] = uid

        bundle = json.dumps(
            {
                "archiveId": archive_id,
                "uid": uid,
                "items": [
                    {
                        "evidenceId": b.evidence_id,
                        "kind": b.kind,
                        "sha256": b.sha256,
                        "bytesBase64": _b64(b.data),
                    }
                    for b in evidence
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

        nonce, ciphertext = encrypt_evidence(bundle, self._keys.data_key())
        pdf = build_verification_summary(enriched, evidence)

        manifest = {
            "archiveId": archive_id,
            "uid": uid,
            "algorithm": ENCRYPTION_ALGORITHM,
            "nonceBase64": _b64(nonce),
            "createdAt": datetime.now(UTC).isoformat(),
            "retentionDays": DEFAULT_RETENTION_DAYS,
            # Digests over what is actually stored, so integrity can be
            # re-verified from the vault alone.
            "evidenceSha256": hashlib.sha256(ciphertext).hexdigest(),
            "plaintextSha256": hashlib.sha256(bundle).hexdigest(),
            "verificationPdfSha256": hashlib.sha256(pdf).hexdigest(),
            "items": [{"evidenceId": b.evidence_id, "kind": b.kind, "sha256": b.sha256} for b in evidence],
        }
        return ArchivePackage(archive_id, pdf, ciphertext, manifest, nonce)

    def upload_package(self, package: ArchivePackage) -> dict:
        if self._vault is None:
            raise ArchiveError("no archive vault configured; refusing to proceed")
        base = f"verification-archives/{package.archive_id}"
        paths = {
            "verification.pdf": package.verification_pdf,
            "evidence.enc": package.evidence_enc,
            "manifest.json": package.manifest_bytes,
        }
        written = {}
        for name, data in paths.items():
            blob = self._vault.blob(f"{base}/{name}")
            blob.upload_from_string(data)
            written[name] = f"{base}/{name}"
        return written

    # -- 4-6: existence + integrity (§AT) ------------------------------

    def verify_archive(self, uid: str, package: ArchivePackage, paths: dict) -> ArchiveReceipt:
        """Re-reads what was uploaded and re-derives its digests.

        Deliberately re-downloads instead of trusting the bytes still in
        memory: the point is to prove the VAULT holds an intact archive,
        not that this process once held one.
        """
        if self._vault is None:
            raise ArchiveError("no archive vault configured")

        for required in ("evidence.enc", "manifest.json", "verification.pdf"):
            if required not in paths:
                raise ArchiveError(f"archive is missing {required}")
            if not self._vault.blob(paths[required]).exists():
                raise ArchiveError(f"archive object {required} does not exist in the vault")

        stored_enc = self._vault.blob(paths["evidence.enc"]).download_as_bytes()
        stored_manifest = self._vault.blob(paths["manifest.json"]).download_as_bytes()

        manifest_digest = hashlib.sha256(stored_manifest).hexdigest()
        evidence_digest = hashlib.sha256(stored_enc).hexdigest()

        if manifest_digest != hashlib.sha256(package.manifest_bytes).hexdigest():
            raise ArchiveError("manifest integrity check failed")
        if evidence_digest != package.manifest["evidenceSha256"]:
            raise ArchiveError("evidence integrity check failed")

        # Strongest available proof: decrypt and confirm the plaintext
        # digest. A corrupt or tampered archive fails HERE, before any
        # deletion is possible.
        plaintext = decrypt_evidence(package.nonce, stored_enc, self._keys.data_key())
        if hashlib.sha256(plaintext).hexdigest() != package.manifest["plaintextSha256"]:
            raise ArchiveError("decrypted archive does not match its recorded digest")

        return ArchiveReceipt(
            archive_id=package.archive_id,
            uid=uid,
            verified_at=datetime.now(UTC),
            evidence_ids=[i["evidenceId"] for i in package.manifest["items"]],
            manifest_sha256=manifest_digest,
            evidence_sha256=evidence_digest,
        )

    # -- 7: deletion, only against a receipt (§AT, §AU) ----------------

    def delete_live_evidence(self, receipt: ArchiveReceipt, *, actor_uid: str = "system") -> dict:
        """Deletes raw live evidence.

        Takes an ArchiveReceipt, not a uid+archive_id pair, precisely so
        that a caller CANNOT invoke this without having gone through
        verify_archive. There is no "force" parameter by design.

        Verification state and reward eligibility survive untouched
        (§AU): only the raw bytes and their Storage paths go.
        """
        if not isinstance(receipt, ArchiveReceipt):
            raise ArchiveError("a verified archive receipt is required before deletion")
        if not receipt.archive_id or not receipt.evidence_ids:
            raise ArchiveError("incomplete archive receipt")

        case_ref = self._db.collection(model.VERIFICATION_CASES).document(receipt.uid)
        deleted = []
        for evidence_id in receipt.evidence_ids:
            ev_ref = case_ref.collection(model.VERIFICATION_EVIDENCE).document(evidence_id)
            snap = ev_ref.get()
            if not snap.exists:
                continue
            item = snap.to_dict() or {}
            if self._live is not None and item.get("storagePath"):
                blob = self._live.blob(item["storagePath"])
                if blob.exists():
                    blob.delete()
            # Metadata is kept; the durable path is not, so nothing can
            # later be pointed back at an object that no longer exists.
            ev_ref.set(
                {
                    "liveEvidenceDeleted": True,
                    "liveEvidenceDeletedAt": fb_firestore.SERVER_TIMESTAMP,
                    "storagePath": "",
                },
                merge=True,
            )
            deleted.append(evidence_id)

        # The minimum application metadata from §AU -- verification and
        # reward state are explicitly preserved.
        case_ref.set(
            {
                "verificationArchiveId": receipt.archive_id,
                "archiveStatus": "archived",
                "archivedAt": fb_firestore.SERVER_TIMESTAMP,
                "liveEvidenceDeletedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        self._db.collection(model.VERIFICATION_ARCHIVES).document(receipt.archive_id).set(
            {
                "archiveId": receipt.archive_id,
                "uid": receipt.uid,
                "manifestSha256": receipt.manifest_sha256,
                "evidenceSha256": receipt.evidence_sha256,
                "algorithm": ENCRYPTION_ALGORITHM,
                "integrityVerifiedAt": fb_firestore.SERVER_TIMESTAMP,
                "liveEvidenceDeletedAt": fb_firestore.SERVER_TIMESTAMP,
                "evidenceCount": len(deleted),
                "retentionDays": DEFAULT_RETENTION_DAYS,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        batch = self._db.batch()
        write_audit(
            batch,
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="system",
                action="verification_evidence_deleted",
                target_type="verificationCase",
                target_id=receipt.uid,
                changed_fields=["liveEvidenceDeletedAt"],
                new_value=receipt.archive_id,
                reason_code="archived_then_deleted",
            ),
        )
        batch.commit()
        return {"archiveId": receipt.archive_id, "deleted": deleted}

    # -- the whole run -------------------------------------------------

    def load_live_evidence(self, uid: str) -> list[EvidenceBlob]:
        """Reads the live evidence bytes a case still has.

        Raises rather than returning an empty list when storage is not
        configured: "no bucket" and "no evidence" must never collapse
        into the same answer, because build_package treats an empty list
        as a refusal and a caller could otherwise read that refusal as
        "there was nothing to archive" (§BI).
        """
        if self._live is None:
            raise ArchiveError("live evidence storage is not configured; refusing to proceed")
        blobs: list[EvidenceBlob] = []
        ev_col = (
            self._db.collection(model.VERIFICATION_CASES).document(uid).collection(model.VERIFICATION_EVIDENCE)
        )
        for snap in ev_col.stream():
            item = snap.to_dict() or {}
            if item.get("liveEvidenceDeleted"):
                continue
            path = item.get("storagePath")
            if not path:
                continue
            data = self._live.blob(path).download_as_bytes()
            blobs.append(
                EvidenceBlob(
                    evidence_id=snap.id,
                    kind=item.get("kind") or "other",
                    storage_path=path,
                    data=data,
                )
            )
        return blobs

    def archive_case(
        self, uid: str, evidence: list[EvidenceBlob] | None = None, *, actor_uid: str = "system"
    ) -> dict:
        """One case, end to end, in the §AT order. Any failure returns a
        result with `deleted: False` and leaves live evidence intact.

        `evidence` may be omitted, in which case the live bytes are read
        here; tests and the offline pipeline pass them in directly.
        """
        case_snap = self._db.collection(model.VERIFICATION_CASES).document(uid).get()
        if not case_snap.exists:
            return {"uid": uid, "ok": False, "deleted": False, "error": "no_case"}
        case = case_snap.to_dict() or {}
        if case.get("verificationStatus") != "verified":
            return {"uid": uid, "ok": False, "deleted": False, "error": "not_verified"}
        if case.get("archiveStatus") == "archived":
            return {"uid": uid, "ok": True, "deleted": False, "error": "already_archived"}

        try:
            if evidence is None:
                evidence = self.load_live_evidence(uid)
            package = self.build_package(uid, case, evidence)
            paths = self.upload_package(package)
            receipt = self.verify_archive(uid, package, paths)
        except ArchiveError as exc:
            # STOP. Live evidence untouched.
            self._db.collection(model.VERIFICATION_CASES).document(uid).set(
                {
                    "archiveStatus": "failed",
                    "archiveError": str(exc)[:300],
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            logger.error("archive failed for %s: %s -- live evidence retained", uid, exc)
            return {"uid": uid, "ok": False, "deleted": False, "error": str(exc)}

        result = self.delete_live_evidence(receipt, actor_uid=actor_uid)
        return {"uid": uid, "ok": True, "deleted": True, **result}

    def weekly_summary(self, week_start: datetime, week_end: datetime) -> dict:
        """The Admin-safe weekly overview from §AW. Counts only -- it
        never returns evidence and never mints a download."""
        q = (
            self._db.collection(model.VERIFICATION_ARCHIVES)
            .where("createdAt", ">=", week_start)
            .where("createdAt", "<", week_end)
        )
        archived = sum(1 for _ in q.stream())
        failed_q = self._db.collection(model.VERIFICATION_CASES).where("archiveStatus", "==", "failed")
        failures = sum(1 for _ in failed_q.stream())
        pending_q = (
            self._db.collection(model.VERIFICATION_CASES)
            .where("verificationStatus", "==", "verified")
            .where("archiveStatus", "==", "none")
        )
        pending = sum(1 for _ in pending_q.stream())
        return {
            "weekStart": week_start.isoformat(),
            "weekEnd": week_end.isoformat(),
            "archived": archived,
            "failures": failures,
            "pendingDeletion": pending,
            "completedDeletion": archived,
            "integrityStatus": "verified" if failures == 0 else "attention_required",
        }


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


def require_archive_permission(permissions: set[str]) -> None:
    if "archives.view" not in (permissions or set()):
        raise ForbiddenError("missing required permission: archives.view")


__all__ = [
    "ArchiveError",
    "ArchiveOps",
    "ArchivePackage",
    "ArchiveReceipt",
    "ConflictError",
    "EnvKeyProvider",
    "EvidenceBlob",
    "KeyProvider",
    "ValidationError",
    "decrypt_evidence",
    "encrypt_evidence",
    "generate_archive_id",
    "require_archive_permission",
]
