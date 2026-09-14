// QA FIXTURE -- fake replacement for the gstatic firebase-app.js module.
// TEST-ONLY; see fake-firebase-init.js's header comment for context.
const QA_APP = { name: '[QA-FIXTURE]', options: {} };
export function initializeApp() { return QA_APP; }
export function deleteApp() { return Promise.resolve(); }
export function getApps() { return [QA_APP]; }
export function getApp() { return QA_APP; }
