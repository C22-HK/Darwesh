package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/C22-HK/darwesh-backend/internal/config"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestHealthzReturnsOK(t *testing.T) {
	router := New(config.Config{Env: "development"}, testLogger())
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
}

func TestAPIV1HealthReturnsOK(t *testing.T) {
	router := New(config.Config{Env: "development"}, testLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
}

func TestCORSRejectsUnlistedOrigin(t *testing.T) {
	router := New(config.Config{Env: "development", AllowedOrigins: []string{"https://www.darweshgroup.com"}}, testLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no Access-Control-Allow-Origin header for an unlisted origin, got %q", got)
	}
}

func TestCORSAllowsListedOrigin(t *testing.T) {
	router := New(config.Config{Env: "development", AllowedOrigins: []string{"https://www.darweshgroup.com"}}, testLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("Origin", "https://www.darweshgroup.com")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://www.darweshgroup.com" {
		t.Fatalf("expected Access-Control-Allow-Origin to be the listed origin, got %q", got)
	}
}

func TestSecurityHeadersPresent(t *testing.T) {
	router := New(config.Config{Env: "development"}, testLogger())
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("expected X-Content-Type-Options: nosniff")
	}
	if rec.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("expected Referrer-Policy: no-referrer")
	}
}
