import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config';

// Local dev convenience: load the repo-root .env if present. In AWS, env comes from the ECS task definition.
const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: false });
  app.use(helmet());
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: false });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
  console.log(`ConstructOS API listening on http://localhost:${config.API_PORT}/api/v1`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
