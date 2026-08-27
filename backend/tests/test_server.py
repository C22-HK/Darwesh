from fastapi.testclient import TestClient

from app.config import Config
from app.server import create_app


def make_client(**config_kwargs) -> TestClient:
    config_kwargs.setdefault("port", "8080")
    config_kwargs.setdefault("env", "development")
    cfg = Config(**config_kwargs)
    return TestClient(create_app(cfg, None))


def test_healthz_returns_ok():
    client = make_client()
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_api_v1_health_returns_ok():
    client = make_client()
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200


def test_cors_rejects_unlisted_origin():
    client = make_client(allowed_origins=["https://www.darweshgroup.com"])
    resp = client.get("/api/v1/health", headers={"Origin": "https://evil.example.com"})
    assert resp.headers.get("access-control-allow-origin") is None


def test_cors_allows_listed_origin():
    client = make_client(allowed_origins=["https://www.darweshgroup.com"])
    resp = client.get("/api/v1/health", headers={"Origin": "https://www.darweshgroup.com"})
    assert resp.headers.get("access-control-allow-origin") == "https://www.darweshgroup.com"


def test_security_headers_present():
    client = make_client()
    resp = client.get("/healthz")
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("referrer-policy") == "no-referrer"


def test_forgot_password_route_not_registered_when_unconfigured():
    client = make_client()
    resp = client.post("/api/v1/auth/forgot-password")
    assert resp.status_code == 404
