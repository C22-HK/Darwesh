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
    titleKey: 'svc.engineer.title', title: 'Engineering',
    taglineKey: 'svc.engineer.tagline', tagline: 'Structural, civil, and MEP engineering from verified professionals.',
    profileHref: 'engineer.html',
    directoryHref: 'service.html?type=engineer',
    ctaKey: 'svc.cta.browseProviders', ctaFallback: 'Browse Engineers'
  },
  {
    key: 'designer',
    serviceType: 'designer',
    icon: 'palette',
    fallbackIcon: 'palette',
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
    titleKey: 'svc.lawyer.title', title: 'Legal',
    taglineKey: 'svc.lawyer.tagline', tagline: 'Real estate and property legal services from verified professionals.',
    profileHref: 'lawyer.html',
    directoryHref: 'service.html?type=lawyer',
    ctaKey: 'svc.cta.browseProviders', ctaFallback: 'Browse Lawyers'
  },
  {
    key: 'landscaping',
    serviceType: 'landscaping',
    icon: 'yard',
    fallbackIcon: 'yard',
    titleKey: 'svc.landscaping.title', title: 'Landscaping',
    taglineKey: 'svc.landscaping.tagline', tagline: 'Garden, yard, and outdoor space design from verified professionals.',
    profileHref: 'landscaping.html',
    directoryHref: 'service.html?type=landscaping',
    ctaKey: 'svc.cta.browseProviders', ctaFallback: 'Browse Landscapers'
  },
  {
    key: 'cleaning',
    serviceType: 'cleaning',
    icon: 'cleaning_services',
    fallbackIcon: 'cleaning_services',
    titleKey: 'svc.cleaning.title', title: 'Cleaning',
    taglineKey: 'svc.cleaning.tagline', tagline: 'Home, office, and move-in/move-out cleaning from individuals, teams, and companies.',
    profileHref: 'cleaning.html',
    directoryHref: 'service.html?type=cleaning',
    ctaKey: 'svc.cta.browseProviders', ctaFallback: 'Browse Cleaning Providers'
  }
];

export function getService(key) {
  return SERVICE_CATALOG.find((s) => s.key === key) || null;
}
