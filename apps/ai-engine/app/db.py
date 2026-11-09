"""Tenant-scoped Postgres access (psycopg 3 pool)."""

import re
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def is_uuid(value: str) -> bool:
    return bool(_UUID.match(value))


@lru_cache
def pool() -> ConnectionPool:
    return ConnectionPool(get_settings().ai_database_url, min_size=1, max_size=10, open=True)


@contextmanager
def tenant_tx(tenant_id: str) -> Iterator[psycopg.Cursor]:
    """One transaction scoped to one tenant (SET LOCAL semantics); RLS does the rest."""
    if not is_uuid(tenant_id):
        raise ValueError("invalid tenant id")
    with pool().connection() as conn:
        with conn.transaction():
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("select set_config('app.current_tenant', %s, true)", (tenant_id,))
                yield cur


def append_audit(cur: psycopg.Cursor, tenant_id: str, actor: str | None, action: str,
                 entity_type: str, entity_id: str | None, payload: str) -> None:
    cur.execute(
        """insert into audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, payload)
           values (%s, %s, %s, %s, %s, %s::jsonb)""",
        (tenant_id, actor, action, entity_type, entity_id, payload),
    )
