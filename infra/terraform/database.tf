# Aurora PostgreSQL 16, Serverless v2.
# The master user is the *owner* role (migrations only). The API uses
# constructos_app, created by the bootstrap step described in infra/README.md.

resource "aws_kms_key" "data" {
  description             = "${local.name} data-at-rest (Aurora, S3, Secrets)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
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

  master_username             = "constructos_owner"
  manage_master_user_password = true # stored and rotated in Secrets Manager; never in state or code
  master_user_secret_kms_key_id = aws_kms_key.data.key_id

  db_subnet_group_name            = module.vpc.database_subnet_group_name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.pg16.name

  storage_encrypted = true
  kms_key_id        = aws_kms_key.data.arn

  backup_retention_period      = 35
  preferred_backup_window      = "00:00-01:00" # 02:00-03:00 SAST
  copy_tags_to_snapshot        = true
  deletion_protection          = var.environment == "production"
  skip_final_snapshot          = var.environment != "production"
  final_snapshot_identifier    = "${local.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${local.name}-writer"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  promotion_tier      = 0
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}

resource "aws_rds_cluster_instance" "reader" {
  count               = var.aurora_reader_count
  identifier          = "${local.name}-reader-${count.index}"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  promotion_tier      = 1
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}
