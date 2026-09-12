// Darwesh Personal Network Rewards -- the ONE place the reward formula
// lives on the client. The authoritative copy is the backend
// (backend/app/verification/rewards.py); this module exists so the UI
// can render and preview the same numbers without inventing a second
// formula, and it must stay in step with the Python module.
//
// THE CLIENT IS NEVER AUTHORITATIVE (brief §AK). Nothing here decides
// whether a user is verified, whether a referral qualified, or what
// discount they actually hold -- it only computes a display value from
// state the server already decided, and previews the effect of a config
// an admin is editing. Every real transition is a server write the
// browser cannot perform (see firestore.rules' rewardLedger/referrals
// blocks: they are backend-only).
//
// DECIMAL SAFETY (brief §A, §BD)
// ------------------------------
// 3.5% must stay 3.5% and 6.5% must stay 6.5% -- never 4% or 7%.
// Two things break that in JavaScript and both are avoided here:
//
//   1. parseInt('3.5') === 3, and Math.round(3.5) === 4. Neither appears
//      in this module, and scripts/ci-checks.js fails the build if a
//      reward path reintroduces them.
//   2. Binary floating point: 0.1 + 0.2 !== 0.3. The configured values
//      today (3.5, 3) happen to be exactly representable, but a future
//      admin may set 1.1 or 2.35, so all arithmetic runs on INTEGER
//      BASIS POINTS (1% = 100bp, 3.5% = 350bp) and converts back only at
//      the edge. Integer addition cannot drift.

/** 1% expressed in the integer unit all arithmetic here uses. */
export const BASIS_POINTS_PER_PERCENT = 100;

/** Smallest percentage step the product supports: 0.01%. */
export const PERCENT_EPSILON = 0.01;

/** Bounds any configured reward percentage must satisfy. */
export const REWARD_PERCENT_MIN = 0;
export const REWARD_PERCENT_MAX = 100;

/**
 * The product defaults from the brief (§A). These are DEFAULTS, not
 * constants: an admin changes them in Admin > Rewards Configuration and
 * the stored config wins. They live here so a brand-new deployment with
 * no config document still behaves exactly as specified rather than
 * silently paying 0%.
 */
export const DEFAULT_REWARD_CONFIG = Object.freeze({
  verificationReward: 3.5,
  qualifiedReferralReward: 3,
  requiredQualifiedReferrals: 1,
  maximumPersonalDiscount: 6.5,
  // How a personal network reward interacts with a public promotional
  // campaign (brief §B). Default is deliberately NOT 'stack'.
  stackingPolicy: 'highest_benefit',
});

/** Every stacking policy Admin may choose (brief §B). */
export const STACKING_POLICIES = Object.freeze([
  'personal_only',
  'campaign_only',
  'highest_benefit',
  'stack',
]);

// ---------------------------------------------------------------------
// Decimal-safe primitives
// ---------------------------------------------------------------------

/**
 * Percent -> integer basis points. Rounds to the nearest basis point
 * (0.01%) because that is the smallest unit the product supports, so
 * this is a deliberate quantisation of sub-supported precision, NOT the
 * "round 3.5 to 4" bug -- 3.5 becomes 350, exactly.
 *
 * Returns null for anything unparseable so a caller can tell "not a
 * number" from a legitimate zero.
 */
export function toBasisPoints(percent) {
  if (percent === null || percent === undefined || percent === '') return null;
  const n = typeof percent === 'number' ? percent : Number(String(percent).trim());
  if (!Number.isFinite(n)) return null;
  // Number.EPSILON nudge: (1.005 * 100) is 100.49999999999999 in binary
  // floating point, which would round DOWN to 100 instead of 101.
  return Math.round((n + Number.EPSILON) * BASIS_POINTS_PER_PERCENT);
}

/** Integer basis points -> percent as a Number (350 -> 3.5). */
export function fromBasisPoints(bp) {
  if (!Number.isFinite(bp)) return 0;
  return bp / BASIS_POINTS_PER_PERCENT;
}

/**
 * A percentage as a human string, with the decimal preserved and
 * trailing zeros trimmed: 3.5 -> "3.5", 6.5 -> "6.5", 3 -> "3",
 * 0 -> "0", 3.50 -> "3.5". Never rounds to an integer.
 */
