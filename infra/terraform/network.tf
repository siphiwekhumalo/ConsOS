data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "constructos-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.16"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets   = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]
  database_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 20)]

  create_database_subnet_group       = true
  create_database_subnet_route_table = true # no internet route for the DB tier

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway

  enable_dns_hostnames = true
  enable_dns_support   = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_cloudwatch_iam_role  = true
  flow_log_max_aggregation_interval    = 60
}

# Gateway endpoint: S3 traffic from tasks bypasses NAT (cheaper, stays on the AWS network).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ingress to the load balancer"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP (redirected to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }
}

# All four Fargate services: ingress from the ALB only, on their container ports.
resource "aws_security_group" "services" {
  name        = "${local.name}-services"
  description = "ECS services: ingress from the ALB only"
  vpc_id      = module.vpc.vpc_id

  dynamic "ingress" {
    for_each = toset([80, 3000, 8000, 8081])
    content {
      description     = "port ${ingress.value} from ALB"
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      security_groups = [aws_security_group.alb.id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"] # Claude API, ECR, Secrets Manager (via NAT)
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Aurora: ingress from ECS services only"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Postgres from services"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.services.id]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache: ingress from ECS services only"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Redis from services"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.services.id]
  }
}
