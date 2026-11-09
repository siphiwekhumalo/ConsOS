import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { ProjectsController } from './projects/projects.controller';
import { AuditController } from './audit/audit.controller';
import { FilesController } from './files/files.controller';
import { StorageService } from './files/storage.service';
import { DiaryController } from './diary/diary.controller';
import { FormulasController } from './formulas/formulas.controller';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, RedisModule, AuthModule],
      controllers: [
        HealthController,
        MeController,
        ProjectsController,
        AuditController,
        FilesController,
        DiaryController,
        FormulasController,
      ],
      providers: [StorageService],
    };
  }
}
