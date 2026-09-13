// Darwesh Group -- ONE place that answers "where does this signed-in account
// manage its own things?" (launch-readiness audit, fix B3).
//
// Before this module, three surfaces each answered that question with their
// own partial table: js/nav-auth.js knew the professional roles, login.html
// and account.html knew only `role === 'agent'`, and signup-professional.html
// knew its success link. None of them knew about real-estate offices or
// organizations at all -- so an office owner, an office employee, a
// developer or a residential community always landed on the generic
// customer page (account.html), with no link anywhere on the site to
// office.html or org-projects.html. The pages existed and worked; they were
// simply unreachable after the signup success screen.
//
// Every decision here is derived from data the caller already holds (the
// users/{uid} document) and from js/professional-roles.js -- nothing is
// invented, and nothing here is an authorization decision: each destination
// page still resolves ownership/membership itself against firestore.rules
// and the backend. A wrong destination is a navigation inconvenience, never
// an access grant.
import { PROFESSIONAL_ROLES } from './professional-roles.js';

// accountType -> profile page, built from the one capability map. Cleaning
// is the only role with two accountTypes (an individual and a team/company
// owner both land on cleaning.html), so that alias is declared here rather
// than distorting the role map with a second entry for the same serviceType.
const PROFESSIONAL_DESTINATIONS = Object.fromEntries(
  Object.values(PROFESSIONAL_ROLES).map((r) => [r.accountType, r.page])
);
PROFESSIONAL_DESTINATIONS.cleaning_team_or_company_owner = PROFESSIONAL_ROLES.cleaning.page;

// Real-estate offices live on the `companies` collection and are managed on
// office.html (which resolves "my office" through the backend's
// /me/companies, for owners, active employees and pending/invited joiners
// alike -- see office.html's own loader).
export const OFFICE_ACCOUNT_TYPES = ['office_owner', 'office_employee'];

// Organizations whose management surface is the project/unit authoring page
// (org-projects.html only accepts organizations of these two types --
// ORG_TYPES in js/org-projects.js).
export const PROJECT_ORG_ACCOUNT_TYPES = ['org_owner_developer', 'org_owner_residential_community'];

// U3 (launch-readiness): organization.html is these two account types'
// whole management surface (profile + type-specific business details --
// financing terms or the products catalog). It used to not exist, so
// this list was routed nowhere (account.html said so honestly rather than
// link to a page that did not exist) -- now it does, kept as a distinct
// list from PROJECT_ORG_ACCOUNT_TYPES because a developer/community's
// primary daily surface stays org-projects.html (project/unit authoring);
// they reach organization.html for the profile itself via a link on that
// page instead of as their post-login destination.
export const OTHER_ORG_ACCOUNT_TYPES = ['org_owner_finance_provider', 'org_owner_furniture_store'];

/**
 * The page a signed-in account should be sent to after login, and the page
 * the header "Profile" chip points at. `profile` is the users/{uid} document
 * data (or null/undefined when it does not exist yet).
 */
export function resolveProfileDestination(profile) {
  const p = profile || {};
  // `role` is the real, admin-assigned authorization field (firestore.rules
  // myRole()); accountType is only a self-declared routing hint. Role wins.
  if (p.role === 'admin') return 'admin.html';
  if (p.role === 'agent') return 'agent-dashboard.html';
  const pro = PROFESSIONAL_DESTINATIONS[p.accountType];
  if (pro) return pro;
  if (OFFICE_ACCOUNT_TYPES.includes(p.accountType)) return 'office.html';
  if (PROJECT_ORG_ACCOUNT_TYPES.includes(p.accountType)) return 'org-projects.html';
  if (OTHER_ORG_ACCOUNT_TYPES.includes(p.accountType)) return 'organization.html';
  return 'account.html';
}

/**
 * What account.html should say about this account's management surface, or
 * null when the generic customer page IS the whole story (customers,
 * agents -- who are redirected before this is consulted -- and professionals,
 * whose profile page is already the header destination).
 *
 * Returns { kind, href, icon }.
 */
export function describeManagementSurface(profile) {
  const p = profile || {};
  if (OFFICE_ACCOUNT_TYPES.includes(p.accountType)) {
    return { kind: 'office', href: 'office.html', icon: 'apartment' };
  }
  if (PROJECT_ORG_ACCOUNT_TYPES.includes(p.accountType)) {
    return { kind: 'orgProjects', href: 'org-projects.html', icon: 'domain' };
  }
  if (OTHER_ORG_ACCOUNT_TYPES.includes(p.accountType)) {
    return {
      kind: 'orgGeneric',
      href: 'organization.html',
      icon: p.accountType === 'org_owner_finance_provider' ? 'account_balance' : 'chair'
    };
  }
  return null;
}
