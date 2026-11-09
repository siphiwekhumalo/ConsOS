import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from '../config';
import { REDIS, type MaybeRedis } from '../redis/redis.module';
import { RedisThrottlerStorage } from '../redis/redis-throttler.storage';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { InvitesController } from './invites.controller';
import { AuthService } from './auth.service';
import { EntitlementsService } from './entitlements.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { expiresIn: config.JWT_TTL_SECONDS, algorithm: 'HS256', issuer: 'constructos' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'constructos' },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: MaybeRedis) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        // Shared across API tasks when Redis is configured; in-memory otherwise.
        ...(redis ? { storage: new RedisThrottlerStorage(redis) } : {}),
      }),
    }),
  ],
  controllers: [AuthController, InvitesController],
  providers: [
    AuthService,
    EntitlementsService,
    // Order matters: authenticate first, then authorise.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [EntitlementsService],
})
export class AuthModule {}
