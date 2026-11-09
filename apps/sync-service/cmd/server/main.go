// Command server runs the ConstructOS edge-sync service.
//
// Environment:
//
//	SYNC_DATABASE_URL  Postgres URL for the constructos_sync role (required)
//	JWT_SECRET         shared HS256 secret with the core API (required, >= 32 chars)
//	PORT               listen port (default 8081)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/constructos/sync-service/internal/auth"
	"github.com/constructos/sync-service/internal/db"
	"github.com/constructos/sync-service/internal/syncapi"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "edge-sync")

	dbURL := os.Getenv("SYNC_DATABASE_URL")
	secret := os.Getenv("JWT_SECRET")
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	switch {
	case dbURL == "":
		fatal(log, "SYNC_DATABASE_URL is required")
	case strings.Contains(dbURL, "constructos_owner"):
		fatal(log, "SYNC_DATABASE_URL must use the constructos_sync role, never the owner")
	case len(secret) < 32:
		fatal(log, "JWT_SECRET must be at least 32 characters")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, dbURL)
	if err != nil {
		fatal(log, "database connection failed: "+err.Error())
	}
	defer pool.Close()

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           syncapi.NewRouter(syncapi.NewStore(pool), auth.NewVerifier(secret), log),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second, // slow site links upload big backlogs
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx) // ECS sends SIGTERM; drain in-flight pushes
	}()

	log.Info("listening", "port", port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(log, err.Error())
	}
	log.Info("stopped")
}

func fatal(log *slog.Logger, msg string) {
	log.Error(msg)
	os.Exit(1)
}
