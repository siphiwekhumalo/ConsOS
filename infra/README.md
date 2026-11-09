# Infrastructure (Terraform, af-south-1)

> **Not yet validated.** This code has not been through `terraform validate` or `plan`.
> Run both before first use.

## What this provisions

- VPC across 2 AZs (configurable to 3): public, private and isolated database subnets; NAT per AZ (or a single NAT for staging); VPC flow logs; S3 gateway endpoint.
- Security groups: ALB (443 in), API (3000 from ALB only), DB (5432 from API only).
- Aurora PostgreSQL 16 Serverless v2: writer plus N readers, encrypted with a customer KMS key, TLS enforced, 35-day backups, master password managed by Secrets Manager.
- S3: tenant-files bucket (private, KMS, versioned, TLS-only) and an **Object Lock COMPLIANCE** bucket for audit-ledger anchors.
- ECR repository (immutable tags, scan on push) and ECS Fargate cluster with a log group.

**Next increment:** ALB with ACM wildcard certificate, ECS task definition and service for the API, WAF,
CloudFront for the web app, ElastiCache, Route 53.

## Usage

```bash
cd infra/terraform
cp staging.tfvars.example staging.tfvars
terraform init        # after configuring the S3 backend in versions.tf
terraform plan  -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars
```

## Database bootstrap (once per environment)

Migrations run as the Aurora master user (`constructos_owner`), using credentials from the secret in the
`aurora_master_secret_arn` output. The migration creates `constructos_app` as `NOLOGIN`. Give it a
login once, with a password generated into Secrets Manager (never typed into code or tickets):

```sql
ALTER ROLE constructos_app LOGIN PASSWORD '<from Secrets Manager>';
```

The API task receives `DATABASE_URL_APP` from Secrets Manager through the ECS task definition.
