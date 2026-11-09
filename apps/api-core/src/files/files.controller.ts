import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { StorageService } from './storage.service';

/** Allow-list: construction documents only. Executables/HTML are never accepted. */
const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'application/acad', // DWG
  'image/vnd.dxf',
] as const;

const CreateUpload = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(ALLOWED_TYPES),
  sizeBytes: z.number().int().positive().max(500 * 1024 * 1024),
  category: z.enum(['general', 'drawing', 'photo', 'contract', 'tax', 'hse']).default('general'),
  projectId: z.string().uuid().optional(),
});
type CreateUpload = z.infer<typeof CreateUpload>;

const ListQuery = z.object({ projectId: z.string().uuid().optional() });
type ListQuery = z.infer<typeof ListQuery>;

/** Categories whose downloads are recorded in the audit ledger. */
const SENSITIVE = new Set(['contract', 'tax']);

@Controller('files')
export class FilesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Step 1: register the file and get a presigned PUT URL.
   * The object key is server-generated ({tenant}/{file}); clients never choose keys.
   */
  @Post('uploads')
  @Roles('owner', 'admin', 'project_manager', 'site_foreman', 'finance')
  async createUpload(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(CreateUpload)) body: CreateUpload) {
    const fileId = randomUUID();
    const objectKey = `${p.tenantId}/${fileId}`;
    await this.db.forTenant(p.tenantId, async (tx) => {
      try {
        await tx.insert(schema.files).values({
          id: fileId,
          tenantId: p.tenantId,
          projectId: body.projectId ?? null,
          objectKey,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          category: body.category,
          uploadedBy: p.userId,
        });
      } catch (err) {
        // FK (tenant_id, project_id): a project id from another tenant fails here.
        if ((err as { cause?: { code?: string } }).cause?.code === '23503') {
          throw new BadRequestException('Unknown project');
        }
        throw err;
      }
    });
    const uploadUrl = await this.storage.presignUpload(objectKey, body.contentType, body.sizeBytes);
    return {
      fileId,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': body.contentType },
    };
  }

  /** Step 2: confirm the upload landed; verifies the object exists with the declared size. */
  @Post(':id/complete')
  async complete(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const file = await this.find(p, id);
    if (file.status !== 'pending') throw new ConflictException(`File is already ${file.status}`);
    if (file.uploadedBy !== p.userId) throw new NotFoundException();

    const size = await this.storage.objectSize(file.objectKey);
    if (size === null) throw new ConflictException('Upload not found in storage yet');
    const status = size === file.sizeBytes ? 'uploaded' : 'rejected';

    return this.db.forTenant(p.tenantId, async (tx) => {
      const [updated] = await tx
        .update(schema.files)
        .set({ status })
        .where(eq(schema.files.id, id))
        .returning();
      await appendAudit(tx, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: status === 'uploaded' ? 'file.uploaded' : 'file.rejected',
        entityType: 'file',
        entityId: id,
        payload: { filename: file.filename, category: file.category, sizeBytes: size, projectId: file.projectId },
      });
      return updated;
    });
  }

  @Get()
  list(@CurrentUser() p: Principal, @Query(new ZodBodyPipe(ListQuery)) q: ListQuery) {
    const f = schema.files;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx
        .select()
        .from(f)
        .where(and(eq(f.status, 'uploaded'), q.projectId ? eq(f.projectId, q.projectId) : undefined))
        .orderBy(desc(f.createdAt))
        .limit(200),
    );
  }

  /** Short-lived presigned GET. Contract and tax documents are access-logged. */
  @Get(':id/download')
  async download(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const file = await this.find(p, id);
    if (file.status !== 'uploaded') throw new NotFoundException();
    if (SENSITIVE.has(file.category)) {
      await this.db.forTenant(p.tenantId, (tx) =>
        appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'file.downloaded',
          entityType: 'file',
          entityId: id,
          payload: { filename: file.filename, category: file.category },
        }),
      );
    }
    return { url: await this.storage.presignDownload(file.objectKey, file.filename) };
  }

  private async find(p: Principal, id: string) {
    const [file] = await this.db.forTenant(p.tenantId, (tx) =>
      tx.select().from(schema.files).where(eq(schema.files.id, id)),
    );
    if (!file) throw new NotFoundException();
    return file;
  }
}
