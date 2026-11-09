import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.module';
import { Public } from '../auth/decorators';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** ALB target-group health check. */
  @Public()
  @Get()
  async check() {
    try {
      await this.db.raw.execute(sql`select 1`);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'db_unavailable' });
    }
  }
}
