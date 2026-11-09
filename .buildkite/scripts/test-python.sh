#!/usr/bin/env bash
# AI engine: locked dependencies + pytest. The virtualenv lives inside the
# container so the checkout is never modified.
set -euo pipefail

echo "+++ :python: pytest"
docker run --rm -v "$PWD/apps/ai-engine:/app" -w /app \
  -e UV_PROJECT_ENVIRONMENT=/tmp/venv -e UV_LINK_MODE=copy \
  ghcr.io/astral-sh/uv:0.8.13-python3.12-bookworm-slim \
  sh -c "uv sync --frozen && uv run --frozen python -m pytest -q"
