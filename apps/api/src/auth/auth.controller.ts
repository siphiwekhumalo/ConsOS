import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators';

const LoginBody = z.object({
  tenant: z.string().trim().toLowerCase().min(2).max(63),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
type LoginBody = z.infer<typeof LoginBody>;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body(new ZodBodyPipe(LoginBody)) body: LoginBody) {
    return this.auth.login(body.tenant, body.email, body.password);
  }
}
