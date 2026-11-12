import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { findLogin, schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AccessTokenClaims, Principal } from './auth.types';

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

  async issue(userId: string, tenantId: string, role: AccessTokenClaims['role'], sessionStart = Math.floor(Date.now() / 1000)) {
    const claims: AccessTokenClaims = { sub: userId, tid: tenantId, role, sat: sessionStart };
    return {
      accessToken: await this.jwt.signAsync(claims),
      expiresIn: this.config.JWT_TTL_SECONDS,
    };
  }

  /**
   * Swap a still-valid access token for a fresh one while the user is working.
   * The user is re-read, so a deactivation or role change takes effect at the
   * next refresh; and no session outlives SESSION_MAX_HOURS from sign-in.
   */
  async refresh(p: Principal) {
    const start = p.sessionStart ?? 0;
    if (Math.floor(Date.now() / 1000) - start >= this.config.SESSION_MAX_HOURS * 3600) {
      throw new UnauthorizedException('Your session has reached its time limit. Sign in again.');
    }
    const [user] = await this.db.forTenant(p.tenantId, (tx) =>
      tx.select({ role: schema.users.role, isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, p.userId)),
    );
    if (!user?.isActive) throw new UnauthorizedException('Your account is no longer active');
    return this.issue(p.userId, p.tenantId, user.role, start);
  }

  async hashPassword(password: string) {
    return hash(password);
  }
}
