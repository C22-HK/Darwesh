# Canonical allowlists for the Profile Architecture. These MUST stay in
# lockstep with firestore.rules -- specifically isValidSelfAccountType(),
# isProtectedPermissionKey(), and the organizations/serviceProviders
# `type`/`serviceType`/`providerType`/`servicesOffered` allowlists (already
# published to production as of Phase 1). Backend and rules independently
# enforcing the SAME values is deliberate defense in depth (a bug in one
# layer doesn't silently widen what the other allows) -- but the account
# type *strings* specifically must be byte-for-byte identical between the
# two, not just similar, because rolePermissionDefaults/{accountType} doc
# IDs are looked up by this exact string in both firestore.rules'
# roleDefaultPermissions() and this backend's permission_resolver.py. If
# a caller's stored accountType doesn't match a rolePermissionDefaults
# document id character-for-character, that caller's permissions silently
# resolve to nothing (fails closed, but that's a real user losing access,
# not just an inconsistency) -- so change these together, never separately.
from __future__ import annotations

# Every self-settable accountType value, mirroring firestore.rules'
# isValidSelfAccountType() exactly. 'admin' is NOT here on purpose -- it
# is a protected, backend/admin-only-assignable value, never selectable
# during public signup (see ADMIN_ACCOUNT_TYPE below and
# firestore.rules' comment on the same exclusion).
SELF_ACCOUNT_TYPES: frozenset[str] = frozenset(
    {
        "individual_customer",
        "real_estate_agent",
        "office_owner",
        "office_employee",
        "professional_engineer",
        "professional_designer",
        "professional_lawyer",
        "professional_landscaping",
        "cleaning_individual",
        "cleaning_team_or_company_owner",
        "org_owner_residential_community",
        "org_owner_developer",
        "org_owner_finance_provider",
        "org_owner_furniture_store",
    }
)

# The one protected, non-public accountType value. Valid as a STORED
# value (an admin's own users/{uid}.accountType may legitimately be
# 'admin'), never accepted from any public-facing request -- see
# is_valid_public_account_type() below, which deliberately excludes it.
ADMIN_ACCOUNT_TYPE = "admin"

# Every accountType value that may ever legitimately exist on a document,
# public-signup-settable or not. Used for read-side / admin-tool
# validation where 'admin' is a legitimate value to accept (e.g. an admin
# endpoint listing role defaults for every known type).
ALL_ACCOUNT_TYPES: frozenset[str] = SELF_ACCOUNT_TYPES | {ADMIN_ACCOUNT_TYPE}


def is_valid_public_account_type(value: object) -> bool:
    """True only for a value a non-admin caller may request for
    themselves (signup, or a future self-service profile-type change).
    Deliberately excludes 'admin' and anything not in the canonical set
    -- an unrecognized or admin-shaped value is REJECTED, never silently
    coerced to a default. See constants.py's module docstring for why
    this list must match firestore.rules exactly."""
    return isinstance(value, str) and value in SELF_ACCOUNT_TYPES


# Protected permissions (verbatim list from the approved architecture,
# mirrors firestore.rules' isProtectedPermissionKey() exactly). No
# endpoint in this package ever grants one of these through the generic
# role-defaults/user-overrides mechanism -- see permission_ops.py's
# module docstring for why, and PHASE2_REPORT in the commit message /
# completion report for the explicit decision not to build a "grant a
# protected permission" endpoint this phase.
PROTECTED_PERMISSIONS: frozenset[str] = frozenset(
    {
        "admin_access",
        "manage_roles",
        "manage_permissions",
        "verify_profiles",
        "suspend_users",
        "change_organization_owner",
        "manage_platform_security",
    }
)

# Every non-protected permission key this phase's endpoints know about --
# mirrors the categories/keys enumerated in the approved architecture
# (Listings/Office/Professional/Cleaning/Business/Organization/
# Installments/Admin). Role-defaults and user-override writes reject any
# key outside PROTECTED_PERMISSIONS | KNOWN_PERMISSIONS outright, so a
# typo'd or invented permission name can never silently become a no-op
# grant that a rules author later assumes is real.
KNOWN_PERMISSIONS: frozenset[str] = frozenset(
    {
        # Listings
        "create_listing",
        "edit_own_listing",
        "edit_office_listing",
        "delete_own_listing",
        "publish_listing",
        # Office
        "manage_office_profile",
        "manage_office_employees",
        "invite_employee",
        "approve_employee",
        "manage_office_customers",
        "view_office_analytics",
        # Professional / Services
        "manage_professional_profile",
        "manage_portfolio",
        "receive_service_requests",
        "manage_service_requests",
        # Cleaning
        "manage_cleaning_profile",
        "manage_cleaning_services",
        "manage_cleaning_portfolio",
        "receive_cleaning_requests",
        "manage_own_cleaning_jobs",
        # Business / Store
        "manage_business_profile",
        "manage_store_profile",
        "create_product",
        "edit_own_product",
        "delete_own_product",
        "manage_product_availability",
        "view_customer_inquiries",
        # Organization
        "manage_organization_profile",
        "manage_projects",
        "manage_units",
        "manage_team",
        # Installments
        "manage_installment_profile",
        "manage_installment_plans",
        "edit_payment_terms",
        # Admin / Moderation (non-protected subset only -- the protected
        # admin-shaped keys live in PROTECTED_PERMISSIONS above)
        "approve_profiles",
        "manage_reports",
        "moderate_content",
    }
)

# organizations.type -- mirrors firestore.rules' organizations create
# rule exactly. 'real_estate_office' is deliberately absent: offices stay
# on the pre-existing `companies` collection this phase (Phase 1 §2.2
# migration note); creating that type is not offered here.
ORGANIZATION_TYPES: frozenset[str] = frozenset(
    {
        "residential_community",
        "developer_project",
        "finance_provider",
        "furniture_store",
    }
)

# serviceProviders.serviceType / providerType -- mirrors
# firestore.rules' serviceProviders create rule exactly.
SERVICE_TYPES: frozenset[str] = frozenset({"engineer", "designer", "lawyer", "landscaping", "cleaning"})
PROVIDER_TYPES: frozenset[str] = frozenset({"individual", "team", "company"})

# serviceProviders.servicesOffered -- mirrors firestore.rules'
# isValidServicesOffered() exactly.
CLEANING_SERVICE_CATEGORIES: frozenset[str] = frozenset(
    {
        "house_cleaning",
        "apartment_cleaning",
        "office_cleaning",
        "deep_cleaning",
        "move_in_cleaning",
        "move_out_cleaning",
        "post_construction_cleaning",
        "post_renovation_cleaning",
        "commercial_cleaning",
    }
)

# organizations/{orgId}/members/{uid} lifecycle states this package
# writes. 'pending' = a self-requested join awaiting the org owner's (or
# an admin's) decision -- never itself a grant of access (mirrors the
# requestedRole/requestedCompanyId non-authoritative-signal pattern
# already established for signup). 'active' = real, approved membership.
MEMBER_STATUS_PENDING = "pending"
MEMBER_STATUS_ACTIVE = "active"
MEMBER_ROLE_EMPLOYEE = "employee"
