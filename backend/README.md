# Darwesh Backend

A Python/FastAPI API service. This is **milestone 1 + milestone 3**: a
real, working server foundation -- health checks, structured logging,
CORS, security headers -- plus the password-reset email endpoint. No
database, no Redis yet. See
[`docs/BACKEND_MILESTONES.md`](../docs/BACKEND_MILESTONES.md) for what
comes next and why it's sequenced this way.

Nothing in this directory is deployed anywhere yet. It exists, its tests
pass, but it isn't running in production until it's deployed somewhere
(see "Deployment" below) and the frontend/DNS are pointed at it.

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

## Deployment (not yet done -- needs your decision)

This container can run on any of the following; none of them are set up
yet:

- **Google Cloud Run** (recommended first choice) -- pay-per-request,
  scales to zero when idle, fits naturally alongside the existing
  Firebase project (same GCP project, can share IAM). Deploy with
  `gcloud run deploy` pointed at this directory, or via the Cloud
  Console's "Deploy from source" against this repo's `backend/` folder.
- **A VPS** (DigitalOcean/Hetzner/etc.) -- fixed monthly cost regardless
  of traffic, more manual setup (firewall, TLS via Caddy/Nginx, process
  supervision), full control.
- **Render/Railway/Fly.io** -- simplest to get started, similar
  pay-for-what-you-use model to Cloud Run.

Whichever is chosen, the container needs `PORT` set by the platform (all
of the above do this automatically) and, once later milestones add them,
`DATABASE_URL`/`REDIS_URL`/etc. supplied as real secrets through that
platform's environment/secret manager -- never committed to this repo.
