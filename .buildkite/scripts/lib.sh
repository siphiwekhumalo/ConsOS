#!/usr/bin/env bash
# Shared helpers for the deploy-side scripts. Source, don't execute.

# Reads the deploy config Terraform publishes to SSM (/constructos/<env>/deploy-config).
load_deploy_config() {
  local env="${DEPLOY_ENV:?DEPLOY_ENV is required}"
  DEPLOY_CONFIG="$(aws ssm get-parameter --name "/constructos/${env}/deploy-config" \
    --query Parameter.Value --output text --region "${AWS_REGION:-af-south-1}")"
  export DEPLOY_CONFIG
  AWS_REGION="$(cfg .region)"
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
}

cfg() { jq -r "$1" <<<"$DEPLOY_CONFIG"; }

# The image tag is always the full commit SHA: immutable and traceable.
image_tag() { echo "${BUILDKITE_COMMIT:?BUILDKITE_COMMIT is required}"; }

annotate() {
  if command -v buildkite-agent >/dev/null 2>&1; then
    buildkite-agent annotate --style "$1" --context "$2" "$3"
  else
    echo "[$1] $3"
  fi
}
