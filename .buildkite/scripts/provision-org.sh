#!/usr/bin/env bash
# Create a customer organisation + first-owner invite in production by running
# create-tenant.js as a one-off ECS task (same image and owner DB access as the
# migration task). Inputs come from the provision.yml block-step form.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"

field() { buildkite-agent meta-data get "$1"; }

slug="$(field org-id | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
name="$(field org-name)"
tier="$(field org-tier)"
modules="$(field org-modules | paste -sd, -)" # multi-select arrives newline-separated
owner_name="$(field owner-name)"
owner_email="$(field owner-email | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "Organisation ID must be lowercase letters, digits and hyphens" >&2; exit 1; }
[[ "$owner_email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "Owner email is not valid" >&2; exit 1; }

load_deploy_config
cluster="$(cfg .cluster)"
subnets="$(cfg '.subnets | join(",")')"
sg="$(cfg .security_group)"
family="$(cfg .task_families.migrate)"
public_url="$(cfg .public_url)"

# Values are passed as JSON via jq --arg: no shell or JSON injection possible.
overrides="$(jq -n \
  --arg slug "$slug" --arg name "$name" --arg tier "$tier" --arg modules "$modules" \
  --arg owner_name "$owner_name" --arg owner_email "$owner_email" --arg url "$public_url" \
  '{containerOverrides: [{
      name: "migrate",
      command: ["node", "node_modules/@constructos/db/dist/create-tenant.js"],
      environment: [
        {name: "TENANT_SLUG", value: $slug}, {name: "TENANT_NAME", value: $name},
        {name: "TENANT_TIER", value: $tier}, {name: "TENANT_MODULES", value: $modules},
        {name: "OWNER_NAME", value: $owner_name}, {name: "OWNER_EMAIL", value: $owner_email},
        {name: "PUBLIC_URL", value: $url}
      ]}]}')"

echo "--- :office: Provisioning ${slug} (${tier}): ${modules}"
task_arn="$(aws ecs run-task --cluster "$cluster" --task-definition "$family" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=DISABLED}" \
  --overrides "$overrides" --started-by "buildkite-provision-${BUILDKITE_BUILD_NUMBER:-manual}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"

exit_code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].containers[0].exitCode' --output text)"
log="$(aws logs get-log-events --log-group-name "/ecs/${cluster}/migrate" \
  --log-stream-name "migrate/migrate/${task_arn##*/}" --query 'events[].message' --output text || true)"

if [[ "$exit_code" != "0" ]]; then
  echo "$log" | grep -v '^INVITE_URL=' || true
  annotate error provision "Provisioning \`${slug}\` failed (exit ${exit_code}). See the job log."
  exit 1
fi

echo "$log" | tr '\t' '\n' | grep -v '^INVITE_URL=' || true
invite="$(echo "$log" | tr '\t' '\n' | sed -n 's/^INVITE_URL=//p' | head -1)"
echo "+++ :key: One-time owner invite (valid 72 hours, single use)"
echo "Send this privately to ${owner_name} <${owner_email}>:"
echo "$invite"
annotate success provision "Organisation **${name}** (\`${slug}\`) created. The owner's one-time invite link is in the job log; send it privately to ${owner_email}."
