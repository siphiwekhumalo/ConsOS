output "public_url" {
  value = "https://${var.domain_name}"
}

output "name_servers" {
  description = "Only when create_hosted_zone = true: set these as the domain's NS records at the registrar."
  value       = var.create_hosted_zone ? aws_route53_zone.main[0].name_servers : null
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}

output "deploy_config_parameter" {
  description = "SSM parameter the Buildkite deploy step reads."
  value       = aws_ssm_parameter.deploy_config.name
}

output "buildkite_deploy_policy_arn" {
  description = "Attach to the Buildkite deploy agents' IAM role if buildkite_agent_role_name was not set."
  value       = aws_iam_policy.deploy.arn
}

output "anthropic_secret_name" {
  description = "Put the Claude API key here before enabling AI in production."
  value       = aws_secretsmanager_secret.anthropic.name
}

output "aurora_writer_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "tenant_files_bucket" {
  value = aws_s3_bucket.tenant_files.bucket
}

output "audit_anchors_bucket" {
  value = aws_s3_bucket.audit_anchors.bucket
}
