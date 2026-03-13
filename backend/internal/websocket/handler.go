package websocket

import (
	"net/http"
	"strings"

	ws "github.com/gorilla/websocket"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"go.uber.org/zap"
)

var upgrader = ws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // allow all origins for development; tighten in production
	},
}

// SessionHandlerFactory creates a MessageHandler for each new session.
// This allows per-session state (e.g., the pipeline can reference the session).
// If nil, onMessage falls back to the static MessageHandler parameter.
type SessionHandlerFactory func(session *Session) MessageHandler

// HandleWebSocket returns an HTTP handler that upgrades connections to WebSocket
// at the path /ws/<session_id>?token=<JWT>.
//
// It validates the JWT, checks that the session_id exists in the Hub,
// upgrades the connection, creates a Session, and registers it in the Hub.
//
// The factory parameter, if non-nil, is called to create a per-session message handler.
// If factory is nil, the static onMessage handler is used instead.
func HandleWebSocket(hub *Hub, jwtSvc *auth.JWTService, log *zap.Logger, onMessage MessageHandler, factory ...SessionHandlerFactory) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract session_id from URL path: /ws/{session_id}
		sessionID := strings.TrimPrefix(r.URL.Path, "/ws/")
		if sessionID == "" || sessionID == r.URL.Path {
			http.Error(w, `{"error":"missing session_id"}`, http.StatusBadRequest)
			return
		}

		// Validate JWT from query parameter
		token := r.URL.Query().Get("token")
		if token == "" {
			http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
			return
		}

		_, err := jwtSvc.ValidateToken(token)
		if err != nil {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		// Check that the session exists in the Hub (created via POST /api/v1/sessions)
		existing := hub.Get(sessionID)
		if existing == nil {
			http.Error(w, `{"error":"session not found"}`, http.StatusNotFound)
			return
		}

		// Upgrade HTTP → WebSocket
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Error("websocket upgrade failed", zap.Error(err), zap.String("session_id", sessionID))
			return
		}

		// Determine the message handler for this session.
		handler := onMessage
		if len(factory) > 0 && factory[0] != nil {
			// Temporarily create session to pass to factory, then set the handler.
			session := NewSession(sessionID, conn, hub, log, nil)
			// Transfer metadata from hub (set during POST /api/v1/sessions) to the real session.
			if model := hub.GetModel(sessionID); model != "" {
				session.SetModel(model)
			}
			if userID := hub.GetUserID(sessionID); userID != "" {
				session.SetUserID(userID)
			}
			handler = factory[0](session)
			session.SetMessageHandler(handler)
			hub.Register(session)

			log.Info("websocket connected", zap.String("session_id", sessionID))
			session.Run()
			return
		}

		// Create a real Session and register it in the Hub (replaces the placeholder)
		session := NewSession(sessionID, conn, hub, log, handler)
		if model := hub.GetModel(sessionID); model != "" {
			session.SetModel(model)
		}
		if userID := hub.GetUserID(sessionID); userID != "" {
			session.SetUserID(userID)
		}
		hub.Register(session)

		log.Info("websocket connected", zap.String("session_id", sessionID))

		// Run blocks until the session closes.
		session.Run()
	}
}
