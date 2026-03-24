package rest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"github.com/onepantsu/progressql/backend/internal/subscription"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// healthHandler returns a handler that responds with service status and version.
func healthHandler(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(healthResponse{
			Status:  "ok",
			Version: version,
		})
	}
}

type authTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// authTokenHandler returns a handler that issues a JWT for the local desktop client.
// No API key validation — the LLM API key lives on the backend only.
func authTokenHandler(jwtSvc *auth.JWTService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		sessionID := uuid.New().String()
		token, err := jwtSvc.GenerateToken(sessionID)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(authTokenResponse{
			Token:     token,
			ExpiresAt: expiresAt,
		})
	}
}

type registerRequest struct {
	Name             string `json:"name"`
	Email            string `json:"email"`
	Password         string `json:"password"`
	MarketingConsent bool   `json:"marketing_consent"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authUserResponse struct {
	Token     string   `json:"token"`
	ExpiresAt string   `json:"expires_at"`
	User      userInfo `json:"user"`
}

type userInfo struct {
	ID                  string  `json:"id"`
	Email               string  `json:"email"`
	Name                string  `json:"name"`
	EmailVerified       bool    `json:"email_verified"`
	Plan                string  `json:"plan"`
	PlanExpiresAt       *string `json:"plan_expires_at,omitempty"`
	TrialEndsAt         *string `json:"trial_ends_at,omitempty"`
	SubscriptionWarning string  `json:"subscription_warning,omitempty"`
	MarketingConsent    bool    `json:"marketing_consent"`
}

func userInfoFromUser(user *auth.User) userInfo {
	plan := user.Plan
	if plan == "" {
		plan = "free"
	}

	// Compute subscription warning from expiry dates.
	var planExp, trialEnd *time.Time
	if user.PlanExpiresAt != nil {
		if t, err := time.Parse(time.RFC3339, *user.PlanExpiresAt); err == nil {
			planExp = &t
		}
	}
	if user.TrialEndsAt != nil {
		if t, err := time.Parse(time.RFC3339, *user.TrialEndsAt); err == nil {
			trialEnd = &t
		}
	}
	warning := subscription.CheckWarning(plan, planExp, trialEnd)

	return userInfo{
		ID:                  user.ID,
		Email:               user.Email,
		Name:                user.Name,
		EmailVerified:       user.EmailVerified,
		Plan:                plan,
		PlanExpiresAt:       user.PlanExpiresAt,
		TrialEndsAt:         user.TrialEndsAt,
		SubscriptionWarning: string(warning),
		MarketingConsent:    user.MarketingConsent,
	}
}

// registerHandler creates a new user account and returns a JWT.
// If the email is already registered but not verified, it updates credentials and resends the verification code.
func registerHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		user, err := userStore.Register(req.Name, req.Email, req.Password, req.MarketingConsent)
		if err != nil {
			switch {
			case errors.Is(err, auth.ErrEmailAlreadyVerified):
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(errorResponse{Error: "Email already registered"})
			case errors.Is(err, auth.ErrUserExists):
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(errorResponse{Error: "Email already registered"})
			case errors.Is(err, auth.ErrInvalidInput):
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			default:
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to register user"})
			}
			return
		}

		// Prometheus: track successful user registration.
		metrics.UserRegistrationsTotal.Inc()

		// For unverified users (re-registration), resend verification code (async to avoid blocking).
		if !user.EmailVerified && emailSvc != nil && emailSvc.IsConfigured() {
			code, codeErr := emailSvc.GenerateCode(user.ID, user.Email)
			if codeErr == nil {
				go emailSvc.SendVerificationEmail(user.Email, code)
			}
		}

		token, err := jwtSvc.GenerateUserToken(user)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(authUserResponse{
			Token:     token,
			ExpiresAt: expiresAt,
			User:      userInfoFromUser(user),
		})
	}
}

// loginHandler authenticates a user and returns a JWT.
func loginHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		user, err := userStore.Authenticate(req.Email, req.Password)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "Неверный email или пароль"})
			return
		}

		token, err := jwtSvc.GenerateUserToken(user)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(authUserResponse{
			Token:     token,
			ExpiresAt: expiresAt,
			User:      userInfoFromUser(user),
		})
	}
}

// profileHandler returns the authenticated user's profile.
func profileHandler(userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		// Try to fetch fresh data from store (for email_verified status).
		if claims.UserID != "" {
			if user, err := userStore.GetByID(claims.UserID); err == nil {
				w.WriteHeader(http.StatusOK)
				json.NewEncoder(w).Encode(userInfoFromUser(user))
				return
			}
		}

		// Fallback to claims (anonymous sessions, etc.).
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userInfo{
			ID:    claims.UserID,
			Email: claims.Email,
			Name:  claims.Name,
			Plan:  "free",
		})
	}
}

type sendVerificationRequest struct {
	// empty — uses JWT claims to determine user
}

type sendVerificationResponse struct {
	Message string `json:"message"`
}

// sendVerificationHandler sends a verification code email to the authenticated user.
func sendVerificationHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		user, err := userStore.GetByID(claims.UserID)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		if user.EmailVerified {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "email already verified"})
			return
		}

		if !emailSvc.IsConfigured() {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(errorResponse{Error: "email service not configured"})
			return
		}

		code, err := emailSvc.GenerateCode(user.ID, user.Email)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate verification code"})
			return
		}

		if err := emailSvc.SendVerificationEmail(user.Email, code); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to send verification email"})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(sendVerificationResponse{
			Message: fmt.Sprintf("Verification code sent to %s", user.Email),
		})
	}
}

type verifyCodeRequest struct {
	Code string `json:"code"`
}

type verifyCodeResponse struct {
	Verified bool `json:"verified"`
}

// verifyCodeHandler checks a verification code submitted by the authenticated user.
func verifyCodeHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		var req verifyCodeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "code is required"})
			return
		}

		if err := emailSvc.VerifyCode(claims.UserID, req.Code); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		if err := userStore.SetEmailVerified(claims.UserID); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to update verification status"})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(verifyCodeResponse{Verified: true})
	}
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// forgotPasswordHandler sends a password reset code to the user's email.
func forgotPasswordHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req forgotPasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "email is required"})
			return
		}

		// Always return success to prevent email enumeration
		user, err := userStore.GetByEmail(req.Email)
		if err != nil {
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"message": "If this email is registered, a reset code has been sent"})
			return
		}

		if !emailSvc.IsConfigured() {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(errorResponse{Error: "email service not configured"})
			return
		}

		code, err := emailSvc.GenerateResetCode(user.Email)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate reset code"})
			return
		}

		if err := emailSvc.SendPasswordResetEmail(user.Email, code); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to send reset email"})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"message": "If this email is registered, a reset code has been sent"})
	}
}

type resetPasswordRequest struct {
	Email       string `json:"email"`
	Code        string `json:"code"`
	NewPassword string `json:"new_password"`
}

// resetPasswordHandler verifies the reset code and updates the user's password.
func resetPasswordHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req resetPasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		if req.Email == "" || req.Code == "" || req.NewPassword == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "email, code, and new_password are required"})
			return
		}

		if err := emailSvc.VerifyResetCode(req.Email, req.Code); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		user, err := userStore.GetByEmail(req.Email)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		if err := userStore.UpdatePassword(user.ID, req.NewPassword); err != nil {
			if errors.Is(err, auth.ErrInvalidInput) {
				w.WriteHeader(http.StatusBadRequest)
			} else {
				w.WriteHeader(http.StatusInternalServerError)
			}
			json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"message": "Password updated successfully"})
	}
}

type dbContext struct {
	DBName    string `json:"db_name"`
	DBVersion string `json:"db_version"`
}

type createSessionRequest struct {
	Model     string    `json:"model"`
	DBContext dbContext `json:"db_context"`
}

type createSessionResponse struct {
	SessionID           string `json:"session_id"`
	WSURL               string `json:"ws_url"`
	SubscriptionWarning string `json:"subscription_warning,omitempty"`
}

// createSessionHandler returns a handler that creates a new agent session.
// Requires JWT authentication (claims must be in context).
func createSessionHandler(hub *websocket.Hub, serverPort string, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		var req createSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		sessionID := uuid.New().String()

		// Register a placeholder connection in the hub so the session_id is reserved.
		// The actual WebSocket connection will replace it when the client connects via TASK-013.
		hub.Register(&placeholder{sessionID: sessionID})

		// Store the model selected by the client for this session.
		if req.Model != "" {
			hub.SetModel(sessionID, req.Model)
		}

		// Store the user ID from JWT claims for token usage tracking.
		if claims.UserID != "" {
			hub.SetUserID(sessionID, claims.UserID)
		}

		// Build ws_url dynamically from the incoming request Host header.
		scheme := "ws"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "wss"
		}
		host := r.Host
		if host == "" {
			host = fmt.Sprintf("localhost:%s", serverPort)
		}
		wsURL := fmt.Sprintf("%s://%s/ws/%s", scheme, host, sessionID)

		// Check subscription warning for authenticated users.
		var warning string
		if claims.UserID != "" && userStore != nil {
			if user, err := userStore.GetByID(claims.UserID); err == nil {
				info := userInfoFromUser(user)
				warning = info.SubscriptionWarning
			}
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(createSessionResponse{
			SessionID:           sessionID,
			WSURL:               wsURL,
			SubscriptionWarning: warning,
		})
	}
}

// placeholder implements websocket.Conn for reserving a session_id in the Hub
// before the real WebSocket connection is established.
type placeholder struct {
	sessionID string
}

func (p *placeholder) SessionID() string { return p.sessionID }
func (p *placeholder) Close() error      { return nil }

type modelResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	IsDefault bool   `json:"is_default"`
}

type modelsListResponse struct {
	Models []modelResponse `json:"models"`
}

// modelsHandler returns a handler that responds with the list of available LLM models.
func modelsHandler(models []config.ModelInfo, defaultModel string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		resp := modelsListResponse{
			Models: make([]modelResponse, 0, len(models)),
		}

		for _, m := range models {
			resp.Models = append(resp.Models, modelResponse{
				ID:        m.ID,
				Name:      m.Name,
				Provider:  m.Provider,
				IsDefault: m.ID == defaultModel,
			})
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}
}

// --- Legal document handlers ---

type legalDocumentResponse struct {
	ID          string  `json:"id"`
	DocType     string  `json:"doc_type"`
	Version     string  `json:"version"`
	Title       string  `json:"title"`
	Language    string  `json:"language"`
	ContentHTML string  `json:"content_html"`
	PublishedAt *string `json:"published_at,omitempty"`
	EffectiveAt *string `json:"effective_at,omitempty"`
}

// legalDocumentHandler returns the active legal document for the given type.
// GET /api/v1/legal/{type} — returns the latest active document.
// GET /api/v1/legal/{type}/{version} — returns a specific version.
func legalDocumentHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		docType := r.PathValue("type")
		if docType == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing document type"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		version := r.PathValue("version")
		lang := r.URL.Query().Get("lang")
		if lang == "" {
			lang = "ru"
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		var doc legalDocumentResponse
		var publishedAt, effectiveAt *time.Time

		if version != "" {
			// Specific version requested.
			err := db.QueryRow(ctx, `
				SELECT id, doc_type, version, title, language, content_html, published_at, effective_at
				FROM legal_documents
				WHERE doc_type = $1 AND version = $2 AND language = $3`,
				docType, version, lang,
			).Scan(&doc.ID, &doc.DocType, &doc.Version, &doc.Title, &doc.Language, &doc.ContentHTML, &publishedAt, &effectiveAt)
			if err != nil {
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(errorResponse{Error: "document not found"})
				return
			}
		} else {
			// Latest active document.
			err := db.QueryRow(ctx, `
				SELECT id, doc_type, version, title, language, content_html, published_at, effective_at
				FROM legal_documents
				WHERE doc_type = $1 AND language = $2 AND is_active = TRUE
				ORDER BY effective_at DESC NULLS LAST, created_at DESC
				LIMIT 1`,
				docType, lang,
			).Scan(&doc.ID, &doc.DocType, &doc.Version, &doc.Title, &doc.Language, &doc.ContentHTML, &publishedAt, &effectiveAt)
			if err != nil {
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(errorResponse{Error: "document not found"})
				return
			}
		}

		if publishedAt != nil {
			s := publishedAt.UTC().Format(time.RFC3339)
			doc.PublishedAt = &s
		}
		if effectiveAt != nil {
			s := effectiveAt.UTC().Format(time.RFC3339)
			doc.EffectiveAt = &s
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(doc)
	}
}

type legalAcceptRequest struct {
	DocType    string `json:"doc_type"`
	DocVersion string `json:"doc_version"`
	Source     string `json:"source"`
}

type legalAcceptResponse struct {
	Accepted bool `json:"accepted"`
}

// legalAcceptHandler records user acceptance of a legal document.
// POST /api/v1/legal/accept — requires JWT authentication.
func legalAcceptHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "authentication required"})
			return
		}

		var req legalAcceptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		if req.DocType == "" || req.DocVersion == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "doc_type and doc_version are required"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		source := req.Source
		if source == "" {
			source = "app"
		}

		ip := r.Header.Get("X-Forwarded-For")
		if ip == "" {
			ip = r.RemoteAddr
		}
		userAgent := r.Header.Get("User-Agent")

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		_, err := db.Exec(ctx, `
			INSERT INTO legal_acceptances (user_id, doc_type, doc_version, source, ip, user_agent)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			claims.UserID, req.DocType, req.DocVersion, source, ip, userAgent,
		)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to record acceptance"})
			return
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(legalAcceptResponse{Accepted: true})
	}
}

