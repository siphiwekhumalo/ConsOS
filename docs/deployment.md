# Deploying ConstructOS to production (https://baheka-construct-os.com)

**Written for:** whoever owns the AWS account and the Buildkite organisation. Part A is done once.
Part B is what happens on every release.

## How a release works

```
push to main ──► Buildkite: tests (TS + DB isolation, Go, Python, Terraform, ShellCheck)
             ──► build 4 images (linux/amd64), push to ECR tagged with the commit SHA
             ──► ⏸ "Release to baheka-construct-os.com?" (a person clicks Release)
             ──► migrations as a one-off ECS task (stops the release if they fail)
             ──► roll api-core, sync-service, ai-engine, web (ECS; auto-rollback if unhealthy)
             ──► verify each service runs the new revision ──► smoke test the live domain
```

Other branches run the tests only. Infrastructure changes go through a separate pipeline
(`.buildkite/infra.yml`): plan, then a person approves, then apply.

| Path on baheka-construct-os.com | Served by |
|---|---|
| `/api/*` | api-core (NestJS) |
| `/sync/*` | sync-service (Go) |
| `/ai/*` | ai-engine (FastAPI) |
| everything else | web (React app, nginx) |
| `www.` | 301 redirect to the apex domain |
| `http://` | 301 redirect to `https://` |

## Part A: one-time setup

### 1. AWS account
- Enable the **af-south-1 (Cape Town)** opt-in region: Account → AWS Regions.
- Create the Terraform state bucket and lock table. The state holds generated secrets, so keep the bucket private and encrypted:
  ```bash
  aws s3api create-bucket --bucket baheka-terraform-state-af-south-1 --region af-south-1 \
    --create-bucket-configuration LocationConstraint=af-south-1
  aws s3api put-bucket-versioning --bucket baheka-terraform-state-af-south-1 --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket baheka-terraform-state-af-south-1 \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
  aws s3api put-public-access-block --bucket baheka-terraform-state-af-south-1 \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws dynamodb create-table --table-name baheka-terraform-locks --region af-south-1 \
    --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
  ```

### 2. Domain: baheka-construct-os.com
Terraform needs a Route 53 hosted zone for the domain. It uses the zone to issue the TLS certificate
(DNS validation) and to point the apex and `www` at the load balancer.
- **Domain already has a Route 53 zone in this account:** keep `create_hosted_zone = false` in
  `infra/terraform/environments/production.tfvars`.
- **Domain is registered elsewhere (e.g. a South African registrar):**
  1. Set `create_hosted_zone = true`.
  2. Run the first apply. It will wait on certificate validation.
  3. Set the registrar's NS records to the `name_servers` output. The apply then completes once DNS propagates.

### 3. Resources created earlier in the AWS console
Terraform creates and manages its own VPC, so the console-built `construct-os-production-vpc` is not
used. Delete it once you're sure nothing else depends on it.

To keep using the console bucket `construct-os-tenant-storage-prod` for tenant files:
1. Set `tenant_files_bucket_name` in `production.tfvars`.
2. Import the bucket before the first apply:
   ```bash
   terraform import -var-file=environments/production.tfvars aws_s3_bucket.tenant_files construct-os-tenant-storage-prod
   ```

### 4. First infrastructure apply
Run this from a machine with admin credentials, or through the infra pipeline once Buildkite is set up:
```bash
cd infra/terraform
cp backend.hcl.example backend.hcl        # adjust bucket/table names
terraform init -backend-config=backend.hcl
terraform plan  -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars
```
This creates:
- The network: VPC across 3 AZs, NAT, and flow logs.
- Aurora PostgreSQL 16 and Redis.
- KMS encryption and Secrets Manager entries. All passwords and the JWT secret are generated; none is typed by a person.
- The S3 buckets, including the CORS rule for browser uploads from the domain.
- ECR repositories and the ECS cluster with its four services.
- The load balancer and WAF, the TLS certificate, and the DNS records.

**The services stay unhealthy until the first release.** Terraform starts them on a placeholder image tag.

### 5. Claude API key (AI engine)
```bash
aws secretsmanager put-secret-value --region af-south-1 \
  --secret-id constructos-production/anthropic-api-key --secret-string '<key from the Anthropic Console>'
```
Get POPIA sign-off before AI processes personal information. Until the key is set, AI jobs fail
cleanly; set `ai_provider = "fake"` if you want them to succeed with placeholder results.

### 6. Buildkite
Buildkite clusters only accept steps for queues that exist in the cluster. The pipelines are written
around that:

