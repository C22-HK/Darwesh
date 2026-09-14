// Darwesh Group -- frontend mirror of backend/app/access/constants.py
// (launch-readiness audit, fix C2).
//
// WHY THIS EXISTS. firestore.rules' hasPermission()/hasOrgPermission() only
// ever resolve true for a key affirmatively granted in
// rolePermissionDefaults/{accountType} (or a per-user/per-member override),
// and that collection is writable by the backend's Admin SDK only -- never
// by any client session, admin included (see firestore.rules §2.6). The
// backend endpoint that writes it (POST /api/v1/access/role-defaults,
// app.access.handlers.PermissionAdminHandler) existed with no UI in front of
// it, so no accountType had any defaults and every org owner's first
// project/unit/private-contact write was denied. admin.html's "Role
// permission defaults" panel is that UI; this file gives it the vocabulary.
//
// DRIFT GUARD. scripts/ci-checks.js parses constants.py and fails the build
// if SELF_ACCOUNT_TYPES / KNOWN_PERMISSIONS / PROTECTED_PERMISSIONS here
// ever differ from the backend's canonical sets. Edit both together.

export const SELF_ACCOUNT_TYPES = [
  'individual_customer',
  'real_estate_agent',
  'office_owner',
  'office_employee',
  'professional_engineer',
  'professional_designer',
  'professional_lawyer',
  'professional_landscaping',
  'professional_maintenance',
  'cleaning_individual',
  'cleaning_team_or_company_owner',
  'org_owner_residential_community',
  'org_owner_developer',
  'org_owner_finance_provider',
  'org_owner_furniture_store'
];

// Never delegable through any mechanism -- the backend rejects a write that
// even names one of these, and firestore.rules refuses to resolve them.
// Listed only so the UI can guarantee it never sends one.
export const PROTECTED_PERMISSIONS = [
  'admin_access', 'manage_roles', 'manage_permissions', 'verify_profiles',
  'suspend_users', 'change_organization_owner', 'manage_platform_security',
  // Permanently closing an account is irreversible and takes a person's
  // access to their own history with it, so it is never delegable.
  'verification.account.close'
];

