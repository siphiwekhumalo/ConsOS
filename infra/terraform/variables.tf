variable "environment" {
  description = "Deployment environment name (e.g. staging, production)."
  type        = string
}

variable "region" {
  description = "AWS region. af-south-1 (Cape Town) keeps tenant data in South Africa for POPIA."
  type        = string
  default     = "af-south-1"
}

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

variable "audit_retention_days" {
  description = "S3 Object Lock retention for audit-ledger anchors. Contract records commonly need 5+ years."
  type        = number
  default     = 2555 # ~7 years
}
