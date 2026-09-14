// Darwesh Arena -- client-side display mirror of backend/app/arena/model.py.
// Display/formatting only. Every real decision (points, unlocks, step
// transitions, deal stages, commission) is made server-side by
// app/arena/arena_ops.py; this module never re-implements that logic, it
// only knows how to render what the server already returned.
//
// THE STEP ENGINE: a Challenge's `steps` array is authored entirely by an
// admin (see js/admin-arena.js's Challenge Builder) -- nothing about a
// specific flow (join/submit/verify/buyer/sale) is hardcoded here or
// anywhere in arena-hub.js/arena-challenge.js. Both pages render whatever
// steps a challenge happens to declare.

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'elite', 'legendary'];
export const CATEGORIES = ['residential', 'commercial', 'land', 'projects', 'city', 'special', 'partner'];
export const STEP_STATUSES = ['locked', 'available', 'in_progress', 'verification_pending', 'completed', 'skipped'];
export const DEAL_STAGES = [
  'lead', 'contacted', 'qualified', 'matched', 'viewing_scheduled',
  'viewing_completed', 'negotiating', 'deal_pending', 'closed', 'lost',
];
export const SELF_REPORTABLE_DEAL_STAGES = ['lead', 'contacted'];
export const PROPERTY_SOURCES = ['my_property', 'owner_permission', 'agency_partner'];
export const PAYMENT_STATES = ['pending', 'invoiced', 'received', 'waived', 'disputed'];

/**
 * The challenge's card-facing status. Mirrors effective_challenge_state's
 * possible outputs (draft/scheduled/live/paused/ending_soon/ended/archived)
 * -- the server already computed this (see GET /api/v1/arena/challenges),
 * this only maps it to a badge tone/label.
 */
export function challengeStatusMeta(challenge) {
  const state = (challenge && challenge.effectiveState) || 'draft';
  const meta = {
    draft: { tone: 'muted', key: 'arena.status.draft', fallback: 'Draft' },
    scheduled: { tone: 'info', key: 'arena.status.scheduled', fallback: 'Upcoming' },
    live: { tone: 'live', key: 'arena.status.live', fallback: 'Live' },
    ending_soon: { tone: 'warn', key: 'arena.status.endingSoon', fallback: 'Ending Soon' },
    paused: { tone: 'muted', key: 'arena.status.paused', fallback: 'Paused' },
    ended: { tone: 'ended', key: 'arena.status.ended', fallback: 'Completed' },
    archived: { tone: 'muted', key: 'arena.status.archived', fallback: 'Archived' },
  };
  return meta[state] || meta.draft;
}

/** The viewer's own participation status for a card badge, when joined. */
export function participationMeta(mySubmission) {
  if (!mySubmission) return null;
  const status = mySubmission.overallStatus || 'joined';
  const meta = {
    joined: { key: 'arena.mystatus.joined', fallback: 'Joined' },
    in_progress: { key: 'arena.mystatus.inProgress', fallback: 'In Progress' },
    verification_pending: { key: 'arena.mystatus.verificationPending', fallback: 'Verification Pending' },
    completed: { key: 'arena.mystatus.completed', fallback: 'Completed' },
    won: { key: 'arena.mystatus.won', fallback: 'Won' },
    rejected: { key: 'arena.mystatus.rejected', fallback: 'Rejected' },
  };
  return meta[status] || meta.joined;
}

export function difficultyMeta(difficulty) {
  const meta = {
    easy: { key: 'arena.difficulty.easy', fallback: 'Easy' },
    medium: { key: 'arena.difficulty.medium', fallback: 'Medium' },
    hard: { key: 'arena.difficulty.hard', fallback: 'Hard' },
    elite: { key: 'arena.difficulty.elite', fallback: 'Elite' },
    legendary: { key: 'arena.difficulty.legendary', fallback: 'Legendary' },
  };
  return meta[difficulty] || { key: 'arena.difficulty.medium', fallback: 'Medium' };
}

