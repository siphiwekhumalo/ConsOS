import { BadRequestException, Body, Controller, Get, GoneException, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, findInvite, revokeOpenInvites, schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators';

const Accept = z.object({
  token: z.string().min(30).max(64),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
});

/**
 * Public, pre-authentication endpoints for accepting an invitation or a
 * password-reset link. The token is the only credential; it is single-use,
 * short-lived and stored only as a hash.
 */
@Controller('auth/invite')
@Public()
@UseGuards(ThrottlerGuard)
export class InvitesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async lookup(@Param('token') token: string) {
    const invite = await findInvite(this.db.raw, token);
    if (!invite) throw new NotFoundException('This link is invalid or has expired. Ask your administrator for a new one.');
    return {
      purpose: invite.purpose,
      email: invite.email,
      fullName: invite.fullName,
      organisation: { name: invite.tenantName, id: invite.tenantSlug },
      expiresAt: invite.expiresAt,
    };
  }

  @Post('accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(@Body(new ZodBodyPipe(Accept)) body: z.infer<typeof Accept>) {
    const invite = await findInvite(this.db.raw, body.token);
    if (!invite) throw new NotFoundException('This link is invalid or has expired. Ask your administrator for a new one.');
    if (body.password.toLowerCase().includes(invite.email.split('@')[0]!.toLowerCase())) {
      throw new BadRequestException('Choose a password that does not contain your email name');
    }
    const passwordHash = await this.auth.hashPassword(body.password);

    const role = await this.db.forTenant(invite.tenantId, async (tx) => {
      // Spend the invite atomically: a second concurrent accept finds nothing to spend.
      const spent = await tx
        .update(schema.userInvites)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.userInvites.id, invite.inviteId), isNull(schema.userInvites.usedAt)))
        .returning({ id: schema.userInvites.id });
      if (spent.length === 0) throw new GoneException('This link has already been used.');
      await revokeOpenInvites(tx, invite.userId);

      const [user] = await tx
        .update(schema.users)
        .set({ passwordHash, isActive: true })
        .where(eq(schema.users.id, invite.userId))
        .returning({ role: schema.users.role });
      await appendAudit(tx, {
        tenantId: invite.tenantId,
        actorUserId: invite.userId,
        action: invite.purpose === 'invite' ? 'user.activated' : 'user.password_reset',
        entityType: 'user',
        entityId: invite.userId,
        payload: { email: invite.email },
      });
      return user!.role;
    });

    return {
      ...(await this.auth.issue(invite.userId, invite.tenantId, role)),
      organisation: { id: invite.tenantSlug, name: invite.tenantName },
    };
  }
}
