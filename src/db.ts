import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from './config';

export function createPool(config: Config): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/** 轮询等待 Postgres 可连接（Compose 下应用可能早于数据库就绪） */
export async function waitForDatabase(pool: Pool, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    `等待数据库就绪超时（${timeoutSec}s）: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 读取 schema.sql（生产镜像 /app/src，开发环境本地 src） */
function readSchema(config: Config): string {
  const candidates = [
    config.schemaPath,
    join(__dirname, 'schema.sql'),
    join(process.cwd(), 'src', 'schema.sql'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`找不到 schema.sql，尝试过: ${candidates.join(', ')}`);
}

/** 幂等初始化表结构 */
export async function initSchema(pool: Pool, config: Config): Promise<void> {
  const sql = readSchema(config);
  await pool.query(sql);
}

export async function ping(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
