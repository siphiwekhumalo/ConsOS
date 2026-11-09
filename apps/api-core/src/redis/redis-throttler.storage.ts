import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

// Fixed-window counter, atomic in Redis. Returns [hits, pttl_ms].
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

/** Rate-limit storage shared by every API task, so limits hold across the Fargate fleet. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string) {
    const [hits, pttl] = (await this.redis.eval(
      INCREMENT,
      1,
      `throttle:${throttlerName}:${key}`,
      String(ttl),
    )) as [number, number];
    const seconds = Math.max(0, Math.ceil(pttl / 1000));
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    };
  }
}
