package websocket

import "sync"

// Conn represents a WebSocket connection managed by the Hub.
// This is an interface to allow mock implementations in tests.
type Conn interface {
	// SessionID returns the unique session identifier for this connection.
	SessionID() string
	// Close closes the underlying WebSocket connection.
	Close() error
}

// Hub manages a set of active WebSocket connections, keyed by session_id.
// All methods are safe for concurrent use.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]Conn
	// models stores the LLM model selected at session creation time, keyed by session_id.
	models map[string]string
	// userIDs stores the user_id from JWT claims at session creation time, keyed by session_id.
	userIDs map[string]string
}

// NewHub creates a new Hub ready to accept connections.
func NewHub() *Hub {
	return &Hub{
		conns:   make(map[string]Conn),
		models:  make(map[string]string),
		userIDs: make(map[string]string),
	}
}

// Register adds a connection to the hub. If a connection with the same
// session_id already exists, it is replaced (the old connection is not closed).
func (h *Hub) Register(conn Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conns[conn.SessionID()] = conn
}

// Unregister removes a connection from the hub by session_id.
// Returns true if the connection was found and removed.
func (h *Hub) Unregister(sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.conns[sessionID]; ok {
		delete(h.conns, sessionID)
		delete(h.models, sessionID)
		delete(h.userIDs, sessionID)
		return true
	}
	return false
}

// SetModel stores the LLM model for a session_id.
func (h *Hub) SetModel(sessionID, model string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.models[sessionID] = model
}

// GetModel returns the LLM model for a session_id, or empty string if not set.
func (h *Hub) GetModel(sessionID string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.models[sessionID]
}

// SetUserID stores the user_id for a session_id.
func (h *Hub) SetUserID(sessionID, userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.userIDs[sessionID] = userID
}

// GetUserID returns the user_id for a session_id, or empty string if not set.
func (h *Hub) GetUserID(sessionID string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.userIDs[sessionID]
}

// Get returns the connection for the given session_id, or nil if not found.
func (h *Hub) Get(sessionID string) Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.conns[sessionID]
}

// Len returns the number of active connections.
func (h *Hub) Len() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// All returns a snapshot of all active connections.
func (h *Hub) All() []Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	result := make([]Conn, 0, len(h.conns))
	for _, c := range h.conns {
		result = append(result, c)
	}
	return result
}

// CloseAll closes all registered connections and removes them from the hub.
// Returns the number of connections that were closed.
func (h *Hub) CloseAll() int {
	h.mu.Lock()
	conns := make([]Conn, 0, len(h.conns))
	for _, c := range h.conns {
		conns = append(conns, c)
	}
	h.conns = make(map[string]Conn)
	h.models = make(map[string]string)
	h.userIDs = make(map[string]string)
	h.mu.Unlock()

	for _, c := range conns {
		_ = c.Close()
	}
	return len(conns)
}
