import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { BoxInfo, Placement, Position, columnKey, microToWeight, ruleKey } from './domain';
import { DischargeItem } from './discharge';
import {
  RestowPortPlan,
  RestowSimulation,
  simulateRestowPlan,
  validateRestowPlanInput,
} from './restow';

/* ---------- DTO ---------- */

export interface CreateRestowPlanInput {
  /** 非负临时堆位容量（同时在暂存中的箱数上限） */
  capacity: number;
  /** 每港按序的暂存/回放操作（港序须与审查一致） */
  ports: RestowPortPlan[];
}

interface ReviewRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  request_jsonb: { ports: string[]; items: DischargeItem[] };
}

interface RestowPlanRow {
  id: string;
  review_id: string;
  voyage_id: string;
  manifest_rev: number;
  request_hash: string;
  request_jsonb: CreateRestowPlanInput;
  result_jsonb: RestowSimulation;
  created_at: Date;
}

/* ---------- 提交内容指纹（同审查同内容天然幂等） ---------- */

/**
 * 规范化哈希：容量与港序/操作按提交顺序原样参与（操作顺序即作业顺序），
 * 使“同一提交内容”不因 JSON 字段顺序而异。
 */
function hashRestowRequest(input: CreateRestowPlanInput): string {
  const canonical = JSON.stringify({
    capacity: input.capacity,
    ports: input.ports.map((p) => ({
      port: p.port,
      operations: p.operations.map((o) => ({ action: o.action, boxNo: o.boxNo })),
    })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- 读取辅助 ---------- */

async function loadManifestItems(
  client: PoolClient,
  voyageId: string,
  rev: number,
): Promise<Placement[]> {
  const res = await client.query(
    `SELECT box_no, bay, row, tier FROM manifest_items
     WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
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

interface ConstraintSnapshot {
  defaultLimit: bigint;
  columnLimits: Map<string, bigint>;
  rules: Map<string, number>;
}

/** 读取某修订号当时生效的安全约束快照（默认列承重 + 按列覆盖 + 不相容类别对） */
async function loadConstraints(
  client: PoolClient,
  voyageId: string,
  rev: number,
): Promise<ConstraintSnapshot> {
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

function planToJson(row: RestowPlanRow) {
  return {
    planId: row.id,
    reviewId: row.review_id,
    voyageId: row.voyage_id,
    manifestRevision: row.manifest_rev,
    requestHash: row.request_hash,
    createdAt: row.created_at.toISOString(),
    capacity: row.request_jsonb.capacity,
    ports: row.request_jsonb.ports,
    simulation: row.result_jsonb,
  };
}

/* ---------- 服务 ---------- */

export class RestowPlanService {
  constructor(private readonly pool: Pool) {}

  /**
   * 对已留档的卸货审查提交逐港倒箱作业方案：
   *  - 审查必须存在（未知审查 -> 404 discharge_review_not_found）；
   *  - 港序必须与审查完全一致（否则 400 invalid_restow_plan / port_order_mismatch）；
   *  - 以审查对应清单的冻结箱位及该清单修订号当时生效的安全约束为基准逐港模拟：
   *    非法操作 -> 400 invalid_restow_plan；任一步违反列承重/危险品间距 -> 422
   *    restow_safety_violation；某港结束仍有本港箱受阻 -> 422 port_boxes_blocked；
   *    拒绝均不留档；
   *  - 成功即冻结方案（按港的操作后箱位、实际卸箱与倒箱次数），永久留档可查；
   *    航次后续改位、约束更新或签发新清单均不回写已冻结结果；
   *  - 同一审查同一提交内容（规范化哈希）天然幂等：200 replay:true 返回首次结果；
   *    不同内容分别留档。
   */
  async createPlan(
    reviewId: string,
    input: CreateRestowPlanInput,
  ): Promise<{ replay: boolean; plan: ReturnType<typeof planToJson> }> {
    const requestHash = hashRestowRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 锁审查行：未知审查即 404；同时串行化基于同一审查的并发提交
      const reviewRes = await client.query(
        `SELECT id, voyage_id, manifest_rev, request_jsonb
         FROM discharge_reviews WHERE id=$1 FOR UPDATE`,
        [reviewId],
      );
      const review = reviewRes.rows[0] as ReviewRow | undefined;
      if (!review) {
        throw HttpError.notFound(
          'discharge_review_not_found',
          `卸货审查 ${reviewId} 不存在，无法据此提交倒箱作业方案`,
        );
      }

      // 幂等：同审查 + 同提交内容已有方案 -> 原样返回首次结果（不重新模拟）
      const existing = await client.query(
        `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM restow_plans WHERE review_id=$1 AND request_hash=$2`,
        [reviewId, requestHash],
      );
      if (existing.rows.length === 1) {
        const row = existing.rows[0] as RestowPlanRow;
        await client.query('COMMIT');
        return { replay: true, plan: planToJson(row) };
      }

      // 请求级校验：港序须与审查一致
      const reviewPorts = review.request_jsonb.ports;
      const issues = validateRestowPlanInput({ reviewPorts, plan: input.ports });
      if (issues.length > 0) {
        throw HttpError.badRequest('invalid_restow_plan', '倒箱作业方案的港序必须与审查一致，已拒绝', {
          issueCount: issues.length,
          issues,
        });
      }

      // 模拟基准：清单冻结箱位 + 该清单修订号当时生效的安全约束（与后续航次演进解耦）
      const [placements, boxes, constraints, voyageRes] = await Promise.all([
        loadManifestItems(client, review.voyage_id, review.manifest_rev),
        loadBoxes(client, review.voyage_id),
        loadConstraints(client, review.voyage_id, review.manifest_rev),
        client.query(`SELECT n_bays, n_rows, n_tiers FROM voyages WHERE id=$1`, [review.voyage_id]),
      ]);
      const voyageRow = voyageRes.rows[0] as { n_bays: number; n_rows: number; n_tiers: number };

      const outcome = simulateRestowPlan({
        ports: reviewPorts,
        items: review.request_jsonb.items,
        placements,
        capacity: input.capacity,
        plan: input.ports,
        geometry: { bays: voyageRow.n_bays, rows: voyageRow.n_rows, tiers: voyageRow.n_tiers },
        boxes,
        columnLimits: constraints.columnLimits,
        defaultColumnLimit: constraints.defaultLimit,
        rules: constraints.rules,
      });

      if (!outcome.ok) {
        const failure = outcome.failure;
        if (failure.kind === 'illegal_operation') {
          throw HttpError.badRequest('invalid_restow_plan', '倒箱作业方案包含非法操作，已拒绝', {
            issueCount: 1,
            issues: [failure.issue],
          });
        }
        if (failure.kind === 'safety_violation') {
          throw new HttpError(
            422,
            'restow_safety_violation',
            `倒箱作业方案在港 ${failure.port}（第 ${failure.portIndex} 港）` +
              (failure.opIndex === null
                ? '开始卸货后'
                : `第 ${failure.opIndex} 步操作（${failure.action} ${failure.boxNo}）后`) +
              `违反船上安全约束，共 ${failure.violations.length} 项，整份方案已拒绝`,
            {
              port: failure.port,
              portIndex: failure.portIndex,
              opIndex: failure.opIndex,
              action: failure.action,
              boxNo: failure.boxNo,
              violationCount: failure.violations.length,
              violations: failure.violations,
            },
          );
        }
        throw new HttpError(
          422,
          'port_boxes_blocked',
          `港 ${failure.port}（第 ${failure.portIndex} 港）结束时仍有 ${failure.blocked.length} 个本港箱受阻留船，整份方案已拒绝`,
          {
            port: failure.port,
            portIndex: failure.portIndex,
            blocked: failure.blocked,
          },
        );
      }

      const inserted = await client.query(
        `INSERT INTO restow_plans
           (review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at`,
        [
          reviewId,
          review.voyage_id,
          review.manifest_rev,
          requestHash,
          JSON.stringify({ capacity: input.capacity, ports: input.ports }),
          JSON.stringify(outcome.simulation),
        ],
      );
      const row = inserted.rows[0] as RestowPlanRow;

      await client.query('COMMIT');
      return { replay: false, plan: planToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 取某份倒箱作业方案的冻结结果 */
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

  /** 按审查列出倒箱作业方案（含冻结结果；拒绝的方案不留档故不在列表中） */
  async listByReview(reviewId: string) {
    const client = await this.pool.connect();
    try {
      const review = await client.query(
        `SELECT voyage_id FROM discharge_reviews WHERE id=$1`,
        [reviewId],
      );
      if (review.rows.length === 0) {
        throw HttpError.notFound('discharge_review_not_found', `卸货审查 ${reviewId} 不存在`);
      }
      const res = await client.query(
        `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM restow_plans WHERE review_id=$1 ORDER BY created_at DESC`,
        [reviewId],
      );
      return {
        reviewId,
        voyageId: review.rows[0].voyage_id as string,
        plans: (res.rows as RestowPlanRow[]).map((r) => planToJson(r)),
      };
    } finally {
      client.release();
    }
  }

  /** 按航次列出其各审查下的倒箱作业方案 */
  async listByVoyage(voyageId: string) {
    const client = await this.pool.connect();
    try {
      const voyage = await client.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
      if (voyage.rows.length === 0) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }
      const res = await client.query(
        `SELECT id, review_id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM restow_plans WHERE voyage_id=$1 ORDER BY created_at DESC`,
        [voyageId],
      );
      return { voyageId, plans: (res.rows as RestowPlanRow[]).map((r) => planToJson(r)) };
    } finally {
      client.release();
    }
  }
}
