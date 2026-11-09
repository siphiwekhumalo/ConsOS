# Tenant files (site photos, drawings, certificates). Objects live under
# {tenant_id}/... but the prefix is NOT the isolation boundary on its own: the
# API authorises every access and hands out short-lived presigned URLs.
#
# To adopt an existing console-created bucket instead of creating one:
#   tenant_files_bucket_name = "construct-os-tenant-storage-prod"
#   terraform import aws_s3_bucket.tenant_files construct-os-tenant-storage-prod
resource "aws_s3_bucket" "tenant_files" {
  bucket        = var.tenant_files_bucket_name
  bucket_prefix = var.tenant_files_bucket_name == null ? "${local.name}-files-" : null
}

resource "aws_s3_bucket_public_access_block" "tenant_files" {
  bucket                  = aws_s3_bucket.tenant_files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tenant_files" {
  bucket = aws_s3_bucket.tenant_files.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "tenant_files" {
  bucket = aws_s3_bucket.tenant_files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_files" {
  bucket = aws_s3_bucket.tenant_files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

# Browsers upload and download directly with presigned URLs, so the bucket must
# accept cross-origin PUT/GET from the platform's own origin, and nothing else.
resource "aws_s3_bucket_cors_configuration" "tenant_files" {
  bucket = aws_s3_bucket.tenant_files.id
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = ["https://${var.domain_name}", "https://www.${var.domain_name}"]
    allowed_headers = ["content-type", "content-length", "x-amz-*"]
    expose_headers  = ["etag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "tenant_files_tls" {
  bucket = aws_s3_bucket.tenant_files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.tenant_files.arn, "${aws_s3_bucket.tenant_files.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Audit-ledger anchors: periodic signed hash-chain heads written here under
# Object Lock COMPLIANCE mode, so not even an account admin can alter or delete
# them during the retention period.
resource "aws_s3_bucket" "audit_anchors" {
  bucket_prefix       = "${local.name}-audit-"
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "audit_anchors" {
  bucket                  = aws_s3_bucket.audit_anchors.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_retention_days
    }
  }
}

resource "aws_s3_bucket_policy" "audit_anchors_tls" {
  bucket = aws_s3_bucket.audit_anchors.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.audit_anchors.arn, "${aws_s3_bucket.audit_anchors.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Server access logs for both data buckets land in the log bucket (alb.tf).
resource "aws_s3_bucket_logging" "tenant_files" {
  bucket        = aws_s3_bucket.tenant_files.id
  target_bucket = aws_s3_bucket.alb_logs.id
  target_prefix = "s3-access/tenant-files/"
}

resource "aws_s3_bucket_logging" "audit_anchors" {
  bucket        = aws_s3_bucket.audit_anchors.id
  target_bucket = aws_s3_bucket.alb_logs.id
  target_prefix = "s3-access/audit-anchors/"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}
