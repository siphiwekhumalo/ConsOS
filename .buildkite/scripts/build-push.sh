#!/usr/bin/env bash
# Build one service image for linux/amd64 and push it to ECR, tagged with the
# commit SHA. Idempotent: an existing tag (immutable repos) is not rebuilt.
#   usage: build-push.sh <api-core|sync-service|ai-engine|web>
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"

service="${1:?service name required}"
load_deploy_config
tag="$(image_tag)"
registry="$(cfg .ecr_registry)"
repo_url="$(cfg ".repositories[\"$service\"]")"
repo_name="${repo_url#*/}"

[[ "$repo_url" != "null" ]] || { echo "Unknown service: $service" >&2; exit 1; }

echo "--- :ecr: Logging in to $registry"
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"

if aws ecr describe-images --repository-name "$repo_name" --image-ids "imageTag=$tag" >/dev/null 2>&1; then
  echo "Image $repo_url:$tag already exists; skipping build."
  exit 0
fi

echo "+++ :docker: Building $service @ ${tag:0:12}"
case "$service" in
  api-core) docker build --platform linux/amd64 -f apps/api-core/Dockerfile -t "$repo_url:$tag" . ;;
  web) docker build --platform linux/amd64 -f apps/web/Dockerfile -t "$repo_url:$tag" . ;;
  sync-service) docker build --platform linux/amd64 -t "$repo_url:$tag" apps/sync-service ;;
  ai-engine) docker build --platform linux/amd64 -t "$repo_url:$tag" apps/ai-engine ;;
  *) echo "Unknown service: $service" >&2; exit 1 ;;
esac

echo "--- :ecr: Pushing"
docker push "$repo_url:$tag"
