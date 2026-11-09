from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../../.env", ".env"), extra="ignore")

    ai_database_url: str = Field(description="Postgres URL for the constructos_ai role")
    jwt_secret: str = Field(min_length=32)
    port: int = 8000

    # "anthropic" calls the Claude API; "fake" returns deterministic canned
    # results so local development and tests never spend API credits.
    ai_provider: Literal["anthropic", "fake"] = "anthropic"
    ai_model: str = "claude-opus-5-5"

    s3_bucket: str
    s3_region: str = "af-south-1"
    s3_endpoint: str | None = None
    s3_force_path_style: bool = False

    max_pdf_bytes: int = 32 * 1024 * 1024  # Claude API request limit

    @model_validator(mode="after")
    def _never_owner(self) -> "Settings":
        if "constructos_owner" in self.ai_database_url:
            raise ValueError("AI_DATABASE_URL must use the constructos_ai role, never the owner")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
