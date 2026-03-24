package auth

import (
	"context"
	"net/http"
	"strings"
)

// contextKey is an unexported type for context keys in this package.
type contextKey string

// ClaimsContextKey is the context key for storing JWT claims.
const ClaimsContextKey contextKey = "claims"

// UserIDContextKey is the context key for storing the authenticated user's ID.
// This is set separately from Claims so that downstream middleware (e.g. logging)
// can read user_id without importing the Claims type.
const UserIDContextKey contextKey = "user_id"

// AuthMiddleware returns HTTP middleware that validates JWT Bearer tokens.
// Valid requests get Claims added to context; invalid/missing tokens get 401.
// When the token contains a user_id, it is also stored under UserIDContextKey.
func AuthMiddleware(jwtSvc *JWTService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			claims, err := jwtSvc.ValidateToken(parts[1])
			if err != nil {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), ClaimsContextKey, claims)
			if claims.UserID != "" {
				ctx = context.WithValue(ctx, UserIDContextKey, claims.UserID)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext extracts Claims from the request context.
// Returns nil if no claims are present.
func ClaimsFromContext(ctx context.Context) *Claims {
	claims, _ := ctx.Value(ClaimsContextKey).(*Claims)
	return claims
}

// UserIDFromContext extracts the user ID string from the request context.
// Returns empty string if not present.
func UserIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(UserIDContextKey).(string)
	return id
}
