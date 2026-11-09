import { Controller, Get, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser } from '../auth/decorators';
import { EntitlementsService } from '../auth/entitlements.service';
import type { Principal } from '../auth/auth.types';

@Controller('me')
export class MeController {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Who am I, which organisation, and which modules should the UI render. */
  @Get()
  async me(@CurrentUser() principal: Principal) {
    const result = await this.db.forTenant(principal.tenantId, async (tx) => {
      const [user] = await tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          fullName: schema.users.fullName,
          role: schema.users.role,
        })
        .from(schema.users)
        .where(eq(schema.users.id, principal.userId));
      const [tenant] = await tx
        .select({
          id: schema.tenants.id,
          slug: schema.tenants.slug,
          name: schema.tenants.name,
          tier: schema.tenants.tier,
        })
        .from(schema.tenants);
      return { user, tenant };
    });
    if (!result.user || !result.tenant) throw new NotFoundException();
    return {
      ...result,
      modules: await this.entitlements.activeModules(principal.tenantId),
    };
  }
}
