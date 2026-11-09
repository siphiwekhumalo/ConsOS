import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';

export const REDIS = Symbol('REDIS');

/** `null` when REDIS_URL is unset (local dev without Redis). */
export type MaybeRedis = Redis | null;

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: MaybeRedis) {}
  async onApplicationShutdown() {
    await this.redis?.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MaybeRedis => {
        const log = new Logger('Redis');
        if (!config.REDIS_URL) {
          log.warn('REDIS_URL not set: using in-process rate limits and caches (single instance only)');
          return null;
        }
        const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
        redis.on('error', (err) => log.error(err.message));
        return redis;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
