import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isModuleId, schema, type ModuleId } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { APP_CONFIG, type AppConfig } from '../config';
import { REDIS, type MaybeRedis } from '../redis/redis.module';

/**
 * Resolves a tenant's active modules from the database (not from the token),
 * so a downgrade or suspension takes effect within ENTITLEMENT_CACHE_SECONDS
 * rather than when the token expires. Cached in Redis (shared by all API
 * tasks) or in memory when Redis is not configured.
 */
@Injectable()
export class EntitlementsService {
  private readonly memory = new Map<string, { modules: ModuleId[]; expires: number }>();

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: MaybeRedis,
  ) {}

  private key(tenantId: string) {
    return `entitlements:${tenantId}`;
  }

  async activeModules(tenantId: string): Promise<ModuleId[]> {
    const cached = await this.readCache(tenantId);
    if (cached) return cached;

    const rows = await this.db.forTenant(tenantId, (tx) =>
      tx
        .select({ activeModules: schema.tenants.activeModules })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId)),
    );
    const modules = (rows[0]?.activeModules ?? []).filter(isModuleId);
    await this.writeCache(tenantId, modules);
    return modules;
  }

  /** Call after changing a tenant's subscription. */
  async invalidate(tenantId: string) {
    this.memory.delete(tenantId);
    await this.redis?.del(this.key(tenantId)).catch(() => undefined);
  }

  private async readCache(tenantId: string): Promise<ModuleId[] | null> {
    if (this.redis) {
      // A Redis outage must not take the API down: fall through to the DB.
      const raw = await this.redis.get(this.key(tenantId)).catch(() => null);
      return raw ? (JSON.parse(raw) as string[]).filter(isModuleId) : null;
    }
    const hit = this.memory.get(tenantId);
    return hit && hit.expires > Date.now() ? hit.modules : null;
  }

  private async writeCache(tenantId: string, modules: ModuleId[]) {
    const ttl = this.config.ENTITLEMENT_CACHE_SECONDS;
    if (ttl === 0) return;
    if (this.redis) {
      await this.redis.set(this.key(tenantId), JSON.stringify(modules), 'EX', ttl).catch(() => undefined);
      return;
    }
    this.memory.set(tenantId, { modules, expires: Date.now() + ttl * 1000 });
  }
}