// Every grantable key, grouped exactly as constants.py groups them. The
// `rules` flag marks keys firestore.rules actually consults today (a key
// without it is recorded for the backend's /me/permissions read side and
// for future rules, and granting it changes nothing in Firestore yet).
//
// `labelKey`/`labelFallback` and `descKey`/`descFallback` (redesign of the
// admin.html "Role permission defaults" panel into a Permission Workspace)
// give each raw key a human-readable name and one-line explanation for the
// UI -- `key` itself is unchanged and still what's written to
// rolePermissionDefaults/{accountType}.permissions, read by
// firestore.rules, and sent to the backend. Never render `key` as the
// primary label; it may still appear as a small technical aside.
export const PERMISSION_GROUPS = [
  { key: 'listings', icon: 'home_work', labelKey: 'admin.rd.groupListings', fallback: 'Listings',
    descKey: 'admin.rd.groupListingsDesc', descFallback: 'Create and manage property listings',
    permissions: [
      { key: 'create_listing', labelKey: 'admin.rd.perm.create_listing.label', labelFallback: 'Create listing', descKey: 'admin.rd.perm.create_listing.desc', descFallback: 'Can create a new property listing' },
      { key: 'edit_own_listing', labelKey: 'admin.rd.perm.edit_own_listing.label', labelFallback: 'Edit own listing', descKey: 'admin.rd.perm.edit_own_listing.desc', descFallback: 'Can edit listings this account owns' },
      { key: 'edit_office_listing', labelKey: 'admin.rd.perm.edit_office_listing.label', labelFallback: 'Edit office listing', descKey: 'admin.rd.perm.edit_office_listing.desc', descFallback: "Can edit listings belonging to their office" },
      { key: 'delete_own_listing', labelKey: 'admin.rd.perm.delete_own_listing.label', labelFallback: 'Delete own listing', descKey: 'admin.rd.perm.delete_own_listing.desc', descFallback: 'Can permanently remove listings this account owns' },
      { key: 'publish_listing', labelKey: 'admin.rd.perm.publish_listing.label', labelFallback: 'Publish listing', descKey: 'admin.rd.perm.publish_listing.desc', descFallback: 'Can make a listing publicly visible' }
    ] },
  { key: 'office', icon: 'apartment', labelKey: 'admin.rd.groupOffice', fallback: 'Real-estate office',
    descKey: 'admin.rd.groupOfficeDesc', descFallback: 'Run an office profile, team, and customers',
    permissions: [
      { key: 'manage_office_profile', labelKey: 'admin.rd.perm.manage_office_profile.label', labelFallback: 'Manage office profile', descKey: 'admin.rd.perm.manage_office_profile.desc', descFallback: "Can edit the office's public profile" },
      { key: 'manage_office_employees', labelKey: 'admin.rd.perm.manage_office_employees.label', labelFallback: 'Manage office employees', descKey: 'admin.rd.perm.manage_office_employees.desc', descFallback: 'Can add, edit, or remove office staff' },
      { key: 'invite_employee', labelKey: 'admin.rd.perm.invite_employee.label', labelFallback: 'Invite employee', descKey: 'admin.rd.perm.invite_employee.desc', descFallback: 'Can send an invitation to join the office' },
      { key: 'approve_employee', labelKey: 'admin.rd.perm.approve_employee.label', labelFallback: 'Approve employee', descKey: 'admin.rd.perm.approve_employee.desc', descFallback: "Can approve a pending employee's join request" },
      { key: 'manage_office_customers', labelKey: 'admin.rd.perm.manage_office_customers.label', labelFallback: 'Manage office customers', descKey: 'admin.rd.perm.manage_office_customers.desc', descFallback: "Can view and manage the office's customer records" },
      { key: 'view_office_analytics', labelKey: 'admin.rd.perm.view_office_analytics.label', labelFallback: 'View office analytics', descKey: 'admin.rd.perm.view_office_analytics.desc', descFallback: "Can see the office's performance figures" }
    ] },
  { key: 'professional', icon: 'engineering', labelKey: 'admin.rd.groupProfessional', fallback: 'Professional services',
    descKey: 'admin.rd.groupProfessionalDesc', descFallback: 'Manage a professional profile and its requests',
    permissions: [
      { key: 'manage_professional_profile', labelKey: 'admin.rd.perm.manage_professional_profile.label', labelFallback: 'Manage professional profile', descKey: 'admin.rd.perm.manage_professional_profile.desc', descFallback: 'Can edit their public professional profile' },
      { key: 'manage_portfolio', labelKey: 'admin.rd.perm.manage_portfolio.label', labelFallback: 'Manage portfolio', descKey: 'admin.rd.perm.manage_portfolio.desc', descFallback: 'Can add, edit, or remove portfolio work' },
      { key: 'receive_service_requests', labelKey: 'admin.rd.perm.receive_service_requests.label', labelFallback: 'Receive service requests', descKey: 'admin.rd.perm.receive_service_requests.desc', descFallback: 'Can be contacted for a new service request' },
      { key: 'manage_service_requests', labelKey: 'admin.rd.perm.manage_service_requests.label', labelFallback: 'Manage service requests', descKey: 'admin.rd.perm.manage_service_requests.desc', descFallback: 'Can accept, decline, or update incoming requests' }
    ] },
  { key: 'cleaning', icon: 'cleaning_services', labelKey: 'admin.rd.groupCleaning', fallback: 'Cleaning',
    descKey: 'admin.rd.groupCleaningDesc', descFallback: 'Manage a cleaning profile, services, and jobs',
    permissions: [
      { key: 'manage_cleaning_profile', labelKey: 'admin.rd.perm.manage_cleaning_profile.label', labelFallback: 'Manage cleaning profile', descKey: 'admin.rd.perm.manage_cleaning_profile.desc', descFallback: 'Can edit their public cleaning-service profile' },
      { key: 'manage_cleaning_services', labelKey: 'admin.rd.perm.manage_cleaning_services.label', labelFallback: 'Manage cleaning services', descKey: 'admin.rd.perm.manage_cleaning_services.desc', descFallback: 'Can add, edit, or remove the services they offer' },
      { key: 'manage_cleaning_portfolio', labelKey: 'admin.rd.perm.manage_cleaning_portfolio.label', labelFallback: 'Manage cleaning portfolio', descKey: 'admin.rd.perm.manage_cleaning_portfolio.desc', descFallback: 'Can add, edit, or remove portfolio photos' },
      { key: 'receive_cleaning_requests', labelKey: 'admin.rd.perm.receive_cleaning_requests.label', labelFallback: 'Receive cleaning requests', descKey: 'admin.rd.perm.receive_cleaning_requests.desc', descFallback: 'Can be contacted for a new cleaning job' },
      { key: 'manage_own_cleaning_jobs', labelKey: 'admin.rd.perm.manage_own_cleaning_jobs.label', labelFallback: 'Manage own cleaning jobs', descKey: 'admin.rd.perm.manage_own_cleaning_jobs.desc', descFallback: 'Can accept, decline, or update their own jobs' }
    ] },
  { key: 'business', icon: 'storefront', labelKey: 'admin.rd.groupBusiness', fallback: 'Business / store',
    descKey: 'admin.rd.groupBusinessDesc', descFallback: 'Run a store profile and its product catalog',
    permissions: [
      { key: 'manage_business_profile', labelKey: 'admin.rd.perm.manage_business_profile.label', labelFallback: 'Manage business profile', descKey: 'admin.rd.perm.manage_business_profile.desc', descFallback: "Can edit the business's public profile" },
      { key: 'manage_store_profile', labelKey: 'admin.rd.perm.manage_store_profile.label', labelFallback: 'Manage store profile', descKey: 'admin.rd.perm.manage_store_profile.desc', descFallback: "Can edit the store's public profile" },
      { key: 'create_product', rules: true, labelKey: 'admin.rd.perm.create_product.label', labelFallback: 'Create product', descKey: 'admin.rd.perm.create_product.desc', descFallback: 'Can add a new product to the catalog' },
      { key: 'edit_own_product', rules: true, labelKey: 'admin.rd.perm.edit_own_product.label', labelFallback: 'Edit own product', descKey: 'admin.rd.perm.edit_own_product.desc', descFallback: 'Can edit products this account owns' },
      { key: 'delete_own_product', labelKey: 'admin.rd.perm.delete_own_product.label', labelFallback: 'Delete own product', descKey: 'admin.rd.perm.delete_own_product.desc', descFallback: 'Can permanently remove products this account owns' },
      { key: 'manage_product_availability', labelKey: 'admin.rd.perm.manage_product_availability.label', labelFallback: 'Manage product availability', descKey: 'admin.rd.perm.manage_product_availability.desc', descFallback: 'Can mark products in or out of stock' },
      { key: 'view_customer_inquiries', labelKey: 'admin.rd.perm.view_customer_inquiries.label', labelFallback: 'View customer inquiries', descKey: 'admin.rd.perm.view_customer_inquiries.desc', descFallback: 'Can see questions customers send about products' }
    ] },
  { key: 'organization', icon: 'domain', labelKey: 'admin.rd.groupOrganization', fallback: 'Organization',
    descKey: 'admin.rd.groupOrganizationDesc', descFallback: 'Run an organization profile and its team',
    permissions: [
      { key: 'manage_organization_profile', rules: true, labelKey: 'admin.rd.perm.manage_organization_profile.label', labelFallback: 'Manage organization profile', descKey: 'admin.rd.perm.manage_organization_profile.desc', descFallback: "Can edit the organization's public profile" },
      { key: 'manage_projects', labelKey: 'admin.rd.perm.manage_projects.label', labelFallback: 'Manage projects', descKey: 'admin.rd.perm.manage_projects.desc', descFallback: 'Can create and edit the organization\'s projects' },
      { key: 'manage_units', labelKey: 'admin.rd.perm.manage_units.label', labelFallback: 'Manage units', descKey: 'admin.rd.perm.manage_units.desc', descFallback: "Can create and edit units within a project" },
      { key: 'manage_team', labelKey: 'admin.rd.perm.manage_team.label', labelFallback: 'Manage team', descKey: 'admin.rd.perm.manage_team.desc', descFallback: "Can add, edit, or remove team members" }
    ] },
  { key: 'projects', icon: 'construction', labelKey: 'admin.rd.groupProjects', fallback: 'Projects / buildings / units',
    descKey: 'admin.rd.groupProjectsDesc', descFallback: 'Build out projects, buildings, and their units',
    permissions: [
      { key: 'create_project', rules: true, labelKey: 'admin.rd.perm.create_project.label', labelFallback: 'Create project', descKey: 'admin.rd.perm.create_project.desc', descFallback: 'Can create a new development project' },
      { key: 'edit_own_project', rules: true, labelKey: 'admin.rd.perm.edit_own_project.label', labelFallback: 'Edit own project', descKey: 'admin.rd.perm.edit_own_project.desc', descFallback: 'Can edit projects this account owns' },
      { key: 'create_building', rules: true, labelKey: 'admin.rd.perm.create_building.label', labelFallback: 'Create building', descKey: 'admin.rd.perm.create_building.desc', descFallback: 'Can add a new building to a project' },
      { key: 'edit_own_building', rules: true, labelKey: 'admin.rd.perm.edit_own_building.label', labelFallback: 'Edit own building', descKey: 'admin.rd.perm.edit_own_building.desc', descFallback: 'Can edit buildings this account owns' },
      { key: 'manage_floor_plans', rules: true, labelKey: 'admin.rd.perm.manage_floor_plans.label', labelFallback: 'Manage floor plans', descKey: 'admin.rd.perm.manage_floor_plans.desc', descFallback: 'Can add, edit, or remove floor plans' },
      { key: 'create_unit', rules: true, labelKey: 'admin.rd.perm.create_unit.label', labelFallback: 'Create unit', descKey: 'admin.rd.perm.create_unit.desc', descFallback: 'Can add a new sellable/rentable unit' },
      { key: 'edit_own_unit', rules: true, labelKey: 'admin.rd.perm.edit_own_unit.label', labelFallback: 'Edit own unit', descKey: 'admin.rd.perm.edit_own_unit.desc', descFallback: 'Can edit units this account owns' },
      { key: 'publish_unit_listing', rules: true, labelKey: 'admin.rd.perm.publish_unit_listing.label', labelFallback: 'Publish unit listing', descKey: 'admin.rd.perm.publish_unit_listing.desc', descFallback: 'Can make a unit publicly visible for sale/rent' }
    ] },
  { key: 'estates', icon: 'real_estate_agent', labelKey: 'admin.rd.groupEstates', fallback: 'Estates',
    descKey: 'admin.rd.groupEstatesDesc', descFallback: 'Create and maintain permanent Estate records',
    permissions: [
      { key: 'create_estate', rules: true, labelKey: 'admin.rd.perm.create_estate.label', labelFallback: 'Create estate', descKey: 'admin.rd.perm.create_estate.desc', descFallback: 'Can create a new permanent Estate record' },
      { key: 'edit_own_estate', rules: true, labelKey: 'admin.rd.perm.edit_own_estate.label', labelFallback: 'Edit own estate', descKey: 'admin.rd.perm.edit_own_estate.desc', descFallback: 'Can edit Estate records this account owns' }
    ] },
  { key: 'installments', icon: 'payments', labelKey: 'admin.rd.groupInstallments', fallback: 'Installments',
    descKey: 'admin.rd.groupInstallmentsDesc', descFallback: 'Offer and manage installment financing plans',
    permissions: [
      { key: 'manage_installment_profile', labelKey: 'admin.rd.perm.manage_installment_profile.label', labelFallback: 'Manage installment profile', descKey: 'admin.rd.perm.manage_installment_profile.desc', descFallback: "Can edit the finance provider's public profile" },
      { key: 'manage_installment_plans', labelKey: 'admin.rd.perm.manage_installment_plans.label', labelFallback: 'Manage installment plans', descKey: 'admin.rd.perm.manage_installment_plans.desc', descFallback: 'Can create and edit installment plans offered' },
      { key: 'edit_payment_terms', labelKey: 'admin.rd.perm.edit_payment_terms.label', labelFallback: 'Edit payment terms', descKey: 'admin.rd.perm.edit_payment_terms.desc', descFallback: 'Can change the payment terms of a plan' }
    ] },
  { key: 'moderation', icon: 'flag', labelKey: 'admin.rd.groupModeration', fallback: 'Moderation (non-protected)',
    descKey: 'admin.rd.groupModerationDesc', descFallback: 'Review profiles, reports, and flagged content',
    permissions: [
      { key: 'approve_profiles', labelKey: 'admin.rd.perm.approve_profiles.label', labelFallback: 'Approve profiles', descKey: 'admin.rd.perm.approve_profiles.desc', descFallback: 'Can approve a pending profile submission' },
      { key: 'manage_reports', labelKey: 'admin.rd.perm.manage_reports.label', labelFallback: 'Manage reports', descKey: 'admin.rd.perm.manage_reports.desc', descFallback: 'Can review and resolve user-submitted reports' },
      { key: 'moderate_content', labelKey: 'admin.rd.perm.moderate_content.label', labelFallback: 'Moderate content', descKey: 'admin.rd.perm.moderate_content.desc', descFallback: 'Can hide or remove flagged content' }
    ] },
  // Verification / Network / Rewards. Granular on purpose (brief §AL):
  // being an admin must not by itself mean being able to open someone's
  // national ID, so seeing the queue, opening one document, revealing
  // sensitive fields and restricting/suspending an account are four
  // separate grants that escalate in that order.
  { key: 'verification', icon: 'verified_user', labelKey: 'admin.rd.groupVerification', fallback: 'Verification & network',
    descKey: 'admin.rd.groupVerificationDesc', descFallback: 'Review identity verification and the agent network',
    permissions: [
      { key: 'verification.view', rules: true, labelKey: 'admin.rd.perm.verification.view.label', labelFallback: 'View verification queue', descKey: 'admin.rd.perm.verification.view.desc', descFallback: 'Can see who is waiting to be verified' },
      { key: 'verification.review', rules: true, labelKey: 'admin.rd.perm.verification.review.label', labelFallback: 'Review verification', descKey: 'admin.rd.perm.verification.review.desc', descFallback: 'Can approve or reject a verification submission' },
      { key: 'verification.documents.view', rules: true, labelKey: 'admin.rd.perm.verification.documents.view.label', labelFallback: 'View verification documents', descKey: 'admin.rd.perm.verification.documents.view.desc', descFallback: 'Can open a submitted ID document' },
      { key: 'verification.sensitive.reveal', labelKey: 'admin.rd.perm.verification.sensitive.reveal.label', labelFallback: 'Reveal sensitive fields', descKey: 'admin.rd.perm.verification.sensitive.reveal.desc', descFallback: 'Can view unmasked sensitive identity fields' },
      { key: 'verification.account.restrict', labelKey: 'admin.rd.perm.verification.account.restrict.label', labelFallback: 'Restrict account', descKey: 'admin.rd.perm.verification.account.restrict.desc', descFallback: "Can limit an account's capabilities" },
      { key: 'verification.account.suspend', labelKey: 'admin.rd.perm.verification.account.suspend.label', labelFallback: 'Suspend account', descKey: 'admin.rd.perm.verification.account.suspend.desc', descFallback: 'Can temporarily suspend an account' },
      { key: 'referrals.review', rules: true, labelKey: 'admin.rd.perm.referrals.review.label', labelFallback: 'Review referrals', descKey: 'admin.rd.perm.referrals.review.desc', descFallback: 'Can review referral-code activity' },
      { key: 'rewards.manage', rules: true, labelKey: 'admin.rd.perm.rewards.manage.label', labelFallback: 'Manage rewards', descKey: 'admin.rd.perm.rewards.manage.desc', descFallback: 'Can configure verification reward rules' },
      { key: 'offers.manage', labelKey: 'admin.rd.perm.offers.manage.label', labelFallback: 'Manage offers', descKey: 'admin.rd.perm.offers.manage.desc', descFallback: 'Can create and edit public promotional offers' },
      { key: 'archives.view', rules: true, labelKey: 'admin.rd.perm.archives.view.label', labelFallback: 'View archives', descKey: 'admin.rd.perm.archives.view.desc', descFallback: 'Can see archived verification records' }
    ] },
  // Darwesh Arena. Same granular principle as verification above:
  // reviewing a submission/deal (verifying a step, confirming a sale) is a
  // much weaker grant than owning challenge config, rank thresholds and
  // manual point adjustments.
  { key: 'arena', icon: 'military_tech', labelKey: 'admin.rd.groupArena', fallback: 'Darwesh Arena',
    descKey: 'admin.rd.groupArenaDesc', descFallback: 'Review submissions or manage challenges and ranks',
    permissions: [
      { key: 'arena.review', rules: true, labelKey: 'admin.rd.perm.arena.review.label', labelFallback: 'Review submissions', descKey: 'admin.rd.perm.arena.review.desc', descFallback: 'Can approve or reject Arena submissions' },
      { key: 'arena.manage', rules: true, labelKey: 'admin.rd.perm.arena.manage.label', labelFallback: 'Manage Arena', descKey: 'admin.rd.perm.arena.manage.desc', descFallback: 'Can edit challenges, ranks, and commission rules' }
    ] },
  // Property Watch / Area Alerts. Read-only aggregate visibility only --
  // no key here lets an admin browse or edit another user's saved alert.
  { key: 'alerts', icon: 'notifications_active', labelKey: 'admin.rd.groupAlerts', fallback: 'Property Watch / Area Alerts',
    descKey: 'admin.rd.groupAlertsDesc', descFallback: 'See aggregate area-alert activity',
    permissions: [
      { key: 'alerts.review', rules: true, labelKey: 'admin.rd.perm.alerts.review.label', labelFallback: 'View alert summary', descKey: 'admin.rd.perm.alerts.review.desc', descFallback: 'Can see aggregate Area Alerts activity' }
    ] },
  // Brokerage Fee Discount system (Phase 1). One key gates every route --
  // there is no lower-privilege "view but don't touch" split here, unlike
  // verification.*/arena.* above.
  { key: 'brokerage', icon: 'percent', labelKey: 'admin.rd.groupBrokerage', fallback: 'Brokerage Fee Discounts',
    descKey: 'admin.rd.groupBrokerageDesc', descFallback: 'Set and manage brokerage fee discounts',
    permissions: [
      { key: 'brokerage.manage', rules: true, labelKey: 'admin.rd.perm.brokerage.manage.label', labelFallback: 'Manage brokerage discounts', descKey: 'admin.rd.perm.brokerage.manage.desc', descFallback: 'Can set and manage brokerage fee discounts' }
    ] }
];

