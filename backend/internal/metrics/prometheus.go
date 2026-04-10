package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// --- HTTP metrics ---

var HTTPRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "http_requests_total",
	Help: "Total number of HTTP requests.",
}, []string{"method", "path", "status_code"})

var HTTPRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "http_request_duration_seconds",
	Help:    "Duration of HTTP requests in seconds.",
	Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
}, []string{"method", "path"})

// --- AI Agent metrics ---

var AgentRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "agent_requests_total",
	Help: "Total number of agent pipeline requests.",
}, []string{"action", "status"})

var AgentRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name: "agent_request_duration_seconds",
	Help: "Duration of agent pipeline requests in seconds.",
}, []string{"action"})

var LLMTokensTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "llm_tokens_total",
	Help: "Total number of LLM tokens consumed.",
}, []string{"model", "type"})

var AgentToolCallsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "agent_tool_calls_total",
	Help: "Total number of agent tool calls.",
}, []string{"tool_name", "status"})

// --- Business metrics ---

var UserRegistrationsTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "user_registrations_total",
	Help: "Total number of user registrations.",
})

var UserSubscriptionsActivatedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "user_subscriptions_activated_total",
	Help: "Total number of user subscriptions activated.",
}, []string{"plan"})

var UserSubscriptionsExpiredTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "user_subscriptions_expired_total",
	Help: "Total number of user subscriptions expired.",
}, []string{"reason"})

var PromoCodesApplied = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "promo_codes_applied_total",
	Help: "Total promo codes applied",
}, []string{"code", "type"})

var PaymentsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "payments_total",
	Help: "Total number of payments.",
}, []string{"status", "currency"})

var PaymentsAmountTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "payments_amount_total",
	Help: "Total payment amounts.",
}, []string{"currency"})

// --- Balance & Quota metrics ---

var BalanceTopUpsTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "balance_topups_total",
	Help: "Total number of balance top-ups.",
})

var BalanceTopUpsAmountTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "balance_topups_amount_total",
	Help: "Total amount of balance top-ups in USD.",
})

var BalanceChargesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "balance_charges_total",
	Help: "Total number of balance charges.",
}, []string{"charge_type"}) // "model_charge", "over_quota_charge"

var QuotaExceededTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "quota_exceeded_total",
	Help: "Total number of quota exceeded events.",
}, []string{"plan"})

var RevenueByPlanTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "revenue_by_plan_total",
	Help: "Total revenue in USD by plan.",
}, []string{"plan"}) // "pro", "pro_yearly", "balance_topup"

// --- Credits metrics ---

var CreditsGrantedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "credits_granted_usd_total",
	Help: "Total USD credits granted to users",
}, []string{"plan", "type"}) // type: daily, monthly

var CreditsExpiredTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "credits_expired_usd_total",
	Help: "Total USD credits expired (unused)",
}, []string{"plan"})

var CreditsUsedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "credits_used_usd_total",
	Help: "Total USD credits consumed by AI requests",
}, []string{"plan"})

// --- Balance (USD) metrics ---

var BalanceChargedUSDTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "balance_charged_usd_total",
	Help: "Total USD charged from user balance (beyond credits)",
}, []string{"plan"})

// --- Active users and platform balance ---

var ActiveUsersGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "active_users",
	Help: "Number of active users by plan",
}, []string{"plan"})

var TotalBalanceUSD = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "total_balance_usd",
	Help: "Sum of all user balances in USD",
})

// --- Request cost ---

var RequestCostUSD = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "request_cost_usd",
	Help:    "Cost of individual AI requests in USD",
	Buckets: []float64{0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5},
}, []string{"model", "action"})

