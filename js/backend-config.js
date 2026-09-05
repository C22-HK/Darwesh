// Public backend API base URL. Nothing here is secret -- this file
// ships to every browser -- so it only ever holds a URL, never a
// credential. Detected from hostname since this is a static site with
// no build step and no environment variables at build time.
//
// The one thing this file exists to prevent: hardcoding localhost into
// what ships to real visitors. Every page that needs to call the
// backend imports BACKEND_BASE_URL from here instead of writing its
// own URL, so there is exactly one place to update if the deployed
// backend's origin ever changes (see backend/README.md "Deployment").
//
// The value below IS the real, currently-deployed Cloud Run backend --
// this comment previously (incorrectly) said "not deployed yet" long
// after that stopped being true; if a call against it fails, that is a
// real deployment-configuration question (CORS allowlist, Firebase
// credentials, IAM), not evidence the backend doesn't exist. The UI
// already handles a failed call as "couldn't reach the server" rather
// than crashing either way.
const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

const PRODUCTION_BACKEND_BASE_URL = 'https://darwesh-backend-353477435585.me-central1.run.app';
const DEV_BACKEND_BASE_URL = 'http://localhost:8080';

export const BACKEND_BASE_URL = DEV_HOSTS.has(window.location.hostname)
  ? DEV_BACKEND_BASE_URL
  : PRODUCTION_BACKEND_BASE_URL;
