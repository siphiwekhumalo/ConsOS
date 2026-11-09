# Image registries + ECS cluster. One repository per service; the migrate task
# reuses the api-core image.

resource "aws_ecr_repository" "svc" {
  for_each             = toset(["api-core", "sync-service", "ai-engine", "web"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecr_lifecycle_policy" "svc" {
  for_each   = aws_ecr_repository.svc
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 50 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(["api-core", "sync-service", "ai-engine", "web", "migrate"])
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
  depends_on        = [aws_kms_key_policy.data]
}
