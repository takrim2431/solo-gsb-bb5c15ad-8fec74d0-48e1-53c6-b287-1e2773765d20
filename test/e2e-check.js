/* eslint-disable no-console */
// 现场装船核对 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: node test/e2e-check.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30198;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-check'),
    user: 'stowage',
    password: 'stowage',
    port: 54398,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54398/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 1. 登记 + 合法布局 rev1 + 签发清单 rev1 ----
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-CHECK-001',
      bays: 3, rows: 2, tiers: 3,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'BOX-1', weight: '500', category: '1' },
        { boxNo: 'BOX-2', weight: '600', category: '3' },
        { boxNo: 'BOX-3', weight: '400', category: '5' },
        { boxNo: 'BOX-4', weight: '300', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    const vid = voyage.id;

    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 } },
        { boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);

    // ---- 2. 清单不存在拒绝开工 ----
    const noManifest = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 99 });
    check('清单不存在拒绝开工 404 manifest_not_found',
      noManifest.status === 404 && noManifest.body.error.code === 'manifest_not_found',
      JSON.stringify(noManifest.body));

    // ---- 3. 以 rev1 清单开启作业 A ----
    const openA = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 1 }, 201);
    const jobA = openA.body.job;
    check('作业 A 开启 open，基准=rev1', jobA.status === 'open' && jobA.manifestRevision === 1);
    check('开工返回应装明细 4 箱', openA.body.expected.length === 4);

    // 同一清单再开 -> 409，且带回既有作业
    const openAgain = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 1 });
    check('同一清单重复开工 409 check_job_exists',
      openAgain.status === 409 && openAgain.body.error.code === 'check_job_exists' &&
      openAgain.body.error.details.existingJob.jobId === jobA.jobId);

    // ---- 4. 基准冻结：调整布局 rev2 + 签发新清单 rev2 + 开作业 B，作业 A 基准不变 ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 1, tier: 0 } }],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 }, 201);
    const openB = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 2 }, 201);
    const jobB = openB.body.job;
    check('不同清单可开作业 B', jobB.manifestRevision === 2 && jobB.jobId !== jobA.jobId);

    const stA0 = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}`, undefined, 200)).body;
    const a3 = stA0.details.expected.find((e) => e.boxNo === 'BOX-3');
    check('作业 A 基准冻结：BOX-3 应装仍是 rev1 的 (2,2,0)',
      a3.position.bay === 2 && a3.position.row === 2 && a3.position.tier === 0);
    check('初始状态：应装4 已核对0 缺失4',
      stA0.counts.expected === 4 && stA0.counts.checked === 0 && stA0.counts.missing === 4);

    const jobs = (await http('GET', `${BASE}/voyages/${vid}/check-jobs`, undefined, 200)).body;
    check('作业列表含两个作业', jobs.jobs.length === 2);

    // ---- 5. 上报：正确/撤销/错位/清单外 ----
    const r1 = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-001', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
    });
    check('上报 BOX-1 正确 -> 201 已核对 1',
      r1.status === 201 && r1.body.status.counts.checked === 1 && r1.body.replay === false);

    // 相同上报号+内容重试 -> 原结果
    const r1retry = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-001', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
    });
    check('相同上报号与内容重试 -> 200 replay 原结果',
      r1retry.status === 200 && r1retry.body.replay === true &&
      r1retry.body.status.counts.checked === 1 && r1retry.body.report.seq === 1);

    // 相同上报号+不同内容 -> 409
    const r1conflict = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-001', boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 },
    });
    check('相同上报号不同内容 -> 409 report_no_conflict',
      r1conflict.status === 409 && r1conflict.body.error.code === 'report_no_conflict');

    // 坐标越界 -> 400，不留痕
    const badCoord = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-002', boxNo: 'BOX-2', position: { bay: 9, row: 2, tier: 0 },
    });
    check('坐标越界 -> 400 invalid_coordinates',
      badCoord.status === 400 && badCoord.body.error.code === 'invalid_coordinates');

    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-003', boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 },
    }, 201);
    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-004', boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 1 },
    }, 201);

    // BOX-3 先报错位
    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-005', boxNo: 'BOX-3', position: { bay: 2, row: 1, tier: 0 },
    }, 201);
    let st = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}`, undefined, 200)).body;
    check('错位上报：misplaced=1，BOX-3 带应装/实装坐标',
      st.counts.misplaced === 1 &&
      st.details.misplaced[0].boxNo === 'BOX-3' &&
      st.details.misplaced[0].expectedPosition.row === 2 &&
      st.details.misplaced[0].actualPosition.row === 1);

    // 清单外箱实装 -> extra
    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-006', boxNo: 'GHOST', position: { bay: 3, row: 1, tier: 0 },
    }, 201);
    st = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}`, undefined, 200)).body;
    check('清单外箱计入 extra=1', st.counts.extra === 1 && st.details.extra[0].boxNo === 'GHOST');
    check('有差异不可结案 closeable=false', st.closeable === false);

    // ---- 6. 结案被拒：差异返回，作业继续开放 ----
    const closeFail = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/close`);
    check('有差异结案 -> 409 check_not_closeable 且作业仍开放',
      closeFail.status === 409 && closeFail.body.error.code === 'check_not_closeable' &&
      closeFail.body.error.details.status.open === true);

    // ---- 7. 撤销 GHOST（清单外消失）；BOX-3 先撤销（缺失）再补正确上报 ----
    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-007', boxNo: 'GHOST', position: null,
    }, 201);
    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-008', boxNo: 'BOX-3', position: null,
    }, 201);
    st = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}`, undefined, 200)).body;
    check('撤销清单外箱后 extra=0', st.counts.extra === 0);
    check('BOX-3 撤销后缺失 reason=revoked',
      st.counts.missing === 1 && st.details.missing[0].boxNo === 'BOX-3' &&
      st.details.missing[0].reason === 'revoked');

    await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-009', boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 },
    }, 201);
    st = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}`, undefined, 200)).body;
    check('补报正确后：已核对 4、缺失/错位/清单外全 0、closeable=true',
      st.counts.checked === 4 && st.counts.missing === 0 &&
      st.counts.misplaced === 0 && st.counts.extra === 0 && st.closeable === true);

    // 留痕：8 条受理（越界与冲突未留痕）
    const reports = (await http('GET', `${BASE}/check-jobs/${jobA.jobId}/reports`, undefined, 200)).body;
    check('上报留痕 8 条且 seq 连续 1..8',
      reports.reports.length === 8 &&
      reports.reports.every((r, i) => r.seq === i + 1));

    // ---- 8. 结案冻结 ----
    const close = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/close`, undefined, 201);
    check('结案成功 status=closed frozen=true',
      close.body.status.status === 'closed' && close.body.status.frozen === true);

    // 重复结案幂等
    const closeAgain = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/close`, undefined, 200);
    check('重复结案 200 replay', closeAgain.body.replay === true);

    // ---- 9. 结案后拒绝新上报；已受理上报号仍可重试 ----
    const afterClose = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-NEW', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
    });
    check('结案后新上报 -> 409 check_job_closed',
      afterClose.status === 409 && afterClose.body.error.code === 'check_job_closed');

    const replayAfterClose = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-001', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
    }, 200);
    check('结案后已受理上报号原样重试 -> 200 replay，结果冻结',
      replayAfterClose.body.replay === true &&
      replayAfterClose.body.status.status === 'closed' &&
      replayAfterClose.body.status.counts.checked === 4);

    // 结案后已受理上报号换内容仍报冲突
    const conflictAfterClose = await http('POST', `${BASE}/check-jobs/${jobA.jobId}/reports`, {
      reportNo: 'R-001', boxNo: 'BOX-1', position: { bay: 1, row: 2, tier: 0 },
    });
    check('结案后上报号换内容 -> 409', conflictAfterClose.status === 409);

    // ---- 10. 并发上报：不同上报号全部顺序受理，seq 无丢失无重复 ----
    const concurrent = await Promise.all(
      ['C-1', 'C-2', 'C-3', 'C-4', 'C-5'].map((no) =>
        http('POST', `${BASE}/check-jobs/${jobB.jobId}/reports`, {
          reportNo: no, boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
        }),
      ),
    );
    check('作业 B 并发 5 上报全部 201', concurrent.every((r) => r.status === 201));
    const seqs = concurrent.map((r) => r.body.report.seq).sort((a, b) => a - b);
    check('并发上报 seq 为 1..5 无重复', seqs.join(',') === '1,2,3,4,5');

    // 同上报号同内容并发：一个首次受理，其余重放
    const sameNo = await Promise.all(
      [1, 2, 3].map(() =>
        http('POST', `${BASE}/check-jobs/${jobB.jobId}/reports`, {
          reportNo: 'D-DUP', boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 },
        }),
      ),
    );
    const firstCount = sameNo.filter((r) => r.status === 201).length;
    const replayCount = sameNo.filter((r) => r.status === 200 && r.body.replay).length;
    check('同上报号并发：恰一个 201，其余 200 replay',
      firstCount === 1 && replayCount === 2, sameNo.map((r) => r.status).join(','));

    // ---- 11. 并发结案 vs 新上报：顺序生效，无丢失/无双写 ----
    // 让作业 B 先补齐到可结案（BOX-3 应装在 rev2 的 (2,1,0)，BOX-4 (1,1,1)）
    // 当前已报 BOX-1 多次（最后仍是 1,1,0），BOX-2 已报 D-DUP
    await http('POST', `${BASE}/check-jobs/${jobB.jobId}/reports`, {
      reportNo: 'E-3', boxNo: 'BOX-3', position: { bay: 2, row: 1, tier: 0 },
    }, 201);
    await http('POST', `${BASE}/check-jobs/${jobB.jobId}/reports`, {
      reportNo: 'E-4', boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 1 },
    }, 201);
    const closeableNow = (await http('GET', `${BASE}/check-jobs/${jobB.jobId}`, undefined, 200)).body;
    check('作业 B 已可结案', closeableNow.closeable === true && closeableNow.counts.extra === 0);

    const [closeRes, newReportRes] = await Promise.all([
      http('POST', `${BASE}/check-jobs/${jobB.jobId}/close`),
      http('POST', `${BASE}/check-jobs/${jobB.jobId}/reports`, {
        reportNo: 'E-NEW', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 },
      }),
    ]);
    const after = (await http('GET', `${BASE}/check-jobs/${jobB.jobId}`, undefined, 200)).body;
    if (after.status === 'closed') {
      // 结案先生效：新上报必须被拒，结果冻结
      check('结案先生效：并发新上报被拒 409', newReportRes.status === 409,
        `close=${closeRes.status} report=${newReportRes.status}`);
    } else {
      // 上报先生效（内容与清单一致，仍可结案）：结案必须失败或……此时无差异，结案应成功。
      // 该分支理论上不会出现（两者都在可结案状态，顺序不影响结案成功），仅作不变量校验。
      check('上报先生效：作业仍开放且新上报已受理',
        newReportRes.status === 201 && after.open === true,
        `close=${closeRes.status} report=${newReportRes.status}`);
    }
    check('并发后结案结果存在（201 或 200 重放）',
      closeRes.status === 201 || closeRes.status === 200,
      `close=${closeRes.status}`);
    check('作业 B 最终 closed 且差异为 0',
      after.status === 'closed' && after.counts.missing === 0 &&
      after.counts.misplaced === 0 && after.counts.extra === 0,
      JSON.stringify(after.counts));

    // ---- 12. 404 ----
    const nfJob = await http('GET', `${BASE}/check-jobs/00000000-0000-0000-0000-000000000000`);
    check('未知作业 404', nfJob.status === 404 && nfJob.body.error.code === 'check_job_not_found');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
