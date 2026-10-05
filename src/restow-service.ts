import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { BoxInfo, Placement, Position, columnKey, microToWeight, ruleKey } from './domain';
import {
  RestowPortPlan,
  RestowRejection,
  RestowSimulation,
  simulateRestow,
  validateRestowPlanInput,
} from './restow';

/* ---------- DTO ---------- */

export interface CreateRestowPlanInput {
  /** 非负临时堆位容量 */
  temporaryCapacity: number;
  /** 每港按序作业（港序须与审查一致） */
  portPlans: RestowPortPlan[];
}

interface ReviewBaselineRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  request_jsonb: {
    ports: string[];
    items: Array<{ boxNo: string; dischargePort: string }>;
  };
}

interface RestowPlanRow {
  id: string;
  review_id: string;
  voyage_id: string;
  manifest_rev: number;
  request_hash: string;
  request_jsonb: { temporaryCapacity: number; portPlans: RestowPortPlan[] };
  result_jsonb: RestowSimulation;
  created_at: Date;
}

/* ---------- 提交内容指纹（同内容天然幂等） ---------- */

/**
 * 规范化哈希：temporaryCapacity 与 portPlans（operations 按提交序，箱号/操作类型原样）
 * 整体序列化做 sha256，使“同一提交内容”不因 JSON 字段顺序而异。
 */
