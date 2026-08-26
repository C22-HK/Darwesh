// Package server wires up the HTTP router and its middleware. Kept
// separate from main.go so the router itself is testable without also
// standing up a real listening socket.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/C22-HK/darwesh-backend/internal/config"
)

// New builds the Gin engine: middleware, routes, everything except
// actually listening on a port (that's main.go's job, so this can be
// unit-tested with httptest without opening a real socket).
func New(cfg config.Config, logger *slog.Logger) *gin.Engine {
	if cfg.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(requestLogger(logger))
	r.Use(gin.Recovery()) // turns a panic in a handler into a 500, not a crashed process
	r.Use(corsMiddleware(cfg.AllowedOrigins))
	r.Use(securityHeaders())

	// Two health endpoints on purpose: /healthz is the conventional path
	// most platforms (Cloud Run, Kubernetes, uptime checkers) probe by
	// default; /api/v1/health matches this project's versioned API
	// namespace so every future real endpoint follows the same
	// /api/v1/* pattern from day one.
	r.GET("/healthz", healthCheck)

	v1 := r.Group("/api/v1")
	{
		v1.GET("/health", healthCheck)
	}

	return r
}

func healthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

// requestLogger logs one structured line per request -- method, path,
// status, latency, client IP. Never logs request/response bodies, headers,
// or query strings, so it can't accidentally leak a token or password even
// once endpoints that accept them exist.
func requestLogger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		c.Next()
		logger.Info("request",
			"method", c.Request.Method,
			"path", path,
			"status", c.Writer.Status(),
			"latency_ms", time.Since(start).Milliseconds(),
			"client_ip", c.ClientIP(),
		)
	}
}

// corsMiddleware allows only the exact origins in the allowlist -- an
// empty list means no browser-based cross-origin requests are permitted
// at all, which is the correct default for an API with no approved
// frontend integration yet. Never reflects an arbitrary Origin header or
// uses a wildcard with credentials, both classic CORS misconfigurations.
func corsMiddleware(allowedOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// securityHeaders sets the response headers this API controls directly --
// distinct from the ones GitHub Pages can't set for the static frontend
// (see docs/SECURITY_AUDIT.md, L1). A real Content-Security-Policy is left
// out here deliberately: this is a JSON API with no HTML responses, so a
// CSP has nothing to constrain yet -- adding one prematurely just for the
// sake of it would be checkbox security, not real protection.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Next()
	}
}
