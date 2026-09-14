// QA FIXTURE -- fake replacement for the gstatic firebase-app-check.js
// module. TEST-ONLY; see fake-firebase-init.js's header comment.
export class ReCaptchaEnterpriseProvider {
  constructor() {}
}
export function initializeAppCheck() { return { __qaAppCheck: true }; }
export function getToken() { return Promise.resolve({ token: 'qa-fixture-app-check-token' }); }
