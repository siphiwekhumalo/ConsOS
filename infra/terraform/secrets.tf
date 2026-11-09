# Every secret the services need, in Secrets Manager (KMS-encrypted).
# ECS injects them as environment variables; nothing secret is in images,
# task-definition plaintext or the repository. (They are in Terraform state,
# which is why the state backend must be private and encrypted.)

resource "random_password" "jwt" {
  length  = 64
  special = false
}

locals {
  generated_secrets = {
    "jwt-secret"         = random_password.jwt.result
    "database-url-owner" = local.db_url.owner
    "database-url-app"   = local.db_url.app
    "database-url-sync"  = local.db_url.sync
    "database-url-ai"    = local.db_url.ai
    "app-db-password"    = random_password.db["app"].result
    "sync-db-password"   = random_password.db["sync"].result
    "ai-db-password"     = random_password.db["ai"].result
    "redis-url"          = local.redis_url
  }
}

locals {
  # Static key list: for_each may not iterate over a map with sensitive values.
  generated_secret_names = toset([
    "jwt-secret", "database-url-owner", "database-url-app", "database-url-sync", "database-url-ai",
    "app-db-password", "sync-db-password", "ai-db-password", "redis-url",
  ])
}

resource "aws_secretsmanager_secret" "generated" {
  for_each                = local.generated_secret_names
  name                    = "${local.name}/${each.key}"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each      = local.generated_secret_names
  secret_id     = aws_secretsmanager_secret.generated[each.key].id
  secret_string = local.generated_secrets[each.key]
}

# Set by an operator after apply (never in code):
#   aws secretsmanager put-secret-value --secret-id constructos-production/anthropic-api-key --secret-string '<key>'
resource "aws_secretsmanager_secret" "anthropic" {
  name                    = "${local.name}/anthropic-api-key"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "anthropic_placeholder" {
  secret_id     = aws_secretsmanager_secret.anthropic.id
  secret_string = "set-me"

  lifecycle {
    ignore_changes = [secret_string] # the real key is set out of band
  }
}

locals {
  secret_arn = merge(
    { for k, s in aws_secretsmanager_secret.generated : k => s.arn },
    { "anthropic-api-key" = aws_secretsmanager_secret.anthropic.arn },
  )
}
