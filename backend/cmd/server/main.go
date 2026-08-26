// Darwesh backend -- API server foundation.
//
// This is milestone 1 only: a real, working Gin server with health checks,
// structured logging, CORS, and graceful shutdown. Deliberately does NOT
// yet connect to PostgreSQL, Redis, or the Firebase Admin SDK -- those are
// separate milestones, each needing its own real, provisioned instance and
// credentials before there's anything honest to wire up. See
// docs/BACKEND_MILESTONES.md for what comes next and why it's sequenced
// this way.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/C22-HK/darwesh-backend/internal/config"
	"github.com/C22-HK/darwesh-backend/internal/server"
)

func main() {
	cfg := config.Load()

	logLevel := slog.LevelInfo
	if !cfg.IsProduction() {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
	slog.SetDefault(logger)

	router := server.New(cfg, logger)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      router,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Run the server in a goroutine so the main goroutine is free to wait
	// for a shutdown signal instead.
	go func() {
		logger.Info("server starting", "port", cfg.Port, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed to start", "error", err.Error())
			os.Exit(1)
		}
	}()

	// Graceful shutdown: on SIGINT/SIGTERM (what Docker, Cloud Run, and
	// systemd all send to ask a process to stop), finish in-flight
	// requests instead of dropping them, but don't wait forever.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutdown signal received, draining in-flight requests")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("server stopped cleanly")
}
