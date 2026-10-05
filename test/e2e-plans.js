/* eslint-disable no-console */
// 端到端验证：试排方案（建立 / 方案内整批调整 / 查询 / 发布 / 只读与幂等）
//   - 从航次当前修订号建立多个相互独立的方案：以创建时布局为初值、固定当时约束快照
//   - 方案内整批调整沿用箱号/坐标/最终布局校验规则，按方案修订号防并发覆盖；失败不改变方案
//   - 查询方案返回当前试排布局、约束与版本；未知方案明确 404
//   - 正式航次、清单与核对作业不受试排影响
//   - 发布：航次当前修订号仍等于方案来源修订号才原子写入新修订号并继承方案约束；
//     否则 409 冲突且保留方案；发布后方案只读，重复发布返回首次结果
// 运行: node test/e2e-plans.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30197;
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
    databaseDir: path.join('/tmp', 'pgdata-e2e-plans'),
    user: 'stowage',
    password: 'stowage',
    port: 54397,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54397/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const posOf = (layout, boxNo) => layout.placements.find((p) => p.boxNo === boxNo)?.position;

  try {
    // ---- 登记：3x3x2；默认 10000；(1,1) 覆盖 1200；规则 1-3 距离 3；4 箱 ----
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-PLAN-001',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      boxes: [
        { boxNo: 'B1', weight: '500', category: '1' },
        { boxNo: 'B2', weight: '600', category: '3' },
        { boxNo: 'B3', weight: '400', category: '5' },
        { boxNo: 'B4', weight: '300', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    const vid = voyage.id;

    // 正式布局 rev=1：B1@(1,1,0) B4@(1,1,1) B2@(3,3,0) B3@(2,2,0)
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
        { boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } },
      ],
    }, 200);

    // ---- 1. 从 rev=1 建立两个相互独立的方案 ----
    const planA = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '方案A' }, 201)).body;
    check('方案A 建立：来源修订号=1、方案修订号=0、状态 open',
      planA.sourceRevision === 1 && planA.planRevision === 0 && planA.status === 'open',
      JSON.stringify(planA));
    check('方案A 初值=创建时布局（4 箱原位）',
      planA.placements.length === 4 &&
      posOf(planA, 'B1').bay === 1 && posOf(planA, 'B2').bay === 3 && posOf(planA, 'B3').bay === 2);
    check('方案A 固定当时约束（默认10000/覆盖(1,1)=1200/规则1-3）',
      planA.defaultColumnWeightLimit === '10000' &&
      planA.columnWeightLimits.length === 1 && planA.columnWeightLimits[0].weightLimit === '1200' &&
      planA.incompatRules.length === 1 && planA.incompatRules[0].minDistance === 3);

    const planB = (await http('POST', `${BASE}/voyages/${vid}/plans`, undefined, 201)).body;
    check('方案B 独立建立（不同 planId、label 可空）',
      planB.planId !== planA.planId && planB.label === null && planB.sourceRevision === 1);

    const list = (await http('GET', `${BASE}/voyages/${vid}/plans`, undefined, 200)).body;
    check('航次方案列表含 2 个方案', list.plans.length === 2);

    // ---- 2. 方案内整批调整：合法 / 违规 422 / 过期 409 / 请求级 400；失败不改变方案 ----
    const mvA = await http('POST', `${BASE}/plans/${planA.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: { bay: 2, row: 1, tier: 0 } }],
    }, 200);
    check('方案A 合法调整：方案修订号 0->1，applied=1',
      mvA.body.planRevision === 1 && mvA.body.previousPlanRevision === 0 && mvA.body.applied === 1);
    check('方案A 新布局 B3@(2,1,0)', posOf(mvA.body.plan, 'B3').row === 1);

    const badMove = await http('POST', `${BASE}/plans/${planA.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B2', position: { bay: 1, row: 2, tier: 0 } }], // 距 B1=1 < 3
    });
    check('方案A 违规调整 422 incompatible_too_close',
      badMove.status === 422 && badMove.body.error.code === 'validation_failed' &&
      badMove.body.error.details.violations.some((x) => x.reason === 'incompatible_too_close'));
    const afterBad = (await http('GET', `${BASE}/plans/${planA.planId}`, undefined, 200)).body;
    check('失败后方案不变（修订号仍 1、B2 仍在 (3,3,0)）',
      afterBad.planRevision === 1 && posOf(afterBad, 'B2').bay === 3);

    const staleMove = await http('POST', `${BASE}/plans/${planA.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } }],
    });
    check('方案A 过期方案修订号 409 stale_revision（返回当前方案修订号 1）',
      staleMove.status === 409 && staleMove.body.error.code === 'stale_revision' &&
      staleMove.body.error.details.currentRevision === 1 &&
      staleMove.body.error.details.expectedRevision === 0, JSON.stringify(staleMove.body));

    const unknownBox = await http('POST', `${BASE}/plans/${planA.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'NOPE', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('方案A 未知箱号 400 invalid_adjustment/unknown_box',
      unknownBox.status === 400 && unknownBox.body.error.code === 'invalid_adjustment' &&
      unknownBox.body.error.details.issues.some((i) => i.reason === 'unknown_box'));

    // 方案B 独立调整（与方案A 互不影响）：B2 -> (3,2,0)，距 B1 为 3 达标
    const mvB = await http('POST', `${BASE}/plans/${planB.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B2', position: { bay: 3, row: 2, tier: 0 } }],
    }, 200);
    check('方案B 独立调整成功（B2@(3,2,0)）',
      mvB.body.planRevision === 1 && posOf(mvB.body.plan, 'B2').row === 2);
    const planANow = (await http('GET', `${BASE}/plans/${planA.planId}`, undefined, 200)).body;
    check('方案A 不受方案B 影响（B2 仍在 (3,3,0)）', posOf(planANow, 'B2').bay === 3);

    // ---- 3. 正式航次不受试排影响；查询方案返回布局/约束/版本；未知方案 404 ----
    const voyageNow = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('试排期间正式航次修订号仍为 1', voyageNow.revision === 1);
    const formalLayout = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('正式布局不受试排影响（B3 仍在 (2,2,0)）', posOf(formalLayout, 'B3').row === 2);

    check('查询方案返回布局/约束/版本',
      planANow.geometry.bays === 3 && planANow.defaultColumnWeightLimit === '10000' &&
      planANow.sourceRevision === 1 && planANow.planRevision === 1 && planANow.status === 'open' &&
      planANow.publishedRevision === null);
    const nf = await http('GET', `${BASE}/plans/00000000-0000-0000-0000-000000000000`);
    check('未知方案 404 plan_not_found',
      nf.status === 404 && nf.body.error.code === 'plan_not_found');
    const badId = await http('GET', `${BASE}/plans/not-a-uuid`);
    check('非法方案 ID 400 invalid_plan_id',
      badId.status === 400 && badId.body.error.code === 'invalid_plan_id');

    // ---- 4. 正式航次继续前进（rev 1->2），方案A 来源修订号被偏离 ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } }],
    }, 200);

    const conflict = await http('POST', `${BASE}/plans/${planA.planId}/publish`, undefined);
    check('发布冲突 409 publish_conflict（航次 2 ≠ 来源 1）',
      conflict.status === 409 && conflict.body.error.code === 'publish_conflict' &&
      conflict.body.error.details.sourceRevision === 1 &&
      conflict.body.error.details.currentRevision === 2, JSON.stringify(conflict.body));
    const planAKept = (await http('GET', `${BASE}/plans/${planA.planId}`, undefined, 200)).body;
    check('冲突后方案保留（仍 open，可继续调整）',
      planAKept.status === 'open' && planAKept.planRevision === 1);
    const mvA2 = await http('POST', `${BASE}/plans/${planA.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B4', position: null }],
    }, 200);
    check('冲突后方案仍可调整（撤位 B4，方案修订号 1->2）',
      mvA2.body.planRevision === 2 && mvA2.body.plan.unplacedBoxNos.includes('B4'));

    // ---- 5. 从 rev=2 建立方案C，调整后发布成功 ----
    const planC = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '方案C' }, 201)).body;
    check('方案C 来源修订号=2', planC.sourceRevision === 2 && posOf(planC, 'B3').row === 1);
    // 批1：B2 -> (2,3,0)（距 B1=3 达标）；批2：撤 B4；批3：B4 复位 (1,1,1)
    await http('POST', `${BASE}/plans/${planC.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B2', position: { bay: 2, row: 3, tier: 0 } }],
    }, 200);
    await http('POST', `${BASE}/plans/${planC.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B4', position: null }],
    }, 200);
    const mvC3 = await http('POST', `${BASE}/plans/${planC.planId}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } }],
    }, 200);
    check('方案C 撤位/复位后 4 箱全部配位（方案修订号=3）',
      mvC3.body.planRevision === 3 && mvC3.body.plan.unplacedBoxNos.length === 0);

    const pub = await http('POST', `${BASE}/plans/${planC.planId}/publish`, undefined, 201);
    check('发布成功 201：写入航次修订号 3',
      pub.body.published === true && pub.body.replay === false &&
      pub.body.voyageRevision === 3 && pub.body.sourceRevision === 2 &&
      pub.body.planRevision === 3, JSON.stringify(pub.body));
    check('发布布局=方案布局（B2@(2,3,0)、B3@(3,1,0)）',
      posOf(pub.body.layout, 'B2').row === 3 && posOf(pub.body.layout, 'B3').bay === 3 &&
      pub.body.layout.placements.length === 4 && pub.body.layout.current === true);
    check('新修订号继承方案约束（默认10000/覆盖(1,1)/规则1-3）',
      pub.body.layout.defaultColumnWeightLimit === '10000' &&
      pub.body.layout.columnWeightLimits.length === 1 &&
      pub.body.layout.incompatRules.length === 1);

    const voyageAfterPub = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('发布后航次当前修订号=3', voyageAfterPub.revision === 3);
    const lay3 = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('航次当前布局即方案布局', posOf(lay3, 'B2').row === 3 && posOf(lay3, 'B3').bay === 3);

    // ---- 6. 发布后方案只读；重复发布返回首次结果 ----
    const readOnly = await http('POST', `${BASE}/plans/${planC.planId}/moves`, {
      baseRevision: 3,
      moves: [{ boxNo: 'B1', position: null }],
    });
    check('已发布方案拒绝调整 409 plan_published',
      readOnly.status === 409 && readOnly.body.error.code === 'plan_published');

    const repub = await http('POST', `${BASE}/plans/${planC.planId}/publish`, undefined, 200);
    check('重复发布 200 replay：返回首次发布结果（修订号 3、同一发布时间）',
      repub.body.replay === true && repub.body.voyageRevision === 3 &&
      repub.body.publishedAt === pub.body.publishedAt, JSON.stringify(repub.body));
    const voyageAfterRepub = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('重复发布不产生新修订号（仍为 3）', voyageAfterRepub.revision === 3);
    const planCFinal = (await http('GET', `${BASE}/plans/${planC.planId}`, undefined, 200)).body;
    check('方案C 状态 published、记录 publishedRevision=3',
      planCFinal.status === 'published' && planCFinal.publishedRevision === 3 &&
      planCFinal.publishedAt !== null);

    // ---- 7. 发布后正式流程不受影响：签发/核对照常；历史布局冻结 ----
    const manifest = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 }, 201);
    check('按发布后的 rev=3 签发清单（4 箱）',
      manifest.body.current === true && manifest.body.boxCount === 4);
    const job = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 3 }, 201);
    check('以 rev=3 清单开启核对作业', job.body.job.manifestRevision === 3);
    check('核对基准=发布布局（B2@(2,3,0)）',
      job.body.expected.find((e) => e.boxNo === 'B2').position.row === 3);

    const lay1 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=1`, undefined, 200)).body;
    check('历史 rev=1 布局冻结（B3@(2,2,0)）', posOf(lay1, 'B3').row === 2);
    const lay2 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=2`, undefined, 200)).body;
    check('历史 rev=2 布局冻结（B3@(3,1,0)、B2@(3,3,0)）',
      posOf(lay2, 'B3').bay === 3 && posOf(lay2, 'B2').bay === 3);

    // ---- 8. 并发：同方案同方案修订号两批调整只有一个成功 ----
    const planD = (await http('POST', `${BASE}/voyages/${vid}/plans`, undefined, 201)).body;
    // 两批各自合法（B2/B3 均独占一列，撤位不破坏连续性），唯一分野是方案修订号竞争
    const [m1, m2] = await Promise.all([
      http('POST', `${BASE}/plans/${planD.planId}/moves`, {
        baseRevision: 0,
        moves: [{ boxNo: 'B2', position: null }],
      }),
      http('POST', `${BASE}/plans/${planD.planId}/moves`, {
        baseRevision: 0,
        moves: [{ boxNo: 'B3', position: null }],
      }),
    ]);
    const ms = [m1.status, m2.status].sort();
    check('并发同方案修订号调整：一个 200 一个 409', ms[0] === 200 && ms[1] === 409,
      JSON.stringify(ms));
    const planDNow = (await http('GET', `${BASE}/plans/${planD.planId}`, undefined, 200)).body;
    check('并发后方案修订号恰好 +1 为 1', planDNow.planRevision === 1);

    // ---- 9. 并发：同源两方案同时发布只有一个成功 ----
    const planE = (await http('POST', `${BASE}/voyages/${vid}/plans`, undefined, 201)).body;
    const planF = (await http('POST', `${BASE}/voyages/${vid}/plans`, undefined, 201)).body;
    check('方案E/F 来源修订号均为 3',
      planE.sourceRevision === 3 && planF.sourceRevision === 3);
    const [p1, p2] = await Promise.all([
      http('POST', `${BASE}/plans/${planE.planId}/publish`, undefined),
      http('POST', `${BASE}/plans/${planF.planId}/publish`, undefined),
    ]);
    const ps = [p1.status, p2.status].sort();
    check('并发同源发布：一个 201 一个 409 publish_conflict', ps[0] === 201 && ps[1] === 409,
      JSON.stringify([p1.status, p2.status, p1.body?.error?.code, p2.body?.error?.code]));
    const loser = p1.status === 409 ? p1 : p2;
    check('失败方为 publish_conflict 且方案保留',
      loser.body.error.code === 'publish_conflict' &&
      loser.body.error.details.currentRevision === 4);
    const voyageFinal = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('并发发布后航次修订号恰好 +1 为 4', voyageFinal.revision === 4);

    // 未知航次建立方案 -> 404
    const nfVoyage = await http('POST', `${BASE}/voyages/00000000-0000-0000-0000-000000000000/plans`, {});
    check('未知航次建立方案 404 voyage_not_found',
      nfVoyage.status === 404 && nfVoyage.body.error.code === 'voyage_not_found');

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
