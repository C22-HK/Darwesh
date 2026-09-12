// Darwesh verification & referral domain model -- shared vocabulary for
// the user flow, the Admin review workspace and the signup referral
// field. Pure logic: no Firestore, no DOM, no HTML.
//
// Mirrored authoritatively in backend/app/verification/model.py. Where
// the two could disagree the BACKEND WINS -- this copy exists so the UI
// can label and gate things without inventing a parallel vocabulary.

// ---------------------------------------------------------------------
// State machines (brief §H -- these are deliberately SEPARATE axes)
// ---------------------------------------------------------------------

/** What we know about the person's identity evidence. */
export const VERIFICATION_STATUSES = Object.freeze([
  'unverified',
  'pending',
  'verified',
  'needs_review',
  'needs_resubmission',
  'rejected',
]);

/** What the account itself is allowed to do. Independent of the above:
 *  "Verification: Rejected / Account: Active" is a legitimate pairing,
 *  and so is "Verification: Needs Review / Account: Active". */
export const ACCOUNT_STATUSES = Object.freeze([
  'active',
  'restricted',
  'suspended',
  'closed',
]);

/** Face / liveness outcomes (brief §F). 'unavailable' is honest about a
 *  provider that is not live rather than silently reporting a pass. */
export const FACE_RESULTS = Object.freeze([
  'pending',
  'passed',
  'failed',
  'needs_review',
  'unavailable',
]);

/** Name comparison outcomes (brief §G). Transliteration variance is
 *  expected in this market and is NOT fraud by itself. */
export const NAME_MATCH_RESULTS = Object.freeze([
  'exact',
  'likely',
  'needs_review',
  'strong_mismatch',
]);

/** Which evidence kinds a case may carry (brief §Z). */
export const EVIDENCE_KINDS = Object.freeze([
  'id_front',
  'id_back',
  'selfie',
  'liveness',
  'business_registration',
  'business_license',
  'professional_credential',
  'other',
]);

/** Verification tracks. Identity is required for the reward; the other
 *  two are additive badges (brief §AG) and must never be collapsed into
 *  one vague "Verified". */
export const VERIFICATION_TRACKS = Object.freeze(['identity', 'business', 'professional']);

/**
 * Legal verification-status transitions. Anything not listed is refused
 * by the backend. Encoded here so the Admin UI can only OFFER actions
 * that would actually succeed, instead of showing a button that 403s.
 */
export const VERIFICATION_TRANSITIONS = Object.freeze({
  unverified: ['pending'],
  pending: ['verified', 'needs_review', 'needs_resubmission', 'rejected'],
  needs_review: ['verified', 'needs_resubmission', 'rejected'],
  needs_resubmission: ['pending', 'rejected'],
  // A rejected case can be reopened for resubmission -- rejection is not
  // a dead end (brief §AB prefers review/resubmission over closure).
  rejected: ['needs_resubmission', 'pending'],
  // Terminal for this case; a new case would be created instead.
  verified: ['needs_review'],
});

export function canTransitionVerification(from, to) {
  if (!VERIFICATION_STATUSES.includes(from) || !VERIFICATION_STATUSES.includes(to)) return false;
  return (VERIFICATION_TRANSITIONS[from] || []).includes(to);
}

/**
 * The reward gate (brief §I). BOTH components must be approved --
 * partial completion earns nothing. Kept as one function so no surface
 * can invent a looser definition of "fully verified".
 */
export function isFullyIdentityVerified(caseState) {
  const c = caseState || {};
  return c.verificationStatus === 'verified'
      && c.idVerified === true
      && c.faceResult === 'passed';
}

/** Referral features stay locked until the user's OWN identity is
 *  verified (brief §J). */
export function isReferralUnlocked(caseState) {
  return isFullyIdentityVerified(caseState);
}

// ---------------------------------------------------------------------
// Referral codes (brief §K)
// ---------------------------------------------------------------------

// Unambiguous alphabet: no O/0, no I/1 -- these codes get read aloud,
// written on business cards and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_PREFIX = 'DW-';
export const REFERRAL_CODE_BODY_LENGTH = 5;
const CODE_RE = /^DW-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

/**
 * Generates a candidate code (e.g. DW-M7K4P). Uniqueness is NOT decided
 * here -- the backend claims the code in a transaction against the
 * referralCodes collection and regenerates on collision. This function
 * only produces a well-formed random candidate.
 *
 * Uses crypto where available. A code derived from Math.random alone
 * would be guessable, and a guessable code is a referral-farming tool.
 */
