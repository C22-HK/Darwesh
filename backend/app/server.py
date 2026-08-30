# Builds the FastAPI app: middleware, routes, everything except actually
# listening on a port (that's app/main.py's job, so this can be
# unit-tested with TestClient without opening a real socket).
from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import Config

request_logger = logging.getLogger("darwesh.request")


def create_app(
    cfg: Config,
    auth_handler: object | None = None,
    email_otp_send_handler: object | None = None,
    email_otp_verify_handler: object | None = None,
    signup_complete_handler: object | None = None,
    password_reset_confirm_handler: object | None = None,
    organization_handler: object | None = None,
    permission_admin_handler: object | None = None,
) -> FastAPI:
    """Every *_handler argument is None-able on purpose: app.main only
    constructs one when its required settings are actually present. When
    one is None, its route simply isn't registered -- a 404 for a route
    that isn't configured, rather than a route that exists but silently
    can't do its job. auth_handler backs the legacy link-based
    /api/v1/auth/forgot-password; the email_otp_*/signup_complete/
    password_reset_confirm handlers back the email-OTP signup and
    password-recovery flow -- both can be registered at once (the legacy
    link-based flow stays available as a fallback for any account) or
    independently. organization_handler/permission_admin_handler back the
    Profile Architecture Phase 2 access-management endpoints (see
    app.access.handlers) -- registered together (both come from
    app.main.build_access_handlers, gated on the same Firebase Admin
    credential check)."""
    app = FastAPI(title="Darwesh Backend", docs_url=None, redoc_url=None, openapi_url=None)

    app.add_middleware(_RequestLoggingMiddleware)
    app.add_middleware(_SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        # An explicit allowlist, never a wildcard -- an empty list means no
        # cross-origin browser access is permitted at all, the correct
        # default for an API with no approved frontend integration yet.
        allow_origins=cfg.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Two health endpoints on purpose: /healthz is the conventional path
    # most platforms (Cloud Run, Kubernetes, uptime checkers) probe by
    # default; /api/v1/health matches this project's versioned API
    # namespace so every future real endpoint follows the same
    # /api/v1/* pattern from day one.
    app.add_api_route("/healthz", _health_check, methods=["GET"])
    app.add_api_route("/api/v1/health", _health_check, methods=["GET"])

    if auth_handler is not None:
        app.add_api_route(
            "/api/v1/auth/forgot-password",
            auth_handler.forgot_password,
            methods=["POST"],
        )
    if email_otp_send_handler is not None:
        app.add_api_route("/api/v1/auth/email-otp/send", email_otp_send_handler.send, methods=["POST"])
    if email_otp_verify_handler is not None:
        app.add_api_route("/api/v1/auth/email-otp/verify", email_otp_verify_handler.verify, methods=["POST"])
    if signup_complete_handler is not None:
        app.add_api_route("/api/v1/auth/signup/complete", signup_complete_handler.complete, methods=["POST"])
    if password_reset_confirm_handler is not None:
        app.add_api_route(
            "/api/v1/auth/password-reset/confirm",
            password_reset_confirm_handler.confirm,
            methods=["POST"],
        )
    if organization_handler is not None:
        app.add_api_route("/api/v1/access/organizations", organization_handler.create, methods=["POST"])
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/membership-requests",
            organization_handler.request_membership,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/invite",
            organization_handler.invite_member,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/invitations/accept",
            organization_handler.accept_invitation,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/invitations/decline",
            organization_handler.decline_invitation,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/revoke-invitation",
            organization_handler.revoke_invitation,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/approve",
            organization_handler.approve_membership,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/reject",
            organization_handler.reject_membership,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/remove",
            organization_handler.remove_member,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/members/{target_uid}/permissions",
            organization_handler.set_member_permissions,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/organizations/{org_id}/transfer-ownership",
            organization_handler.transfer_ownership,
            methods=["POST"],
        )
    if permission_admin_handler is not None:
        app.add_api_route(
            "/api/v1/access/role-defaults", permission_admin_handler.set_role_defaults, methods=["POST"]
        )
        app.add_api_route(
            "/api/v1/access/users/{target_uid}/permission-overrides",
            permission_admin_handler.set_user_overrides,
            methods=["POST"],
        )
        app.add_api_route(
            "/api/v1/access/me/permissions", permission_admin_handler.get_my_permissions, methods=["GET"]
        )

    return app


async def _health_check(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "time": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")})


class _RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Logs one structured line per request -- method, path, status,
    latency, client IP. Never logs request/response bodies, headers, or
    query strings, so it can't accidentally leak a token or password even
    once endpoints that accept them exist."""

    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        path = request.url.path
        response = await call_next(request)
        latency_ms = round((time.monotonic() - start) * 1000)
        client_ip = request.client.host if request.client else "unknown"
        request_logger.info(
            "request",
            extra={
                "method": request.method,
                "path": path,
                "status": response.status_code,
                "latency_ms": latency_ms,
                "client_ip": client_ip,
            },
        )
        return response


class _SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Sets the response headers this API controls directly -- distinct
    from the ones GitHub Pages can't set for the static frontend (see
    docs/SECURITY_AUDIT.md, L1). Content-Security-Policy, X-Frame-Options,
    and Permissions-Policy are left out deliberately: this is a JSON API
    with no HTML responses, so there is no page for a browser to render,
    frame, or grant feature access to -- those headers protect an HTML
    document's rendering context, which doesn't exist here, so adding
    them would be checkbox security with nothing real to constrain.
    Strict-Transport-Security is different: it's a per-origin instruction
    a browser honors for *any* future request to this host over HTTPS,
    regardless of response content type, so it's included."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        # 2 years, includes subdomains -- long enough to be a durable
        # commitment once this is actually deployed on a real domain,
        # short of preload-list submission (which requires production
        # traffic on a stable domain first, not appropriate to opt into
        # from a codebase that isn't deployed anywhere yet).
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response
