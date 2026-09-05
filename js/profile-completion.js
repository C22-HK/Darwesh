// Darwesh Group -- owner-only profile completion for serviceProviders.
//
// WHAT THIS IS NOT: an invented score. Every step below names a field that
// actually exists in the serviceProviders schema (see firestore.rules'
// create-time key allowlist) and is checked against the real document. A
// step is "done" only if the stored value is genuinely usable -- a bio of
// three spaces does not count, and neither does an empty specialties array.
// Nothing here writes anything; it reads the same document the profile has
// already loaded, so it costs zero extra Firestore reads.
//
// CAPABILITY-DRIVEN, per js/professional-roles.js. The steps a role is
// asked to complete are the ones that role can actually act on:
//   - a lawyer is never asked for a project portfolio, because
//     allowsPortfolio('lawyer') is false and there is no UI for them to
//     add one. Asking would be a dead end, not guidance.
//   - a cleaning provider IS asked for servicesOffered, because that
//     field is real for them (firestore.rules validates its enum) and
//     drives how they appear in discovery.
//
// OWNER-ONLY, ALWAYS. The percentage and the missing-step list are
// guidance for the person filling the profile in; they are not a public
// quality signal and must never be rendered to a visitor. renderCompletion
// takes an explicit isOwnerView and returns without touching the DOM when
// it is false -- the caller cannot forget, because the guard lives here.
import { allowsPortfolio } from './professional-roles.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

/** A string field counts only when it holds real, non-whitespace content. */
function hasText(value, min = 1) {
  return typeof value === 'string' && value.trim().length >= min;
}
/** An array field counts only when it actually has entries. */
function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

/**
 * The completion steps for a provider, in the order they are worth doing.
 * Every `done` reads a real field off `data`.
 *
 * @param {object} data serviceProviders/{id} document data
 * @param {string} serviceType role key from PROFESSIONAL_ROLES
 * @param {{hasPortfolioItems?: boolean, hasContactSaved?: boolean}} extra
 *   Facts the profile page already knows that do not live on the provider
 *   document itself -- passed in rather than re-queried here, so this
 *   module stays read-only and free of Firestore access.
 * @returns {{key: string, label: string, done: boolean}[]}
 */
export function completionSteps(data, serviceType, extra = {}) {
  const d = data || {};
  const steps = [
    {
      key: 'photo',
      label: tr('rp.completePhoto', 'Add a profile photo'),
      done: hasText(d.photoOrLogoUrl),
    },
    {
      key: 'cover',
      label: tr('rp.completeCover', 'Add a cover image'),
      done: hasText(d.coverImageUrl),
    },
    {
      // 40 characters is roughly one real sentence -- enough to tell a
      // visitor something, and low enough that a genuine short bio is not
      // nagged at forever.
      key: 'bio',
      label: tr('rp.completeBio', 'Write a short professional bio'),
      done: hasText(d.description, 40),
    },
    {
      key: 'city',
      label: tr('rp.completeCity', 'Set your city or service area'),
      done: hasText(d.city) || hasItems(d.serviceAreas),
    },
    {
      key: 'specialties',
      label: tr('rp.completeSpecialties', 'List your specialties'),
      done: hasItems(d.specialties),
    },
    {
      // experienceYears is a number in the schema; 0 is a legitimate
      // stored value but not evidence the owner filled anything in, so
      // this asks for a positive figure rather than "is the key present".
      key: 'experience',
      label: tr('rp.completeExperience', 'Add your years of experience'),
      done: typeof d.experienceYears === 'number' && d.experienceYears > 0,
    },
    {
      // Choosing a visibility is the step -- NOT choosing 'public'. A
      // provider who deliberately keeps contact details on-request has
      // completed this properly, and must never be pushed toward
      // publishing a phone number to reach 100%.
      key: 'contact',
      label: tr('rp.completeContact', 'Set your contact details and visibility'),
      done: !!extra.hasContactSaved || hasText(d.contactVisibility),
    },
  ];

  // Cleaning providers have a real, rules-validated services enum; for
  // every other role the equivalent information already lives in
  // specialties, so asking twice would be noise.
  if (serviceType === 'cleaning') {
    steps.push({
      key: 'services',
      label: tr('rp.completeServices', 'Choose the services you offer'),
      done: hasItems(d.servicesOffered),
    });
  }

  // Only roles that CAN show a gallery are asked for one. A lawyer never
  // sees this step, because there is no lawyer portfolio UI to send them
  // to -- see js/professional-roles.js.
  if (allowsPortfolio(serviceType)) {
    steps.push({
      key: 'portfolio',
      label: tr('rp.completePortfolio', 'Add a project to your portfolio'),
      done: !!extra.hasPortfolioItems || hasItems(d.portfolio),
    });
  }

  return steps;
}

