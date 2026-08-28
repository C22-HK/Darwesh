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

export function sendEmailOtp(email, purpose) {
  return postJson('/api/v1/auth/email-otp/send', { email, purpose });
}

export function verifyEmailOtp(email, purpose, code) {
  return postJson('/api/v1/auth/email-otp/verify', { email, purpose, code });
}

export function completeSignup({ verifyToken, fullName, phoneNumber, password, requestedRole, companyName }) {
  return postJson('/api/v1/auth/signup/complete', {
    verifyToken,
    fullName,
    phoneNumber,
    password,
    requestedRole,
    companyName
  });
}

export function confirmPasswordReset({ resetToken, newPassword }) {
  return postJson('/api/v1/auth/password-reset/confirm', { resetToken, newPassword });
}
