#!/usr/bin/env bash
# Production release of one commit:
#   1. run database migrations (+ service-role passwords) as a one-off ECS task
#   2. register new task-definition revisions with the commit's images
#   3. roll api-core, sync-service, ai-engine, then web; wait until stable
#   4. verify each service actually runs the new revision (the ECS circuit
#      breaker rolls back failed deploys automatically; that must fail the build)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"

load_deploy_config
tag="$(image_tag)"
cluster="$(cfg .cluster)"
subnets="$(cfg '.subnets | join(",")')"
sg="$(cfg .security_group)"
public_url="$(cfg .public_url)"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

image_for() { echo "$(cfg ".repositories[\"$1\"]"):$tag"; }

# Clone the latest revision of a task family with a new image; prints the new ARN.
register_revision() {
  local family="$1" image="$2" out="$workdir/$1.json"
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg img "$image" '
      .containerDefinitions[0].image = $img
      | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
         placementConstraints, requiresCompatibilities, cpu, memory, runtimePlatform}
      | with_entries(select(.value != null))' >"$out"
  aws ecs register-task-definition --cli-input-json "file://$out" \
    --query taskDefinition.taskDefinitionArn --output text
}

for svc in api-core sync-service ai-engine web; do
  repo="$(cfg ".repositories[\"$svc\"]")"
  aws ecr describe-images --repository-name "${repo#*/}" --image-ids "imageTag=$tag" >/dev/null ||
    { echo "Image for $svc @ $tag is missing; run the build steps first." >&2; exit 1; }
done

# --------------------------------------------------------------------------- 1. migrations
echo "--- :database: Running migrations @ ${tag:0:12}"
migrate_family="$(cfg .task_families.migrate)"
migrate_td="$(register_revision "$migrate_family" "$(image_for api-core)")"
task_arn="$(aws ecs run-task --cluster "$cluster" --task-definition "$migrate_td" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=DISABLED}" \
  --started-by "buildkite-${BUILDKITE_BUILD_NUMBER:-manual}" --query 'tasks[0].taskArn' --output text)"
echo "migration task: $task_arn"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"

exit_code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
task_id="${task_arn##*/}"
echo "--- :scroll: Migration log"
aws logs get-log-events --log-group-name "/ecs/${cluster}/migrate" \
  --log-stream-name "migrate/migrate/${task_id}" --query 'events[].message' --output text || true
if [[ "$exit_code" != "0" ]]; then
  annotate error deploy "Migrations failed (exit $exit_code) for \`${tag:0:12}\`. Nothing was rolled out."
  exit 1
fi

# --------------------------------------------------------------------------- 2-3. roll services
declare -A new_td
for svc in api-core sync-service ai-engine web; do
  echo "--- :ecs: Registering $svc"
  new_td[$svc]="$(register_revision "$(cfg ".task_families[\"$svc\"]")" "$(image_for "$svc")")"
  echo "${new_td[$svc]}"
done

for svc in api-core sync-service ai-engine web; do
  echo "--- :rocket: Rolling $svc"
  aws ecs update-service --cluster "$cluster" --service "$(cfg ".services[\"$svc\"]")" \
    --task-definition "${new_td[$svc]}" --query 'service.deployments[0].id' --output text
done

echo "+++ :hourglass: Waiting for services to stabilise"
services=()
for svc in api-core sync-service ai-engine web; do services+=("$(cfg ".services[\"$svc\"]")"); done
aws ecs wait services-stable --cluster "$cluster" --services "${services[@]}"

# --------------------------------------------------------------------------- 4. verify
failed=()
for svc in api-core sync-service ai-engine web; do
  # shellcheck disable=SC2016 # backticks are JMESPath literals, not shell
  running="$(aws ecs describe-services --cluster "$cluster" --services "$(cfg ".services[\"$svc\"]")" \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text)"
  [[ "$running" == "${new_td[$svc]}" ]] || failed+=("$svc")
done
if ((${#failed[@]})); then
  annotate error deploy "Rolled back by ECS: ${failed[*]} did not become healthy on \`${tag:0:12}\`."
  exit 1
fi

annotate success deploy "Released \`${tag:0:12}\` to ${public_url}"
echo "Released ${tag:0:12} to ${public_url}"