export const KNOWN_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));

// Recommended starting defaults per accountType -- what each role needs
// for the flows that exist on the site today (org-projects.html, office.html,
// the professional profile pages, the products rules). An admin sees these
// pre-filled after "Apply recommended", reviews them, and saves; nothing is
// applied without that explicit save. Customers, agents and office
// employees get none by default: agents are authorized by `role`, and an
// employee's capabilities are granted per-office by the owner.
const ORG_PROJECT_DEFAULTS = [
  'manage_organization_profile', 'manage_projects', 'manage_units', 'manage_team',
  'create_project', 'edit_own_project', 'create_building', 'edit_own_building',
  'manage_floor_plans', 'create_unit', 'edit_own_unit', 'publish_unit_listing',
  'create_estate', 'edit_own_estate'
];
const PROFESSIONAL_DEFAULTS = [
  'manage_professional_profile', 'manage_portfolio', 'receive_service_requests', 'manage_service_requests'
];
export const RECOMMENDED_ROLE_DEFAULTS = {
  individual_customer: [],
  real_estate_agent: ['create_listing', 'edit_own_listing', 'delete_own_listing'],
  office_owner: [
    'create_listing', 'edit_own_listing', 'edit_office_listing', 'delete_own_listing', 'publish_listing',
    'manage_office_profile', 'manage_office_employees', 'invite_employee', 'approve_employee',
    'manage_office_customers', 'view_office_analytics'
  ],
  office_employee: [],
  professional_engineer: PROFESSIONAL_DEFAULTS,
  professional_designer: PROFESSIONAL_DEFAULTS,
  professional_lawyer: PROFESSIONAL_DEFAULTS,
  professional_landscaping: PROFESSIONAL_DEFAULTS,
  professional_maintenance: PROFESSIONAL_DEFAULTS,
  cleaning_individual: [
    'manage_cleaning_profile', 'manage_cleaning_services', 'manage_cleaning_portfolio',
    'receive_cleaning_requests', 'manage_own_cleaning_jobs'
  ],
  cleaning_team_or_company_owner: [
    'manage_cleaning_profile', 'manage_cleaning_services', 'manage_cleaning_portfolio',
    'receive_cleaning_requests', 'manage_own_cleaning_jobs', 'manage_team'
  ],
  org_owner_residential_community: ORG_PROJECT_DEFAULTS,
  org_owner_developer: ORG_PROJECT_DEFAULTS,
  org_owner_finance_provider: [
    'manage_organization_profile', 'manage_installment_profile', 'manage_installment_plans', 'edit_payment_terms'
  ],
  org_owner_furniture_store: [
    'manage_organization_profile', 'manage_business_profile', 'manage_store_profile',
    'create_product', 'edit_own_product', 'delete_own_product', 'manage_product_availability',
    'view_customer_inquiries'
  ]
};
