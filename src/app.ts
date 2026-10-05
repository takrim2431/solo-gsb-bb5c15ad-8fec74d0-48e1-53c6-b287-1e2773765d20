import express from 'express';
import { Pool } from 'pg';
import { createApiRouter, errorHandler } from './http/routes';
import { VoyageService } from './service';
import { CheckService } from './check-service';
import { PlanService } from './plan-service';
import { DischargeService } from './discharge-service';
import { BerthBookingService } from './berth-service';
import { ping } from './db';

export function createApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (_req, res) => {
    const dbOk = await ping(pool);
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'up' : 'down',
    });
  });

  const service = new VoyageService(pool);
  const checkService = new CheckService(pool);
  const planService = new PlanService(pool);
  const dischargeService = new DischargeService(pool);
  const berthBookingService = new BerthBookingService(pool);
  app.use(
    '/api',
    createApiRouter(service, checkService, planService, dischargeService, berthBookingService),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'route_not_found', message: '接口不存在' } });
  });
  app.use(errorHandler);

  return app;
}
