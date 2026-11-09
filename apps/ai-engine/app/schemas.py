"""Result models. Every AI output is a SUGGESTION for a human to review."""

from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Tender BOQ extraction
# Quantities and money are decimal STRINGS end to end (never floats).
# ---------------------------------------------------------------------------


class BoqItem(BaseModel):
    item_no: str
    description: str
    unit: str
    quantity: str | None
    rate: str | None
    amount: str | None


class BoqSection(BaseModel):
    name: str
    items: list[BoqItem]


class BoqExtraction(BaseModel):
    document_title: str | None
    currency: str
    sections: list[BoqSection]
    warnings: list[str] = Field(default_factory=list)


_NULLABLE_STR = {"anyOf": [{"type": "string"}, {"type": "null"}]}

# Hand-written strict JSON schema for output_config.format (additionalProperties
# false + required everywhere), mirrored by the Pydantic models above.
BOQ_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["document_title", "currency", "sections", "warnings"],
    "properties": {
        "document_title": _NULLABLE_STR,
        "currency": {"type": "string"},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "items"],
                "properties": {
                    "name": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["item_no", "description", "unit", "quantity", "rate", "amount"],
                            "properties": {
                                "item_no": {"type": "string"},
                                "description": {"type": "string"},
                                "unit": {"type": "string"},
                                "quantity": _NULLABLE_STR,
                                "rate": _NULLABLE_STR,
                                "amount": _NULLABLE_STR,
                            },
                        },
                    },
                },
            },
        },
    },
}


def _dec(value: str | None) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(value.replace(" ", "").replace(",", ""))
    except InvalidOperation:
        return None


def check_boq_arithmetic(boq: BoqExtraction) -> BoqExtraction:
    """Deterministic check, independent of the model: quantity x rate must equal amount.

    Tender BOQs regularly contain extension errors; flagging them is valuable on its own.
    """
    flagged = list(boq.warnings)
    for section in boq.sections:
        for item in section.items:
            q, r, a = _dec(item.quantity), _dec(item.rate), _dec(item.amount)
            if q is None or r is None or a is None:
                continue
            expected = (q * r).quantize(Decimal("0.01"))
            if abs(expected - a) > Decimal("0.01"):
                flagged.append(
                    f"Item {item.item_no}: {item.quantity} x {item.rate} = {expected}, "
                    f"but the BOQ states {item.amount}"
                )
    return boq.model_copy(update={"warnings": flagged})


# ---------------------------------------------------------------------------
# Site-diary risk review
# ---------------------------------------------------------------------------

RiskCategory = Literal["delay", "safety", "productivity", "weather", "quality", "resourcing"]
Severity = Literal["low", "medium", "high"]


class Risk(BaseModel):
    category: RiskCategory
    severity: Severity
    finding: str
    evidence_dates: list[str]
    recommendation: str


class DiaryRiskReview(BaseModel):
    summary: str
    risks: list[Risk]


DIARY_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "risks"],
    "properties": {
        "summary": {"type": "string"},
        "risks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["category", "severity", "finding", "evidence_dates", "recommendation"],
                "properties": {
                    "category": {"type": "string", "enum": list(RiskCategory.__args__)},
                    "severity": {"type": "string", "enum": list(Severity.__args__)},
                    "finding": {"type": "string"},
                    "evidence_dates": {"type": "array", "items": {"type": "string"}},
                    "recommendation": {"type": "string"},
                },
            },
        },
    },
}
