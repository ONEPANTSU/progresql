package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/onepantsu/progressql/backend/internal/api/rest"
	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/database"
	"github.com/onepantsu/progressql/backend/internal/logger"
	"github.com/onepantsu/progressql/backend/internal/subscription"
	"github.com/onepantsu/progressql/backend/internal/websocket"
	"go.uber.org/zap"
)

func main() {
	cfg, err := config.LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
		os.Exit(1)
	}

	log, err := logger.Init(cfg.LogLevel, cfg.Environment, cfg.Version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to init logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()

	// Connect to PostgreSQL and run migrations.
	ctx := context.Background()
	db, err := database.Connect(ctx, cfg.DatabaseURL, log)
	if err != nil {
		log.Fatal("failed to connect to database", zap.Error(err))
	}
	defer db.Close()

	hub := websocket.NewHub()

	// User store — PostgreSQL-backed.
	userStore := auth.NewUserStore(db)

	// Subscription expiry notifier — checks every hour, sends emails at 3-day and 1-day thresholds.
	emailSvc := auth.NewEmailService(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPassword, cfg.SMTPFrom)
	notifier := subscription.NewNotifier(db, emailSvc, userStore, log, 1*time.Hour)
	notifier.Start()

	router := rest.NewRouter(cfg, log, hub, userStore, db)

	addr := ":" + cfg.ServerPort
	srv := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	// Graceful shutdown on SIGINT/SIGTERM
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Info("starting HTTP server", zap.String("addr", addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("server failed", zap.Error(err))
		}
	}()

	<-stop
	log.Info("graceful shutdown initiated")

	// Step 0: Stop subscription notifier.
	notifier.Stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Step 1: Close all active WebSocket sessions.
	closed := hub.CloseAll()
	log.Info("closed websocket sessions", zap.Int("count", closed))

	// Step 2: Shut down HTTP server.
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("http server shutdown error", zap.Error(err))
	}

	log.Info("graceful shutdown complete")
}