export function generateReferralCode(randomBytes) {
  const n = REFERRAL_CODE_BODY_LENGTH;
  let bytes = randomBytes;
  if (!bytes) {
    bytes = new Uint32Array(n);
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let body = '';
  for (let i = 0; i < n; i += 1) body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return REFERRAL_CODE_PREFIX + body;
}

/**
 * Canonical form for comparison and storage. Entry is case-insensitive
 * (§K) and tolerant of the things people actually type: spaces, a
 * missing prefix, a lowercase prefix, an en-dash pasted from a message.
 * Returns null when it cannot be read as a code at all.
 */
export function normalizeReferralCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toUpperCase();
  // Strip separators, then re-apply the canonical prefix.
  //
  // The trailing `-` is the ASCII hyphen and is load-bearing: `‐-―` is
  // the U+2010..U+2015 typographic-dash RANGE and does NOT include it,
  // so without this the canonical printed form "DW-M7K4P" -- the exact
  // string this app shows people and they copy -- kept its hyphen,
  // became "-M7K4P" after the prefix was stripped, failed the length
  // check and was reported as an invalid code. Matches the character
  // class in backend/app/verification/model.py.
  s = s.replace(/[\s‐-―_.-]/g, '');
  if (s.startsWith('DW')) s = s.slice(2);
  if (s.length !== REFERRAL_CODE_BODY_LENGTH) return null;
  const candidate = REFERRAL_CODE_PREFIX + s;
  return CODE_RE.test(candidate) ? candidate : null;
}

export function isValidReferralCodeFormat(input) {
  return normalizeReferralCode(input) !== null;
}

/** Optional convenience link (brief §L). The CODE is primary -- the
 *  system works entirely without this. */
export function referralSignupUrl(code, baseHref) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  const rel = `signup.html?ref=${encodeURIComponent(normalized)}`;
  try {
    return new URL(rel, baseHref || (typeof window !== 'undefined' ? window.location.href : undefined)).href;
  } catch (_) {
    return rel;
  }
}

// ---------------------------------------------------------------------
// Referral relationships (brief §Q, §R)
// ---------------------------------------------------------------------

export const REFERRAL_STATUSES = Object.freeze([
  'pending',
  'qualified',
  'rejected',
  'suspicious',
  'revoked',
]);

/** Only a QUALIFIED referral counts toward the reward. */
export function countsTowardReward(referral) {
  return !!referral && referral.status === 'qualified';
}

// ---------------------------------------------------------------------
// Name matching (brief §G)
// ---------------------------------------------------------------------

// Arabic/Kurdish diacritics and tatweel carry no identity information
// for this comparison and are stripped before matching.
const ARABIC_MARKS_RE = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/**
 * Folds a name to a comparable form: case, diacritics, Arabic letter
 * variants (أ إ آ -> ا, ة -> ه, ى -> ي), Kurdish/Persian variants
 * (ک -> ك, ی -> ي), punctuation and extra whitespace.
 */
export function foldName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // Latin combining marks
    .replace(ARABIC_MARKS_RE, '')          // Arabic harakat + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ةۃ]/g, 'ه')
    .replace(/[ىېۍ]/g, 'ي')
    .replace(/[کڪ]/g, 'ك')
    .replace(/[یۑ]/g, 'ي')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Latin transliteration families that are the SAME name in this market.
 * A profile reading "Mohammed" against an ID reading "Muhammad" is
 * ordinary, not suspicious, and must never be auto-escalated (§G).
 */
const TRANSLITERATION_GROUPS = [
  ['mohammed', 'mohammad', 'muhammad', 'mohamed', 'muhammed', 'mehmet', 'mohammd'],
  ['ahmed', 'ahmad', 'ahmet'],
  ['ali', 'aly'],
  ['hussein', 'husain', 'hussain', 'huseyin', 'husein'],
  ['hassan', 'hasan'],
  ['omar', 'umar', 'omer'],
  ['othman', 'osman', 'uthman'],
  ['ibrahim', 'ibraheem', 'brahim'],
  ['yousef', 'yusuf', 'yousif', 'youssef', 'yusif'],
  ['abdullah', 'abdallah', 'abdulla'],
  ['karim', 'kareem'],
  ['rashid', 'rasheed'],
  ['sami', 'samy'],
  ['salah', 'salih', 'saleh'],
  ['jamal', 'jamil', 'jameel'],
  ['zana', 'zanaa'],
  ['kawa', 'kawah'],
  ['aras', 'araz'],
  ['dilan', 'dylan', 'delan'],
  ['rezan', 'rezhan'],
];

const TRANSLITERATION_LOOKUP = (() => {
  const m = new Map();
  TRANSLITERATION_GROUPS.forEach((group, i) => group.forEach((name) => m.set(name, i)));
  return m;
})();

function tokensEquivalent(a, b) {
  if (a === b) return true;
  const ga = TRANSLITERATION_LOOKUP.get(a);
  const gb = TRANSLITERATION_LOOKUP.get(b);
  if (ga !== undefined && ga === gb) return true;
  // A short spelling difference in a long token (Kareem/Karim) is a
  // transliteration artefact, not a different person.
  if (Math.abs(a.length - b.length) <= 2 && Math.min(a.length, b.length) >= 4) {
    return levenshtein(a, b) <= 1;
  }
  return false;
}

/** Plain Levenshtein, bounded by the shorter string -- names are short,
 *  so the simple O(n*m) table is appropriate here. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Compares a profile name against an ID name and returns one of
 * NAME_MATCH_RESULTS plus the evidence behind it.
 *
 * This is a REVIEW SIGNAL. Even 'strong_mismatch' only raises a flag --
 * §G and §AB are explicit that it must never auto-close an account.
 * No invented confidence percentage is returned (§AA).
 */
