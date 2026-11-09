#!/usr/bin/env bash
# Infrastructure pipeline: plan or apply the production stack.
#   usage: terraform.sh plan|apply
# Needs TF_STATE_BUCKET and TF_LOCK_TABLE in the pipeline environment.
set -euo pipefail

action="${1:?plan or apply}"
env="${DEPLOY_ENV:?DEPLOY_ENV is required}"
region="${AWS_REGION:-af-south-1}"
TF_IMAGE="hashicorp/terraform:1.9.8"

tf() {
  docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf \
    -e TF_IN_AUTOMATION=1 -e AWS_REGION="$region" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    -e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -e AWS_CONTAINER_CREDENTIALS_FULL_URI \
    "$TF_IMAGE" "$@"
}

echo "--- :terraform: init (${env})"
tf init -input=false \
  -backend-config="bucket=${TF_STATE_BUCKET:?}" \
  -backend-config="key=constructos/${env}/terraform.tfstate" \
  -backend-config="region=${region}" \
  -backend-config="dynamodb_table=${TF_LOCK_TABLE:?}" \
  -backend-config="encrypt=true"

var_file="environments/${env}.tfvars"

case "$action" in
  plan)
    echo "+++ :terraform: plan"
    tf plan -input=false -var-file="$var_file" -no-color -out=tfplan | tee plan.txt
    if command -v buildkite-agent >/dev/null 2>&1; then
      { echo '<details><summary>Terraform plan</summary>'; echo; echo '```'; grep -E '^(Plan:|No changes|  [#~+-])' plan.txt | head -400; echo '```'; echo '</details>'; } |
        buildkite-agent annotate --style info --context tf-plan
    fi
    ;;
  apply)
    echo "+++ :terraform: apply"
    tf apply -input=false -auto-approve -var-file="$var_file"
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 1
    ;;
esac
