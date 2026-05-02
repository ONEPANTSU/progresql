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
	"github.com/onepantsu/progressql/backend/internal/models"
	"github.com/onepantsu/progressql/backend/internal/subscription"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// healthHandler returns a handler that responds with service status and version.
//
// @Summary      Health check
// @Description  Returns service status and current version
// @Tags         system
// @Produce      json
// @Success      200  {object}  healthResponse
// @Router       /api/v1/health [get]
func healthHandler(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(healthResponse{
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
//
// @Summary      Issue anonymous JWT
// @Description  Issues a short-lived JWT for the local desktop client (no credentials required)
// @Tags         auth
// @Produce      json
// @Success      200  {object}  authTokenResponse
// @Failure      500  {object}  errorResponse
// @Router       /api/v1/auth/token [post]
func authTokenHandler(jwtSvc *auth.JWTService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		sessionID := uuid.New().String()
		token, err := jwtSvc.GenerateToken(sessionID)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(authTokenResponse{
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

	// Normalize expired paid plans: if plan is paid but plan_expires_at is in the past,
	// treat as "free" so the client sees the correct effective plan.
	effectivePlan := plan
	if plan != "free" && plan != "trial" && planExp != nil && time.Now().After(*planExp) {
		effectivePlan = "free"
	}

	warning := subscription.CheckWarning(effectivePlan, planExp, trialEnd)

	return userInfo{
		ID:                  user.ID,
		Email:               user.Email,
		Name:                user.Name,
		EmailVerified:       user.EmailVerified,
		Plan:                effectivePlan,
		PlanExpiresAt:       user.PlanExpiresAt,
		TrialEndsAt:         user.TrialEndsAt,
		SubscriptionWarning: string(warning),
		MarketingConsent:    user.MarketingConsent,
	}
}

// registerHandler creates a new user account and returns a JWT.
// If the email is already registered but not verified, it updates credentials and resends the verification code.
//
// @Summary      Register a new user
// @Description  Creates a new user account and returns a JWT. If the email exists but is unverified, credentials are updated and a new verification code is sent.
// @Tags         auth
// @Accept       json
// @Produce      json
// @Param        body  body      registerRequest   true  "Registration data"
// @Success      201   {object}  authUserResponse
// @Failure      400   {object}  errorResponse
// @Failure      409   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/auth/register [post]
func registerHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		user, err := userStore.Register(req.Name, req.Email, req.Password, req.MarketingConsent)
		if err != nil {
			switch {
			case errors.Is(err, auth.ErrEmailAlreadyVerified):
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "Email already registered"})
			case errors.Is(err, auth.ErrUserExists):
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "Email already registered"})
			case errors.Is(err, auth.ErrInvalidInput):
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			default:
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to register user"})
			}
			return
		}

		// Prometheus: track successful user registration.
		metrics.UserRegistrationsTotal.Inc()

		// For unverified users (re-registration), resend verification code (async to avoid blocking).
		if !user.EmailVerified && emailSvc != nil && emailSvc.IsConfigured() {
			code, codeErr := emailSvc.GenerateCode(user.ID, user.Email)
			if codeErr == nil {
				go func() {
					_ = emailSvc.SendVerificationEmail(user.Email, code)
				}()
			}
		}

		token, err := jwtSvc.GenerateUserToken(user)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(authUserResponse{
			Token:     token,
			ExpiresAt: expiresAt,
			User:      userInfoFromUser(user),
		})
	}
}

// loginHandler authenticates a user and returns a JWT.
//
// @Summary      Login
// @Description  Authenticates the user with email and password and returns a JWT
// @Tags         auth
// @Accept       json
// @Produce      json
// @Param        body  body      loginRequest      true  "Login credentials"
// @Success      200   {object}  authUserResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/auth/login [post]
func loginHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		user, err := userStore.Authenticate(req.Email, req.Password)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "Неверный email или пароль"})
			return
		}

		token, err := jwtSvc.GenerateUserToken(user)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate token"})
			return
		}

		expiresAt := time.Now().Add(auth.TokenTTL).UTC().Format(time.RFC3339)

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(authUserResponse{
			Token:     token,
			ExpiresAt: expiresAt,
			User:      userInfoFromUser(user),
		})
	}
}