// --- Admin analytics handlers ---

// adminMiddleware restricts access to a set of admin user IDs.
func adminMiddleware(adminIDs []string, next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(adminIDs))
	for _, id := range adminIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			allowed[trimmed] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" || !allowed[claims.UserID] {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(errorResponse{Error: "admin access required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

type analyticsUserSummary struct {
	UserID           string  `json:"user_id"`
	Email            string  `json:"email"`
	Name             string  `json:"name"`
	TotalRequests    int     `json:"total_requests"`
	TotalTokens      int64   `json:"total_tokens"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalCostUSD     float64 `json:"total_cost_usd"`
}

type analyticsUsersResponse struct {
	Users []analyticsUserSummary `json:"users"`
	Month string                 `json:"month,omitempty"`
}

// analyticsUsersHandler returns aggregated token usage per user.
// Supports ?month=YYYY-MM query parameter for filtering.
func analyticsUsersHandler(db *pgxpool.Pool, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		month := r.URL.Query().Get("month")

		query := `
			SELECT user_id,
				COUNT(*)             AS total_requests,
				COALESCE(SUM(total_tokens), 0)      AS total_tokens,
				COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
				COALESCE(SUM(completion_tokens), 0)  AS completion_tokens,
				COALESCE(SUM(cost_usd), 0)           AS total_cost_usd
			FROM token_usage`

		var args []interface{}
		if month != "" {
			query += ` WHERE to_char(created_at, 'YYYY-MM') = $1`
			args = append(args, month)
		}
		query += ` GROUP BY user_id ORDER BY total_cost_usd DESC`

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to query analytics"})
			return
		}
		defer rows.Close()

		users := make([]analyticsUserSummary, 0)
		for rows.Next() {
			var s analyticsUserSummary
			if err := rows.Scan(&s.UserID, &s.TotalRequests, &s.TotalTokens, &s.PromptTokens, &s.CompletionTokens, &s.TotalCostUSD); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to scan row"})
				return
			}
			// Enrich with user info from store.
			if user, err := userStore.GetByID(s.UserID); err == nil {
				s.Email = user.Email
				s.Name = user.Name
			}
			users = append(users, s)
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(analyticsUsersResponse{Users: users, Month: month})
	}
}

type analyticsMonthBreakdown struct {
	Month            string  `json:"month"`
	TotalRequests    int     `json:"total_requests"`
	TotalTokens      int64   `json:"total_tokens"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalCostUSD     float64 `json:"total_cost_usd"`
}

