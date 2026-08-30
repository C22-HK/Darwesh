# Profile Architecture Phase 2: the trusted backend layer for accountType-
# aware signup, organization ownership/membership, and the permission/
# access-control system whose Firestore collections (organizations,
# serviceProviders, products, permissionDefinitions, rolePermissionDefaults,
# accessAuditLog, users.permissionOverrides) were introduced -- rules-only,
# additive, already published to production -- in Phase 1. Every write in
# this package goes through the Firebase Admin SDK (bypasses firestore.rules
# the same way app.otp.firebase_admin_ops already does), which is *why*
# firestore.rules denies these same writes to every client SDK caller,
# including an authenticated admin session: this package is the only
# trusted path in.
