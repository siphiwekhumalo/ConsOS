#!/usr/bin/env bash
# Terraform formatting + static validation (no AWS credentials, no state).
set -euo pipefail

TF_IMAGE="hashicorp/terraform:1.9.8"
tf() { docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf -e TF_IN_AUTOMATION=1 "$TF_IMAGE" "$@"; }

echo "+++ :terraform: fmt -check"
tf fmt -check -recursive -diff

echo "+++ :terraform: validate"
tf init -backend=false -input=false >/dev/null
tf validate
