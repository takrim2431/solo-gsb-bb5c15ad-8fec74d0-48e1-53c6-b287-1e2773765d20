import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import { Geometry, Position } from './domain';
import {
  CheckEvaluation,
  CheckReportContent,
  ExpectedItem,
  latestStates,
  reportInBounds,
  sameReportContent,
  evaluateCheck,
} from './check';

/* ---------- DTO ---------- */

export interface OpenCheckJobInput {
  manifestRevision: number;
}

export interface CheckReportInput {
  reportNo: string;
  boxNo: string;
  /** null = 撤销（未装）；非 null = 实装位置 */
  position: Position | null;
}

interface CheckJobRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  next_seq: string;
}

interface CheckReportRow {
  report_no: string;
  seq: string;
  box_no: string;
  revoked: boolean;
  bay: number | null;
  row: number | null;
  tier: number | null;
  accepted_at: Date;
}

/* ---------- 序列化 ---------- */

function jobToJson(job: CheckJobRow, geometry: Geometry) {
  return {
    jobId: job.id,
    voyageId: job.voyage_id,
    manifestRevision: job.manifest_rev,
    status: job.status,
    open: job.status === 'open',
    openedAt: job.opened_at.toISOString(),
    closedAt: job.closed_at ? job.closed_at.toISOString() : null,
    geometry,
  };
}

function reportToJson(r: CheckReportRow) {
  return {
    reportNo: r.report_no,
    seq: Number(r.seq),
    boxNo: r.box_no,
    revoked: r.revoked,
    position: r.revoked ? null : { bay: r.bay, row: r.row, tier: r.tier },
    acceptedAt: r.accepted_at.toISOString(),
  };
}

