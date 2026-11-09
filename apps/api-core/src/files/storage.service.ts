import { Inject, Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, type AppConfig } from '../config';

/**
 * Thin S3 wrapper. Clients upload and download directly to/from S3 with
 * short-lived presigned URLs; file bytes never pass through the API.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  /** Signs URLs with the host the browser can reach. Same as `s3` in AWS. */
  private readonly signer: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const client = (endpoint?: string) =>
      new S3Client({ region: config.S3_REGION, endpoint, forcePathStyle: config.S3_FORCE_PATH_STYLE });
    this.s3 = client(config.S3_ENDPOINT);
    this.signer = config.S3_PUBLIC_ENDPOINT ? client(config.S3_PUBLIC_ENDPOINT) : this.s3;
  }

  presignUpload(key: string, contentType: string, sizeBytes: number) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
        ServerSideEncryption: this.config.S3_ENDPOINT ? undefined : 'aws:kms',
      }),
      {
        expiresIn: this.config.S3_UPLOAD_URL_TTL_SECONDS,
        // Sign these so the client cannot swap type or size after authorisation.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  presignDownload(key: string, filename: string) {
    const safeName = filename.replace(/["\\\r\n]/g, '_');
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: this.config.S3_DOWNLOAD_URL_TTL_SECONDS },
    );
  }

  /** Returns the stored size, or null if the object does not exist. */
  async objectSize(key: string): Promise<number | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      return head.ContentLength ?? null;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }
}