type analyticsUserDetailResponse struct {
	UserID           string                    `json:"user_id"`
	Email            string                    `json:"email"`
	Name             string                    `json:"name"`
	TotalRequests    int                       `json:"total_requests"`
	TotalTokens      int64                     `json:"total_tokens"`
	PromptTokens     int64                     `json:"prompt_tokens"`
	CompletionTokens int64                     `json:"completion_tokens"`
	TotalCostUSD     float64                   `json:"total_cost_usd"`
	Months           []analyticsMonthBreakdown `json:"months"`
}

// analyticsUserDetailHandler returns detailed token usage for a specific user with monthly breakdown.
func analyticsUserDetailHandler(db *pgxpool.Pool, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		userID := r.PathValue("id")
		if userID == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing user_id in path"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// Overall totals for the user.
		totalQuery := `
			SELECT COUNT(*),
				COALESCE(SUM(total_tokens), 0),
				COALESCE(SUM(prompt_tokens), 0),
				COALESCE(SUM(completion_tokens), 0),
				COALESCE(SUM(cost_usd), 0)
			FROM token_usage WHERE user_id = $1`

		resp := analyticsUserDetailResponse{
			UserID: userID,
			Months: make([]analyticsMonthBreakdown, 0),
		}

		err := db.QueryRow(ctx, totalQuery, userID).Scan(
			&resp.TotalRequests, &resp.TotalTokens, &resp.PromptTokens,
			&resp.CompletionTokens, &resp.TotalCostUSD,
		)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to query user totals"})
			return
		}

		// Enrich with user info.
		if user, userErr := userStore.GetByID(userID); userErr == nil {
			resp.Email = user.Email
			resp.Name = user.Name
		}

		// Monthly breakdown.
		monthQuery := `
			SELECT to_char(created_at, 'YYYY-MM') AS month,
				COUNT(*),
				COALESCE(SUM(total_tokens), 0),
				COALESCE(SUM(prompt_tokens), 0),
				COALESCE(SUM(completion_tokens), 0),
				COALESCE(SUM(cost_usd), 0)
			FROM token_usage WHERE user_id = $1
			GROUP BY month ORDER BY month DESC`

		rows, err := db.Query(ctx, monthQuery, userID)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to query monthly breakdown"})
			return
		}
		defer rows.Close()

		for rows.Next() {
			var m analyticsMonthBreakdown
			if err := rows.Scan(&m.Month, &m.TotalRequests, &m.TotalTokens, &m.PromptTokens, &m.CompletionTokens, &m.TotalCostUSD); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to scan month row"})
				return
			}
			resp.Months = append(resp.Months, m)
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}
}