function hashRestowRequest(input: CreateRestowPlanInput): string {
  const canonical = JSON.stringify({
    temporaryCapacity: input.temporaryCapacity,
    portPlans: input.portPlans,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- 读取辅助 ---------- */

async function loadReviewForUpdate(
  client: PoolClient,
  reviewId: string,
): Promise<ReviewBaselineRow | null> {
  const res = await client.query(
    `SELECT id, voyage_id, manifest_rev, request_jsonb
     FROM discharge_reviews WHERE id=$1 FOR UPDATE`,
    [reviewId],
  );
  return (res.rows[0] as ReviewBaselineRow | undefined) ?? null;
}

async function loadManifestItems(
  client: PoolClient,
  voyageId: string,
  rev: number,
): Promise<Placement[]> {
  const res = await client.query(
    `SELECT box_no, bay, row, tier FROM manifest_items WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
    [voyageId, rev],
  );
  return res.rows.map(
    (r): Placement => ({
      boxNo: r.box_no as string,
      position: { bay: r.bay, row: r.row, tier: r.tier } as Position,
    }),
  );
}

async function loadBoxes(client: PoolClient, voyageId: string): Promise<BoxInfo[]> {
  const res = await client.query(
    `SELECT box_no, weight_ug::text AS weight_ug, category FROM boxes WHERE voyage_id=$1 ORDER BY box_no`,
    [voyageId],
  );
  return res.rows.map((r) => ({
    boxNo: r.box_no as string,
    weight: microToWeight(BigInt(r.weight_ug as string)),
    category: r.category as string,
  }));
}

/**
 * 读取清单修订号【当时】生效的安全约束快照（默认列承重 + 按列覆盖 + 不相容规则）。
 * 倒箱方案以该冻结快照为安全基准；后续约束更新不回写。
 */
async function loadConstraintsAt(
  client: PoolClient,
  voyageId: string,
  rev: number,
): Promise<{
  defaultLimit: bigint;
  columnLimits: Map<string, bigint>;
  rules: Map<string, number>;
}> {
  const [defRes, limitRes, ruleRes] = await Promise.all([
    client.query(
      `SELECT weight_limit::text AS weight_limit FROM constraint_defaults WHERE voyage_id=$1 AND rev=$2`,
      [voyageId, rev],
    ),
    client.query(
      `SELECT bay, row, weight_limit::text AS weight_limit
       FROM constraint_column_limits WHERE voyage_id=$1 AND rev=$2 ORDER BY bay,row`,
      [voyageId, rev],
    ),
    client.query(
      `SELECT cat_a, cat_b, min_distance
       FROM constraint_incompat_rules WHERE voyage_id=$1 AND rev=$2 ORDER BY cat_a,cat_b`,
      [voyageId, rev],
    ),
  ]);
  const defRow = defRes.rows[0];
  if (!defRow) {
    throw new Error(`航次 ${voyageId} 缺少修订号 ${rev} 的约束快照（数据不一致）`);
  }
  const columnLimits = new Map<string, bigint>();
  for (const r of limitRes.rows) {
    columnLimits.set(columnKey(r.bay as number, r.row as number), BigInt(r.weight_limit as string));
  }
  const rules = new Map<string, number>();
  for (const r of ruleRes.rows) {
    rules.set(ruleKey(r.cat_a as string, r.cat_b as string), Number(r.min_distance));
  }
  return { defaultLimit: BigInt(defRow.weight_limit as string), columnLimits, rules };
}

async function loadGeometry(
  client: PoolClient,
  voyageId: string,
): Promise<{ bays: number; rows: number; tiers: number }> {
  const res = await client.query(
    `SELECT n_bays, n_rows, n_tiers FROM voyages WHERE id=$1`,
    [voyageId],
  );
  const r = res.rows[0];
  if (!r) throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
  return { bays: r.n_bays, rows: r.n_rows, tiers: r.n_tiers };
}

function planToJson(row: RestowPlanRow) {
  return {
    planId: row.id,
    reviewId: row.review_id,
    voyageId: row.voyage_id,
    manifestRevision: row.manifest_rev,
    requestHash: row.request_hash,
    createdAt: row.created_at.toISOString(),
    temporaryCapacity: row.request_jsonb.temporaryCapacity,
    portPlans: row.request_jsonb.portPlans,
    simulation: row.result_jsonb,
  };
}

/* ---------- 服务 ---------- */

export class RestowPlanService {
  constructor(private readonly pool: Pool) {}

  /**
   * 对已留档卸货审查提交逐港倒箱作业方案。
   *
   *  - 审查必须存在（未知 -> 404 discharge_review_not_found）；
   *  - 以审查对应清单的冻结箱位 + 该清单修订号当时安全约束为基准逐港模拟；
   *  - 结构非法（港序不一致/未知港/未知箱/非法操作）-> 400 invalid_restow_request；
   *  - 非法操作、容量超限、重复暂存、跨港滞留、安全违反、港末受阻
   *    -> 422 restow_plan_rejected（details.reason + 相关箱号 + violations/blocked），不留档；
   *  - 成功结果随提交内容永久冻结留档；同一审查同内容重试 -> 200 replay:true 原结果；
   *    不同内容分别留档；后续改位/约束更新/新清单不回写。
   */
  async createPlan(
    reviewId: string,
    input: CreateRestowPlanInput,
  ): Promise<{ replay: boolean; plan: ReturnType<typeof planToJson> }> {
    const requestHash = hashRestowRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 锁审查行：未知审查即 404；串行化基于同一审查的并发方案提交
      const review = await loadReviewForUpdate(client, reviewId);
      if (!review) {
        throw HttpError.notFound(
          'discharge_review_not_found',
          `卸货审查 ${reviewId} 不存在，无法据此提交倒箱作业方案`,
        );
      }

      // 幂等：同审查 + 同提交内容已有方案 -> 原样返回首次冻结结果
      const existing = await client.query(
        `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM restow_plans WHERE review_id=$1 AND request_hash=$2`,
        [reviewId, requestHash],
      );
      if (existing.rows.length === 1) {
        await client.query('COMMIT');
        return { replay: true, plan: planToJson(existing.rows[0] as RestowPlanRow) };
      }

      const voyageId = review.voyage_id;
      const manifestRev = review.manifest_rev;

      // 冻结基准：清单箱位 + 舱位尺寸（不可变）+ 箱档案（不可变）+ 当时安全约束
      const [placements, boxes, constraints, geometry] = await Promise.all([
        loadManifestItems(client, voyageId, manifestRev),
        loadBoxes(client, voyageId),
        loadConstraintsAt(client, voyageId, manifestRev),
        loadGeometry(client, voyageId),
      ]);

      // 结构级请求校验：港序一致、港/箱/操作类型已知
      const issues = validateRestowPlanInput({
        reviewPorts: review.request_jsonb.ports,
        manifestBoxNos: placements.map((p) => p.boxNo),
        temporaryCapacity: input.temporaryCapacity,
        portPlans: input.portPlans,
      });
      if (issues.length > 0) {
        throw HttpError.badRequest('invalid_restow_request', '逐港倒箱作业方案请求非法，已拒绝', {
          issueCount: issues.length,
          issues,
        });
      }

      // 逐港模拟（RestowRejection -> 422，不留档）
      let simulation: RestowSimulation;
      try {
        simulation = simulateRestow({
          ports: review.request_jsonb.ports,
          items: review.request_jsonb.items,
          placements,
          temporaryCapacity: input.temporaryCapacity,
          portPlans: input.portPlans,
          geometry,
          boxes,
          defaultColumnLimit: constraints.defaultLimit,
          columnLimits: constraints.columnLimits,
          rules: constraints.rules,
        });
      } catch (err) {
        if (err instanceof RestowRejection) {
          throw new HttpError(
            422,
            'restow_plan_rejected',
            err.message,
            { reason: err.reason, ...(err.details ?? {}) },
          );
        }
        throw err;
      }

      const inserted = await client.query(
        `INSERT INTO restow_plans
           (review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at`,
        [
          reviewId,
          voyageId,
          manifestRev,
          requestHash,
          JSON.stringify({
            temporaryCapacity: input.temporaryCapacity,
            portPlans: input.portPlans,
          }),
          JSON.stringify(simulation),
        ],
      );

      await client.query('COMMIT');
      return { replay: false, plan: planToJson(inserted.rows[0] as RestowPlanRow) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 取某次倒箱方案的冻结结果 */
  async getPlan(planId: string) {
    const res = await this.pool.query(
      `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
       FROM restow_plans WHERE id=$1`,
      [planId],
    );
    if (res.rows.length === 0) {
      throw HttpError.notFound('restow_plan_not_found', `倒箱作业方案 ${planId} 不存在`);
    }
    return planToJson(res.rows[0] as RestowPlanRow);
  }

  /** 按审查列出全部倒箱方案（含同审查不同内容的各自留档） */
  async listByReview(reviewId: string) {
    const review = await this.pool.query(
      `SELECT voyage_id FROM discharge_reviews WHERE id=$1`,
      [reviewId],
    );
    if (review.rows.length === 0) {
      throw HttpError.notFound('discharge_review_not_found', `卸货审查 ${reviewId} 不存在`);
    }
    const res = await this.pool.query(
      `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
       FROM restow_plans WHERE review_id=$1 ORDER BY created_at`,
      [reviewId],
    );
    return {
      reviewId,
      voyageId: review.rows[0].voyage_id as string,
      plans: (res.rows as RestowPlanRow[]).map(planToJson),
    };
  }
}
