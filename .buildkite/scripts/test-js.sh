#!/usr/bin/env bash
# TypeScript workspace: build, typecheck and test against a real Postgres.
set -euo pipefail

compose=(docker compose -f .buildkite/docker-compose.ci.yml -p "ci-${BUILDKITE_JOB_ID:-local}")
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "--- :docker: Building test image"
"${compose[@]}" build js

echo "+++ :typescript: build, typecheck, test"
"${compose[@]}" run --rm js
