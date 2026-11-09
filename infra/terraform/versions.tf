terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Configure remote state per environment (S3 bucket + DynamoDB lock table) before first apply:
  # backend "s3" {
  #   bucket         = "<state-bucket>"
  #   key            = "constructos/<env>/terraform.tfstate"
  #   region         = "af-south-1"
  #   dynamodb_table = "<lock-table>"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "constructos"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
