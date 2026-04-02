package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// TokenTTL is the default lifetime of a JWT token.
// 30 days for desktop app — sessions must survive laptop reboots.
const TokenTTL = 30 * 24 * time.Hour

// Claims represents the custom JWT claims for a session.
type Claims struct {
	SessionID string `json:"session_id"`
	UserID    string `json:"user_id,omitempty"`
	Email     string `json:"email,omitempty"`
	Name      string `json:"name,omitempty"`
	jwt.RegisteredClaims
}

// JWTService handles JWT token generation and validation.
type JWTService struct {
	secret []byte
}

// NewJWTService creates a new JWTService with the given secret.
func NewJWTService(secret string) *JWTService {
	return &JWTService{secret: []byte(secret)}
}

// GenerateToken creates a signed JWT for the given session ID.
// The token is valid for TokenTTL (30 days) and uses HS256.
func (s *JWTService) GenerateToken(sessionID string) (string, error) {
	now := time.Now()
	claims := Claims{
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(TokenTTL)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

// GenerateUserToken creates a signed JWT for an authenticated user.
func (s *JWTService) GenerateUserToken(user *User) (string, error) {
	now := time.Now()
	claims := Claims{
		SessionID: user.ID,
		UserID:    user.ID,
		Email:     user.Email,
		Name:      user.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(TokenTTL)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

// ValidateToken parses and validates the JWT string.
// Returns the Claims on success or an error if the token is invalid or expired.
func (s *JWTService) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token claims")
	}

	return claims, nil
}
