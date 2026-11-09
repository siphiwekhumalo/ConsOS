# Aurora PostgreSQL 16, Serverless v2.
# The master user is the *owner* role (migrations only). Each service has its
# own least-privilege role; passwords are generated here, stored in Secrets
# Manager (see secrets.tf) and applied by the migrate task (provision-roles).

resource "aws_kms_key" "data" {
  description             = "${local.name} data-at-rest (Aurora, S3, Secrets, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# CloudWatch Logs must be allowed to use the key for encrypted log groups.
data "aws_caller_identity" "current" {}

resource "aws_kms_key_policy" "data" {
  key_id = aws_kms_key.data.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
      },
    ]
  })
}

resource "random_password" "db" {
  for_each = toset(["owner", "app", "sync", "ai"])
  length   = 40
  special  = false # URL-safe: these are embedded in connection strings
}

resource "aws_rds_cluster_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = local.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "16.6"
  database_name      = "constructos"

  master_username = "constructos_owner"
  master_password = random_password.db["owner"].result

  db_subnet_group_name            = module.vpc.database_subnet_group_name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.pg16.name

  storage_encrypted = true
  kms_key_id        = aws_kms_key.data.arn

  backup_retention_period         = 35
  preferred_backup_window         = "00:00-01:00" # 02:00-03:00 SAST
  copy_tags_to_snapshot           = true
  deletion_protection             = var.environment == "production"
  skip_final_snapshot             = var.environment != "production"
  final_snapshot_identifier       = "${local.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier                      = "${local.name}-writer"
  cluster_identifier              = aws_rds_cluster.main.id
  instance_class                  = "db.serverless"
  engine                          = aws_rds_cluster.main.engine
  engine_version                  = aws_rds_cluster.main.engine_version
  promotion_tier                  = 0
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}

resource "aws_rds_cluster_instance" "reader" {
  count                           = var.aurora_reader_count
  identifier                      = "${local.name}-reader-${count.index}"
  cluster_identifier              = aws_rds_cluster.main.id
  instance_class                  = "db.serverless"
  engine                          = aws_rds_cluster.main.engine
  engine_version                  = aws_rds_cluster.main.engine_version
  promotion_tier                  = 1
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}

locals {
  db_host = aws_rds_cluster.main.endpoint
  db_url = {
    for role, user in {
      owner = "constructos_owner"
      app   = "constructos_app"
      sync  = "constructos_sync"
      ai    = "constructos_ai"
    } : role => "postgresql://${user}:${random_password.db[role].result}@${local.db_host}:5432/constructos?sslmode=require"
  }
}
