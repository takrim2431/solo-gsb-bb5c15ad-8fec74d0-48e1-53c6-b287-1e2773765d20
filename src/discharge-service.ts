import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { Placement, Position } from './domain';
import {
  DischargeItem,
  DischargeSimulation,
  simulateDischarge,
  validateDischargeReviewInput,
} from './discharge';

/* ---------- DTO ---------- */

export interface CreateDischargeReviewInput {
  /** 有序且不重复的卸港列表 */
  ports: string[];
  /** 清单内每个箱的卸港（箱号必须与冻结清单完全一致） */
  items: DischargeItem[];
}

interface ReviewRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  request_hash: string;
  request_jsonb: { ports: string[]; items: DischargeItem[] };
  result_jsonb: DischargeSimulation;
  created_at: Date;
}

/* ---------- 提交内容指纹（同内容天然幂等） ---------- */

/**
 * 规范化哈希：箱号原样参与（trim 已在请求体层完成），ports 按提交顺序、
 * items 按箱号排序后做 sha256，使“同一提交内容”不因 JSON 字段顺序/条目顺序而异。
 */
function hashDischargeRequest(input: CreateDischargeReviewInput): string {
  const canonical = JSON.stringify({
    ports: input.ports,
    items: [...input.items].sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- 读取辅助 ---------- */

async function loadVoyageExists(client: PoolClient, voyageId: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
  return res.rows.length > 0;
}

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

function reviewToJson(row: ReviewRow) {
  return {
    reviewId: row.id,
    voyageId: row.voyage_id,
    manifestRevision: row.manifest_rev,
    requestHash: row.request_hash,
    createdAt: row.created_at.toISOString(),
    ports: row.result_jsonb.ports,
    items: row.request_jsonb.items,
    simulation: row.result_jsonb,
  };
}

/* ---------- 服务 ---------- */

export class DischargeService {
  constructor(private readonly pool: Pool) {}

  /**
   * 对某修订号的【已签发冻结清单】提交港序卸货审查：
   *  - 清单必须存在（航次/清单未知 -> 404）；
   *  - 港序必须非空、不重复；申报箱号必须与清单完全一致；每箱卸港必须在港序列表中，
   *    任一不满足 -> 400 invalid_discharge_request（issues 一次性列出）；
   *  - 按清单冻结箱位逐港模拟，结果与提交内容一并永久留档；
   *  - 同一清单同一提交内容（规范化哈希）天然幂等：200 replay:true 返回首次结果；
   *  - 航次后续调整或签发新清单不改变旧审查结果（结果在创建时已冻结入库）。
   */
  async createReview(
    voyageId: string,
    manifestRevision: number,
    input: CreateDischargeReviewInput,
  ): Promise<{ replay: boolean; review: ReturnType<typeof reviewToJson> }> {
    const requestHash = hashDischargeRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 锁航次行串行化同航次审查创建（与清单冻结读取保持一致视图）
      const voyage = await client.query(
        `SELECT id, voyage_no FROM voyages WHERE id=$1 FOR UPDATE`,
        [voyageId],
      );
      if (voyage.rows.length === 0) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }

      const manifest = await client.query(
        `SELECT rev, issued_at FROM manifests WHERE voyage_id=$1 AND rev=$2`,
        [voyageId, manifestRevision],
      );
      if (manifest.rows.length === 0) {
        throw HttpError.notFound(
          'manifest_not_found',
          `航次在修订号 ${manifestRevision} 没有已签发的装载清单，卸货审查无法进行`,
        );
      }

      // 幂等：同清单 + 同提交内容已有审查 -> 原样返回首次结果（不重新模拟）
      const existing = await client.query(
        `SELECT id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM discharge_reviews
         WHERE voyage_id=$1 AND manifest_rev=$2 AND request_hash=$3`,
        [voyageId, manifestRevision, requestHash],
      );
      if (existing.rows.length === 1) {
        const row = existing.rows[0] as ReviewRow;
        await client.query('COMMIT');
        return { replay: true, review: reviewToJson(row) };
      }

      // 冻结箱位取自清单独立副本（manifest_items），与后续布局调整完全解耦
      const frozenItems = await loadManifestItems(client, voyageId, manifestRevision);

      // 请求级业务校验：空/重复港序、箱号缺漏/多余、卸港不在列表
      const issues = validateDischargeReviewInput({
        ports: input.ports,
        items: input.items,
        manifestBoxNos: frozenItems.map((p) => p.boxNo),
      });
      if (issues.length > 0) {
        throw HttpError.badRequest('invalid_discharge_request', '卸货审查请求非法，已拒绝', {
          issueCount: issues.length,
          issues,
        });
      }

      // 按清单冻结箱位逐港模拟（纯函数）
      const simulation = simulateDischarge({
        ports: input.ports,
        items: input.items,
        placements: frozenItems,
      });

      const inserted = await client.query(
        `INSERT INTO discharge_reviews
           (voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         RETURNING id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at`,
        [
          voyageId,
          manifestRevision,
          requestHash,
          JSON.stringify({ ports: input.ports, items: input.items }),
          JSON.stringify(simulation),
        ],
      );
      const row = inserted.rows[0] as ReviewRow;

      await client.query('COMMIT');
      return { replay: false, review: reviewToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 取某次审查的冻结结果 */
  async getReview(reviewId: string) {
    const res = await this.pool.query(
      `SELECT id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
       FROM discharge_reviews WHERE id=$1`,
      [reviewId],
    );
    if (res.rows.length === 0) {
      throw HttpError.notFound(
        'discharge_review_not_found',
        `卸货审查 ${reviewId} 不存在`,
      );
    }
    return reviewToJson(res.rows[0] as ReviewRow);
  }

  /**
   * 列出审查（可按清单修订号过滤）。审查结果在创建时即冻结，
   * 航次后续调整或签发新清单不影响列表中任何一条旧审查。
   */
  async listReviews(voyageId: string, manifestRevision?: number) {
    const client = await this.pool.connect();
    try {
      if (!(await loadVoyageExists(client, voyageId))) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }
      const params: (string | number)[] = [voyageId];
      let where = `voyage_id=$1`;
      if (manifestRevision !== undefined) {
        params.push(manifestRevision);
        where += ` AND manifest_rev=$2`;
      }
      const res = await client.query(
        `SELECT id, voyage_id, manifest_rev, request_hash, request_jsonb, result_jsonb, created_at
         FROM discharge_reviews WHERE ${where}
         ORDER BY manifest_rev DESC, created_at DESC`,
        params,
      );
      return { reviews: (res.rows as ReviewRow[]).map((r) => reviewToJson(r)) };
    } finally {
      client.release();
    }
  }
}
