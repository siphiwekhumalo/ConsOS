import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { findLogin } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AccessTokenClaims } from './auth.types';

@Injectable()
export class AuthService {
  // Verified against when the user doesn't exist, so response time doesn't
  // reveal which tenant/email combinations are valid.
  private readonly dummyHash: Promise<string> = hash('constructos-timing-equaliser');

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(tenantSlug: string, email: string, password: string) {
    const record = await findLogin(this.db.raw, tenantSlug, email);
    const ok = await verify(record?.passwordHash ?? (await this.dummyHash), password).catch(
      () => false,
    );
    if (!record || !ok) {
      throw new UnauthorizedException('Invalid tenant, email or password');
    }
    return this.issue(record.userId, record.tenantId, record.role);
  }

  async issue(userId: string, tenantId: string, role: AccessTokenClaims['role']) {
    const claims: AccessTokenClaims = { sub: userId, tid: tenantId, role };
    return {
      accessToken: await this.jwt.signAsync(claims),
      expiresIn: this.config.JWT_TTL_SECONDS,
    };
  }

  async hashPassword(password: string) {
    return hash(password);
  }
}
