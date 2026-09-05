# Darwesh Backend

A Python/FastAPI API service. This is **milestone 1 + milestone 3**: a
real, working server foundation -- health checks, structured logging,
CORS, security headers -- plus the password-reset email endpoint. No
database, no Redis yet. See
[`docs/BACKEND_MILESTONES.md`](../docs/BACKEND_MILESTONES.md) for what
comes next and why it's sequenced this way.

**Deployed.** This service runs in production on Google Cloud Run:
service `darwesh-backend`, region `me-central1`. Treat it as a live,
traffic-serving service, not inert code — a change merged here doesn't
take effect until redeployed (see "Deployment" below), but the
currently-deployed revision is real and currently answering real
requests.

## Run locally

```bash
cd backend
cp .env.example .env   # edit if you want non-default values
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.main
```

Then:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/api/v1/health
```

## Test

```bash
pip install -r requirements-dev.txt
pytest
```

## Lint + format check

```bash
ruff check app tests scripts
ruff format --check app tests scripts
```

## Build the container image

```bash
docker build -t darwesh-backend .
docker run --rm -p 8080:8080 -e APP_ENV=production darwesh-backend
```

## Deployment

**Currently deployed on Google Cloud Run** — service `darwesh-backend`,
region `me-central1`, redeployed with `gcloud run deploy` pointed at
this directory (or via the Cloud Console's "Deploy from source" against
this repo's `backend/` folder). This was chosen over the alternatives
originally considered (a VPS; Render/Railway/Fly.io) for the reasons
that made it the recommended first choice: pay-per-request, scales to
zero when idle, and shares IAM with the existing Firebase project (same
GCP project).

The container needs `PORT` set by the platform (Cloud Run does this
automatically) and every real secret (`OTP_HMAC_SECRET`,
`RESEND_API_KEY`, and — outside of local dev — `FIREBASE_SERVICE_ACCOUNT_JSON`,
which production instead omits in favor of Application Default
Credentials) supplied through Cloud Run's own environment/secret
configuration — never committed to this repo. Verify whether these are
currently set as plain environment variables or via Secret Manager
with:

```bash
gcloud run services describe darwesh-backend --region=me-central1 --format=json
```

(Secret Manager-backed values show as `secretKeyRef` entries rather than
plain `env` values — the stronger, more auditable pattern for a live
service; see `INFRASTRUCTURE_SECURITY_REVIEW.md`'s INFRA-05.)
