// Thin fetch wrappers around the email-OTP backend endpoints
// (backend/app/otp/email_handler.py). Every page that needs signup or
// password-recovery talks to the backend only through this module, so
// there's exactly one place that knows the request/response shapes and
// exactly one place that decides what's safe to show a user when a
// call fails.
import { BACKEND_BASE_URL } from './backend-config.js';

// Couldn't reach the backend at all -- network failure, CORS
// rejection, DNS failure, or (today) simply because nothing is
// deployed at BACKEND_BASE_URL yet. Distinct from BackendResponseError
// so a page can show "couldn't reach the server" rather than a
// nonsensical validation message.
export class BackendUnavailableError extends Error {
  constructor() {
    super('backend unavailable');
    this.name = 'BackendUnavailableError';
  }
}

// The backend was reached and responded with an error. `message` is
// always the backend's own `error` field -- every error string that
// module returns is already written to be safe to show a user (see
// backend/app/otp/email_handler.py and backend/app/otp/handler.py),
// never a stack trace or raw exception detail. `status` lets a caller
// distinguish e.g. 429 (rate limited) from 400 (bad input) from 409
// (duplicate account) without string-matching the message.
export class BackendResponseError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BackendResponseError';
    this.status = status;
  }
}

// The backend's `error` strings above are written in English only --
// every page that showed err.message directly left KU/AR/TR visitors
// reading raw English for the exact validation errors (wrong/expired
// OTP, rate limits) they're most likely to hit. This is the one place
// that maps each known backend string to a translated, safe UI
// message; a message the backend hasn't sent before (wording changed,
// or a case this list doesn't cover yet) falls back to a generic
// translated error rather than raw English. Every page's
// describeBackendError() should call this for a BackendResponseError
// instead of returning err.message.
const KNOWN_BACKEND_ERRORS = [
  ['Please provide a valid request body.', 'auth.err.invalidBody'],
  ['Unsupported or missing purpose.', 'auth.err.invalidPurpose'],
  ["That email address doesn't look right.", 'auth.err.invalidEmail'],
  ["That phone number doesn't look right.", 'auth.err.invalidPhone'],
  ['Too many requests. Please wait a while and try again.', 'auth.err.tooManyRequests'],
  ['Too many requests for this email address. Please wait a while and try again.', 'auth.err.tooManyRequestsEmail'],
  ['Too many requests for this phone number. Please wait a while and try again.', 'auth.err.tooManyRequestsPhone'],
  ['A code was already sent recently. Please wait before requesting another.', 'auth.err.codeAlreadySent'],
  ['Please provide the verification code.', 'auth.err.missingCode'],
  ['Too many incorrect attempts. Please request a new code.', 'auth.err.tooManyAttempts'],
  ['That code is incorrect or has expired.', 'auth.err.codeIncorrect'],
  ['Missing or invalid verification token.', 'auth.err.invalidToken'],
  ['Please provide your full name.', 'auth.err.missingName'],
  ['Invalid requested role.', 'auth.err.invalidRole'],
  ['Please provide the company or agency you work for.', 'auth.err.missingCompany'],
  ['Invalid account type.', 'auth.err.invalidAccountType'],
  ['This verification code has expired or already been used. Please start over.', 'auth.err.codeExpired'],
  ['This reset link has expired or already been used. Please request a new code.', 'auth.err.resetLinkExpired'],
  ['Could not create your account right now. Please try again.', 'auth.err.createAccountFailed'],
  ['Could not complete your signup right now. Please try again.', 'auth.err.completeSignupFailed'],
  ['Missing or invalid reset token.', 'auth.err.invalidResetToken'],
  ['Could not reset your password right now. Please try again.', 'auth.err.resetFailed'],
];
// Messages with a number or field name interpolated by the backend
// (password/company length, "account with this X already exists") --
// matched by prefix/substring since the exact text varies.
const KNOWN_BACKEND_ERROR_PATTERNS = [
  [/^Password must be at least \d+ characters\.$/, 'auth.err.passwordTooShort'],
  [/^Company name must be at most \d+ characters\.$/, 'auth.err.companyNameTooLong'],
  [/^An account with this .+ already exists\.$/, 'auth.err.accountExists'],
];

export function localizeBackendError(err, tr, genericKey, genericFallback) {
  if (err instanceof BackendResponseError) {
    const exact = KNOWN_BACKEND_ERRORS.find(([msg]) => msg === err.message);
    if (exact) return tr(exact[1], err.message);
    const pattern = KNOWN_BACKEND_ERROR_PATTERNS.find(([re]) => re.test(err.message));
    if (pattern) return tr(pattern[1], err.message);
  }
  return tr(genericKey || 'auth.otp.errGeneric', genericFallback || 'Something went wrong. Please try again.');
}

