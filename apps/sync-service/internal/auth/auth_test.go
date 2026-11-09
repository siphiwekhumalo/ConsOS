package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const secret = "test-secret-at-least-32-characters-long!!"

func sign(t *testing.T, method jwt.SigningMethod, key any, c jwt.MapClaims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(method, c).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func valid() jwt.MapClaims {
	return jwt.MapClaims{
		"sub": "11111111-1111-1111-1111-111111111111", "tid": "22222222-2222-2222-2222-222222222222",
		"role": "site_foreman", "iss": "constructos", "exp": time.Now().Add(time.Minute).Unix(),
	}
}

func TestVerifyAcceptsCoreAPIToken(t *testing.T) {
	p, err := NewVerifier(secret).Verify(sign(t, jwt.SigningMethodHS256, []byte(secret), valid()))
	if err != nil {
		t.Fatal(err)
	}
	if p.TenantID != "22222222-2222-2222-2222-222222222222" || p.Role != "site_foreman" {
		t.Fatalf("unexpected principal %+v", p)
	}
}

func TestVerifyRejects(t *testing.T) {
	v := NewVerifier(secret)
	cases := map[string]string{}

	c := valid()
	c["exp"] = time.Now().Add(-time.Minute).Unix()
	cases["expired"] = sign(t, jwt.SigningMethodHS256, []byte(secret), c)

	c = valid()
	c["iss"] = "someone-else"
	cases["wrong issuer"] = sign(t, jwt.SigningMethodHS256, []byte(secret), c)

	c = valid()
	delete(c, "exp")
	cases["no expiry"] = sign(t, jwt.SigningMethodHS256, []byte(secret), c)

	c = valid()
	delete(c, "tid")
	cases["no tenant"] = sign(t, jwt.SigningMethodHS256, []byte(secret), c)

	cases["wrong secret"] = sign(t, jwt.SigningMethodHS256, []byte("another-secret-another-secret-123456"), valid())
	cases["alg none"] = sign(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, valid())
	cases["HS512"] = sign(t, jwt.SigningMethodHS512, []byte(secret), valid())
	cases["garbage"] = "not.a.token"

	for name, tok := range cases {
		if _, err := v.Verify(tok); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}
