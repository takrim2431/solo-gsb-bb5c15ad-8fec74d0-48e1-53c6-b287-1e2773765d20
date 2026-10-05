/* eslint-disable no-console */
// 逐港倒箱作业方案 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-restow.js
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
    databaseDir: path.join('/tmp', 'pgdata-e2e-restow'),
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

  try {
    // ---- 准备：航次 2bay×1row×3tier，4 箱，签发 rev1 ----
    // 列 (1,1)：BOX-1(t0) / BOX-2(t1) / BOX-3(t2)；列 (2,1)：BOX-4(t0)
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-RESTOW-001',
      bays: 2, rows: 1, tiers: 3,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'BOX-1', weight: '500', category: '1' },
        { boxNo: 'BOX-2', weight: '500', category: '1' },
        { boxNo: 'BOX-3', weight: '500', category: '1' },
        { boxNo: 'BOX-4', weight: '500', category: '1' },
      ],
    }, 201);
    const vid = voyage.id;
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 2 } },
        { boxNo: 'BOX-4', position: { bay: 2, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);

    // 不可行审查：BOX-1(SHA) 被 BOX-2(SIN)、BOX-3(HAM) 压住；BOX-4(SHA) 可卸
    const { body: review } = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [
        { boxNo: 'BOX-1', dischargePort: 'SHA' },
        { boxNo: 'BOX-2', dischargePort: 'SIN' },
        { boxNo: 'BOX-3', dischargePort: 'HAM' },
        { boxNo: 'BOX-4', dischargePort: 'SHA' },
      ],
    }, 201);
    check('审查不可行（feasibleWithoutRestow=false）',
      review.simulation.feasibleWithoutRestow === false);
    const reviewId = review.reviewId;
    const plansUrl = `${BASE}/discharge-reviews/${reviewId}/restow-plans`;

    // ---- 1. 可行倒箱方案：SHA 暂存 BOX-3/BOX-2 卸 BOX-1/BOX-4，回放后逐港卸空 ----
    const okBody = {
      capacity: 2,
      ports: [
        {
          port: 'SHA',
          operations: [
            { action: 'stash', boxNo: 'BOX-3' },
            { action: 'stash', boxNo: 'BOX-2' },
            { action: 'restore', boxNo: 'BOX-3' },
            { action: 'restore', boxNo: 'BOX-2' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    };
    const ok = await http('POST', plansUrl, okBody, 201);
    check('可行方案 201 且 replay=false', ok.body.replay === false && !!ok.body.planId);
    const sim = ok.body.simulation;
    check('方案冻结审查与清单信息',
      ok.body.reviewId === reviewId && ok.body.voyageId === vid && ok.body.manifestRevision === 1);
    const sha = sim.portResults[0];
    check('SHA 实际卸 BOX-1、BOX-4（暂存后自动卸）',
      JSON.stringify(sha.discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-1', 'BOX-4']));
    check('SHA 倒箱 2 次（两次暂存）', sha.restows === 2);
    check('SHA 操作后箱位：BOX-3@(1,1,0)、BOX-2@(1,1,1)',
      JSON.stringify(sha.placements) === JSON.stringify([
        { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 0 } },
      ]), JSON.stringify(sha.placements));
    const sin = sim.portResults[1];
    check('SIN 港开始卸 BOX-2（自回放层 t1）',
      JSON.stringify(sin.discharged) === JSON.stringify([
        { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 1 } },
      ]));
    const ham = sim.portResults[2];
    check('HAM 卸 BOX-3 后全船卸空',
      ham.discharged.length === 1 && ham.discharged[0].boxNo === 'BOX-3' &&
      ham.placements.length === 0);
    check('总计数：4 箱全卸、倒箱 2 次',
      sim.counts.totalBoxes === 4 && sim.counts.discharged === 4 && sim.counts.restows === 2);

    // ---- 2. 同审查同内容重试 -> 200 replay，返回原结果 ----
    const replay = await http('POST', plansUrl, okBody, 200);
    check('同内容重试 replay=true 且同一 planId',
      replay.body.replay === true && replay.body.planId === ok.body.planId);

    // ---- 3. 不同内容（容量 3）分别留档 ----
    const other = await http('POST', plansUrl, { ...okBody, capacity: 3 }, 201);
    check('不同内容分别留档（新 planId）',
      other.body.replay === false && other.body.planId !== ok.body.planId);

    // ---- 4. 查询：单条 / 按审查 / 按航次 ----
    const one = await http('GET', `${BASE}/restow-plans/${ok.body.planId}`, undefined, 200);
    check('GET 单份方案返回冻结结果',
      one.body.planId === ok.body.planId && one.body.simulation.counts.restows === 2 &&
      one.body.capacity === 2);
    const byReview = await http('GET', plansUrl, undefined, 200);
    check('按审查列出 2 份方案', byReview.body.plans.length === 2);
    const byVoyage = await http('GET', `${BASE}/voyages/${vid}/restow-plans`, undefined, 200);
    check('按航次列出 2 份方案', byVoyage.body.plans.length === 2);

    // ---- 5. 请求级拒绝 ----
    const negCap = await http('POST', plansUrl, { ...okBody, capacity: -1 });
    check('负容量 400 invalid_request_body',
      negCap.status === 400 && negCap.body.error.code === 'invalid_request_body');

    const mismatch = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SIN', operations: [] },
        { port: 'SHA', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('港序不一致 400 invalid_restow_plan / port_order_mismatch',
      mismatch.body.error.code === 'invalid_restow_plan' &&
      mismatch.body.error.details.issues.some((i) => i.reason === 'port_order_mismatch'));

    const badAction = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [{ action: 'move', boxNo: 'BOX-3' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    });
    check('非法操作类型 400 invalid_request_body',
      badAction.status === 400 && badAction.body.error.code === 'invalid_request_body');

    const notTop = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [{ action: 'stash', boxNo: 'BOX-2' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('暂存非列顶箱 400 box_not_column_top',
      notTop.body.error.details.issues.some((i) => i.reason === 'box_not_column_top' && i.boxNo === 'BOX-2'));

    const ghost = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [{ action: 'stash', boxNo: 'GHOST' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('暂存未知箱 400 box_not_aboard',
      ghost.body.error.details.issues.some((i) => i.reason === 'box_not_aboard'));

    const dupStash = await http('POST', plansUrl, {
      capacity: 3,
      ports: [
        {
          port: 'SHA',
          operations: [
            { action: 'stash', boxNo: 'BOX-3' },
            { action: 'restore', boxNo: 'BOX-3' },
            { action: 'stash', boxNo: 'BOX-3' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('同箱重复暂存 400 box_already_restowed',
      dupStash.body.error.details.issues.some((i) => i.reason === 'box_already_restowed'));

    const badRestore = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [{ action: 'restore', boxNo: 'BOX-3' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('回放未暂存箱 400 box_not_stashed',
      badRestore.body.error.details.issues.some((i) => i.reason === 'box_not_stashed'));

    const overCap = await http('POST', plansUrl, {
      capacity: 1,
      ports: [
        {
          port: 'SHA',
          operations: [
            { action: 'stash', boxNo: 'BOX-3' },
            { action: 'stash', boxNo: 'BOX-2' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('容量超限 400 capacity_exceeded',
      overCap.body.error.details.issues.some(
        (i) => i.reason === 'capacity_exceeded' && i.capacity === 1 &&
          JSON.stringify(i.stashedBoxNos) === JSON.stringify(['BOX-3']),
      ));

    const lingering = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [{ action: 'stash', boxNo: 'BOX-3' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 400);
    check('暂存跨港滞留 400 stash_lingering_across_port',
      lingering.body.error.details.issues.some(
        (i) => i.reason === 'stash_lingering_across_port' &&
          JSON.stringify(i.boxNos) === JSON.stringify(['BOX-3']),
      ));

    // ---- 6. 港末本港箱受阻 -> 422 port_boxes_blocked ----
    const blocked = await http('POST', plansUrl, {
      capacity: 2,
      ports: [
        { port: 'SHA', operations: [] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 422);
    check('无操作时 BOX-1 受阻 422 port_boxes_blocked',
      blocked.body.error.code === 'port_boxes_blocked' &&
      blocked.body.error.details.port === 'SHA' &&
      blocked.body.error.details.blocked.length === 1 &&
      blocked.body.error.details.blocked[0].boxNo === 'BOX-1' &&
      blocked.body.error.details.blocked[0].blockers.map((b) => b.boxNo).join(',') === 'BOX-2,BOX-3');

    // ---- 7. 危险品间距：回放降低层高违反 -> 422 restow_safety_violation ----
    const { body: voyage2 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-RESTOW-002',
      bays: 2, rows: 1, tiers: 2,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'X', weight: '500', category: '5' },
        { boxNo: 'B', weight: '500', category: '3' },
        { boxNo: 'A', weight: '500', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 2 }],
    }, 201);
    const vid2 = voyage2.id;
    await http('POST', `${BASE}/voyages/${vid2}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'X', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'A', position: { bay: 2, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid2}/manifests`, { expectedRevision: 1 }, 201);
    const { body: review2 } = await http('POST', `${BASE}/voyages/${vid2}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [
        { boxNo: 'X', dischargePort: 'SHA' },
        { boxNo: 'B', dischargePort: 'SIN' },
        { boxNo: 'A', dischargePort: 'HAM' },
      ],
    }, 201);
    const unsafe = await http('POST', `${BASE}/discharge-reviews/${review2.reviewId}/restow-plans`, {
      capacity: 1,
      ports: [
        {
          port: 'SHA',
          operations: [
            { action: 'stash', boxNo: 'B' },
            { action: 'restore', boxNo: 'B' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    }, 422);
    check('回放后危险品间距不足 422 restow_safety_violation',
      unsafe.body.error.code === 'restow_safety_violation' &&
      unsafe.body.error.details.opIndex === 2 &&
      unsafe.body.error.details.violations.length === 1 &&
      unsafe.body.error.details.violations[0].reason === 'incompatible_too_close' &&
      unsafe.body.error.details.violations[0].distance === 1 &&
      unsafe.body.error.details.violations[0].minDistance === 2,
      JSON.stringify(unsafe.body.error.details));

    // ---- 8. 拒绝不留档：列表仍只有 2 份方案 ----
    const afterReject = await http('GET', plansUrl, undefined, 200);
    check('全部拒绝均不留档（仍 2 份方案）', afterReject.body.plans.length === 2);
    const voyage2Plans = await http('GET', `${BASE}/voyages/${vid2}/restow-plans`, undefined, 200);
    check('安全约束违反的航次 0 份方案', voyage2Plans.body.plans.length === 0);

    // ---- 9. 404 / 400 ----
    const otherId = '00000000-0000-0000-0000-000000000000';
    const noReview = await http('POST', `${BASE}/discharge-reviews/${otherId}/restow-plans`, okBody);
    check('未知审查 404 discharge_review_not_found',
      noReview.status === 404 && noReview.body.error.code === 'discharge_review_not_found');
    const badReviewId = await http('POST', `${BASE}/discharge-reviews/not-a-uuid/restow-plans`, okBody);
    check('审查 ID 非法 400 invalid_discharge_review_id',
      badReviewId.status === 400 && badReviewId.body.error.code === 'invalid_discharge_review_id');
    const noPlan = await http('GET', `${BASE}/restow-plans/${otherId}`, undefined);
    check('未知方案 404 restow_plan_not_found',
      noPlan.status === 404 && noPlan.body.error.code === 'restow_plan_not_found');
    const badPlanId = await http('GET', `${BASE}/restow-plans/not-a-uuid`, undefined);
    check('方案 ID 非法 400 invalid_restow_plan_id',
      badPlanId.status === 400 && badPlanId.body.error.code === 'invalid_restow_plan_id');
    const noVoyagePlans = await http('GET', `${BASE}/voyages/${otherId}/restow-plans`, undefined);
    check('未知航次列表 404 voyage_not_found',
      noVoyagePlans.status === 404 && noVoyagePlans.body.error.code === 'voyage_not_found');
    const noReviewPlans = await http('GET', `${BASE}/discharge-reviews/${otherId}/restow-plans`, undefined);
    check('未知审查列表 404 discharge_review_not_found',
      noReviewPlans.status === 404 && noReviewPlans.body.error.code === 'discharge_review_not_found');

    // ---- 10. 并发同内容提交：一方 201、一方 200 replay，同一 planId ----
    const concurrentBody = { ...okBody, capacity: 4 };
    const rs = await Promise.all([
      http('POST', plansUrl, concurrentBody),
      http('POST', plansUrl, concurrentBody),
    ]);
    const statuses = rs.map((r) => r.status).sort();
    check('并发同内容：一方 201、一方 200',
      JSON.stringify(statuses) === JSON.stringify([200, 201]), JSON.stringify(statuses));
    check('并发同内容：同一 planId',
      rs[0].body.planId === rs[1].body.planId && !!rs[0].body.planId);

    // ---- 11. 冻结：航次改位 + 约束更新 + 签发新清单，不回写已冻结方案 ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '8000',
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 }, 201);
    const frozen = await http('GET', `${BASE}/restow-plans/${ok.body.planId}`, undefined, 200);
    check('航次改位/约束更新/新清单后，已冻结方案结果不变',
      frozen.body.manifestRevision === 1 &&
      JSON.stringify(frozen.body.simulation) === JSON.stringify(sim));
    const finalList = await http('GET', plansUrl, undefined, 200);
    check('方案列表最终 3 份（含并发留档 1 份）', finalList.body.plans.length === 3);

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
