// Package config centralizes environment-based configuration. Nothing in
// this package reads a config file or hardcodes a value that should differ
// between environments -- every setting comes from an env var, with a safe
// default for local development only.
package config

import (
	"os"
)

// Config holds all runtime configuration for the server. Fields are added
// here as real functionality needs them (a database DSN, an email API key,
// etc.) -- deliberately minimal for now, matching this milestone's scope
// (server foundation only, no database or external services wired in yet).
type Config struct {
	// Port the HTTP server listens on. Cloud Run and most PaaS platforms
	// inject PORT automatically; 8080 is the conventional local default.
	Port string

	// Env identifies the running environment ("development" or
	// "production"), used to decide things like log verbosity and
	// whether Gin runs in debug or release mode. Never used for a
	// security decision on its own (e.g. "skip auth if development") --
	// that would be a real vulnerability if this var were ever
	// misconfigured in production.
	Env string

	// AllowedOrigins is the CORS allowlist for browser requests to this
	// API. Starts empty (no cross-origin browser access permitted) until
	// a real frontend integration needs it -- an open CORS policy is a
	// common way APIs accidentally expose themselves to any website.
	AllowedOrigins []string
}

// Load reads configuration from environment variables. Returns sane,
// safe-by-default values for anything unset -- a missing env var should
// never silently widen what the server permits (e.g. AllowedOrigins
// defaults to none, not "*").
func Load() Config {
	return Config{
		Port:           getEnv("PORT", "8080"),
		Env:            getEnv("APP_ENV", "development"),
		AllowedOrigins: splitNonEmpty(os.Getenv("ALLOWED_ORIGINS")),
	}
}

func (c Config) IsProduction() bool {
	return c.Env == "production"
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func splitNonEmpty(csv string) []string {
	if csv == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i <= len(csv); i++ {
		if i == len(csv) || csv[i] == ',' {
			if i > start {
				out = append(out, csv[start:i])
			}
			start = i + 1
		}
	}
	return out
}
