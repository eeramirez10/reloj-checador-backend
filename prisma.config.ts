import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';
import { databaseForEnvironment } from './src/infrastructure/config/database-environment.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: databaseForEnvironment({ APP_ENV: process.env.APP_ENV, DATABASE_URL: env('DATABASE_URL'), PRODUCTION_DATABASE_URL: process.env.PRODUCTION_DATABASE_URL }) },
});
