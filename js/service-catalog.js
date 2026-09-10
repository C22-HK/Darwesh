// Darwesh Group -- Service Universe catalog. The SINGLE source of truth
// for which service domains the Service Universe (services.html) and the
// reusable provider directory (service.html) both render.
//
// AUDITED before this list was written (see BUG_HUNT_QA_REPORT.md's
// sibling report for this phase for the full writeup). Only service
// domains with REAL backing data are listed here:
//
//   - firestore.rules' serviceProviders create rule allowlists exactly
//     five serviceType values: engineer, designer, lawyer, landscaping,
//     cleaning (firestore.rules:945). Nothing else exists as a document
//     shape a real signed-up professional can actually create.
//   - signup-professional.html offers real signup flows for all five
//     (professional_engineer, professional_designer, professional_lawyer,
//     professional_landscaping, cleaning_individual/
//     cleaning_team_or_company_owner).
//   - serviceProviders/{id} has `allow read: if true` -- public,
//     real-time, queryable data, not a placeholder.
//
// Maintenance/repair, moving/transport, finance/installments, and
// furniture/home-goods (candidate domains from the Service Universe spec)
// have NO matching serviceType, NO signup path, and NO Firestore
// collection at all -- not even schema-only. Per this phase's explicit
// instruction ("Do NOT invent providers just to populate planets"),
// they are deliberately NOT in this catalog and therefore never become
// planets. See the final report's audit section for the full A/B/C/D
// classification.
export const SERVICE_CATALOG = [
  {
    key: 'engineer',
    serviceType: 'engineer',
    icon: 'architecture',
    fallbackIcon: 'architecture',
    photo: 'images/services/engineering.jpg',
    titleKey: 'svc.engineer.title', title: 'Engineering',
    taglineKey: 'svc.engineer.tagline', tagline: 'Structural, civil, and MEP engineering from verified professionals.',
    profileHref: 'engineer.html',
    directoryHref: 'service.html?type=engineer',
    ctaKey: 'svc.cta.browseEngineers', ctaFallback: 'Browse Engineers'
  },
  {
    key: 'designer',
    serviceType: 'designer',
    icon: 'palette',
    fallbackIcon: 'palette',
    photo: 'images/services/interior-design.jpg',
    titleKey: 'svc.designer.title', title: 'Interior & Architectural Design',
    taglineKey: 'svc.designer.tagline', tagline: 'Interior and architectural design work, published by real Darwesh designers.',
    profileHref: 'designer.html',
    // Design already has a richer, purpose-built discovery experience
    // (published-work grid with category filters) -- reused as-is per
    // this phase's instruction to prefer existing architecture over a
    // duplicate directory.
    directoryHref: 'design.html',
    ctaKey: 'svc.cta.exploreWork', ctaFallback: 'Explore Design Work'
  },
  {
    key: 'lawyer',
    serviceType: 'lawyer',
    icon: 'gavel',
    fallbackIcon: 'gavel',
    photo: 'images/services/legal-services.jpg',
    titleKey: 'svc.lawyer.title', title: 'Legal',
    taglineKey: 'svc.lawyer.tagline', tagline: 'Real estate and property legal services from verified professionals.',
    profileHref: 'lawyer.html',
    directoryHref: 'service.html?type=lawyer',
    ctaKey: 'svc.cta.browseLawyers', ctaFallback: 'Browse Lawyers'
  },
  {
    key: 'landscaping',
    serviceType: 'landscaping',
    icon: 'yard',
    fallbackIcon: 'yard',
    photo: 'images/services/landscaping.jpg',
    titleKey: 'svc.landscaping.title', title: 'Landscaping',
    taglineKey: 'svc.landscaping.tagline', tagline: 'Garden, yard, and outdoor space design from verified professionals.',
    profileHref: 'landscaping.html',
    directoryHref: 'service.html?type=landscaping',
    ctaKey: 'svc.cta.browseLandscapers', ctaFallback: 'Browse Landscapers'
  },
  {
    key: 'cleaning',
    serviceType: 'cleaning',
    icon: 'cleaning_services',
    fallbackIcon: 'cleaning_services',
    photo: 'images/services/cleaning.jpg',
    titleKey: 'svc.cleaning.title', title: 'Cleaning',
    taglineKey: 'svc.cleaning.tagline', tagline: 'Home, office, and move-in/move-out cleaning from individuals, teams, and companies.',
    profileHref: 'cleaning.html',
    directoryHref: 'service.html?type=cleaning',
    ctaKey: 'svc.cta.browseCleaning', ctaFallback: 'Browse Cleaning Providers'
  },
  {
    // Maintenance was added to js/professional-roles.js in Phase 3B --
    // with a real maintenance.html profile page, a real signup path, and
    // a real `maintenance` value in firestore.rules' serviceProviders
    // serviceType enum -- but this catalog was never updated to match.
    // The role therefore existed everywhere EXCEPT the one place
    // visitors discover services from. Adding it here closes that drift;
    // the header comment above (written when only five roles existed) is
    // corrected by this entry rather than by rewriting history.
    key: 'maintenance',
    serviceType: 'maintenance',
    icon: 'handyman',
    fallbackIcon: 'handyman',
    photo: null, // no source photograph available yet -- icon treatment
    titleKey: 'svc.maintenance.title', title: 'Maintenance & Repair',
    taglineKey: 'svc.maintenance.tagline', tagline: 'Repairs, upkeep, and property maintenance from verified providers.',
    profileHref: 'maintenance.html',
    directoryHref: 'service.html?type=maintenance',
    ctaKey: 'svc.cta.browseMaintenance', ctaFallback: 'Browse Maintenance Providers'
  },
  {
    // INSTALLMENT is the one service here that is NOT a serviceProviders
    // role, and deliberately so: nobody signs up as "an installment
    // provider". What actually exists is developer PROJECTS that offer
    // instalment terms -- firestore.rules' projects/{projectId} already
    // allowlists and type-validates installmentAvailable,
    // minDownPaymentPercent, monthlyInstallmentFrom and
    // paymentPeriodMonths, and the collection is `allow read: if true`.
    //
    // So this entry has no `serviceType` and no provider profile page.
    // `countSource` below is what lets it live in the same catalog
    // without special-casing the renderer: services whose supply is a
    // provider head-count keep the default serviceProviders count, and
    // this one counts real qualifying projects instead.
    key: 'installment',
    serviceType: null,
    icon: 'payments',
    fallbackIcon: 'payments',
    photo: null, // no source photograph available yet -- icon treatment
    titleKey: 'svc.installment.title', title: 'Installments',
    taglineKey: 'svc.installment.tagline', tagline: 'Properties offered on real instalment plans, with the terms published by the developer.',
    profileHref: null,
    directoryHref: 'installments.html',
    ctaKey: 'svc.cta.browseInstallments', ctaFallback: 'Browse Installment Offers',
    countSource: { collection: 'projects', field: 'installmentAvailable', value: true },
    // The Service Universe's default zero/unknown copy describes a pool
    // of professionals ("Providers will appear here as they join"). That
    // would be a false description of this service, whose supply is
    // published developer projects -- so it carries its own wording.
    zeroCountKey: 'svc.installment.noneYet', zeroCountFallback: 'No installment offers are published yet',
    unknownCountKey: 'svc.installment.explore', unknownCountFallback: 'Explore published installment offers'
  },
  {
    // MAM AI is not a pool of professionals someone signs up to join --
    // it is Darwesh's own voice-first AI assistant, with its own
    // dedicated full-page destination (mam-ai.html). `noCount` tells
    // service-universe.js to skip the provider-count fetch entirely
    // rather than querying serviceProviders for a role that doesn't
    // exist, which would either error or (worse) silently return zero
    // and read as "no professionals have joined yet".
    key: 'mamai',
    serviceType: null,
    icon: 'scatter_plot',
    fallbackIcon: 'scatter_plot',
    titleKey: 'svc.mamai.title', title: 'MAM AI',
    taglineKey: 'svc.mamai.tagline', tagline: "Your voice-first AI assistant for finding properties, exploring services, navigating Darwesh, and completing supported tasks.",
    profileHref: null,
    directoryHref: 'mam-ai.html',
    ctaKey: 'svc.cta.openMamAi', ctaFallback: 'Open MAM AI',
    noCount: true,
    staticInfoKey: 'svc.mamai.alwaysAvailable', staticInfoFallback: 'Available any time -- open MAM AI to search, ask, and act.'
  }
];

/**
 * How to count real supply for a service. Provider services count
 * serviceProviders of their role; anything that declares its own
 * countSource (see `installment`) uses that instead. Returning a
 * descriptor rather than running the query keeps this module free of
 * Firestore imports, exactly as it was before.
 * @returns {{collection: string, field: string, value: *}}
 */
export function countSourceFor(svc) {
  return svc.countSource || { collection: 'serviceProviders', field: 'serviceType', value: svc.serviceType };
}

export function getService(key) {
  return SERVICE_CATALOG.find((s) => s.key === key) || null;
}