// profileHandler returns the authenticated user's profile.
//
// @Summary      Get current user profile
// @Description  Returns profile information for the authenticated user
// @Tags         auth
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  userInfo
// @Failure      401  {object}  errorResponse
// @Router       /api/v1/auth/profile [get]
func profileHandler(userStore *auth.UserStore, db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		// Try to fetch fresh data from store (for email_verified status).
		if claims.UserID != "" {
			if user, err := userStore.GetByID(claims.UserID); err == nil {
				// If paid plan is expired, downgrade to free in DB.
				if user.Plan != "free" && user.Plan != "trial" && user.Plan != "" && user.PlanExpiresAt != nil {
					t, parseErr := time.Parse(time.RFC3339, *user.PlanExpiresAt)
					if parseErr == nil && time.Now().After(t) {
						if db != nil {
							tag, dbErr := db.Exec(r.Context(),
								`UPDATE users SET plan = 'free' WHERE id = $1 AND plan NOT IN ('free','trial')`,
								user.ID)
							_ = tag
							_ = dbErr
						}
						user.Plan = "free"
					}
				}
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(userInfoFromUser(user))
				return
			}
		}

		// Fallback to claims (anonymous sessions, etc.).
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(userInfo{
			ID:    claims.UserID,
			Email: claims.Email,
			Name:  claims.Name,
			Plan:  "free",
		})
	}
}

type sendVerificationResponse struct {
	Message string `json:"message"`
}

// sendVerificationHandler sends a verification code email to the authenticated user.
//
// @Summary      Send email verification code
// @Description  Sends a one-time verification code to the authenticated user's email address
// @Tags         auth
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  sendVerificationResponse
// @Failure      400  {object}  errorResponse
// @Failure      401  {object}  errorResponse
// @Failure      404  {object}  errorResponse
// @Failure      500  {object}  errorResponse
// @Failure      503  {object}  errorResponse
// @Router       /api/v1/auth/send-verification [post]
func sendVerificationHandler(jwtSvc *auth.JWTService, userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		user, err := userStore.GetByID(claims.UserID)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		if user.EmailVerified {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "email already verified"})
			return
		}

		if !emailSvc.IsConfigured() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "email service not configured"})
			return
		}

		code, err := emailSvc.GenerateCode(user.ID, user.Email)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate verification code"})
			return
		}

		if err := emailSvc.SendVerificationEmail(user.Email, code); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to send verification email"})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(sendVerificationResponse{
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
//
// @Summary      Verify email code
// @Description  Validates the one-time code and marks the user's email as verified
// @Tags         auth
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      verifyCodeRequest  true  "Verification code"
// @Success      200   {object}  verifyCodeResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/auth/verify-code [post]
func verifyCodeHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		var req verifyCodeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "code is required"})
			return
		}

		if err := emailSvc.VerifyCode(claims.UserID, req.Code); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		if err := userStore.SetEmailVerified(claims.UserID); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to update verification status"})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(verifyCodeResponse{Verified: true})
	}
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// forgotPasswordHandler sends a password reset code to the user's email.
//
// @Summary      Forgot password
// @Description  Sends a password-reset code to the provided email address. Always returns 200 to prevent email enumeration.
// @Tags         auth
// @Accept       json
// @Produce      json
// @Param        body  body      forgotPasswordRequest  true  "User email"
// @Success      200   {object}  map[string]string
// @Failure      400   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Failure      503   {object}  errorResponse
// @Router       /api/v1/auth/forgot-password [post]
func forgotPasswordHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req forgotPasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "email is required"})
			return
		}

		// Always return success to prevent email enumeration
		user, err := userStore.GetByEmail(req.Email)
		if err != nil {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "If this email is registered, a reset code has been sent"})
			return
		}

		if !emailSvc.IsConfigured() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "email service not configured"})
			return
		}

		code, err := emailSvc.GenerateResetCode(user.Email)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to generate reset code"})
			return
		}

		if err := emailSvc.SendPasswordResetEmail(user.Email, code); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to send reset email"})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "If this email is registered, a reset code has been sent"})
	}
}

