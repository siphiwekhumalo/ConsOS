output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnets
}

output "aurora_writer_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "aurora_reader_endpoint" {
  value = aws_rds_cluster.main.reader_endpoint
}

output "aurora_master_secret_arn" {
  description = "Secrets Manager ARN holding the owner (migration) credentials."
  value       = aws_rds_cluster.main.master_user_secret[0].secret_arn
}

output "tenant_files_bucket" {
  value = aws_s3_bucket.tenant_files.bucket
}

output "audit_anchors_bucket" {
  value = aws_s3_bucket.audit_anchors.bucket
}

output "ecr_api_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
