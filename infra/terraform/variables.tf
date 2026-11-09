variable "environment" {
  description = "Deployment environment name (e.g. staging, production)."
  type        = string
}

variable "region" {
  description = "AWS region. af-south-1 (Cape Town) keeps tenant data in South Africa for POPIA. It is an opt-in region; enable it on the account first."
  type        = string
  default     = "af-south-1"
}

# --------------------------------------------------------------------------- domain
variable "domain_name" {
  description = "Public domain the platform is served on."
  type        = string
  default     = "baheka-construct-os.com"
}

variable "create_hosted_zone" {
  description = "true = create the Route 53 zone (then point the registrar's NS records at the output name servers). false = use an existing Route 53 zone for domain_name."
  type        = bool
  default     = false
}

# --------------------------------------------------------------------------- network
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones to span (af-south-1 has 3)."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per AZ. Cheaper; acceptable for staging only."
  type        = bool
  default     = false
}

# --------------------------------------------------------------------------- data
variable "aurora_min_acu" {
  description = "Aurora Serverless v2 minimum capacity. 0 allows auto-pause (non-production only)."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  type    = number
  default = 4
}

variable "aurora_reader_count" {
  description = "Number of reader instances in other AZs (failover targets)."
  type        = number
  default     = 1
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "tenant_files_bucket_name" {
  description = "Exact name for the tenant-files bucket (e.g. an existing console-created bucket you will import). null = generated name."
  type        = string
  default     = null
}

variable "audit_retention_days" {
  description = "S3 Object Lock retention for audit-ledger anchors. Contract records commonly need 5+ years."
  type        = number
  default     = 2555 # ~7 years
}

# --------------------------------------------------------------------------- services
variable "bootstrap_image_tag" {
  description = "Image tag used when Terraform first creates task definitions. Deployments (Buildkite) register new revisions with the commit SHA; Terraform ignores those changes."
  type        = string
  default     = "bootstrap"
}

variable "service_scale" {
  description = "Fargate sizing and task counts per service."
  type = map(object({
    cpu     = number
    memory  = number
    desired = number
    min     = number
    max     = number
  }))
  default = {
    "api-core"     = { cpu = 512, memory = 1024, desired = 2, min = 2, max = 6 }
    "sync-service" = { cpu = 256, memory = 512, desired = 2, min = 2, max = 8 }
    "ai-engine"    = { cpu = 512, memory = 1024, desired = 1, min = 1, max = 3 }
    "web"          = { cpu = 256, memory = 512, desired = 2, min = 2, max = 4 }
  }
}

variable "ai_provider" {
  description = "\"anthropic\" for real Claude calls (set the ANTHROPIC_API_KEY secret first) or \"fake\"."
  type        = string
  default     = "anthropic"
}

# --------------------------------------------------------------------------- CI/CD
variable "buildkite_agent_role_name" {
  description = "IAM role name of the Buildkite deploy agents (e.g. from the Elastic CI Stack). When set, the deploy policy is attached to it."
  type        = string
  default     = null
}
