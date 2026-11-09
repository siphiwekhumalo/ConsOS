import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ModuleId, UserRole } from '@constructos/db';
import type { Principal } from './auth.types';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_MODULE = 'auth:requiredModule';
export const REQUIRED_ROLES = 'auth:requiredRoles';

/** Skip authentication (login, health). Everything else is authenticated by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Require the caller's tenant to have this module active (checked server-side on each request). */
export const RequiresModule = (moduleId: ModuleId) => SetMetadata(REQUIRED_MODULE, moduleId);

/** Require one of these roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
  if (!req.principal) throw new Error('CurrentUser used on an unauthenticated route');
  return req.principal;
});
