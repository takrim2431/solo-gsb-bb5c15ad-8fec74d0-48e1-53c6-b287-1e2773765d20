import { createPool, waitForDatabase, initSchema } from './db';
import { loadConfig } from './config';
import { createApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  await waitForDatabase(pool, config.dbStartupTimeoutSec);
  await initSchema(pool, config);

  const app = createApp(pool);
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[dangerous-cargo-stowage] 服务已启动: http://0.0.0.0:${config.port} (env=${config.nodeEnv})`,
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[${signal}] 正在关闭服务...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败:', err);
  process.exit(1);
});
