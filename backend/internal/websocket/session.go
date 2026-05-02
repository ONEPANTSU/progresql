package websocket

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	ws "github.com/gorilla/websocket"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"go.uber.org/zap"
)

const (
	// writeWait is the time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// pongWait is the time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// pingPeriod sends pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// maxMessageSize is the maximum message size allowed from peer.
	maxMessageSize = 512 * 1024 // 512 KB

	// sendBufferSize is the channel buffer size for outgoing messages.
	sendBufferSize = 64
)

// MessageHandler is a callback invoked for each incoming message routed by type.
type MessageHandler func(env *Envelope)

// HistoryMessage represents a single message in the conversation history.
// Uses Role ("user" or "assistant") and Content to avoid coupling websocket to the llm package.
type HistoryMessage struct {
	Role    string
	Content string
}

// MaxHistoryMessages is the maximum number of messages stored per session.
const MaxHistoryMessages = 20

// Session represents a single WebSocket client session.
// It manages read and write goroutines, a send channel for outgoing messages,
// and a map of pending tool.result channels keyed by call_id.
type Session struct {
	id     string
	model  string
	userID string
	conn   *ws.Conn
	hub   *Hub
	log   *zap.Logger

	// send is the buffered channel for outgoing messages.
	send chan []byte

	// toolResults stores channels waiting for tool.result responses, keyed by call_id.
	toolResults   map[string]chan *Envelope
	toolResultsMu sync.Mutex

	// cancelFuncs stores context cancel functions for active requests, keyed by request_id.
	cancelFuncs   map[string]context.CancelFunc
	cancelFuncsMu sync.Mutex

	// history stores conversation messages for multi-turn context (up to MaxHistoryMessages).
	history   []HistoryMessage
	historyMu sync.RWMutex

	// onMessage is called for each incoming message that is not a tool.result.
	onMessage MessageHandler

	// done is closed when the session shuts down.
	done chan struct{}
	once sync.Once
}

// NewSession creates a new Session wrapping a gorilla/websocket connection.
func NewSession(id string, conn *ws.Conn, hub *Hub, logger *zap.Logger, onMessage MessageHandler) *Session {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Session{
		id:          id,
		conn:        conn,
		hub:         hub,
		log:         logger.With(zap.String("session_id", id)),
		send:        make(chan []byte, sendBufferSize),
		toolResults: make(map[string]chan *Envelope),
		cancelFuncs: make(map[string]context.CancelFunc),
		onMessage:   onMessage,
		done:        make(chan struct{}),
	}
}

// SessionID implements the Conn interface.
func (s *Session) SessionID() string {
	return s.id
}

// Model returns the LLM model associated with this session.
func (s *Session) Model() string {
	return s.model
}

// SetModel sets the LLM model for this session.
func (s *Session) SetModel(model string) {
	s.model = model
}

// UserID returns the user ID associated with this session.
func (s *Session) UserID() string {
	return s.userID
}

// SetUserID sets the user ID for this session.
func (s *Session) SetUserID(userID string) {
	s.userID = userID
}

// SetMessageHandler sets the callback for incoming messages (except tool.result).
// Must be called before Run().
func (s *Session) SetMessageHandler(h MessageHandler) {
	s.onMessage = h
}

// AddHistory appends a message to the conversation history.
// If the history exceeds MaxHistoryMessages, the oldest messages are trimmed.
func (s *Session) AddHistory(role, content string) {
	s.historyMu.Lock()
	s.history = append(s.history, HistoryMessage{Role: role, Content: content})
	if len(s.history) > MaxHistoryMessages {
		s.history = s.history[len(s.history)-MaxHistoryMessages:]
	}
	s.historyMu.Unlock()
}

// GetHistory returns a copy of the conversation history.
func (s *Session) GetHistory() []HistoryMessage {
	s.historyMu.RLock()
	cp := make([]HistoryMessage, len(s.history))
	copy(cp, s.history)
	s.historyMu.RUnlock()
	return cp
}

