// Package auth verifies access tokens issued by the core API.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// Principal is the authenticated caller.
type Principal struct {
	UserID   string
	TenantID string
	Role     string
}

type claims struct {
	TID  string `json:"tid"`
	Role string `json:"role"`
	jwt.RegisteredClaims
}

// Verifier validates HS256 tokens signed by the core API with the shared secret.
type Verifier struct {
	secret []byte
}

func NewVerifier(secret string) *Verifier {
	return &Verifier{secret: []byte(secret)}
}

var ErrInvalidToken = errors.New("invalid token")

func (v *Verifier) Verify(token string) (Principal, error) {
	c := &claims{}
	_, err := jwt.ParseWithClaims(token, c,
		func(*jwt.Token) (any, error) { return v.secret, nil },
		jwt.WithValidMethods([]string{"HS256"}), // rejects "none" and algorithm confusion
		jwt.WithIssuer("constructos"),
		jwt.WithExpirationRequired(),
	)
	if err != nil || c.Subject == "" || c.TID == "" || c.Role == "" {
		return Principal{}, ErrInvalidToken
	}
	return Principal{UserID: c.Subject, TenantID: c.TID, Role: c.Role}, nil
}

type ctxKey struct{}

// Middleware rejects requests without a valid bearer token.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || token == "" {
			http.Error(w, `{"message":"Unauthorized"}`, http.StatusUnauthorized)
			return
		}
		p, err := v.Verify(token)
		if err != nil {
			http.Error(w, `{"message":"Unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, p)))
	})
}

// FromContext returns the principal set by Middleware.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
