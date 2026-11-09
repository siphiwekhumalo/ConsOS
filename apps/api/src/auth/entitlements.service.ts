import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isModuleId, schema, type ModuleId } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { APP_CONFIG, type AppConfig } from '../config';

/**
 * Resolves a tenant's active modules from the database (not from the token),
 * so a downgrade or suspension takes effect within ENTITLEMENT_CACHE_SECONDS
 * rather than when the token expires.
 *
 * TODO(phase-1): move the cache to ElastiCache so all API tasks share invalidation.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache = new Map<string, { modules: ModuleId[]; expires: number }>();

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async activeModules(tenantId: string): Promise<ModuleId[]> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.modules;

    const rows = await this.db.forTenant(tenantId, (tx) =>
      tx
        .select({ activeModules: schema.tenants.activeModules })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId)),
    );
    const modules = (rows[0]?.activeModules ?? []).filter(isModuleId);
    this.cache.set(tenantId, {
      modules,
      expires: Date.now() + this.config.ENTITLEMENT_CACHE_SECONDS * 1000,
    });
    return modules;
  }
}
