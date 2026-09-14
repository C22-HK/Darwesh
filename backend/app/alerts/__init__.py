"""Property Watch / Area Alerts -- server-authoritative demand matching.

A user saves a search area (a circle radius, or a city/neighborhood pick)
plus property filters as an `areaAlerts` document. Neither that document
nor its matches nor a user's notifications are ever client-writable (see
firestore.rules) -- app.alerts.alerts_ops is the only place those
collections change, same server-authoritative posture as app.arena and
app.verification.

The one new mechanism this package adds: there is no Cloud Functions/
trigger infrastructure anywhere in this codebase, so "a new listing was
published" has no existing server-side signal to hook into. Both existing
listing-creation call sites (the admin submission-to-listing conversion,
and agent-dashboard.html's direct write) call POST
/api/v1/alerts/notify-listing right after their write succeeds. That
request carries nothing but a listing id -- AlertsOps.notify_new_listing
re-fetches the real document itself and re-derives every fact it matches
on, so the actual notify decision never trusts anything the client
asserted.
"""
