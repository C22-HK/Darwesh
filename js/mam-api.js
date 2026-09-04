// Thin client for the single MAM V2 endpoint (backend/app/mam/routes.py,
// POST /api/v1/mam/chat). Mirrors js/backend-api.js's error-handling
// contract (BackendUnavailableError / BackendResponseError) so
// every MAM surface can reuse the same catch-by-type pattern every other
// backend-calling page already uses -- but this module is deliberately
// its own file, not an addition to backend-api.js, because MAM's
// auth is OPTIONAL (a signed-out visitor is a valid, first-class MAM
// caller -- see routes.py's module docstring) where every function in
// backend-api.js either requires no auth or always requires it.
import { BACKEND_BASE_URL } from './backend-config.js';
import { BackendUnavailableError, BackendResponseError } from './backend-api.js';

// Bounds how long a single turn waits before giving up and surfacing a
// timeout state to the caller, distinct from a user-initiated abort
// (see the `signal` bridging below) -- a hung request must never leave
// the UI stuck in "MAM is thinking" forever.
const REQUEST_TIMEOUT_MS = 20000;

/**
 * @param {{message: string, language: string, sessionId: string, pageContext: object}} turn
 * @param {{user?: object, signal?: AbortSignal}} [opts] `user` is a
 *   Firebase Auth user object (or falsy for an anonymous caller --
 *   MAM proceeds as the public caller, never blocked on sign-in).
 *   `signal` lets the caller cancel a stale in-flight request (e.g. a
 *   newer message was sent) without this module knowing anything about
 *   why.
 */
export async function sendMamChat({ message, language, sessionId, pageContext }, { user, signal } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (user) {
    try {
      headers.Authorization = `Bearer ${await user.getIdToken()}`;
    } catch {
      // Token retrieval failed -- proceed as an anonymous caller rather
      // than failing the whole turn; the backend already treats a
      // missing/invalid token as the public caller (routes.py).
    }
  }

  let response;
  try {
    response = await fetch(BACKEND_BASE_URL + '/api/v1/mam/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, language, sessionId, pageContext }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // AbortError (either the caller's own signal or our timeout) must
    // reach the caller as-is so it can tell "cancelled" apart from
    // "network failure" -- collapsing both into BackendUnavailableError
    // would make a stale-request abort look like a real outage.
    if (err && err.name === 'AbortError') throw err;
    throw new BackendUnavailableError();
  }
  clearTimeout(timeoutId);

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

export { BackendUnavailableError, BackendResponseError };
