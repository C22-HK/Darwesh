// Public backend API base URL. Nothing here is secret -- this file
// ships to every browser -- so it only ever holds a URL, never a
// credential. Detected from hostname since this is a static site with
// no build step and no environment variables at build time.
//
// The one thing this file exists to prevent: hardcoding localhost into
// what ships to real visitors. Every page that needs to call the
// backend imports BACKEND_BASE_URL from here instead of writing its
// own URL, so there is exactly one place to update once the backend is
// actually deployed (see backend/README.md "Deployment" -- as of this
// change, it isn't deployed anywhere yet; every call made through
// js/backend-api.js against the production value below will fail with
// a network error until it is, which the UI already handles as
// "couldn't reach the server" rather than crashing).
const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

// TODO: replace with the real deployed backend origin once
// docs/BACKEND_MILESTONES.md milestone 2 (deployment) is done.
const PRODUCTION_BACKEND_BASE_URL = 'https://darwesh-backend-353477435585.me-central1.run.app';
const DEV_BACKEND_BASE_URL = 'http://localhost:8080';

export const BACKEND_BASE_URL = DEV_HOSTS.has(window.location.hostname)
  ? DEV_BACKEND_BASE_URL
  : PRODUCTION_BACKEND_BASE_URL;
