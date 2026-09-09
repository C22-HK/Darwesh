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
  'suspend_users', 'change_organization_owner', 'manage_platform_security'
];

// Every grantable key, grouped exactly as constants.py groups them. The
// `rules` flag marks keys firestore.rules actually consults today (a key
// without it is recorded for the backend's /me/permissions read side and
// for future rules, and granting it changes nothing in Firestore yet).
export const PERMISSION_GROUPS = [
  { key: 'listings', labelKey: 'admin.rd.groupListings', fallback: 'Listings', permissions: [
    { key: 'create_listing' }, { key: 'edit_own_listing' }, { key: 'edit_office_listing' },
    { key: 'delete_own_listing' }, { key: 'publish_listing' }
  ] },
  { key: 'office', labelKey: 'admin.rd.groupOffice', fallback: 'Real-estate office', permissions: [
    { key: 'manage_office_profile' }, { key: 'manage_office_employees' }, { key: 'invite_employee' },
    { key: 'approve_employee' }, { key: 'manage_office_customers' }, { key: 'view_office_analytics' }
  ] },
  { key: 'professional', labelKey: 'admin.rd.groupProfessional', fallback: 'Professional services', permissions: [
    { key: 'manage_professional_profile' }, { key: 'manage_portfolio' },
    { key: 'receive_service_requests' }, { key: 'manage_service_requests' }
  ] },
  { key: 'cleaning', labelKey: 'admin.rd.groupCleaning', fallback: 'Cleaning', permissions: [
    { key: 'manage_cleaning_profile' }, { key: 'manage_cleaning_services' }, { key: 'manage_cleaning_portfolio' },
    { key: 'receive_cleaning_requests' }, { key: 'manage_own_cleaning_jobs' }
  ] },
  { key: 'business', labelKey: 'admin.rd.groupBusiness', fallback: 'Business / store', permissions: [
    { key: 'manage_business_profile' }, { key: 'manage_store_profile' }, { key: 'create_product', rules: true },
    { key: 'edit_own_product', rules: true }, { key: 'delete_own_product' }, { key: 'manage_product_availability' },
    { key: 'view_customer_inquiries' }
  ] },
  { key: 'organization', labelKey: 'admin.rd.groupOrganization', fallback: 'Organization', permissions: [
    { key: 'manage_organization_profile', rules: true }, { key: 'manage_projects' }, { key: 'manage_units' }, { key: 'manage_team' }
  ] },
  { key: 'projects', labelKey: 'admin.rd.groupProjects', fallback: 'Projects / buildings / units', permissions: [
    { key: 'create_project', rules: true }, { key: 'edit_own_project', rules: true },
    { key: 'create_building', rules: true }, { key: 'edit_own_building', rules: true },
    { key: 'manage_floor_plans', rules: true }, { key: 'create_unit', rules: true },
    { key: 'edit_own_unit', rules: true }, { key: 'publish_unit_listing', rules: true }
  ] },
  { key: 'estates', labelKey: 'admin.rd.groupEstates', fallback: 'Estates', permissions: [
    { key: 'create_estate', rules: true }, { key: 'edit_own_estate', rules: true }
  ] },
  { key: 'installments', labelKey: 'admin.rd.groupInstallments', fallback: 'Installments', permissions: [
    { key: 'manage_installment_profile' }, { key: 'manage_installment_plans' }, { key: 'edit_payment_terms' }
  ] },
  { key: 'moderation', labelKey: 'admin.rd.groupModeration', fallback: 'Moderation (non-protected)', permissions: [
    { key: 'approve_profiles' }, { key: 'manage_reports' }, { key: 'moderate_content' }
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