async function loadJob(
  client: PoolClient,
  jobId: string,
  forUpdate: boolean,
): Promise<CheckJobRow | null> {
  const res = await client.query(
    `SELECT id, voyage_id, manifest_rev, status, opened_at, closed_at, next_seq::text AS next_seq
     FROM check_jobs WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  return (res.rows[0] as CheckJobRow | undefined) ?? null;
}

async function loadGeometry(client: PoolClient, voyageId: string): Promise<Geometry> {
  const res = await client.query(
    `SELECT n_bays, n_rows, n_tiers FROM voyages WHERE id = $1`,
    [voyageId],
  );
  const row = res.rows[0];
  if (!row) throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
  return { bays: row.n_bays, rows: row.n_rows, tiers: row.n_tiers };
}

async function loadExpectedItems(
  client: PoolClient,
  voyageId: string,
  rev: number,
): Promise<ExpectedItem[]> {
  const res = await client.query(
    `SELECT box_no, bay, row, tier FROM manifest_items
     WHERE voyage_id = $1 AND rev = $2 ORDER BY box_no`,
    [voyageId, rev],
  );
  return res.rows.map(
    (r): ExpectedItem => ({
      boxNo: r.box_no,
      position: { bay: r.bay, row: r.row, tier: r.tier },
    }),
  );
}

async function loadAllReports(client: PoolClient, jobId: string): Promise<CheckReportRow[]> {
  const res = await client.query(
    `SELECT report_no, seq::text AS seq, box_no, revoked, bay, row, tier, accepted_at
     FROM check_reports WHERE job_id = $1 ORDER BY seq`,
    [jobId],
  );
  return res.rows as CheckReportRow[];
}

function rowToContent(r: CheckReportRow): CheckReportContent & { seq: number } {
  return {
    seq: Number(r.seq),
    boxNo: r.box_no,
    revoked: r.revoked,
    position: r.revoked ? null : ({ bay: r.bay, row: r.row, tier: r.tier } as Position),
  };
}

function buildEvaluation(
  expectedItems: ExpectedItem[],
  reports: CheckReportRow[],
): CheckEvaluation {
  return evaluateCheck(expectedItems, latestStates(reports.map(rowToContent)));
}

/* ---------- 服务 ---------- */

export class CheckService {
  constructor(private readonly pool: Pool) {}

  /**
   * 开启核对作业：基准必须是航次某修订号的【已签发清单】。
   * 同一清单最多一个作业；基准冻结，后续布局调整/签发新清单不影响它。
   */
  async openJob(voyageId: string, input: OpenCheckJobInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const voyage = await client.query(
        `SELECT n_bays, n_rows, n_tiers FROM voyages WHERE id = $1 FOR UPDATE`,
        [voyageId],
      );
      if (voyage.rows.length === 0) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }
      const geometry: Geometry = {
        bays: voyage.rows[0].n_bays,
        rows: voyage.rows[0].n_rows,
        tiers: voyage.rows[0].n_tiers,
      };

      const manifest = await client.query(
        `SELECT rev FROM manifests WHERE voyage_id = $1 AND rev = $2`,
        [voyageId, input.manifestRevision],
      );
      if (manifest.rows.length === 0) {
        throw HttpError.notFound(
          'manifest_not_found',
          `航次在修订号 ${input.manifestRevision} 没有已签发的装载清单，核对作业无法开工`,
        );
      }

      // ON CONFLICT DO NOTHING：唯一冲突不会污染事务，便于随后取回既有作业
      const res = await client.query(
        `INSERT INTO check_jobs (voyage_id, manifest_rev) VALUES ($1, $2)
         ON CONFLICT (voyage_id, manifest_rev) DO NOTHING
         RETURNING id, voyage_id, manifest_rev, status, opened_at, closed_at, next_seq::text AS next_seq`,
        [voyageId, input.manifestRevision],
      );

      if (res.rows.length === 0) {
        // 同一清单已有作业：返回既有作业信息以便客户端接续，不另开新作业
        const existing = await client.query(
          `SELECT id, voyage_id, manifest_rev, status, opened_at, closed_at, next_seq::text AS next_seq
           FROM check_jobs WHERE voyage_id = $1 AND manifest_rev = $2`,
          [voyageId, input.manifestRevision],
        );
        const job = existing.rows[0] as CheckJobRow;
        throw HttpError.conflict(
          'check_job_exists',
          `修订号 ${input.manifestRevision} 的清单已存在核对作业，同一清单最多一个作业`,
          { existingJob: jobToJson(job, geometry) },
        );
      }
      const job = res.rows[0] as CheckJobRow;

      const expected = await loadExpectedItems(client, voyageId, input.manifestRevision);
      await client.query('COMMIT');
      return { job: jobToJson(job, geometry), expected };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 上报核对结果（作业行级互斥，与结案顺序生效）。
   *  - 相同 reportNo + 相同内容：幂等返回原结果（作业结案后仍可重试）；
   *  - 相同 reportNo + 不同内容：409 report_no_conflict；
   *  - 结案后新上报号：409 check_job_closed；
   *  - 坐标越界：400 invalid_coordinates。
   */
  async submitReport(jobId: string, input: CheckReportInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const job = await loadJob(client, jobId, true);
      if (!job) {
        throw HttpError.notFound('check_job_not_found', `核对作业 ${jobId} 不存在`);
      }

      const existingRes = await client.query(
        `SELECT report_no, seq::text AS seq, box_no, revoked, bay, row, tier, accepted_at
         FROM check_reports WHERE job_id = $1 AND report_no = $2`,
        [jobId, input.reportNo],
      );
      const existing = existingRes.rows[0] as CheckReportRow | undefined;
      const incoming: CheckReportContent = {
        boxNo: input.boxNo,
        revoked: input.position === null,
        position: input.position,
      };

      if (existing) {
        // 幂等/冲突判定优先：已受理上报号即使在结案后也可原样重试
        const stored: CheckReportContent = {
          boxNo: existing.box_no,
          revoked: existing.revoked,
          position: existing.revoked
            ? null
            : ({ bay: existing.bay, row: existing.row, tier: existing.tier } as Position),
        };
        if (!sameReportContent(stored, incoming)) {
          throw HttpError.conflict(
            'report_no_conflict',
            `上报号 ${input.reportNo} 已用于不同内容，上报号在同一作业内唯一且不可复用`,
            {
              reportNo: input.reportNo,
              stored: reportToJson(existing),
              incoming,
            },
          );
        }
        const geometry = await loadGeometry(client, job.voyage_id);
        const expectedItems = await loadExpectedItems(client, job.voyage_id, job.manifest_rev);
        const reports = await loadAllReports(client, jobId);
        const evaluation = buildEvaluation(expectedItems, reports);
        await client.query('COMMIT');
        return {
          replay: true,
          job: jobToJson(job, geometry),
          report: reportToJson(existing),
          status: this.statusSummary(job, expectedItems, evaluation),
        };
      }

      if (job.status === 'closed') {
        throw HttpError.conflict(
          'check_job_closed',
          '核对作业已结案并冻结结果，拒绝新上报；已受理上报号仍可原样重试',
          { jobId, closedAt: job.closed_at ? job.closed_at.toISOString() : null },
        );
      }

      const geometry = await loadGeometry(client, job.voyage_id);
      if (!reportInBounds(incoming, geometry)) {
        throw HttpError.badRequest(
          'invalid_coordinates',
          `箱 ${input.boxNo} 的上报坐标超出舱位范围 (bay 1..${geometry.bays}, row 1..${geometry.rows}, tier 0..${geometry.tiers - 1})`,
          { boxNo: input.boxNo, position: input.position },
        );
      }

      const nextSeq = BigInt(job.next_seq) + 1n;
      const inserted = await client.query(
        `INSERT INTO check_reports (job_id, report_no, seq, box_no, revoked, bay, row, tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING report_no, seq::text AS seq, box_no, revoked, bay, row, tier, accepted_at`,
        [
          jobId,
          input.reportNo,
          nextSeq.toString(),
          input.boxNo,
          input.position === null,
          input.position?.bay ?? null,
          input.position?.row ?? null,
          input.position?.tier ?? null,
        ],
      );
      await client.query(`UPDATE check_jobs SET next_seq=$2 WHERE id=$1`, [
        jobId,
        nextSeq.toString(),
      ]);
      const report = inserted.rows[0] as CheckReportRow;

      const expectedItems = await loadExpectedItems(client, job.voyage_id, job.manifest_rev);
      const reports = await loadAllReports(client, jobId);
      const evaluation = buildEvaluation(expectedItems, reports);
      const updatedJob: CheckJobRow = { ...job, next_seq: nextSeq.toString() };

      await client.query('COMMIT');
      return {
        replay: false,
        job: jobToJson(updatedJob, geometry),
        report: reportToJson(report),
        status: this.statusSummary(updatedJob, expectedItems, evaluation),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 查询当前核对状态：应装 / 已核对 / 缺失 / 错位 / 清单外箱明细 */
  async getStatus(jobId: string) {
    const client = await this.pool.connect();
    try {
      const job = await loadJob(client, jobId, false);
      if (!job) {
        throw HttpError.notFound('check_job_not_found', `核对作业 ${jobId} 不存在`);
      }
      const expectedItems = await loadExpectedItems(client, job.voyage_id, job.manifest_rev);
      const reports = await loadAllReports(client, jobId);
      return this.statusSummary(job, expectedItems, buildEvaluation(expectedItems, reports));
    } finally {
      client.release();
    }
  }

  /**
   * 尝试结案：仅当所有清单箱当前坐标与冻结清单一致且无清单外箱时成功并冻结；
   * 否则返回 409 与差异明细，作业继续开放。重复结案幂等返回冻结结果。
   */
  async closeJob(jobId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const job = await loadJob(client, jobId, true);
      if (!job) {
        throw HttpError.notFound('check_job_not_found', `核对作业 ${jobId} 不存在`);
      }
      const geometry = await loadGeometry(client, job.voyage_id);
      const expectedItems = await loadExpectedItems(client, job.voyage_id, job.manifest_rev);
      const reports = await loadAllReports(client, jobId);
      const evaluation = buildEvaluation(expectedItems, reports);

      // 已结案：幂等返回冻结结果
      if (job.status === 'closed') {
        await client.query('COMMIT');
        return {
          closed: true,
          replay: true,
          job: jobToJson(job, geometry),
          status: this.statusSummary(job, expectedItems, evaluation),
        };
      }

      if (!evaluation.closeable) {
        // 无写入，直接抛错；外层 ROLLBACK 释放作业行锁，作业保持开放
        throw HttpError.conflict(
          'check_not_closeable',
          `核对仍有差异（缺失 ${evaluation.counts.missing}、错位 ${evaluation.counts.misplaced}、清单外 ${evaluation.counts.extra}），作业继续开放`,
          {
            job: jobToJson(job, geometry),
            status: this.statusSummary(job, expectedItems, evaluation),
          },
        );
      }

      const updated = await client.query(
        `UPDATE check_jobs SET status='closed', closed_at=now()
         WHERE id=$1
         RETURNING id, voyage_id, manifest_rev, status, opened_at, closed_at, next_seq::text AS next_seq`,
        [jobId],
      );
      const closedJob = updated.rows[0] as CheckJobRow;
      await client.query('COMMIT');
      return {
        closed: true,
        replay: false,
        job: jobToJson(closedJob, geometry),
        status: this.statusSummary(closedJob, expectedItems, evaluation),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 上报留痕列表（按受理顺序） */
  async listReports(jobId: string) {
    const client = await this.pool.connect();
    try {
      const job = await loadJob(client, jobId, false);
      if (!job) {
        throw HttpError.notFound('check_job_not_found', `核对作业 ${jobId} 不存在`);
      }
      const geometry = await loadGeometry(client, job.voyage_id);
      const reports = await loadAllReports(client, jobId);
      return { job: jobToJson(job, geometry), reports: reports.map(reportToJson) };
    } finally {
      client.release();
    }
  }

  /** 按航次列出核对作业（含基准修订号与状态） */
  async listJobs(voyageId: string) {
    // 确认航次存在，保持与其他接口一致的 404
    const check = await this.pool.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
    if (check.rows.length === 0) {
      throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
    }
    const geometryRes = await this.pool.query(
      `SELECT n_bays, n_rows, n_tiers FROM voyages WHERE id=$1`,
      [voyageId],
    );
    const g = geometryRes.rows[0];
    const geometry: Geometry = { bays: g.n_bays, rows: g.n_rows, tiers: g.n_tiers };

    const res = await this.pool.query(
      `SELECT id, voyage_id, manifest_rev, status, opened_at, closed_at, next_seq::text AS next_seq
       FROM check_jobs WHERE voyage_id=$1 ORDER BY manifest_rev DESC, opened_at DESC`,
      [voyageId],
    );
    return { jobs: (res.rows as CheckJobRow[]).map((j) => jobToJson(j, geometry)) };
  }

  private statusSummary(
    job: CheckJobRow,
    expectedItems: ExpectedItem[],
    evaluation: CheckEvaluation,
  ) {
    return {
      jobId: job.id,
      voyageId: job.voyage_id,
      manifestRevision: job.manifest_rev,
      status: job.status,
      open: job.status === 'open',
      openedAt: job.opened_at.toISOString(),
      closedAt: job.closed_at ? job.closed_at.toISOString() : null,
      frozen: job.status === 'closed',
      closeable: evaluation.closeable,
      counts: evaluation.counts,
      details: {
        expected: evaluation.expected,
        checked: evaluation.checked,
        missing: evaluation.missing,
        misplaced: evaluation.misplaced,
        extra: evaluation.extra,
      },
      expectedCount: expectedItems.length,
    };
  }
}
