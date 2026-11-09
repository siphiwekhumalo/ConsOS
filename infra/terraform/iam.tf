# --------------------------------------------------------------------------- ECS execution role
# Used by the ECS agent: pull images, write logs, read the secrets it injects.
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = values(local.secret_arn) },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.data.arn] },
    ]
  })
}

# --------------------------------------------------------------------------- task roles (least privilege)
resource "aws_iam_role" "task" {
  for_each           = toset(["api-core", "sync-service", "ai-engine", "web", "migrate"])
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# Core API: presigns uploads/downloads and checks object size in the tenant bucket.
resource "aws_iam_role_policy" "api_s3" {
  name = "tenant-files"
  role = aws_iam_role.task["api-core"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.tenant_files.arn}/*" },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = [aws_kms_key.data.arn] },
    ]
  })
}

# AI engine: read-only on tenant files (tender PDFs).
resource "aws_iam_role_policy" "ai_s3" {
  name = "tenant-files-read"
  role = aws_iam_role.task["ai-engine"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.tenant_files.arn}/*" },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.data.arn] },
    ]
  })
}

# --------------------------------------------------------------------------- Buildkite deploy policy
# Attach to the Buildkite deploy agents' role (Elastic CI Stack for AWS). It can
# push images and roll out services in THIS environment only.
data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = [for r in aws_ecr_repository.svc : r.arn]
  }
  statement {
    sid       = "EcrKms"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
  statement {
    sid       = "EcsTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"] # these actions do not support resource-level permissions
  }
  statement {
    sid       = "EcsRollout"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:RunTask", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.execution.arn], [for r in aws_iam_role.task : r.arn])
  }
  statement {
    sid       = "DeployConfig"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.deploy_config.arn]
  }
  statement {
    sid       = "MigrationLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.svc["migrate"].arn}:*"]
  }
}

resource "aws_iam_policy" "deploy" {
  name   = "${local.name}-buildkite-deploy"
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policy_attachment" "buildkite" {
  count      = var.buildkite_agent_role_name == null ? 0 : 1
  role       = var.buildkite_agent_role_name
  policy_arn = aws_iam_policy.deploy.arn
}
