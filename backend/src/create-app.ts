import { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { AppModule } from './app';
export async function createApplication(options: NestApplicationOptions = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, options);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '256kb' });
  app.use(
    helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:'] } } }),
  );
  app.useStaticAssets(resolve(__dirname, '../../../frontend/dist'));
  return app;
}