// ClearHistory removes all messages from the conversation history.
func (s *Session) ClearHistory() {
	s.historyMu.Lock()
	s.history = nil
	s.historyMu.Unlock()
}

// Close shuts down the session, closing the WebSocket connection and the send channel.
func (s *Session) Close() error {
	var err error
	s.once.Do(func() {
		close(s.done)
		err = s.conn.Close()

		// Cancel all active requests.
		s.cancelFuncsMu.Lock()
		for reqID, cancel := range s.cancelFuncs {
			cancel()
			delete(s.cancelFuncs, reqID)
		}
		s.cancelFuncsMu.Unlock()

		// Unblock any pending tool.result waiters.
		s.toolResultsMu.Lock()
		for callID, ch := range s.toolResults {
			close(ch)
			delete(s.toolResults, callID)
		}
		s.toolResultsMu.Unlock()
	})
	return err
}

// Send enqueues a pre-marshaled message for writing to the WebSocket.
// Returns false if the session is closed or the send buffer is full.
func (s *Session) Send(data []byte) bool {
	// Priority check: always prefer the closed signal over the buffer.
	select {
	case <-s.done:
		return false
	default:
	}
	select {
	case <-s.done:
		return false
	case s.send <- data:
		return true
	default:
		// Buffer full — drop message.
		s.log.Warn("send buffer full, dropping message")
		metrics.WebSocketSendBufferDropsTotal.Inc()
		return false
	}
}

// SendEnvelope marshals an Envelope and enqueues it for writing.
func (s *Session) SendEnvelope(env *Envelope) error {
	data, err := env.Marshal()
	if err != nil {
		return err
	}
	if !s.Send(data) {
		return ErrSessionClosed
	}
	return nil
}

// RegisterToolWaiter creates a channel that will receive the tool.result for the given call_id.
func (s *Session) RegisterToolWaiter(callID string) <-chan *Envelope {
	ch := make(chan *Envelope, 1)
	s.toolResultsMu.Lock()
	s.toolResults[callID] = ch
	s.toolResultsMu.Unlock()
	metrics.WebSocketPendingToolWaiters.Inc()
	return ch
}

// UnregisterToolWaiter removes a tool.result waiter for the given call_id.
func (s *Session) UnregisterToolWaiter(callID string) {
	s.toolResultsMu.Lock()
	delete(s.toolResults, callID)
	s.toolResultsMu.Unlock()
	metrics.WebSocketPendingToolWaiters.Dec()
}

// Run starts the read and write goroutines. It blocks until the session is closed.
func (s *Session) Run() {
	go s.writePump()
	s.readPump() // blocks
}