| Queue | Used by | Agents need | Setting |
|---|---|---|---|
| your cluster's **default queue** | All test steps; they name no queue | Docker; no AWS permissions | none |
| **deploy** | Image builds, releases, organisation provisioning | The IAM policy from the Terraform output `buildkite_deploy_policy_arn`. Attach it to the agents' role, or set `buildkite_agent_role_name` and re-apply. It can only push to these ECR repositories and run/roll tasks in this cluster. | Pipeline env `DEPLOY_QUEUE` (default `deploy`) |
| **infra** | Terraform plan/apply | Permissions to manage the whole stack; keep it separate and tightly held | Pipeline env `INFRA_QUEUE` (default `infra`) |

To set it up:
1. In Buildkite, go to **Agents → (your cluster) → Queues** and create `deploy` and `infra`, or point
   `DEPLOY_QUEUE`/`INFRA_QUEUE` at queues you already have. Then run agents for them; the
   **Elastic CI Stack for AWS** in af-south-1 is the simplest option.
2. Create three pipelines from this repository. Default branch is `main`.

| Pipeline | Steps | Environment | Who can run it |
|---|---|---|---|
| `constructos` | `buildkite-agent pipeline upload` (finds `.buildkite/pipeline.yml`) | — | — |
| `constructos-infra` | `buildkite-agent pipeline upload .buildkite/infra.yml` | `TF_STATE_BUCKET`, `TF_LOCK_TABLE` | — |
| `constructos-provision` | `buildkite-agent pipeline upload .buildkite/provision.yml` | — | Platform operations team only |

Builds of `main` add the release steps (`.buildkite/release.yml`) automatically. Branch builds only
run tests, so they work before the `deploy` queue exists.

Optionally, restrict who can unblock the **Release** step with Buildkite teams.

### 7. Creating organisations and users
Nobody ever sets, sends or knows another person's password. Every account is activated through a
**one-time link**:
- valid for 72 hours (24 hours for a password reset);
- single use;
- stored only as a hash.

**A new customer organisation** is created by the platform team:
1. Run the `constructos-provision` pipeline.
2. Fill in the form: organisation ID (what users type at sign-in), name, tier, modules, and the first owner's name and work email.
3. The job creates the organisation and prints the owner's invite link in the job log.
4. Send the link privately to that person. They open it, set their own password and are signed in.

**Everyone else** is added by that organisation's owners or admins, in the app under
**Intelligence & governance → Users & access**:
1. Click **Invite user** and enter the name, email and role.
2. Copy the link that appears and share it privately.

The same page handles:
- **Role changes**.
- **Password reset:** issues a new one-time link. The old password works until the new one is set.
- **Deactivation:** blocks sign-in immediately for new sessions, keeps the person's history, and cancels any open links.
- **Reactivation**.

**Guardrails:**
- Only owners can create or manage owners.
- Nobody can change their own role or deactivate themselves.
- Every organisation keeps at least one active owner.
- Every action is written to the audit trail.

**Not built yet:** sending these links by email (planned via Amazon SES), SSO with Microsoft Entra ID, and MFA.

## Part B: every release
1. Merge to `main`. Tests, then the image builds, run automatically.
2. When the build pauses at **Release to baheka-construct-os.com?**, review the changes and click **Release**.
3. The deploy step:
   1. Runs migrations. If they fail, nothing is rolled out and the migration log is in the build output.
   2. Rolls the services and waits until they're stable.
   3. Fails the build if ECS rolled any service back.
4. The smoke test checks:
   - The app, and all three APIs through the domain.
   - That authentication is enforced.
   - The HTTP → HTTPS and `www` redirects.

**To roll back:** re-run the **Deploy** step of an earlier green build. Images are immutable and
tagged by commit, so this redeploys exactly that version. Migrations are forward-only; write a
new migration rather than editing an applied one.

## What protects production
- **Network:** TLS 1.2+/1.3 only, and the WAF (AWS managed rules plus a per-IP rate limit) in front of everything.
  Services sit in private subnets, reachable only from the load balancer. The database and Redis are reachable only from the services.
- **Database roles:** each service connects with its own least-privilege role over TLS (`sslmode=require`).
  Passwords come from Secrets Manager and are applied by the migration task on every release.
- **Images:** immutable tags and scan-on-push. The deploy role can't touch anything outside this environment.
- **Releases:** a person approves every production release, and releases never overlap.

## Not verified yet
- `terraform validate` passes, but **no `plan` or `apply` has been run against the real account**.
  Expect to fix account-specific details on the first plan: service quotas, region opt-in, domain ownership.
- The pipeline's test steps were run locally in the same containers the agents use, and all pass.
  The AWS-side steps (build-push, deploy) have not run, because they need the account.