type resetPasswordRequest struct {
	Email       string `json:"email"`
	Code        string `json:"code"`
	NewPassword string `json:"new_password"`
}

// resetPasswordHandler verifies the reset code and updates the user's password.
//
// @Summary      Reset password
// @Description  Verifies the reset code and sets a new password for the user
// @Tags         auth
// @Accept       json
// @Produce      json
// @Param        body  body      resetPasswordRequest  true  "Reset payload"
// @Success      200   {object}  map[string]string
// @Failure      400   {object}  errorResponse
// @Failure      404   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/auth/reset-password [post]
func resetPasswordHandler(userStore *auth.UserStore, emailSvc *auth.EmailService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var req resetPasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		if req.Email == "" || req.Code == "" || req.NewPassword == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "email, code, and new_password are required"})
			return
		}

		if err := emailSvc.VerifyResetCode(req.Email, req.Code); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		user, err := userStore.GetByEmail(req.Email)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		if err := userStore.UpdatePassword(user.ID, req.NewPassword); err != nil {
			if errors.Is(err, auth.ErrInvalidInput) {
				w.WriteHeader(http.StatusBadRequest)
			} else {
				w.WriteHeader(http.StatusInternalServerError)
			}
			_ = json.NewEncoder(w).Encode(errorResponse{Error: err.Error()})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "Password updated successfully"})
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
//
// @Summary      Create agent session
// @Description  Creates a new agent session and returns the session ID with the WebSocket URL to connect to
// @Tags         sessions
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      createSessionRequest   true  "Session parameters"
// @Success      201   {object}  createSessionResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Router       /api/v1/sessions [post]
func createSessionHandler(hub *websocket.Hub, serverPort string, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		var req createSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
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
		_ = json.NewEncoder(w).Encode(createSessionResponse{
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
//
// @Summary      List available LLM models
// @Description  Returns the list of available LLM models including which one is the default
// @Tags         models
// @Produce      json
// @Success      200  {object}  modelsListResponse
// @Router       /api/v1/models [get]
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
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// --- Database-driven model catalog types and handler ---

type modelResponseV2 struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Provider        string  `json:"provider"`
	Tier            string  `json:"tier"`
	InputPricePerM  float64 `json:"input_price_per_m"`
	OutputPricePerM float64 `json:"output_price_per_m"`
	IsDefault       bool    `json:"is_default"`
}

type modelsListResponseV2 struct {
	Models []modelResponseV2 `json:"models"`
}

// modelsHandlerV2 returns models from the database-driven model service.
//
// @Summary      List available LLM models (v2, DB-driven)
// @Description  Returns the list of available LLM models from the model catalog database table
// @Tags         models
// @Produce      json
// @Success      200  {object}  modelsListResponseV2
// @Router       /api/v1/models [get]
func modelsHandlerV2(modelsSvc *models.Service, defaultModel string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		resp := modelsListResponseV2{
			Models: make([]modelResponseV2, 0),
		}

		// Try loading from DB-driven model catalog.
		allModels, err := modelsSvc.All(r.Context())
		if err == nil && len(allModels) > 0 {
			for _, m := range allModels {
				resp.Models = append(resp.Models, modelResponseV2{
					ID:              m.ID,
					Name:            m.DisplayName,
					Provider:        m.Provider,
					Tier:            m.Tier,
					InputPricePerM:  m.InputPricePerM,
					OutputPricePerM: m.OutputPricePerM,
					IsDefault:       m.ID == defaultModel,
				})
			}
		}

		// Fallback to config if DB models are empty or unavailable.
		if len(resp.Models) == 0 {
			for _, m := range config.DefaultModels() {
				resp.Models = append(resp.Models, modelResponseV2{
					ID:              m.ID,
					Name:            m.Name,
					Provider:        m.Provider,
					Tier:            m.Tier,
					InputPricePerM:  m.InputPricePerM,
					OutputPricePerM: m.OutputPricePerM,
					IsDefault:       m.ID == defaultModel,
				})
			}
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
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
//
// @Summary      Get legal document (latest)
// @Description  Returns the latest active legal document of the given type. Use ?lang=ru|en to select language (default: ru).
// @Tags         legal
// @Produce      json
// @Param        type     path     string  true   "Document type (e.g. privacy, terms)"
// @Param        lang     query    string  false  "Language code (ru or en)"
// @Success      200      {object} legalDocumentResponse
// @Failure      400      {object} errorResponse
// @Failure      404      {object} errorResponse
// @Failure      500      {object} errorResponse
// @Router       /api/v1/legal/{type} [get]
//
// @Summary      Get legal document (specific version)
// @Description  Returns a specific version of the legal document.
// @Tags         legal
// @Produce      json
// @Param        type     path     string  true   "Document type (e.g. privacy, terms)"
// @Param        version  path     string  true   "Document version"
// @Param        lang     query    string  false  "Language code (ru or en)"
// @Success      200      {object} legalDocumentResponse
// @Failure      400      {object} errorResponse
// @Failure      404      {object} errorResponse
// @Failure      500      {object} errorResponse
// @Router       /api/v1/legal/{type}/{version} [get]
func legalDocumentHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		docType := r.PathValue("type")
		if docType == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing document type"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
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
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "document not found"})
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
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "document not found"})
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
		_ = json.NewEncoder(w).Encode(doc)
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
//
// @Summary      Accept legal document
// @Description  Records the authenticated user's acceptance of a specific legal document version
// @Tags         legal
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      legalAcceptRequest   true  "Acceptance data"
// @Success      201   {object}  legalAcceptResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/legal/accept [post]
func legalAcceptHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "authentication required"})
			return
		}

		var req legalAcceptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		if req.DocType == "" || req.DocVersion == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "doc_type and doc_version are required"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
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
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to record acceptance"})
			return
		}

		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(legalAcceptResponse{Accepted: true})
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
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "admin access required"})
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
//
// @Summary      Admin: list user analytics
// @Description  Returns aggregated token usage and cost per user. Admin-only endpoint. Optionally filter by month (YYYY-MM).
// @Tags         admin
// @Produce      json
// @Security     BearerAuth
// @Param        month  query     string  false  "Filter by month in YYYY-MM format"
// @Success      200    {object}  analyticsUsersResponse
// @Failure      401    {object}  errorResponse
// @Failure      403    {object}  errorResponse
// @Failure      500    {object}  errorResponse
// @Router       /api/v1/admin/analytics/users [get]
func analyticsUsersHandler(db *pgxpool.Pool, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
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
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to query analytics"})
			return
		}
		defer rows.Close()

		users := make([]analyticsUserSummary, 0)
		for rows.Next() {
			var s analyticsUserSummary
			if err := rows.Scan(&s.UserID, &s.TotalRequests, &s.TotalTokens, &s.PromptTokens, &s.CompletionTokens, &s.TotalCostUSD); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to scan row"})
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
		_ = json.NewEncoder(w).Encode(analyticsUsersResponse{Users: users, Month: month})
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
//
// @Summary      Admin: user analytics detail
// @Description  Returns total and monthly token usage breakdown for a specific user. Admin-only endpoint.
// @Tags         admin
// @Produce      json
// @Security     BearerAuth
// @Param        id   path      string  true  "User ID"
// @Success      200  {object}  analyticsUserDetailResponse
// @Failure      400  {object}  errorResponse
// @Failure      401  {object}  errorResponse
// @Failure      403  {object}  errorResponse
// @Failure      500  {object}  errorResponse
// @Router       /api/v1/admin/analytics/users/{id} [get]
func analyticsUserDetailHandler(db *pgxpool.Pool, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		userID := r.PathValue("id")
		if userID == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing user_id in path"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
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
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to query user totals"})
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
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to query monthly breakdown"})
			return
		}
		defer rows.Close()

		for rows.Next() {
			var m analyticsMonthBreakdown
			if err := rows.Scan(&m.Month, &m.TotalRequests, &m.TotalTokens, &m.PromptTokens, &m.CompletionTokens, &m.TotalCostUSD); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to scan month row"})
				return
			}
			resp.Months = append(resp.Months, m)
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}