export function categoryMeta(category) {
  const meta = {
    residential: { key: 'arena.category.residential', fallback: 'Residential' },
    commercial: { key: 'arena.category.commercial', fallback: 'Commercial' },
    land: { key: 'arena.category.land', fallback: 'Land' },
    projects: { key: 'arena.category.projects', fallback: 'Projects' },
    city: { key: 'arena.category.city', fallback: 'City Challenge' },
    special: { key: 'arena.category.special', fallback: 'Special' },
    partner: { key: 'arena.category.partner', fallback: 'Partner' },
  };
  return meta[category] || { key: 'arena.category.residential', fallback: 'Residential' };
}

export function stepStatusIcon(status) {
  if (status === 'completed' || status === 'skipped') return 'check';
  if (status === 'locked') return 'lock';
  return 'dot'; // available / in_progress / verification_pending -- the "current" marker
}

/** Total possible points for a challenge card -- sum of every step's
 *  points plus the completion bonus. Purely additive display math, not a
 *  scoring decision. */
export function totalChallengePoints(challenge) {
  const steps = (challenge && challenge.steps) || [];
  const stepTotal = steps.reduce((sum, s) => sum + (Number(s && s.points) || 0), 0);
  const bonus = Number(challenge && challenge.completionReward && challenge.completionReward.points) || 0;
  return stepTotal + bonus;
}

/** Fraction of joined participants who have completed the challenge, 0-100. */
export function completionRatePct(challenge) {
  const participants = Number(challenge && challenge.participantCount) || 0;
  const completed = Number(challenge && challenge.completedCount) || 0;
  if (participants <= 0) return 0;
  return Math.round((completed / participants) * 100);
}

/** Human "3d left" / "Ended" countdown string from an ISO/millis endDate. */
export function timeRemainingLabel(challenge, tr, now = Date.now()) {
  const t = typeof tr === 'function' ? tr : (_k, f) => f;
  const endMs = toMillis(challenge && challenge.endDate);
  if (endMs === null) return t('arena.time.ongoing', 'Ongoing');
  const diff = endMs - now;
  if (diff <= 0) return t('arena.time.ended', 'Ended');
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days >= 1) return t('arena.time.daysLeft', '{n}d left').replace('{n}', String(days));
  if (hours >= 1) return t('arena.time.hoursLeft', '{n}h left').replace('{n}', String(hours));
  return t('arena.time.lessThanHour', '<1h left');
}

/** Day X / durationDays, for the 90-day phase model. Null when the
 *  challenge has no configured duration/start. */
export function dayProgress(challenge, now = Date.now()) {
  const duration = Number(challenge && challenge.durationDays);
  const startMs = toMillis(challenge && challenge.startDate);
  if (!Number.isFinite(duration) || duration <= 0 || startMs === null) return null;
  const dayIndex = Math.min(duration, Math.max(0, Math.floor((now - startMs) / 86400000) + 1));
  return { day: dayIndex, of: duration };
}

export function toMillis(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Formats a whole number with locale-appropriate thousands separators,
 *  used for XP/points/currency-free counts (never a currency symbol --
 *  callers add that explicitly where genuinely a dollar figure). */
export function formatNumber(n) {
  const v = Number(n) || 0;
  try { return v.toLocaleString(); } catch (_) { return String(v); }
}

export function formatCurrency(n) {
  const v = Number(n) || 0;
  try {
    return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  } catch (_) {
    return '$' + Math.round(v).toLocaleString();
  }
}

/** The current step: the first one whose status is NOT completed/skipped,
 *  in declared order. Used to focus the mission-path UI on exactly one
 *  step, matching the brief's "never overwhelm the user with everything
 *  at once." */
export function currentStepKey(challenge, submission) {
  const steps = (challenge && challenge.steps) || [];
  const progress = (submission && submission.stepProgress) || {};
  for (const step of steps) {
    const status = (progress[step.key] || {}).status || 'locked';
    if (status !== 'completed' && status !== 'skipped') return step.key;
  }
  return steps.length ? steps[steps.length - 1].key : null;
}

export function stepProgressCounts(challenge, submission) {
  const steps = (challenge && challenge.steps) || [];
  const progress = (submission && submission.stepProgress) || {};
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => {
    const status = (progress[s.key] || {}).status;
    return status === 'completed' || status === 'skipped';
  });
  return { done: done.length, total: required.length };
}
