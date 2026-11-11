#!/usr/bin/env bash
# Adds the release steps (.buildkite/release.yml) to builds of main, but only
# once releases are switched on. Buildkite rejects any upload that targets a
# queue missing from the cluster, so until the deploy queue and its AWS-enabled
# agents exist, main builds stay green and say what is missing.
set -euo pipefail

queue="${DEPLOY_QUEUE:-deploy}"

if [[ "${RELEASES_ENABLED:-false}" != "true" ]]; then
  msg="Releases are not switched on yet, so this build only ran the tests. To release to baheka-construct-os.com: create the \`${queue}\` queue in your Buildkite cluster, run agents on it with the AWS deploy role, then set \`RELEASES_ENABLED=true\` in this pipeline's environment (docs/deployment.md, section 6)."
  echo "$msg"
  if command -v buildkite-agent >/dev/null 2>&1; then
    buildkite-agent annotate --style info --context release-disabled "$msg"
  fi
  exit 0
fi

echo "Adding release steps (deploy queue: ${queue})"
buildkite-agent pipeline upload .buildkite/release.yml
