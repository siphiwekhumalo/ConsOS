# ECS Fargate services. Terraform creates the first task-definition revision
# (bootstrap tag); every Buildkite deploy registers a new revision with the
# commit SHA and rolls the service. Terraform therefore ignores task_definition
# drift on the services and never rolls a deployment back by itself.

locals {
  ecr           = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
  public_origin = "https://${var.domain_name}"

  common_env = [
    { name = "S3_BUCKET", value = aws_s3_bucket.tenant_files.bucket },
    { name = "S3_REGION", value = var.region },
    { name = "AWS_REGION", value = var.region },
  ]

  containers = {
    "api-core" = {
      image   = "${local.ecr["api-core"]}:${var.bootstrap_image_tag}"
      port    = 3000
      command = null
      env = concat(local.common_env, [
        { name = "API_PORT", value = "3000" },
        { name = "WEB_ORIGIN", value = local.public_origin },
        { name = "NODE_ENV", value = "production" },
      ])
      secrets = {
        JWT_SECRET       = "jwt-secret"
        DATABASE_URL_APP = "database-url-app"
        REDIS_URL        = "redis-url"
      }
    }
    "sync-service" = {
      image   = "${local.ecr["sync-service"]}:${var.bootstrap_image_tag}"
      port    = 8081
      command = null
      env     = [{ name = "PORT", value = "8081" }]
      secrets = {
        JWT_SECRET        = "jwt-secret"
        SYNC_DATABASE_URL = "database-url-sync"
      }
    }
    "ai-engine" = {
      image   = "${local.ecr["ai-engine"]}:${var.bootstrap_image_tag}"
      port    = 8000
      command = null
      env     = concat(local.common_env, [{ name = "AI_PROVIDER", value = var.ai_provider }])
      secrets = {
        JWT_SECRET        = "jwt-secret"
        AI_DATABASE_URL   = "database-url-ai"
        ANTHROPIC_API_KEY = "anthropic-api-key"
      }
    }
    "web" = {
      image   = "${local.ecr["web"]}:${var.bootstrap_image_tag}"
      port    = 80
      command = null
      env     = []
      secrets = {}
    }
    # One-off task run by every deploy before the services roll: migrations,
    # then service-role passwords from Secrets Manager.
    "migrate" = {
      image = "${local.ecr["api-core"]}:${var.bootstrap_image_tag}"
      port  = null
      command = ["sh", "-c",
      "node node_modules/@constructos/db/dist/migrate.js && node node_modules/@constructos/db/dist/provision-roles.js"]
      env = []
      secrets = {
        DATABASE_URL_OWNER = "database-url-owner"
        APP_DB_PASSWORD    = "app-db-password"
        SYNC_DB_PASSWORD   = "sync-db-password"
        AI_DB_PASSWORD     = "ai-db-password"
      }
    }
  }
  task_size = merge(
    { for k, v in var.service_scale : k => { cpu = v.cpu, memory = v.memory } },
    { migrate = { cpu = 256, memory = 512 } },
  )
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.containers
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.task_size[each.key].cpu
  memory                   = local.task_size[each.key].memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(
    {
      name                   = each.key
      image                  = each.value.image
      essential              = true
      environment            = each.value.env
      secrets                = [for name, key in each.value.secrets : { name = name, valueFrom = local.secret_arn[key] }]
      readonlyRootFilesystem = false
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    },
    each.value.port == null ? {} : { portMappings = [{ containerPort = each.value.port, protocol = "tcp" }] },
    each.value.command == null ? {} : { command = each.value.command },
  )])

  lifecycle {
    ignore_changes = [container_definitions] # image tags are owned by the deploy pipeline
  }
}

resource "aws_ecs_service" "svc" {
  for_each                          = var.service_scale
  name                              = each.key
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.svc[each.key].arn
  desired_count                     = each.value.desired
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = each.key == "ai-engine" ? 180 : 60
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.services.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.svc[each.key].arn
    container_name   = each.key
    container_port   = local.containers[each.key].port
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true # a deploy that never becomes healthy rolls back automatically
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

# CPU-based autoscaling (morning shift check-ins drive sync and API load).
resource "aws_appautoscaling_target" "svc" {
  for_each           = var.service_scale
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = var.service_scale
  name               = "${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# --------------------------------------------------------------------------- deploy config
# Everything the Buildkite deploy script needs, in one parameter.
resource "aws_ssm_parameter" "deploy_config" {
  name = "/constructos/${var.environment}/deploy-config"
  type = "String"
  value = jsonencode({
    region         = var.region
    cluster        = aws_ecs_cluster.main.name
    ecr_registry   = split("/", local.ecr["api-core"])[0]
    repositories   = local.ecr
    task_families  = { for k, t in aws_ecs_task_definition.svc : k => t.family }
    services       = { for k, s in aws_ecs_service.svc : k => s.name }
    subnets        = module.vpc.private_subnets
    security_group = aws_security_group.services.id
    public_url     = local.public_origin
  })
}