export function compareNames(profileName, idName) {
  const a = foldName(profileName);
  const b = foldName(idName);
  if (!a || !b) {
    return { result: 'needs_review', reason: 'missing_name', matchedTokens: 0, totalTokens: 0 };
  }
  if (a === b) {
    const n = a.split(' ').length;
    return { result: 'exact', reason: 'identical_after_folding', matchedTokens: n, totalTokens: n };
  }

  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  const unmatchedB = [...tb];
  let matched = 0;
  ta.forEach((tok) => {
    const idx = unmatchedB.findIndex((other) => tokensEquivalent(tok, other));
    if (idx >= 0) { matched += 1; unmatchedB.splice(idx, 1); }
  });

  const total = Math.max(ta.length, tb.length);
  const ratio = total === 0 ? 0 : matched / total;

  // Every token accounted for, only spelling differed.
  if (matched === ta.length && matched === tb.length) {
    return { result: 'likely', reason: 'transliteration_variant', matchedTokens: matched, totalTokens: total };
  }
  // Most of the name agrees -- commonly a dropped middle/father's name,
  // which is extremely common here and is a review item, not fraud.
  if (ratio >= 0.5) {
    return { result: 'likely', reason: 'partial_name_overlap', matchedTokens: matched, totalTokens: total };
  }
  if (matched > 0) {
    return { result: 'needs_review', reason: 'weak_overlap', matchedTokens: matched, totalTokens: total };
  }
  return { result: 'strong_mismatch', reason: 'no_token_overlap', matchedTokens: 0, totalTokens: total };
}

// ---------------------------------------------------------------------
// Overall risk (brief §AA)
// ---------------------------------------------------------------------

/**
 * Folds the available signals into Low / Medium / High for the Admin
 * header. Deliberately coarse: no fabricated confidence number, and no
 * automated consequence attached -- it orders the review queue, nothing
 * more.
 */
export function overallRisk(signals) {
  const s = signals || {};
  const flags = Array.isArray(s.riskFlags) ? s.riskFlags : [];
  const blocking = flags.filter((f) => BLOCKING_RISK_FLAGS.includes(f));
  if (blocking.length > 0) return 'high';
  if (s.nameMatch === 'strong_mismatch') return 'high';
  if (s.faceResult === 'failed') return 'high';
  if (s.nameMatch === 'needs_review' || s.faceResult === 'needs_review') return 'medium';
  if (flags.length > 0) return 'medium';
  if (s.documentQuality === 'needs_resubmission') return 'medium';
  return 'low';
}

/** Fraud signals (brief §AJ). Each is a REASON TO LOOK, never a verdict.
 *  Note the absence of any IP-only signal: §AJ forbids treating a shared
 *  network as proof, and households/offices legitimately share one. */
export const RISK_FLAGS = Object.freeze([
  'self_referral',
  'circular_referral',
  'duplicate_relationship',
  'rapid_signup_burst',
  'reused_evidence_hash',
  'referral_farming_pattern',
  'name_strong_mismatch',
  'face_mismatch',
  'device_cluster',
]);

/** The subset serious enough to hold a reward pending review. Still no
 *  automatic closure -- an admin decides (§AB). */
export const BLOCKING_RISK_FLAGS = Object.freeze([
  'self_referral',
  'circular_referral',
  'duplicate_relationship',
  'reused_evidence_hash',
]);

// ---------------------------------------------------------------------
// Capture quality (brief §E)
// ---------------------------------------------------------------------

export const QUALITY_ISSUES = Object.freeze([
  'blurry', 'glare', 'too_dark', 'cropped', 'low_resolution',
]);

/** Minimum usable capture. Below this an ID photo cannot be read by a
 *  human reviewer either, so we ask for a retake before submission
 *  rather than wasting a review cycle. */
export const MIN_CAPTURE_WIDTH = 640;
export const MIN_CAPTURE_HEIGHT = 400;

/**
 * Judges a capture from measurements the caller took off a canvas.
 * IMPORTANT (§E): this assesses whether an image is READABLE. It says
 * nothing about whether the document is genuine -- authenticity stays a
 * human review decision, and this function never claims otherwise.
 */
export function assessCaptureQuality(metrics) {
  const m = metrics || {};
  const issues = [];
  if (Number(m.width) < MIN_CAPTURE_WIDTH || Number(m.height) < MIN_CAPTURE_HEIGHT) {
    issues.push('low_resolution');
  }
  // Variance of the Laplacian: the standard readable-vs-blurred proxy.
  if (Number.isFinite(m.sharpness) && m.sharpness < 55) issues.push('blurry');
  if (Number.isFinite(m.brightness) && m.brightness < 55) issues.push('too_dark');
  if (Number.isFinite(m.blownHighlightRatio) && m.blownHighlightRatio > 0.12) issues.push('glare');
  if (m.edgeTouching === true) issues.push('cropped');
  return {
    usable: issues.length === 0,
    issues,
    // Never presented as an authenticity score.
    assessed: true,
  };
}
