import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { VoyageService } from '../service';
import { CheckService } from '../check-service';
import { PlanService } from '../plan-service';
import { DischargeService } from '../discharge-service';
import { BerthBookingService } from '../berth-service';
import { RestowPlanService } from '../restow-service';
import { HttpError } from '../errors';
import {
  adjustBerthBookingSchema,
  applyMovesSchema,
  checkReportSchema,
  createBerthBookingSchema,
  createDischargeReviewSchema,
  createPlanSchema,
  createRestowPlanSchema,
  createVoyageSchema,
  issueManifestSchema,
  migratePlanSchema,
  openCheckJobSchema,
  updateConstraintsSchema,
} from './schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiRouter(
  service: VoyageService,
  checkService: CheckService,
  planService: PlanService,
  dischargeService: DischargeService,
  berthBookingService: BerthBookingService,
  restowPlanService: RestowPlanService,
): Router {
  const router = Router();

  function parseVoyageId(req: Request): string {
    const id = req.params['id'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_voyage_id', `航次 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.infer<Schema> {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw HttpError.badRequest(
        'invalid_request_body',
        '请求体校验失败',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    return result.data;
  }

  // 创建航次（登记三维舱位、列承重、箱、不相容类别对）
  router.post('/voyages', (req, res, next) => {
    (async () => {
      const input = parseBody(createVoyageSchema, req.body);
      const voyage = await service.createVoyage(input);
      res.status(201).json(voyage);
    })().catch(next);
  });

  router.get('/voyages', (_req, res, next) => {
    service.listVoyages().then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id', (req, res, next) => {
    const id = parseVoyageId(req);
    service.getVoyage(id).then((v) => res.json(v)).catch(next);
  });

  // 布局：当前修订号或指定历史修订号 ?rev=N
  router.get('/voyages/:id/layout', (req, res, next) => {
    const id = parseVoyageId(req);
    const revRaw = req.query.rev;
    let rev: number | undefined;
    if (revRaw !== undefined) {
      if (typeof revRaw !== 'string' || !/^\d+$/.test(revRaw)) {
        throw HttpError.badRequest('invalid_revision', 'rev 必须为非负整数');
      }
      rev = Number(revRaw);
    }
    service.getLayout(id, rev).then((v) => res.json(v)).catch(next);
  });

  // 整批调整（携带所见修订号，允许同批交换）
  router.post('/voyages/:id/moves', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(applyMovesSchema, req.body);
    service
      .applyMoves(id, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 安全约束变更（携带所见修订号，整套替换；受理前按新约束复验当前布局）
  router.post('/voyages/:id/constraints', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(updateConstraintsSchema, req.body);
    service
      .updateConstraints(id, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 签发装载清单（冻结当前布局，旧清单保留）
  router.post('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(issueManifestSchema, req.body);
    service
      .issueManifest(id, input.expectedRevision)
      .then((r) => res.status(r.reused ? 200 : 201).json(r.manifest))
      .catch(next);
  });

  router.get('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    service.listManifests(id).then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id/manifests/:rev', (req, res, next) => {
    const id = parseVoyageId(req);
    const raw = req.params['rev'] ?? '';
    if (!/^\d+$/.test(raw)) {
      throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
    }
    service.getManifest(id, Number(raw)).then((v) => res.json(v)).catch(next);
  });

  // ---- 港序卸货审查（按冻结清单箱位逐港模拟，不倒箱判定）----

  // 航次下的卸货审查列表（?manifestRevision=N 可只看某清单）
  router.get('/voyages/:id/discharge-reviews', (req, res, next) => {
    const id = parseVoyageId(req);
    const revRaw = req.query.manifestRevision;
    let rev: number | undefined;
    if (revRaw !== undefined) {
      if (typeof revRaw !== 'string' || !/^\d+$/.test(revRaw)) {
        throw HttpError.badRequest('invalid_revision', 'manifestRevision 必须为非负整数');
      }
      rev = Number(revRaw);
    }
    dischargeService.listReviews(id, rev).then((v) => res.json(v)).catch(next);
  });

  // 对某修订号的已签发冻结清单提交卸货审查（同内容幂等返回首次结果）
  router.post('/voyages/:id/manifests/:rev/discharge-reviews', (req, res, next) => {
    const id = parseVoyageId(req);
    const raw = req.params['rev'] ?? '';
    if (!/^\d+$/.test(raw)) {
      throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
    }
    const input = parseBody(createDischargeReviewSchema, req.body);
    dischargeService
      .createReview(id, Number(raw), input)
      .then((r) => res.status(r.replay ? 200 : 201).json({ replay: r.replay, ...r.review }))
      .catch(next);
  });

  // 取某次卸货审查的冻结结果
  router.get('/discharge-reviews/:reviewId', (req, res, next) => {
    const reviewId = parseReviewId(req);
    dischargeService.getReview(reviewId).then((v) => res.json(v)).catch(next);
  });

  // ---- 逐港倒箱作业方案（依据已留档卸货审查）----

  // 提交逐港倒箱作业方案（同审查同内容重试 200 replay；非法操作/安全违反/港末受阻 422 不留档）
  router.post('/discharge-reviews/:reviewId/restow-plans', (req, res, next) => {
    const reviewId = parseReviewId(req);
    const input = parseBody(createRestowPlanSchema, req.body);
    restowPlanService
      .createPlan(reviewId, input)
      .then((r) => res.status(r.replay ? 200 : 201).json({ replay: r.replay, ...r.plan }))
      .catch(next);
  });

  // 按审查列出倒箱方案（不同内容分别留档）
  router.get('/discharge-reviews/:reviewId/restow-plans', (req, res, next) => {
    const reviewId = parseReviewId(req);
    restowPlanService.listByReview(reviewId).then((v) => res.json(v)).catch(next);
  });

  // 取单条倒箱方案冻结结果
  router.get('/restow-plans/:planId', (req, res, next) => {
    const planId = parseRestowPlanId(req);
    restowPlanService.getPlan(planId).then((v) => res.json(v)).catch(next);
  });

  // ---- 靠泊窗口预订（依据已留档卸货审查）----

  // 依据某审查预订靠泊窗口（同号同内容重试 200 replay，冲突 409）
  router.post('/discharge-reviews/:reviewId/berth-bookings', (req, res, next) => {
    const reviewId = parseReviewId(req);
    const input = parseBody(createBerthBookingSchema, req.body);
    berthBookingService
      .createBooking({ ...input, reviewId })
      .then((r) => res.status(r.replay ? 200 : 201).json({ replay: r.replay, ...r.booking }))
      .catch(next);
  });

  // 按审查查询预订与状态
  router.get('/discharge-reviews/:reviewId/berth-bookings', (req, res, next) => {
    const reviewId = parseReviewId(req);
    berthBookingService.listByReview(reviewId).then((v) => res.json(v)).catch(next);
  });

  // 按航次查询预订与状态
  router.get('/voyages/:id/berth-bookings', (req, res, next) => {
    const id = parseVoyageId(req);
    berthBookingService.listByVoyage(id).then((v) => res.json(v)).catch(next);
  });

  // 取单条预订
  router.get('/berth-bookings/:bookingId', (req, res, next) => {
    const bookingId = parseBookingId(req);
    berthBookingService.getBooking(bookingId).then((v) => res.json(v)).catch(next);
  });

  // 取消预订：记录保留、释放占用；重复取消幂等返回已取消状态
  router.post('/berth-bookings/:bookingId/cancel', (req, res, next) => {
    const bookingId = parseBookingId(req);
    berthBookingService
      .cancelBooking(bookingId)
      .then((v) => res.status(v.replay ? 200 : 200).json(v))
      .catch(next);
  });

  // 调整（改期）已生效的预订：原子释放旧窗口并占用新窗口，旧记录保留为已取消并关联新记录；
  // 同调整号同内容重试 200 replay 返回新记录当前状态，同号改内容 409
  router.post('/berth-bookings/:bookingId/adjust', (req, res, next) => {
    const bookingId = parseBookingId(req);
    const input = parseBody(adjustBerthBookingSchema, req.body);
    berthBookingService
      .adjustBooking(bookingId, input)
      .then((v) =>
        res.status(v.replay ? 200 : 201).json({
          adjusted: true,
          replay: v.replay,
          booking: v.booking,
          previousBooking: v.previousBooking,
        }),
      )
      .catch(next);
  });

  // ---- 现场装船核对 ----

  // 航次下的核对作业列表
  router.get('/voyages/:id/check-jobs', (req, res, next) => {
    const id = parseVoyageId(req);
    checkService.listJobs(id).then((v) => res.json(v)).catch(next);
  });

  // 以某修订号的已签发清单为基准开启核对作业（同一清单最多一个）
  router.post('/voyages/:id/check-jobs', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(openCheckJobSchema, req.body);
    checkService
      .openJob(id, input)
      .then((v) => res.status(201).json(v))
      .catch(next);
  });

  // 查询核对状态：应装/已核对/缺失/错位/清单外箱
  router.get('/check-jobs/:jobId', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService.getStatus(jobId).then((v) => res.json(v)).catch(next);
  });

  // 上报留痕
  router.get('/check-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService.listReports(jobId).then((v) => res.json(v)).catch(next);
  });

  // 现场上报：箱号 + 实装位置/撤销 + 唯一上报号
  router.post('/check-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    const input = parseBody(checkReportSchema, req.body);
    checkService
      .submitReport(jobId, input)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  // 结案：全部一致且无清单外箱才冻结，否则返回差异且作业继续开放
  router.post('/check-jobs/:jobId/close', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService
      .closeJob(jobId)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  // ---- 试排方案 ----

  // 从航次当前修订号建立试排方案（以当前布局为初值、固定当前约束快照）
  router.post('/voyages/:id/plans', (req, res, next) => {
    (async () => {
      const id = parseVoyageId(req);
      const input = parseBody(createPlanSchema, req.body);
      const plan = await planService.createPlan(id, input);
      res.status(201).json(plan);
    })().catch(next);
  });

  // 航次下的试排方案列表
  router.get('/voyages/:id/plans', (req, res, next) => {
    const id = parseVoyageId(req);
    planService.listPlans(id).then((v) => res.json(v)).catch(next);
  });

  // 查询方案：当前试排布局、固定约束与版本（来源修订号/方案修订号/状态）
  router.get('/plans/:planId', (req, res, next) => {
    const planId = parsePlanId(req);
    planService.getPlan(planId).then((v) => res.json(v)).catch(next);
  });

  // 方案内整批调整（携带所见方案修订号；与正式航次同一套校验规则；失败不改变方案）
  router.post('/plans/:planId/moves', (req, res, next) => {
    const planId = parsePlanId(req);
    const input = parseBody(applyMovesSchema, req.body);
    planService
      .applyMoves(planId, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 发布方案：航次当前修订号仍等于方案来源修订号时，原子写入航次新修订号并继承方案约束；
  // 否则 409 冲突且保留方案；已发布方案重复发布幂等返回首次结果
  router.post('/plans/:planId/publish', (req, res, next) => {
    const planId = parsePlanId(req);
    planService
      .publish(planId)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  // 方案迁移：航次修订号前进导致无法发布时，以来源修订号正式布局为共同基线逐箱三方合并到当前航次；
  // 携带所见方案修订号与航次修订号；冲突/复验失败/过期/已发布均不改变方案
  router.post('/plans/:planId/migrate', (req, res, next) => {
    const planId = parsePlanId(req);
    const input = parseBody(migratePlanSchema, req.body);
    planService
      .migrate(planId, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  function parsePlanId(req: Request): string {
    const id = req.params['planId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_plan_id', `试排方案 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseJobId(req: Request): string {
    const id = req.params['jobId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_check_job_id', `核对作业 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseReviewId(req: Request): string {
    const id = req.params['reviewId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_discharge_review_id', `卸货审查 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseBookingId(req: Request): string {
    const id = req.params['bookingId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_berth_booking_id', `靠泊预订 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseRestowPlanId(req: Request): string {
    const id = req.params['planId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_restow_plan_id', `倒箱作业方案 ID 格式非法: ${id}`);
    }
    return id;
  }

  return router;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal_error', message } });
}