async function postJson(path, body) {
  let response;
  try {
    response = await fetch(BACKEND_BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    // Covers "server doesn't exist yet" (current reality -- nothing is
    // deployed) exactly the same way it covers a real user's dropped
    // connection. Never rethrow err.message here -- it can contain the
    // raw request URL/host.
    throw new BackendUnavailableError();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new BackendUnavailableError();
  }

  if (!response.ok) {
    throw new BackendResponseError(response.status, (data && data.error) || 'Request failed.');
  }
  return data;
}

// ---- Authenticated backend calls (Phase 3) -------------------------------
//
// No page in this codebase attaches a Firebase ID token as an
// Authorization header today (confirmed by repo-wide grep) -- every call
// this makes to the Phase 2/2.1/2.2/3 /api/v1/access/* endpoints needs
// one, so this is that pattern's first real implementation. Deliberately
// reuses the SAME BackendResponseError/BackendUnavailableError classes
// postJson() already throws above -- every caller can catch one error
// type regardless of whether the call was authenticated.
export async function authedRequest(user, method, path, { body, query } = {}) {
  let idToken;
  try {
    idToken = await user.getIdToken();
  } catch {
    throw new BackendUnavailableError();
  }
  const url = new URL(BACKEND_BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new BackendUnavailableError();
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new BackendUnavailableError();
  }
  if (!response.ok) {
    throw new BackendResponseError(response.status, (data && data.error) || 'Request failed.');
  }
  return data;
}

export function sendEmailOtp(email, purpose) {
  return postJson('/api/v1/auth/email-otp/send', { email, purpose });
}

export function verifyEmailOtp(email, purpose, code) {
  return postJson('/api/v1/auth/email-otp/verify', { email, purpose, code });
}

export function completeSignup({ verifyToken, fullName, phoneNumber, password, requestedRole, companyName, accountType }) {
  return postJson('/api/v1/auth/signup/complete', {
    verifyToken,
    fullName,
    phoneNumber,
    password,
    requestedRole,
    companyName,
    accountType
  });
}

export function confirmPasswordReset({ resetToken, newPassword }) {
  return postJson('/api/v1/auth/password-reset/confirm', { resetToken, newPassword });
}

// ---- Phase 3: real estate office (companies) employee membership --------
//
// These need the caller's Firebase ID token, unlike everything above
// (pre-authentication OTP/signup/reset flows) -- see authedRequest()
// below, which every function past this point delegates to.
export function listMyCompanies(user) {
  return authedRequest(user, 'GET', '/api/v1/access/me/companies');
}

export function createCompany(user, { name, description, city, district, address }) {
  return authedRequest(user, 'POST', '/api/v1/access/companies', {
    body: { name, description, city, district, address }
  });
}

export function requestCompanyMembership(user, companyId) {
  return authedRequest(user, 'POST', `/api/v1/access/companies/${encodeURIComponent(companyId)}/membership-requests`, {
    body: {}
  });
}

// U1: resolves an invitee's email to {uid, displayName}. Owner/admin of
// that office only (the backend checks), and only for real agent
// accounts -- replaces the client-side users.where('email') query that
// only worked while every agent's email sat on the public users doc.
export function lookupCompanyAgent(user, companyId, email) {
  return authedRequest(user, 'POST', `/api/v1/access/companies/${encodeURIComponent(companyId)}/agents/lookup`, {
    body: { email }
  });
}

export function inviteCompanyEmployee(user, companyId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetUid)}/invite`,
    { body: {} }
  );
}

export function approveCompanyMembership(user, companyId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetUid)}/approve`,
    { body: {} }
  );
}

export function rejectCompanyMembership(user, companyId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetUid)}/reject`,
    { body: {} }
  );
}

export function removeCompanyEmployee(user, companyId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetUid)}/remove`,
    { body: {} }
  );
}

