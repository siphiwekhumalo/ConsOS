# Production settings (no secrets here; secrets are generated or set in Secrets Manager).
environment = "production"
region      = "af-south-1"
domain_name = "baheka-construct-os.com"

# false = the Route 53 hosted zone for baheka-construct-os.com already exists in this account.
# true  = create it, then set the registrar's NS records to the `name_servers` output.
create_hosted_zone = false

az_count            = 3
single_nat_gateway  = false
aurora_min_acu      = 0.5
aurora_max_acu      = 8
aurora_reader_count = 1

# Adopt the console-created bucket (import it first; see infra/README.md):
# tenant_files_bucket_name = "construct-os-tenant-storage-prod"

# IAM role of the Buildkite Elastic CI Stack agents on the `deploy` queue:
# buildkite_agent_role_name = "<elastic-ci-stack-role-name>"

ai_provider = "anthropic"
