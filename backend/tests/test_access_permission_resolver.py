# Pure-logic tests for app.access.permission_resolver -- no Firestore, no
# emulator, exercises every fail-closed branch called out in the Phase 2
# spec: missing accountType, unknown accountType, missing role defaults,
# protected-key exclusion, and normal override-over-default resolution.
from __future__ import annotations

from app.access.permission_resolver import (
    has_permission,
    resolve_effective_permissions,
    validate_permission_write,
)


def test_missing_account_type_resolves_to_no_permissions():
    result = resolve_effective_permissions(
        account_type=None, role_defaults={"permissions": {"create_listing": True}}, overrides=None
    )
    assert result == {}


def test_unknown_account_type_resolves_to_no_permissions():
    result = resolve_effective_permissions(
        account_type="not_a_real_type", role_defaults={"permissions": {"create_listing": True}}, overrides=None
    )
    assert result == {}


def test_missing_role_defaults_document_resolves_to_no_permissions():
    result = resolve_effective_permissions(account_type="individual_customer", role_defaults=None, overrides=None)
    assert result == {}


def test_malformed_role_defaults_document_resolves_to_no_permissions():
    # A document that exists but doesn't have the expected shape must
    # never be treated as "some permissions", only as "no permissions".
    result = resolve_effective_permissions(account_type="individual_customer", role_defaults={}, overrides=None)
    assert result == {}


def test_recognized_account_type_with_matching_defaults_resolves_granted_keys():
    result = resolve_effective_permissions(
        account_type="office_employee",
        role_defaults={"permissions": {"edit_office_listing": True, "manage_office_employees": False}},
        overrides=None,
    )
    assert result == {"edit_office_listing": True}
    assert "manage_office_employees" not in result


def test_override_true_grants_a_key_the_default_denies():
    result = resolve_effective_permissions(
        account_type="office_employee",
        role_defaults={"permissions": {"manage_office_employees": False}},
        overrides={"manage_office_employees": True},
    )
    assert result == {"manage_office_employees": True}


def test_override_false_suppresses_a_key_the_default_grants():
    result = resolve_effective_permissions(
        account_type="office_employee",
        role_defaults={"permissions": {"edit_office_listing": True}},
        overrides={"edit_office_listing": False},
    )
    assert result == {}


def test_protected_key_never_resolves_even_if_present_in_defaults():
    result = resolve_effective_permissions(
        account_type="office_owner", role_defaults={"permissions": {"admin_access": True}}, overrides=None
    )
    assert result == {}


def test_protected_key_never_resolves_even_if_present_in_overrides():
    result = resolve_effective_permissions(
        account_type="office_owner",
        role_defaults={"permissions": {}},
        overrides={"suspend_users": True},
    )
    assert result == {}


def test_admin_account_type_is_resolvable_but_still_fails_closed_without_defaults():
    # 'admin' is a legitimate stored accountType (unlike being self-
    # settable at signup) -- resolving it must still fail closed if no
    # rolePermissionDefaults/admin document exists, same as any other type.
    assert resolve_effective_permissions(account_type="admin", role_defaults=None, overrides=None) == {}
    assert resolve_effective_permissions(
        account_type="admin", role_defaults={"permissions": {"create_listing": True}}, overrides=None
    ) == {"create_listing": True}


def test_has_permission_reads_the_resolved_map():
    assert has_permission("create_listing", effective_permissions={"create_listing": True}) is True
    assert has_permission("create_listing", effective_permissions={}) is False
    assert has_permission("create_listing", effective_permissions={"create_listing": False}) is False


def test_has_permission_refuses_a_protected_key_even_if_forced_true():
    # Defense in depth: even if a caller somehow constructed a resolved
    # map with a protected key set True, has_permission() itself refuses.
    assert has_permission("admin_access", effective_permissions={"admin_access": True}) is False


def test_validate_permission_write_accepts_known_non_protected_keys():
    assert validate_permission_write({"create_listing": True, "edit_own_listing": False}) is None


def test_validate_permission_write_rejects_non_dict():
    assert validate_permission_write(["create_listing"]) is not None
    assert validate_permission_write("create_listing") is not None
    assert validate_permission_write(None) is not None


def test_validate_permission_write_rejects_protected_keys():
    error = validate_permission_write({"admin_access": True})
    assert error is not None
    assert "protected" in error.lower()


def test_validate_permission_write_rejects_unknown_keys():
    error = validate_permission_write({"delete_the_database": True})
    assert error is not None
    assert "unknown" in error.lower()


def test_validate_permission_write_rejects_non_bool_values():
    error = validate_permission_write({"create_listing": "yes"})
    assert error is not None
