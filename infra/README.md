# Infrastructure (Terraform, af-south-1)

Production runbook: **[docs/deployment.md](../docs/deployment.md)**.

| File | What it defines |
|---|---|
| `network.tf` | VPC (public, private and database subnets), NAT, flow logs, security groups |
| `database.tf` | KMS key, Aurora PostgreSQL 16 Serverless v2, generated passwords and connection URLs |
| `redis.tf` | ElastiCache Redis (TLS + auth token) |
| `secrets.tf` | Secrets Manager entries injected into ECS tasks |
| `storage.tf` | Tenant-files bucket (with CORS for the domain), Object Lock audit-anchor bucket |
| `dns.tf` | Route 53 zone/records and ACM certificate for `baheka-construct-os.com` |
| `alb.tf` | Load balancer, HTTPS listener, path routing, `www` redirect, WAF |
| `compute.tf` | ECR repositories, ECS cluster, log groups |
| `iam.tf` | ECS execution/task roles, Buildkite deploy policy |
| `services.tf` | Task definitions, Fargate services, autoscaling, deploy config in SSM |
| `environments/production.tfvars` | Non-secret production settings |

Static checks (also run in CI):

```bash
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:1.9.8 fmt -check -recursive
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:1.9.8 init -backend=false
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:1.9.8 validate
```
