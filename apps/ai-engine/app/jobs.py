"""Job execution. Runs in a background thread now; moves to an SQS worker in AWS."""

import json
import logging

import boto3
from botocore.config import Config

from .config import Settings
from .db import append_audit, tenant_tx
from .llm import ModelOutputError, Provider
from .schemas import check_boq_arithmetic

log = logging.getLogger("ai-engine.jobs")


def _s3(settings: Settings):
    return boto3.client(
        "s3",
        region_name=settings.s3_region,
        endpoint_url=settings.s3_endpoint,
        config=Config(s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"}),
    )


def _set_status(tenant_id: str, job_id: str, status: str, **fields) -> None:
    sets = ["status = %s"] + [f"{k} = %s" for k in fields]
    with tenant_tx(tenant_id) as cur:
        cur.execute(f"update ai_jobs set {', '.join(sets)} where id = %s",
                    (status, *fields.values(), job_id))


def run_job(job_id: str, tenant_id: str, settings: Settings, provider: Provider) -> None:
    try:
        with tenant_tx(tenant_id) as cur:
            cur.execute("select * from ai_jobs where id = %s", (job_id,))
            job = cur.fetchone()
        if job is None:
            return
        _set_status(tenant_id, job_id, "running", model=provider.model)

        if job["kind"] == "boq_extraction":
            result = _boq(job, tenant_id, settings, provider)
        else:
            result = _diary(job, tenant_id, provider)

        with tenant_tx(tenant_id) as cur:
            cur.execute("update ai_jobs set status = 'succeeded', result = %s::jsonb, error = null where id = %s",
                        (result.model_dump_json(), job_id))
            append_audit(cur, tenant_id, str(job["requested_by"]), "ai_job.succeeded", "ai_job", job_id,
                         json.dumps({"kind": job["kind"], "model": provider.model}))
    except (ModelOutputError, ValueError) as exc:
        _fail(tenant_id, job_id, str(exc))
    except Exception:  # noqa: BLE001 - background job: record failure, never crash the worker
        log.exception("job %s failed", job_id)
        _fail(tenant_id, job_id, "Internal error while processing the job")


def _fail(tenant_id: str, job_id: str, message: str) -> None:
    try:
        _set_status(tenant_id, job_id, "failed", error=message[:1000])
    except Exception:  # noqa: BLE001
        log.exception("could not record failure for job %s", job_id)


def _boq(job: dict, tenant_id: str, settings: Settings, provider: Provider):
    with tenant_tx(tenant_id) as cur:
        cur.execute("select object_key, filename, content_type, size_bytes, status from files where id = %s",
                    (job["file_id"],))
        f = cur.fetchone()
    if f is None or f["status"] != "uploaded":
        raise ValueError("File not found or not fully uploaded")
    if f["content_type"] != "application/pdf":
        raise ValueError("BOQ extraction needs a PDF")
    if f["size_bytes"] > settings.max_pdf_bytes:
        raise ValueError("PDF is larger than 32 MB; split it into smaller bills")
    obj = _s3(settings).get_object(Bucket=settings.s3_bucket, Key=f["object_key"])
    pdf = obj["Body"].read()
    return check_boq_arithmetic(provider.extract_boq(pdf, f["filename"]))


def _diary(job: dict, tenant_id: str, provider: Provider):
    with tenant_tx(tenant_id) as cur:
        cur.execute("select id, code, name, status::text as status from projects where id = %s",
                    (job["project_id"],))
        project = cur.fetchone()
        cur.execute(
            """select entry_date, weather::text as weather, workforce_count, work_completed, delays, safety_notes
               from site_diary_entries where project_id = %s
               order by entry_date desc limit 60""",
            (job["project_id"],),
        )
        entries = cur.fetchall()
    if project is None:
        raise ValueError("Project not found")
    if not entries:
        raise ValueError("No site diary entries to review for this project")
    return provider.review_diary({k: str(v) for k, v in project.items()}, entries)
