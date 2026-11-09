"""Verifies access tokens issued by the core API (HS256, shared secret)."""

from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import get_settings

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str
    role: str


def verify_token(token: str, secret: str) -> Principal:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],  # rejects "none" and algorithm confusion
            issuer="constructos",
            options={"require": ["exp", "iss", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise ValueError("invalid token") from exc
    sub, tid, role = claims.get("sub"), claims.get("tid"), claims.get("role")
    if not (isinstance(sub, str) and isinstance(tid, str) and isinstance(role, str)):
        raise ValueError("invalid token claims")
    return Principal(user_id=sub, tenant_id=tid, role=role)


def current_principal(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Principal:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    try:
        return verify_token(creds.credentials, get_settings().jwt_secret)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
