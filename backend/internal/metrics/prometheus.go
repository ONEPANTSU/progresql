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

var PaymentsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "payments_total",
	Help: "Total number of payments.",
}, []string{"status", "currency"})

var PaymentsAmountTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "payments_amount_total",
	Help: "Total payment amounts.",
}, []string{"currency"})

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
