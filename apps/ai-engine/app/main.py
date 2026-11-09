"""ConstructOS AI engine (FastAPI).

Jobs are asynchronous: POST creates a queued job and returns immediately; the
client polls GET /ai/v1/jobs/{id}. Results are suggestions stored in ai_jobs;
this service has read-only access to business data and cannot change it.
"""

import json
import logging
from typing import Annotated, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator

from .auth import Principal, current_principal
from .config import get_settings
from .db import append_audit, is_uuid, pool, tenant_tx
from .jobs import run_job
from .llm import make_provider

logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')

app = FastAPI(title="ConstructOS AI engine", version="0.1.0", docs_url="/ai/docs", openapi_url="/ai/openapi.json")

REQUEST_ROLES = {"owner", "admin", "project_manager", "finance"}
PrincipalDep = Annotated[Principal, Depends(current_principal)]


class CreateJob(BaseModel):
    kind: Literal["boq_extraction", "diary_risk_review"]
    file_id: str | None = Field(default=None, alias="fileId")
    project_id: str | None = Field(default=None, alias="projectId")

    @model_validator(mode="after")
    def _check(self) -> "CreateJob":
        if self.kind == "boq_extraction" and not (self.file_id and is_uuid(self.file_id)):
            raise ValueError("boq_extraction requires fileId")
        if self.kind == "diary_risk_review" and not (self.project_id and is_uuid(self.project_id)):
            raise ValueError("diary_risk_review requires projectId")
        return self


def _job_out(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "status": row["status"],
        "projectId": str(row["project_id"]) if row["project_id"] else None,
        "fileId": str(row["file_id"]) if row["file_id"] else None,
        "model": row["model"],
        "result": row["result"],
        "error": row["error"],
        "createdAt": row["created_at"].isoformat(),
        "updatedAt": row["updated_at"].isoformat(),
    }


def require_ai_module(p: PrincipalDep) -> Principal:
    with tenant_tx(p.tenant_id) as cur:
        cur.execute("select coalesce(bool_or('mod_ai' = any(active_modules)), false) as ok from tenants")
        row = cur.fetchone()
    if not row or not row["ok"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Module mod_ai is not active for your organisation")
    return p


AiPrincipal = Annotated[Principal, Depends(require_ai_module)]


@app.get("/ai/health")
def health() -> dict:
    with pool().connection() as conn:
        conn.execute("select 1")
    return {"status": "ok", "provider": get_settings().ai_provider}


@app.post("/ai/v1/jobs", status_code=status.HTTP_202_ACCEPTED)
def create_job(body: CreateJob, p: AiPrincipal, background: BackgroundTasks) -> dict:
    if p.role not in REQUEST_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role does not permit this action")
    with tenant_tx(p.tenant_id) as cur:
        # Resolve references inside the tenant: RLS hides other tenants' rows.
        if body.file_id:
            cur.execute("select project_id from files where id = %s and status = 'uploaded'", (body.file_id,))
            f = cur.fetchone()
            if f is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
            project_id = f["project_id"]
        else:
            cur.execute("select id from projects where id = %s", (body.project_id,))
            if cur.fetchone() is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
            project_id = body.project_id
        cur.execute(
            """insert into ai_jobs (tenant_id, kind, project_id, file_id, requested_by)
               values (%s, %s, %s, %s, %s) returning *""",
            (p.tenant_id, body.kind, project_id, body.file_id, p.user_id),
        )
        job = cur.fetchone()
        append_audit(cur, p.tenant_id, p.user_id, "ai_job.requested", "ai_job", str(job["id"]),
                     json.dumps({"kind": body.kind}))
    settings = get_settings()
    background.add_task(run_job, str(job["id"]), p.tenant_id, settings, make_provider(settings))
    return _job_out(job)


@app.get("/ai/v1/jobs")
def list_jobs(p: AiPrincipal, limit: int = Query(20, ge=1, le=100)) -> list[dict]:
    with tenant_tx(p.tenant_id) as cur:
        cur.execute("select * from ai_jobs order by created_at desc limit %s", (limit,))
        return [_job_out(r) for r in cur.fetchall()]


@app.get("/ai/v1/jobs/{job_id}")
def get_job(job_id: str, p: AiPrincipal) -> dict:
    if not is_uuid(job_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    with tenant_tx(p.tenant_id) as cur:
        cur.execute("select * from ai_jobs where id = %s", (job_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    return _job_out(row)
