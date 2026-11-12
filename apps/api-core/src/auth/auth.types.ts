import type { UserRole } from '@constructos/db';

/** Claims carried in the access token. Entitlements are deliberately NOT here — see EntitlementsService. */
export interface AccessTokenClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: UserRole;
  /** When the user signed in (epoch seconds). Carried unchanged through refreshes, to cap the session length. */
  sat?: number;
  iat?: number;
}

/** Authenticated principal attached to the request by JwtAuthGuard. */
export interface Principal {
  userId: string;
  tenantId: string;
  role: UserRole;
  /** Sign-in time (epoch seconds). */
  sessionStart?: number;
}
