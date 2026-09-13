# Unit tests must never run holding a real Google credential.
#
# Three tests in this suite assert that credential resolution degrades
# to a clean, catchable ValueError when no Application Default
# Credentials exist:
#
#   test_firebase_credentials.py::test_no_json_with_project_id_but_no_real_adc_available_raises_a_clean_value_error
#   test_firebase_reset.py::test_no_key_with_project_id_but_no_real_adc_raises_a_clean_value_error
#   test_main_wiring.py::test_production_with_adc_configured_but_no_real_adc_available_never_crashes_startup
#
# They used to get that precondition by accident: no machine that had
# ever run them happened to have any credentials configured. Deploy
# Backend run #7 broke the accident. That workflow authenticates to
# Google Cloud before the test gates (so a missing IAM permission is
# caught in seconds rather than after a source upload), and the auth
# step exports GOOGLE_APPLICATION_CREDENTIALS. ADC then resolved
# successfully, no ValueError was raised, and three tests failed --
# against a tree that was itself perfectly fine.
#
# A test that asserts "no credentials are available" has to own that
# condition, not inherit it from whatever set up the environment. This
# fixture clears every variable google.auth.default() consults on its
# way to a credential, for every test, so the suite behaves the same
# whether or not the surrounding job is authenticated -- and so no unit
# test can reach a real Google API with a production identity.
#
# Only credential sources are cleared. FIRESTORE_EMULATOR_HOST (which
# several suites gate on) and the project-id variables are deliberately
# left alone: those name a target, not an identity.
#
# One case is out of reach and worth stating plainly rather than
# pretending otherwise: on a GCE/Cloud Run machine the metadata server
# supplies ADC over the network with no environment variable involved.
# Clearing the metadata *overrides* below stops a redirected metadata
# host from being honoured, but running this suite on a real Google VM
# would still find real credentials. No CI runner or developer laptop
# this project uses is such a machine.
from __future__ import annotations

import pytest

# Every environment variable google.auth.default() reads on the way to
# a credential: the explicit key-file path (and the two aliases the
# google-github-actions/auth action exports alongside it), gcloud's
# config directory -- which holds the well-known
# application_default_credentials.json -- and the metadata-server
# overrides.
_CREDENTIAL_ENV_VARS = (
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "GOOGLE_GHA_CREDS_PATH",
    "CLOUDSDK_CONFIG",
    "GCE_METADATA_HOST",
    "GCE_METADATA_ROOT",
    "GCE_METADATA_IP",
)


@pytest.fixture(scope="session")
def _empty_gcloud_config(tmp_path_factory) -> str:
    """An empty directory to stand in for gcloud's config home.

    Session-scoped: one directory for the whole run, not one per test."""
    return str(tmp_path_factory.mktemp("empty-gcloud-config"))


@pytest.fixture(autouse=True)
def _no_ambient_google_credentials(monkeypatch, _empty_gcloud_config: str) -> None:
    for name in _CREDENTIAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)

    # After the explicit path, google.auth's next stop is gcloud's
    # well-known ADC file under CLOUDSDK_CONFIG (default
    # ~/.config/gcloud). Point that at an empty directory rather than
    # leaving it unset, so a developer who has run
    # `gcloud auth application-default login` gets the same result here
    # that CI does.
    monkeypatch.setenv("CLOUDSDK_CONFIG", _empty_gcloud_config)