/**
 * @returns {{percent: number, steps: object[], missing: object[], complete: boolean}}
 *   `percent` is a real ratio of done steps to applicable steps, rounded
 *   to a whole number -- never a decorative figure.
 */
export function computeCompletion(data, serviceType, extra = {}) {
  const steps = completionSteps(data, serviceType, extra);
  const done = steps.filter((s) => s.done).length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 100;
  return { percent, steps, missing: steps.filter((s) => !s.done), complete: done === steps.length };
}

/**
 * Renders the owner-only completion card into `container`.
 *
 * Returns without rendering anything at all when this is not the owner's
 * own view -- the visibility rule is enforced here rather than trusted to
 * every call site. `container` is emptied first, so re-rendering after a
 * save never stacks duplicate cards.
 */
export function renderCompletion(container, { data, serviceType, isOwnerView, extra = {}, onStepClick } = {}) {
  if (!container) return null;
  if (!isOwnerView) { container.innerHTML = ''; container.hidden = true; return null; }

  const result = computeCompletion(data, serviceType, extra);
  container.innerHTML = '';
  container.hidden = false;

  const card = document.createElement('section');
  card.className = 'pc-card';
  card.setAttribute('aria-label', tr('rp.completionTitle', 'Profile completion'));

  const head = document.createElement('div');
  head.className = 'pc-head';
  const title = document.createElement('p');
  title.className = 'pc-title';
  title.textContent = result.complete
    ? tr('rp.completionDoneTitle', 'Your profile is complete')
    : tr('rp.completionTitle', 'Profile completion');
  const pct = document.createElement('p');
  pct.className = 'pc-percent';
  pct.textContent = `${result.percent}%`;
  head.append(title, pct);

  // The bar is a real progress element, so assistive tech reads the same
  // number sighted users see rather than a styled div with no semantics.
  const bar = document.createElement('div');
  bar.className = 'pc-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(result.percent));
  bar.setAttribute('aria-valuetext', `${result.percent}%`);
  const fill = document.createElement('div');
  fill.className = 'pc-fill';
  fill.style.width = `${result.percent}%`;
  bar.appendChild(fill);

  card.append(head, bar);

  if (result.complete) {
    const done = document.createElement('p');
    done.className = 'pc-hint';
    done.textContent = tr('rp.completionDoneHint', 'Everything we recommend is filled in. You can still edit any of it at any time.');
    card.appendChild(done);
  } else {
    const hint = document.createElement('p');
    hint.className = 'pc-hint';
    hint.textContent = tr('rp.completionHint', 'A fuller profile helps clients choose you. Still to add:');
    card.appendChild(hint);

    const list = document.createElement('ul');
    list.className = 'pc-list';
    // Capped so the card stays a short, actionable nudge rather than a
    // wall of everything not yet done; the percentage already conveys the
    // overall picture.
    result.missing.slice(0, 4).forEach((step) => {
      const li = document.createElement('li');
      li.className = 'pc-item';
      if (onStepClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pc-step-btn';
        btn.textContent = step.label;
        btn.addEventListener('click', () => onStepClick(step));
        li.appendChild(btn);
      } else {
        li.textContent = step.label;
      }
      list.appendChild(li);
    });
    card.appendChild(list);
  }

  container.appendChild(card);
  return result;
}
