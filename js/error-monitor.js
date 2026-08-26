// Client-side error monitoring (Sentry). This site has no server, so this
// is the only place JS errors are ever visible -- without it, a bug that
// breaks a page in production is invisible unless someone reports it.
//
// SENTRY_DSN is intentionally empty until a real Sentry project exists.
// With no DSN, this module does nothing at all -- it's safe to ship
// before Sentry is set up, and starts working the moment a real DSN is
// filled in below. Get a free DSN at https://sentry.io (no card required
// for the free tier) -- create a project, choose "Browser JavaScript",
// and copy the DSN it gives you.
const SENTRY_DSN = '';

if (SENTRY_DSN) {
  const script = document.createElement('script');
  script.src = 'https://browser.sentry-cdn.com/8.9.2/bundle.min.js';
  script.crossOrigin = 'anonymous';
  script.onload = () => {
    window.Sentry.init({
      dsn: SENTRY_DSN,
      environment: location.hostname === 'localhost' ? 'development' : 'production',
      // Errors, not performance tracing or session replay -- keeps this
      // firmly inside the free tier and avoids recording user sessions.
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0
    });
  };
  document.head.appendChild(script);
}
