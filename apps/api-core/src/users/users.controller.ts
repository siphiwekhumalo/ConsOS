import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, createInvite, inviteUrl, revokeOpenInvites, schema, type Tx, type UserRole } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { APP_CONFIG, type AppConfig } from '../config';
import type { Principal } from '../auth/auth.types';

const ROLES = ['owner', 'admin', 'project_manager', 'site_foreman', 'finance', 'viewer'] as const;
const Invite = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
});
const Update = z
  .object({ role: z.enum(ROLES).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, 'Nothing to change');

const U = schema.users;

/**
 * Users & access, per organisation. Owners and admins invite people and manage
 * roles; only owners can create or change owners; nobody can lock themselves
 * out; there is always at least one active owner.
 */
@Controller('users')
@Roles('owner', 'admin')
export class UsersController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: U.id,
          email: U.email,
          fullName: U.fullName,
          role: U.role,
          isActive: U.isActive,
          hasPassword: sql<boolean>`${U.passwordHash} is not null`,
          createdAt: U.createdAt,
          // Explicit aliases: inside a subquery, unqualified "id" would bind to user_invites.id.
          inviteExpiresAt: sql<string | null>`(select max(ui.expires_at) from user_invites ui
            where ui.user_id = "users"."id" and ui.used_at is null and ui.expires_at > now())`,
        })
        .from(U)
        .orderBy(asc(U.fullName));
      return rows.map((r) => ({
        ...r,
        status: !r.hasPassword ? 'invited' : r.isActive ? 'active' : 'deactivated',
      }));
    });
  }

  @Post('invite')
  async invite(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(Invite)) body: z.infer<typeof Invite>) {
    if (body.role === 'owner' && p.role !== 'owner') throw new ForbiddenException('Only an owner can invite another owner');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [user] = await tx
          .insert(U)
          .values({ tenantId: p.tenantId, email: body.email, fullName: body.fullName, role: body.role, passwordHash: null, isActive: false })
          .returning({ id: U.id, email: U.email, fullName: U.fullName, role: U.role });
        const link = await createInvite(tx, { tenantId: p.tenantId, userId: user!.id, purpose: 'invite', createdBy: p.userId });
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'user.invited',
          entityType: 'user',
          entityId: user!.id,
          payload: { email: body.email, role: body.role },
        });
        return { user: user!, inviteUrl: inviteUrl(this.config.WEB_ORIGIN, link.token), expiresAt: link.expiresAt };
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new ConflictException('Someone with this email is already in your organisation');
      throw err;
    }
  }

  /** New one-time link: an invite if they never set a password, otherwise a password reset. */
  @Post(':id/link')
  link(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const target = await this.target(tx, p, id);
      if (target.passwordHash && !target.isActive) throw new BadRequestException('Reactivate this user before sending a reset link');
      const purpose = target.passwordHash ? 'reset' : 'invite';
      const link = await createInvite(tx, { tenantId: p.tenantId, userId: id, purpose, createdBy: p.userId });
      await appendAudit(tx, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: purpose === 'invite' ? 'user.invite_reissued' : 'user.reset_issued',
        entityType: 'user',
        entityId: id,
        payload: { email: target.email },
      });
      return { purpose, inviteUrl: inviteUrl(this.config.WEB_ORIGIN, link.token), expiresAt: link.expiresAt };
    });
  }

  @Patch(':id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Update)) body: z.infer<typeof Update>) {
    if (id === p.userId) throw new ForbiddenException('You cannot change your own role or deactivate yourself');
    if (body.role === 'owner' && p.role !== 'owner') throw new ForbiddenException('Only an owner can make someone an owner');
    return this.db.forTenant(p.tenantId, async (tx) => {
      const target = await this.target(tx, p, id);
      const losingOwner = target.role === 'owner' && ((body.role && body.role !== 'owner') || body.isActive === false);
      if (losingOwner) {
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(U)
          .where(and(eq(U.role, 'owner'), eq(U.isActive, true), ne(U.id, id)))) as [{ n: number }];
        if (n === 0) throw new ConflictException('Your organisation must keep at least one active owner');
      }
      if (body.isActive === true && !target.passwordHash) {
        throw new BadRequestException('This person has not accepted their invite yet. Send them a new link instead');
      }

      const [updated] = await tx
        .update(U)
        .set({ ...(body.role ? { role: body.role } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) })
        .where(eq(U.id, id))
        .returning({ id: U.id, role: U.role, isActive: U.isActive });
      if (body.isActive === false) await revokeOpenInvites(tx, id);

      if (body.role && body.role !== target.role) {
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'user.role_changed',
          entityType: 'user',
          entityId: id,
          payload: { email: target.email, from: target.role, to: body.role },
        });
      }
      if (body.isActive !== undefined && body.isActive !== target.isActive) {
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: body.isActive ? 'user.reactivated' : 'user.deactivated',
          entityType: 'user',
          entityId: id,
          payload: { email: target.email },
        });
      }
      return updated;
    });
  }

  /** Admins may manage everyone except owners; owners may manage everyone but themselves. */
  private async target(tx: Tx, p: Principal, id: string) {
    const [target] = await tx.select().from(U).where(eq(U.id, id));
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'owner' && p.role !== 'owner') throw new ForbiddenException('Only an owner can manage another owner');
    return target as typeof target & { role: UserRole };
  }
}