export function revokeCompanyInvitation(user, companyId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetUid)}/revoke-invitation`,
    { body: {} }
  );
}

export function acceptCompanyInvitation(user, companyId) {
  return authedRequest(user, 'POST', `/api/v1/access/companies/${encodeURIComponent(companyId)}/invitations/accept`, {
    body: {}
  });
}

export function declineCompanyInvitation(user, companyId) {
  return authedRequest(user, 'POST', `/api/v1/access/companies/${encodeURIComponent(companyId)}/invitations/decline`, {
    body: {}
  });
}

// ---- Phase 2: organizations (residential community / developer /
// finance provider / furniture store) -------------------------------------
//
// Existing endpoints (OrganizationHandler, built in an earlier phase) --
// no frontend page called any of these until the professional signup
// wizard. Only the two calls that wizard needs are wrapped here; the
// rest of OrganizationHandler's surface (membership/invite/ownership
// transfer) is unrelated to signup and stays unwrapped until a page
// actually needs it.
// Admin-only (the backend re-checks caller.is_admin; a non-admin gets 403).
// Replaces the whole permissions map for one accountType -- every key sent
// must be a KNOWN (non-protected) permission or the backend rejects the
// write outright (app.access.permission_ops.validate_permission_write).
export function setRoleDefaults(user, { accountType, permissions }) {
  return authedRequest(user, 'POST', '/api/v1/access/role-defaults', { body: { accountType, permissions } });
}

// U5 (launch-readiness): backs BOTH admin.html's central Customer
// Services inbox (every serviceProviders/{id}/requests/{id} document
// across every provider) and account.html's "My Requests" tab (a
// signed-in caller's own requests across every provider they've
// contacted) -- the backend decides which of those two a given caller
// gets from their own token, never from anything passed in here.
// firestore.rules' own read rule cannot service either shape as a
// client-side collectionGroup('requests') query (see tests/firestore/
// customer_and_admin_requests_view.test.mjs and
// PermissionOps.list_service_requests' own docstring for what was
// actually observed against the emulator), so this is the one place
// that reaches it, through the trusted Admin SDK.
export function listServiceRequests(user, status) {
  return authedRequest(user, 'GET', '/api/v1/access/service-requests', {
    query: status ? { status } : undefined
  });
}

// U3 (launch-readiness): organization.html needs to know whether the
// SIGNED-IN caller actually holds 'manage_organization_profile' for a
// specific org before showing the edit form -- an active member's own
// org-scoped grant isn't visible from a client-side read alone (their own
// member doc is readable, but not their GLOBAL accountType-level default,
// which firestore.rules' hasOrgPermission() unions in too). This is the
// one call that resolves the same union server-side, so the page's "can I
// edit?" check matches what the write rule will actually allow instead of
// guessing and letting a write attempt fail.
export function getMyPermissions(user, organizationId) {
  return authedRequest(user, 'GET', '/api/v1/access/me/permissions', {
    query: organizationId ? { organizationId } : undefined
  });
}

export function listMyOrganizations(user) {
  return authedRequest(user, 'GET', '/api/v1/access/me/organizations');
}

export function createOrganization(user, { type, name, description, city, district }) {
  return authedRequest(user, 'POST', '/api/v1/access/organizations', {
    body: { type, name, description, city, district }
  });
}

// U3 (launch-readiness): the organization.html Team tab. Organization
// membership has no email-lookup endpoint the way companies do (U1's
// lookupCompanyAgent) -- inviting a specific person therefore still
// needs their uid, which this page does not collect from a form. Only
// the actions requestMembership/approve/reject/remove -- every one
// operating on a uid the caller already has (their own, or one already
// listed in the members subcollection they can read) -- are wired here.
export function requestOrganizationMembership(user, orgId) {
  return authedRequest(user, 'POST', `/api/v1/access/organizations/${encodeURIComponent(orgId)}/membership-requests`, {
    body: {}
  });
}

export function approveOrganizationMembership(user, orgId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(targetUid)}/approve`,
    { body: {} }
  );
}

export function rejectOrganizationMembership(user, orgId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(targetUid)}/reject`,
    { body: {} }
  );
}

export function removeOrganizationMember(user, orgId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(targetUid)}/remove`,
    { body: {} }
  );
}

export function revokeOrganizationInvitation(user, orgId, targetUid) {
  return authedRequest(
    user,
    'POST',
    `/api/v1/access/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(targetUid)}/revoke-invitation`,
    { body: {} }
  );
}

export function acceptOrganizationInvitation(user, orgId) {
  return authedRequest(user, 'POST', `/api/v1/access/organizations/${encodeURIComponent(orgId)}/invitations/accept`, {
    body: {}
  });
}

export function declineOrganizationInvitation(user, orgId) {
  return authedRequest(user, 'POST', `/api/v1/access/organizations/${encodeURIComponent(orgId)}/invitations/decline`, {
    body: {}
  });
}