export function formatPercent(percent) {
  const bp = toBasisPoints(percent);
  if (bp === null) return '0';
  const whole = Math.trunc(bp / BASIS_POINTS_PER_PERCENT);
  const frac = Math.abs(bp % BASIS_POINTS_PER_PERCENT);
  if (frac === 0) return String(whole);
  // Two decimal places, then trim a trailing zero ("3.50" -> "3.5").
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${fracStr}`;
}

/** The same value with a '%' suffix, for direct display. */
export function formatPercentLabel(percent) {
  return `${formatPercent(percent)}%`;
}

/** True when `value` is a usable reward percentage in [0, 100]. */
export function isValidRewardPercent(value) {
  const bp = toBasisPoints(value);
  if (bp === null) return false;
  return bp >= REWARD_PERCENT_MIN * BASIS_POINTS_PER_PERCENT
      && bp <= REWARD_PERCENT_MAX * BASIS_POINTS_PER_PERCENT;
}

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

/**
 * Normalizes a stored reward-config document, falling back to the
 * product defaults field by field. A malformed or partial document can
 * therefore never produce a nonsense reward -- it degrades to the
 * specified behaviour rather than to zero or NaN.
 */
export function normalizeRewardConfig(data) {
  const d = data || {};
  const pick = (key) => (isValidRewardPercent(d[key]) ? Number(d[key]) : DEFAULT_REWARD_CONFIG[key]);
  const required = Number(d.requiredQualifiedReferrals);
  return {
    verificationReward: pick('verificationReward'),
    qualifiedReferralReward: pick('qualifiedReferralReward'),
    requiredQualifiedReferrals:
      Number.isInteger(required) && required >= 0 && required <= 100
        ? required
        : DEFAULT_REWARD_CONFIG.requiredQualifiedReferrals,
    maximumPersonalDiscount: pick('maximumPersonalDiscount'),
    stackingPolicy: STACKING_POLICIES.includes(d.stackingPolicy)
      ? d.stackingPolicy
      : DEFAULT_REWARD_CONFIG.stackingPolicy,
    updatedAt: d.updatedAt ?? null,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : '',
  };
}

/**
 * Validates an admin's proposed configuration. Returns an array of
 * machine-readable problem codes -- empty means valid. The editor shows
 * these; the backend re-validates identically and is what actually
 * decides (§AK).
 */
export function validateRewardConfig(config) {
  const problems = [];
  const c = config || {};
  ['verificationReward', 'qualifiedReferralReward', 'maximumPersonalDiscount'].forEach((key) => {
    if (!isValidRewardPercent(c[key])) problems.push(`invalid_${key}`);
  });
  const required = Number(c.requiredQualifiedReferrals);
  if (!Number.isInteger(required) || required < 0 || required > 100) {
    problems.push('invalid_requiredQualifiedReferrals');
  }
  if (!STACKING_POLICIES.includes(c.stackingPolicy)) {
    problems.push('invalid_stackingPolicy');
  }
  // A maximum below what full completion would award is not illegal --
  // it is a deliberate cap -- but a maximum of 0 silently disables every
  // reward, which is almost never what an admin meant to type.
  if (problems.length === 0 && toBasisPoints(c.maximumPersonalDiscount) === 0) {
    problems.push('maximum_is_zero');
  }
  return problems;
}

// ---------------------------------------------------------------------
// The reward formula (brief §BD)
// ---------------------------------------------------------------------

/**
 * Computes the personal network discount from authoritative state.
 *
 *   verificationReward = fullyVerified ? config.verificationReward : 0
 *   referralReward     = qualifiedCount >= required ? config.qualifiedReferralReward : 0
 *   total              = min(verification + referral, config.maximum)
 *
 * `state` comes from the server. Passing a browser-supplied
 * `discountPercent` here would be meaningless: this function ignores any
 * such field by construction and recomputes from the component facts.
 *
 * Returns a breakdown, not just a number, because the UI (§S) has to
 * show WHY the user holds the discount they hold.
 */
export function computePersonalDiscount(state, config) {
  const cfg = normalizeRewardConfig(config);
  const s = state || {};

  const fullyVerified = s.identityVerified === true && s.faceVerified === true;
  const qualifiedCount = Number.isInteger(s.qualifiedReferralCount)
    ? Math.max(0, s.qualifiedReferralCount)
    : 0;
  const referralsMet = qualifiedCount >= cfg.requiredQualifiedReferrals;

  const verificationBp = fullyVerified ? toBasisPoints(cfg.verificationReward) : 0;
  const referralBp = (fullyVerified && referralsMet) ? toBasisPoints(cfg.qualifiedReferralReward) : 0;
  const maxBp = toBasisPoints(cfg.maximumPersonalDiscount);

  // Integer arithmetic only -- this sum cannot drift.
  const cappedBp = Math.min(verificationBp + referralBp, maxBp);

  return {
    fullyVerified,
    referralUnlocked: fullyVerified,
    qualifiedReferralCount: qualifiedCount,
    requiredQualifiedReferrals: cfg.requiredQualifiedReferrals,
    referralsMet,
    verificationReward: fromBasisPoints(verificationBp),
    referralReward: fromBasisPoints(referralBp),
    // What the user actually holds.
    personalDiscountPercent: fromBasisPoints(cappedBp),
    // What they would hold at full completion, for the "next reward" UI.
    potentialDiscountPercent: fromBasisPoints(
      Math.min(
        toBasisPoints(cfg.verificationReward) + toBasisPoints(cfg.qualifiedReferralReward),
        maxBp,
      ),
    ),
    // Non-zero only while there is something left to earn.
    nextRewardPercent: fromBasisPoints(
      fullyVerified && !referralsMet ? toBasisPoints(cfg.qualifiedReferralReward)
        : (!fullyVerified ? toBasisPoints(cfg.verificationReward) : 0),
    ),
    cappedByMaximum: verificationBp + referralBp > maxBp,
    config: cfg,
  };
}

/**
 * Resolves a personal reward against a public promotional campaign
 * (brief §B). These are two independent systems and must NOT silently
 * stack; the policy is an admin decision with 'highest_benefit' as the
 * default.
 *
 * Returns which benefit applies and why, so the UI can be explicit
 * rather than showing a number the user cannot account for.
 */
export function resolveEffectiveDiscount(personalPercent, campaignPercent, config) {
  const cfg = normalizeRewardConfig(config);
  const personalBp = toBasisPoints(personalPercent) || 0;
  const campaignBp = toBasisPoints(campaignPercent) || 0;
  const maxBp = toBasisPoints(REWARD_PERCENT_MAX);

  let appliedBp;
  let source;
  switch (cfg.stackingPolicy) {
    case 'personal_only':
      appliedBp = personalBp; source = 'personal'; break;
    case 'campaign_only':
      appliedBp = campaignBp; source = 'campaign'; break;
    case 'stack':
      appliedBp = Math.min(personalBp + campaignBp, maxBp); source = 'stacked'; break;
    case 'highest_benefit':
    default:
      if (campaignBp > personalBp) { appliedBp = campaignBp; source = 'campaign'; }
      else { appliedBp = personalBp; source = 'personal'; }
      break;
  }

  return {
    policy: cfg.stackingPolicy,
    source,
    personalPercent: fromBasisPoints(personalBp),
    campaignPercent: fromBasisPoints(campaignBp),
    appliedPercent: fromBasisPoints(appliedBp),
  };
}

/**
 * Applies a discount to an eligible Darwesh brokerage/service fee
 * (brief §BE). Money is computed in integer minor units (cents) for the
 * same reason percentages use basis points.
 *
 * This NEVER touches a property's listed price -- the caller passes the
 * FEE, and gets the discounted FEE back.
 */
export function applyDiscountToFee(feeAmount, discountPercent) {
  const fee = Number(feeAmount);
  if (!Number.isFinite(fee) || fee < 0) return null;
  const bp = toBasisPoints(discountPercent);
  if (bp === null || bp < 0) return null;

  const feeMinor = Math.round((fee + Number.EPSILON) * 100);
  // fee * percent / 100, all in integers: minor * bp / (100 * 100).
  const discountMinor = Math.round((feeMinor * bp) / (BASIS_POINTS_PER_PERCENT * 100));
  const payableMinor = Math.max(0, feeMinor - discountMinor);
  return {
    originalFee: feeMinor / 100,
    discountPercent: fromBasisPoints(bp),
    discountAmount: discountMinor / 100,
    payableFee: payableMinor / 100,
  };
}
