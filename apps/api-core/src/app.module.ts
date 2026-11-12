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
import { EstimatesController } from './commercial/estimates.controller';
import { UsersController } from './users/users.controller';
import { ControlsController } from './controls/controls.controller';
import { LedgerService } from './ledger/ledger.service';
import { LedgerController } from './ledger/ledger.controller';
import { PayablesController } from './ledger/payables.controller';
import { ReceivablesController } from './ledger/receivables.controller';
import { PaymentsController } from './ledger/payments.controller';
import { BankingController } from './ledger/banking.controller';
import { PurchaseOrdersService } from './procurement/orders.service';
import { OrdersController } from './procurement/orders.controller';
import { RfqsController } from './procurement/rfqs.controller';
import { SubcontractsController } from './procurement/subcontracts.controller';
import { PlantController } from './operations/plant.controller';
import { HseController } from './operations/hse.controller';
import { PayrollController } from './payroll/payroll.controller';

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
        EstimatesController,
        UsersController,
        ControlsController,
        LedgerController,
        PayablesController,
        ReceivablesController,
        PaymentsController,
        BankingController,
        OrdersController,
        RfqsController,
        SubcontractsController,
        PlantController,
        HseController,
        PayrollController,
      ],
      providers: [StorageService, LedgerService, PurchaseOrdersService],
    };
  }
}
