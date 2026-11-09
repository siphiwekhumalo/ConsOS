import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ModuleId, UserRole } from '@constructos/db';
import { IS_PUBLIC, REQUIRED_MODULE, REQUIRED_ROLES } from './decorators';
import { EntitlementsService } from './entitlements.service';
import type { Principal } from './auth.types';

/** Global guard (runs after JwtAuthGuard): enforces @Roles() and @RequiresModule(). */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const principal = ctx.switchToHttp().getRequest<{ principal: Principal }>().principal;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(REQUIRED_ROLES, targets);
    if (roles && !roles.includes(principal.role)) {
      throw new ForbiddenException('Your role does not permit this action');
    }

    const moduleId = this.reflector.getAllAndOverride<ModuleId | undefined>(REQUIRED_MODULE, targets);
    if (moduleId) {
      const active = await this.entitlements.activeModules(principal.tenantId);
      if (!active.includes(moduleId)) {
        throw new ForbiddenException(`Module ${moduleId} is not active for your organisation`);
      }
    }
    return true;
  }
}
