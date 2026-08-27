# Multi-stage build: install dependencies with the full Python image,
# ship only the app + a slim runtime. Runs as a non-root user per the
# VPS/container security guidance in docs/SECURITY_AUDIT.md.

FROM python:3.11-slim AS build
WORKDIR /src
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.11-slim
RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=build /install /usr/local
WORKDIR /app
COPY app ./app
USER app
EXPOSE 8080
CMD ["python", "-m", "app.main"]
