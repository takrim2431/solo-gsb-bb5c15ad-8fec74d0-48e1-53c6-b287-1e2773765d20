export interface Config {
  port: number;
  databaseUrl: string;
  schemaPath: string;
  /** 等待 Postgres 就绪的最长秒数 */
  dbStartupTimeoutSec: number;
  nodeEnv: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少必需的环境变量 ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(env('PORT', '3000')),
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgres://stowage:stowage@localhost:5432/stowage',
    schemaPath: env('SCHEMA_PATH', '/app/src/schema.sql'),
    dbStartupTimeoutSec: Number(env('DB_STARTUP_TIMEOUT_SEC', '60')),
    nodeEnv: env('NODE_ENV', 'development'),
  };
}
