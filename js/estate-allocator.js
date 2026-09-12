// Canonical Estate creation -- the ONE sanctioned way to allocate a new
// Estate public ID and create its document. Every future caller (the
// Admin Estate Data "create Estate" flow, a developer/office publishing
// flow, etc.) is expected to import createEstate() from here rather than
// reimplementing the counter-bump-then-create sequence itself.
//
// ATOMICITY (Phase 1 continuation, explicit review requirement): the
// counter increment (counters/estates) and the new Estate document
// (estates/{N}) are written inside the SAME runTransaction() call below
// -- not as two separate operations. A Firestore transaction commits all
// of its writes together or none of them; there is no state where the
// counter has moved to N but no estates/{N} document exists (or vice
// versa) as a result of calling this function. This directly replaces
// the earlier two-step client pattern (bump the counter, then separately
// setDoc() the Estate), which could leave an allocated-but-unused number
// behind if the second step ever failed after the first one already
// committed.
//
// What this does and does NOT guarantee, precisely:
// - GUARANTEED, by Firestore's own transaction semantics (not by
//   anything in this file): if this function throws, NEITHER the
//   counter nor the Estate document was written -- no partial commit.
//   If it resolves, BOTH were written, together.
// - GUARANTEED, independent of this file, by firestore.rules' own
//   design (see its "Concurrency-safe Estate public ID allocator"
//   comment): two different physical properties can never collide on
//   the same estate number, because Firestore classifies a write to a
//   given document path as `create` only once -- this was already true
//   before this file existed, and remains true regardless of whether a
//   caller uses this helper or (incorrectly) writes the two documents
//   separately. This file's contribution is eliminating the wasted-
//   allocation GAP failure mode, not the uniqueness/collision guarantee,
//   which was never at risk.
// - NOT enforced by firestore.rules, and CANNOT be -- Firestore security
//   rules evaluate each document write independently; there is no rules
//   primitive for "these two writes must be part of the same
//   transaction." That guarantee exists only because every caller goes
//   through this one function. This mirrors how activeListingLocks'
//   *sequencing* (claim the lock, then create the listing) is also a
//   client-discipline convention layered on top of a rules-enforced
//   uniqueness guarantee, not something rules alone could force either.
//
// Firestore's own client SDK already retries a transaction function
// internally when it detects the read snapshot went stale before commit
// (an ABORTED conflict) -- this is a documented, built-in guarantee of
// runTransaction() itself, not something this file re-implements. A
// call to createEstate() that fails after that internal retry budget is
// exhausted, or that fails because the caller is genuinely unauthorized
// (PERMISSION_DENIED), is surfaced to the caller as-is -- this file adds
// no additional retry-on-failure layer of its own, since blindly
// retrying a genuine authorization failure would just add latency to an
// already-correct rejection.
import { db, runTransaction } from './firebase-init.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const COUNTER_ID = 'estates';

/** "DG-EST-000042"-style display form -- cosmetic only, never stored or rules-validated (see firestore.rules). */
export function formatPublicEstateId(n) {
  return 'DG-EST-' + String(n).padStart(6, '0');
}

/**
 * Allocates the next Estate number and creates estates/{N} with
 * `estateFields` in a single atomic transaction. `estateFields` must
 * already match firestore.rules' isValidEstateContent()/create-allowlist
 * shape (this function does not itself re-validate the payload -- the
 * rules layer is still the actual enforcement boundary, same as every
 * other write in this codebase).
 *
 * Resolves to `{ estateId, publicEstateId }` on success. Throws (with
 * the underlying Firestore error, e.g. 'permission-denied') if the
 * caller is unauthorized or the payload fails validation -- callers
 * should surface that to the user rather than silently retrying.
 */
export async function createEstate(estateFields) {
  return runTransaction(db, async (tx) => {
    const counterRef = doc(db, 'counters', COUNTER_ID);
    const counterSnap = await tx.get(counterRef);
    const current = counterSnap.exists() ? counterSnap.data().value : 0;
    const next = current + 1;
    const estateRef = doc(db, 'estates', String(next));

    // tx.set() on the counter is a `create` (value must be exactly 1)
    // the first time this ever runs against a fresh project, and an
    // `update` (value must be exactly current+1) on every call after --
    // Firestore classifies each write by whether the target document
    // already existed, which firestore.rules' counters/estates block is
    // written to handle either way (see its allow create / allow update
    // pair) without this file needing to know or care which case applies.
    tx.set(counterRef, { value: next });
    tx.set(estateRef, estateFields);

    return { estateId: String(next), publicEstateId: formatPublicEstateId(next) };
  });
}
