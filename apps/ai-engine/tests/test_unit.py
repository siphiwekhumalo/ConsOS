import time

import jwt
import pytest

from app.auth import verify_token
from app.llm import FakeProvider
from app.schemas import BOQ_JSON_SCHEMA, BoqExtraction, BoqItem, BoqSection, check_boq_arithmetic

SECRET = "test-secret-at-least-32-characters-long!!"


def token(**overrides):
    claims = {"sub": "u-1", "tid": "t-1", "role": "finance", "iss": "constructos", "exp": int(time.time()) + 60}
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_accepts_core_api_token():
    p = verify_token(token(), SECRET)
    assert (p.user_id, p.tenant_id, p.role) == ("u-1", "t-1", "finance")


@pytest.mark.parametrize(
    "bad",
    [
        token(exp=int(time.time()) - 10),
        token(iss="evil"),
        token(exp=None),
        token(tid=None),
        jwt.encode({"sub": "u", "tid": "t", "role": "x", "iss": "constructos", "exp": int(time.time()) + 60},
                   "another-secret-another-secret-123456", algorithm="HS256"),
        jwt.encode({"sub": "u", "tid": "t", "role": "x", "iss": "constructos", "exp": int(time.time()) + 60},
                   SECRET, algorithm="HS512"),
        "garbage",
    ],
)
def test_rejects_bad_tokens(bad):
    with pytest.raises(ValueError):
        verify_token(bad, SECRET)


def test_rejects_alg_none():
    unsigned = jwt.encode({"sub": "u", "tid": "t", "role": "x", "iss": "constructos",
                           "exp": int(time.time()) + 60}, key=None, algorithm="none")
    with pytest.raises(ValueError):
        verify_token(unsigned, SECRET)


def test_boq_arithmetic_flags_extension_errors():
    boq = BoqExtraction(
        document_title="t", currency="ZAR", warnings=[],
        sections=[BoqSection(name="Bill 2", items=[
            BoqItem(item_no="2.1", description="ok", unit="m3", quantity="1 200", rate="85.50", amount="102,600.00"),
            BoqItem(item_no="2.2", description="wrong", unit="m3", quantity="450", rate="210.00", amount="95000.00"),
            BoqItem(item_no="2.3", description="unpriced", unit="m3", quantity="10", rate=None, amount=None),
        ])],
    )
    checked = check_boq_arithmetic(boq)
    assert len(checked.warnings) == 1
    assert "2.2" in checked.warnings[0] and "94500.00" in checked.warnings[0]


def test_fake_provider_output_matches_schema_shape():
    result = FakeProvider().extract_boq(b"%PDF", "tender.pdf")
    dumped = result.model_dump()
    assert set(dumped) == set(BOQ_JSON_SCHEMA["required"])
    assert dumped["sections"][1]["items"][0]["quantity"] == "1200"  # decimals stay strings


def test_schema_is_strict():
    def walk(node):
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            for child in node["properties"].values():
                walk(child)
        if node.get("type") == "array":
            walk(node["items"])

    walk(BOQ_JSON_SCHEMA)