// Init pre-initializes label combinations so CounterVec metrics are visible
// in Prometheus even before any events occur (avoids "No data" in Grafana).
func Init() {
	// Payments
	PaymentsTotal.WithLabelValues("created", "RUB")
	PaymentsTotal.WithLabelValues("confirmed", "RUB")
	PaymentsTotal.WithLabelValues("failed", "RUB")
	PaymentsTotal.WithLabelValues("created", "USD")
	PaymentsTotal.WithLabelValues("confirmed", "USD")
	PaymentsTotal.WithLabelValues("failed", "USD")
	PaymentsAmountTotal.WithLabelValues("RUB")
	PaymentsAmountTotal.WithLabelValues("USD")

	// Subscriptions
	UserSubscriptionsActivatedTotal.WithLabelValues("pro")
	UserSubscriptionsActivatedTotal.WithLabelValues("pro_yearly")
	UserSubscriptionsExpiredTotal.WithLabelValues("expired")
	UserSubscriptionsExpiredTotal.WithLabelValues("trial_expired")

	// Promo
	PromoCodesApplied.WithLabelValues("", "percent")
	PromoCodesApplied.WithLabelValues("", "amount")

	// Balance charges
	BalanceChargesTotal.WithLabelValues("model_charge")
	BalanceChargesTotal.WithLabelValues("over_quota_charge")

	// Quota exceeded
	QuotaExceededTotal.WithLabelValues("free")
	QuotaExceededTotal.WithLabelValues("pro")
	QuotaExceededTotal.WithLabelValues("pro_yearly")

	// Revenue
	RevenueByPlanTotal.WithLabelValues("pro")
	RevenueByPlanTotal.WithLabelValues("pro_yearly")
	RevenueByPlanTotal.WithLabelValues("balance_topup")

	// Credits
	CreditsGrantedTotal.WithLabelValues("free", "daily")
	CreditsGrantedTotal.WithLabelValues("pro", "monthly")
	CreditsGrantedTotal.WithLabelValues("pro_yearly", "monthly")
	CreditsExpiredTotal.WithLabelValues("free")
	CreditsExpiredTotal.WithLabelValues("pro")
	CreditsExpiredTotal.WithLabelValues("pro_yearly")
	CreditsUsedTotal.WithLabelValues("free")
	CreditsUsedTotal.WithLabelValues("pro")
	CreditsUsedTotal.WithLabelValues("pro_yearly")

	// Balance charged (beyond credits)
	BalanceChargedUSDTotal.WithLabelValues("free")
	BalanceChargedUSDTotal.WithLabelValues("pro")
	BalanceChargedUSDTotal.WithLabelValues("pro_yearly")

	// Active users
	ActiveUsersGauge.WithLabelValues("free")
	ActiveUsersGauge.WithLabelValues("pro")
	ActiveUsersGauge.WithLabelValues("pro_yearly")
}

// --- WebSocket metrics ---

var WebSocketConnectionsTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "websocket_connections_total",
	Help: "Total number of WebSocket connections.",
})

var WebSocketConnectionsActive = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "websocket_connections_active",
	Help: "Number of active WebSocket connections.",
})

var WebSocketDisconnectionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "websocket_disconnections_total",
	Help: "Total number of WebSocket disconnections.",
}, []string{"reason"})

var WebSocketMessagesReceivedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "websocket_messages_received_total",
	Help: "Total number of WebSocket messages received.",
}, []string{"message_type"})

var WebSocketMessagesSentTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "websocket_messages_sent_total",
	Help: "Total number of WebSocket messages sent.",
}, []string{"message_type"})

var WebSocketMessageSizeBytes = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "websocket_message_size_bytes",
	Help:    "Size of WebSocket messages in bytes.",
	Buckets: []float64{1024, 4096, 16384, 65536, 262144, 524288},
}, []string{"direction"})

var WebSocketPendingToolWaiters = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "websocket_pending_tool_waiters",
	Help: "Number of pending tool result waiters.",
})

var WebSocketActiveRequests = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "websocket_active_requests",
	Help: "Number of active agent requests.",
})

var WebSocketCancellationsTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "websocket_cancellations_total",
	Help: "Total number of WebSocket request cancellations.",
})

var WebSocketSendBufferDropsTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "websocket_send_buffer_drops_total",
	Help: "Total number of messages dropped due to full send buffer.",
})

// --- DB Pool metrics ---

var DBPoolConnectionsActive = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "db_pool_connections_active",
	Help: "Number of active database pool connections.",
})

var DBPoolConnectionsIdle = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "db_pool_connections_idle",
	Help: "Number of idle database pool connections.",
})

// --- Landing page metrics ---

var LandingPageViews = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "landing_page_views_total",
	Help: "Total landing page views.",
}, []string{"referrer_domain", "utm_source", "country"})

var LandingButtonClicks = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "landing_button_clicks_total",
	Help: "Landing page button clicks.",
}, []string{"button_id"})

var LandingScrollDepth = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "landing_scroll_depth_total",
	Help: "Landing page scroll depth milestones reached.",
}, []string{"percent"})

var LandingVideoEvents = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "landing_video_events_total",
	Help: "Landing page video events.",
}, []string{"action"})

var LandingDownloads = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "landing_downloads_total",
	Help: "Landing page download button clicks by platform.",
}, []string{"platform"})

var LandingUniqueSessions = promauto.NewCounter(prometheus.CounterOpts{
	Name: "landing_unique_sessions_total",
	Help: "Total unique landing page sessions.",
})
