// Darwesh Group -- the ONE capability map for professional roles.
//
// Two INDEPENDENT axes, deliberately not collapsed into a single "is a
// professional" flag:
//
//   profileMedia  may this role have an avatar + cover image and a premium
//                 public profile?  -- true for every role.
//   posts         may this role publish a visual portfolio
//                 (professionalPosts)?  -- false for lawyer, by decision.
//
// A lawyer has the first and not the second: legal work is not a photo
// gallery. One flag could not express that; two can. Educational/legal
// articles may arrive later as their own text-shaped content type -- that
// is not this map's `posts`, which specifically means the image-led
// project gallery.
//
// NOT IN THIS MAP, and deliberately so:
//   office             companies/{id}. Has a profile, listings and estate
//                      content already. Office news/projects, if ever
//                      wanted, is a dedicated feature -- never this feed.
//                      (Preserves docs/PROFESSIONAL_CONTENT_ARCHITECTURE.md
//                      §9 rather than reversing it.)
//   real_estate_agent  users/{uid}.role. An agent's portfolio IS their
//                      listings; a second content identity for the same
//                      person is exactly the duplication §9 warns about.
//
// ---------------------------------------------------------------------
// MIRRORED IN firestore.rules. Rules cannot import JavaScript, so the role
// list below is duplicated in that file's serviceProviders serviceType
// enum. tests/firestore/phase3a_profile_media.test.mjs asserts the two
// match, so a drift fails CI instead of silently opening or closing a role.
// If you add a role here, add it there in the same commit.
// ---------------------------------------------------------------------
//
// PHASE 3A SCOPE NOTE: `posts` is descriptive of the approved design, NOT
// of what firestore.rules currently permits. professionalPosts is still
// gated to profileType == 'designer' and this phase does not touch it.
// Every other role's `posts: true` becomes real only in the phase that
// follows the server-side rate limiter -- see the approved Phase 3C.
// Nothing reads this field yet; it exists so the map is complete and the
// drift guard has something stable to check.

export const PROFESSIONAL_ROLES = {
  designer:    { profileMedia: true, posts: true,  beforeAfter: true,  page: 'designer.html' },
  engineer:    { profileMedia: true, posts: true,  beforeAfter: false, page: 'engineer.html' },
  lawyer:      { profileMedia: true, posts: false, beforeAfter: false, page: 'lawyer.html' },
  landscaping: { profileMedia: true, posts: true,  beforeAfter: true,  page: 'landscaping.html' },
  cleaning:    { profileMedia: true, posts: true,  beforeAfter: true,  page: 'cleaning.html' },
  maintenance: { profileMedia: true, posts: true,  beforeAfter: true,  page: 'maintenance.html' },
};

/** Every supported serviceType. Must equal firestore.rules' create-time enum. */
export const PROFESSIONAL_SERVICE_TYPES = Object.keys(PROFESSIONAL_ROLES);

/** Roles whose profiles may carry an avatar and cover image. */
export function allowsProfileMedia(serviceType) {
  return !!(PROFESSIONAL_ROLES[serviceType] && PROFESSIONAL_ROLES[serviceType].profileMedia);
}

/**
 * Roles that may publish a visual portfolio, per the approved design.
 * NOTE: this is the design intent, not today's enforcement -- see the
 * PHASE 3A SCOPE NOTE above. Never treat a true here as "the rules allow
 * it"; firestore.rules is the only authority on that.
 */
export function allowsPosts(serviceType) {
  return !!(PROFESSIONAL_ROLES[serviceType] && PROFESSIONAL_ROLES[serviceType].posts);
}

/** Roles where a before/after pair is a meaningful way to show the work. */
export function allowsBeforeAfter(serviceType) {
  return !!(PROFESSIONAL_ROLES[serviceType] && PROFESSIONAL_ROLES[serviceType].beforeAfter);
}

/** The {kind} path segments storage.rules accepts today. Mirrored there. */
export const PROFILE_MEDIA_KINDS = ['photo', 'cover'];

/** Storage path for a provider's profile media. Never built from user input. */
export function profileMediaPath(providerId, kind, fileName) {
  if (!PROFILE_MEDIA_KINDS.includes(kind)) throw new Error(`unsupported media kind: ${kind}`);
  return `professional-media/${providerId}/${kind}/${fileName}`;
}
