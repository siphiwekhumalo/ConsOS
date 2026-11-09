import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, withTenant, type Db, type DbHandle, type Tx } from '@constructos/db';
import { APP_CONFIG, type AppConfig } from '../config';

export const DB_HANDLE = Symbol('DB_HANDLE');

/**
 * Database access for request handlers.
 * `forTenant` is the only way handlers should reach tenant data; `raw` exists
 * for the pre-auth login lookup and health checks.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  get raw(): Db {
    return this.handle.db;
  }

  forTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, tenantId, fn);
  }

  async onApplicationShutdown() {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL_APP),
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
