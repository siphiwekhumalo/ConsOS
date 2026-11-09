import type { UserRole } from '@constructos/db';

/** Claims carried in the access token. Entitlements are deliberately NOT here — see EntitlementsService. */
export interface AccessTokenClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: UserRole;
}

/** Authenticated principal attached to the request by JwtAuthGuard. */
export interface Principal {
  userId: string;
  tenantId: string;
  role: UserRole;
}