// readPump reads messages from the WebSocket and routes them by type.
func (s *Session) readPump() {
	defer func() {
		if s.hub != nil {
			s.hub.Unregister(s.id)
		}
		_ = s.Close()
		metrics.WebSocketDisconnectionsTotal.WithLabelValues("read_pump_exit").Inc()
	}()

	s.conn.SetReadLimit(maxMessageSize)
	_ = s.conn.SetReadDeadline(time.Now().Add(pongWait))
	s.conn.SetPongHandler(func(string) error {
		_ = s.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := s.conn.ReadMessage()
		if err != nil {
			if ws.IsUnexpectedCloseError(err, ws.CloseGoingAway, ws.CloseNormalClosure) {
				s.log.Warn("unexpected websocket close", zap.Error(err))
			}
			return
		}

		// Prometheus: track received message size.
		metrics.WebSocketMessageSizeBytes.WithLabelValues("received").Observe(float64(len(message)))

		env, err := ParseEnvelope(message)
		if err != nil {
			s.log.Warn("invalid message envelope", zap.Error(err))
			s.sendError("", ErrCodeInvalidRequest, "invalid message format")
			continue
		}

		s.routeMessage(env)
	}
}

// RegisterCancel stores a cancel function for the given request_id.
// Called by the pipeline when starting a cancellable request.
func (s *Session) RegisterCancel(requestID string, cancel context.CancelFunc) {
	s.cancelFuncsMu.Lock()
	s.cancelFuncs[requestID] = cancel
	s.cancelFuncsMu.Unlock()
	metrics.WebSocketActiveRequests.Inc()
}

// UnregisterCancel removes and returns the cancel function for the given request_id.
func (s *Session) UnregisterCancel(requestID string) {
	s.cancelFuncsMu.Lock()
	delete(s.cancelFuncs, requestID)
	s.cancelFuncsMu.Unlock()
	metrics.WebSocketActiveRequests.Dec()
}

// routeMessage dispatches an incoming envelope by type.
func (s *Session) routeMessage(env *Envelope) {
	metrics.WebSocketMessagesReceivedTotal.WithLabelValues(env.Type).Inc()

	switch env.Type {
	case TypeToolResult:
		s.handleToolResult(env)
	case TypeAgentCancel:
		s.handleAgentCancel(env)
	default:
		if s.onMessage != nil {
			s.onMessage(env)
		}
	}
}

// handleAgentCancel cancels the context for an active request.
func (s *Session) handleAgentCancel(env *Envelope) {
	requestID := env.RequestID
	if requestID == "" {
		s.log.Warn("agent.cancel missing request_id")
		return
	}

	s.cancelFuncsMu.Lock()
	cancel, ok := s.cancelFuncs[requestID]
	if ok {
		delete(s.cancelFuncs, requestID)
	}
	s.cancelFuncsMu.Unlock()

	if ok {
		s.log.Info("cancelling request", zap.String("request_id", requestID))
		cancel()
		metrics.WebSocketCancellationsTotal.Inc()
	} else {
		s.log.Warn("no active request to cancel", zap.String("request_id", requestID))
	}
}

// handleToolResult delivers a tool.result to the waiting channel.
func (s *Session) handleToolResult(env *Envelope) {
	callID := env.CallID
	if callID == "" {
		s.log.Warn("tool.result missing call_id")
		return
	}

	s.toolResultsMu.Lock()
	ch, ok := s.toolResults[callID]
	if ok {
		delete(s.toolResults, callID)
	}
	s.toolResultsMu.Unlock()

	if !ok {
		s.log.Warn("no waiter for tool.result", zap.String("call_id", callID))
		return
	}

	select {
	case ch <- env:
	default:
		s.log.Warn("tool.result channel full", zap.String("call_id", callID))
	}
}

// writePump pumps messages from the send channel to the WebSocket connection.
func (s *Session) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = s.Close()
	}()

	for {
		select {
		case <-s.done:
			_ = s.conn.WriteMessage(ws.CloseMessage,
				ws.FormatCloseMessage(ws.CloseNormalClosure, ""))
			return

		case message, ok := <-s.send:
			if !ok {
				return
			}
			_ = s.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := s.conn.WriteMessage(ws.TextMessage, message); err != nil {
				s.log.Warn("write error", zap.Error(err))
				return
			}

			// Prometheus: track sent message size and count.
			metrics.WebSocketMessageSizeBytes.WithLabelValues("sent").Observe(float64(len(message)))
			metrics.WebSocketMessagesSentTotal.WithLabelValues("text").Inc()

		case <-ticker.C:
			_ = s.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := s.conn.WriteMessage(ws.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// sendError sends an agent.error envelope to the client.
func (s *Session) sendError(requestID, code, message string) {
	payload := AgentErrorPayload{Code: code, Message: message}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	env := &Envelope{
		Type:      TypeAgentError,
		RequestID: requestID,
		Payload:   raw,
	}
	_ = s.SendEnvelope(env)
}

// errSessionClosed is a sentinel error.
type errSessionClosed struct{}

func (errSessionClosed) Error() string { return "session closed" }

// ErrSessionClosed is returned when trying to send on a closed session.
var ErrSessionClosed error = errSessionClosed{}
