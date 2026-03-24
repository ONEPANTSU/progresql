package rest

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/agent/steps"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"github.com/onepantsu/progressql/backend/internal/payment"
	"github.com/onepantsu/progressql/backend/internal/ratelimit"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// NewRouter creates and returns the HTTP router with all routes registered.
func NewRouter(cfg *config.Config, log *zap.Logger, hub *websocket.Hub, userStore *auth.UserStore, db *pgxpool.Pool) http.Handler {
	mux := http.NewServeMux()

	jwtSvc := auth.NewJWTService(cfg.JWTSecret)
	authMW := auth.AuthMiddleware(jwtSvc)

	// LLM client and tool registry for the agent pipeline.
	llmOpts := []llm.Option{llm.WithLogger(log)}
	if cfg.HTTPBaseURL != "" {
		llmOpts = append(llmOpts, llm.WithBaseURL(cfg.HTTPBaseURL))
	}
	llmClient := llm.NewClient(cfg.OpenRouterAPIKey, llmOpts...)
	registry := tools.NewRegistry()
	metricsCollector := metrics.New()
	pipeline := agent.NewPipeline(llmClient, registry, log, cfg.HTTPModel)
	pipeline.SetDB(db)
	pipeline.SetMetrics(metricsCollector)
	if cfg.ToolCallTimeoutSec > 0 {
		pipeline.SetToolCallTimeout(time.Duration(cfg.ToolCallTimeoutSec)*time.Second, 1)
	}
	if cfg.RateLimitPerMin > 0 {
		pipeline.SetRateLimiter(ratelimit.New(cfg.RateLimitPerMin, time.Minute))
	}
	pipeline.RegisterAction(agent.ActionExplainSQL, &steps.ExplainSQLStep{})
	pipeline.RegisterAction(agent.ActionImproveSQL, &steps.ImproveSQLStep{})
	pipeline.RegisterAction(agent.ActionAnalyzeSchema, &steps.AnalyzeSchemaStep{})
	pipeline.RegisterAction(agent.ActionGenerateSQL,
		&steps.IntentDetectionStep{},
		&steps.SchemaGroundingStep{},
		&steps.ParallelSQLGenerationStep{},
		&steps.DiagnosticRetryStep{},
		&steps.SeedExpansionStep{},
		&steps.ResultAggregationStep{},
		&steps.AutoExecuteStep{},
		&steps.VisualizationStep{},
	)

	mux.HandleFunc("GET /api/v1/health", healthHandler(cfg.Version))
	mux.HandleFunc("GET /api/v1/models", modelsHandler(cfg.AvailableModels, cfg.HTTPModel))
	mux.HandleFunc("GET /api/v1/metrics", metricsCollector.Handler())

	// Prometheus metrics endpoint (no auth required).
	mux.Handle("GET /metrics", promhttp.Handler())

	// Email verification service.
	emailSvc := auth.NewEmailService(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPassword, cfg.SMTPFrom)

	mux.HandleFunc("POST /api/v1/auth/token", authTokenHandler(jwtSvc))
	mux.HandleFunc("POST /api/v1/auth/register", registerHandler(jwtSvc, userStore, emailSvc))
	mux.HandleFunc("POST /api/v1/auth/login", loginHandler(jwtSvc, userStore))
	mux.Handle("GET /api/v1/auth/profile", authMW(http.HandlerFunc(profileHandler(userStore))))
	mux.Handle("POST /api/v1/auth/send-verification", authMW(http.HandlerFunc(sendVerificationHandler(jwtSvc, userStore, emailSvc))))
	mux.Handle("POST /api/v1/auth/verify-code", authMW(http.HandlerFunc(verifyCodeHandler(userStore, emailSvc))))
	mux.HandleFunc("POST /api/v1/auth/forgot-password", forgotPasswordHandler(userStore, emailSvc))
	mux.HandleFunc("POST /api/v1/auth/reset-password", resetPasswordHandler(userStore, emailSvc))
	mux.Handle("POST /api/v1/sessions", authMW(http.HandlerFunc(createSessionHandler(hub, cfg.ServerPort, userStore))))

	// Legal document endpoints (GET — public, POST accept — authenticated).
	mux.HandleFunc("GET /api/v1/legal/{type}/{version}", legalDocumentHandler(db))
	mux.HandleFunc("GET /api/v1/legal/{type}", legalDocumentHandler(db))
	mux.Handle("POST /api/v1/legal/accept", authMW(http.HandlerFunc(legalAcceptHandler(db))))

	// CryptoCloud payment routes.
	cryptoClient := payment.NewCryptoCloudClient(cfg.CryptoCloudAPIKey, cfg.CryptoCloudShopID)
	mux.Handle("POST /api/v1/payments/create-invoice", authMW(http.HandlerFunc(payment.CreateInvoiceHandler(cryptoClient, userStore, db))))
	mux.HandleFunc("POST /api/v1/payments/webhook", payment.WebhookHandler(userStore, db, cfg.CryptoCloudSecret))

	// Admin analytics endpoints (JWT + admin user ID required).
	if len(cfg.AdminUserIDs) > 0 {
		adminMW := func(next http.Handler) http.Handler {
			return authMW(adminMiddleware(cfg.AdminUserIDs, next))
		}
		mux.Handle("GET /api/v1/admin/analytics/users", adminMW(http.HandlerFunc(analyticsUsersHandler(db, userStore))))
		mux.Handle("GET /api/v1/admin/analytics/users/{id}", adminMW(http.HandlerFunc(analyticsUserDetailHandler(db, userStore))))
	}

	// WebSocket endpoint: GET /ws/<session_id>?token=<JWT>
	sessionFactory := websocket.SessionHandlerFactory(func(session *websocket.Session) websocket.MessageHandler {
		return func(env *websocket.Envelope) {
			go pipeline.HandleMessage(session, env)
		}
	})

	mux.HandleFunc("/ws/", websocket.HandleWebSocket(hub, jwtSvc, log, nil, sessionFactory))

	return MetricsMiddleware(CORSMiddleware(mux))
}
