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
export function listMyOrganizations(user) {
  return authedRequest(user, 'GET', '/api/v1/access/me/organizations');
}

export function createOrganization(user, { type, name, description, city, district }) {
  return authedRequest(user, 'POST', '/api/v1/access/organizations', {
    body: { type, name, description, city, district }
  });
}
