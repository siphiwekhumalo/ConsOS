#!/usr/bin/env bash
# Edge-sync service: vet + tests in the same Go version as the production image.
set -euo pipefail

echo "+++ :golang: go vet + go test"
docker run --rm -v "$PWD/apps/sync-service:/src" -w /src golang:1.24-alpine \
  sh -c "go mod verify && go vet ./... && go test -race=false ./..."
