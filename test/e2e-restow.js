/* eslint-disable no-console */
// 逐港倒箱作业方案 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-restow.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30200;
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
    port: 54400,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54400/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：2 bay × 1 row × 3 tier；列1 三层 BOX-1/2/3，列2 BOX-4 ----
    // 配载：列1 自底向上 BOX-1(t0)、BOX-2(t1)、BOX-3(t2)；列2 BOX-4(t0)
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

    // 卸货审查（不可行：BOX-1(SHA) 被 BOX-2(SIN)/BOX-3(HAM) 压住；BOX-4=SHA 列2列顶可卸）
    const review = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [
        { boxNo: 'BOX-1', dischargePort: 'SHA' },
        { boxNo: 'BOX-2', dischargePort: 'SIN' },
        { boxNo: 'BOX-3', dischargePort: 'HAM' },
        { boxNo: 'BOX-4', dischargePort: 'SHA' },
      ],
    }, 201);
    const rid = review.body.reviewId;
    check('前置：卸货审查 feasibleWithoutRestow=false',
      review.body.simulation.feasibleWithoutRestow === false);
    const plansUrl = `${BASE}/discharge-reviews/${rid}/restow-plans`;

    // ---- 1. 成功倒箱方案：SHA 暂存 BOX-3、BOX-2（各一次，容量2）露出 BOX-1，
    //      回放时先放远港箱 BOX-3(HAM) 落 t0、再放近港箱 BOX-2(SIN) 落 t1，
    //      使近港箱回到列顶，后续 SIN/HAM 无需再倒箱（每箱至多暂存一次）----
    // SHA 开始：列1 列顶 BOX-3(HAM) 非本港；列2 BOX-4(SHA) 自动卸。
    // 暂存 BOX-3 -> 列顶 BOX-2(SIN) 非本港；暂存 BOX-2 -> BOX-1(SHA) 露顶卸。
    // 回放 BOX-3（落 t0）、回放 BOX-2（落 t1）。SHA 港末：BOX-3(t0,HAM)、BOX-2(t1,SIN)。
    // SIN 开始：列顶 BOX-2(SIN) 自动卸 -> 列顶 BOX-3(HAM) 非本港，BOX-3 留船。
    // HAM 开始：BOX-3 列顶自动卸。全程每箱仅暂存一次，共 2 次倒箱，4 箱全卸。
    const goodPlan = {
      temporaryCapacity: 2,
      portPlans: [
        {
          port: 'SHA',
          operations: [
            { op: 'stage', boxNo: 'BOX-3' },
            { op: 'stage', boxNo: 'BOX-2' },
            { op: 'replay', boxNo: 'BOX-3' },
            { op: 'replay', boxNo: 'BOX-2' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    };
    const good = await http('POST', plansUrl, goodPlan, 201);
    check('成功方案 201 且 replay=false', good.body.replay === false && !!good.body.planId);
    const sim = good.body.simulation;
    const sha = sim.portResults[0];
    check('SHA 初始自动卸 BOX-4（另一列列顶）',
      JSON.stringify(sha.initialDischarged.map((d) => d.boxNo)) === JSON.stringify(['BOX-4']));
    check('SHA step1 暂存 BOX-3 无连锁卸（列顶变 BOX-2 SIN）',
      sha.steps[0].op === 'stage' && sha.steps[0].discharged.length === 0 &&
      JSON.stringify(sha.steps[0].stagedBoxNos) === JSON.stringify(['BOX-3']));
    check('SHA step2 暂存 BOX-2 连锁卸 BOX-1',
      JSON.stringify(sha.steps[1].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-1']) &&
      JSON.stringify(sha.steps[1].stagedBoxNos) === JSON.stringify(['BOX-3', 'BOX-2']));
    check('SHA step3 回放 BOX-3 落 t0，step4 回放 BOX-2 落 t1（近港箱回列顶）',
      sha.steps[2].position.tier === 0 && sha.steps[3].position.tier === 1 &&
      sha.steps[3].stagedBoxNos.length === 0);
    check('SHA 实际卸 BOX-1、BOX-4，倒箱 2 次',
      JSON.stringify(sha.discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-1', 'BOX-4']) &&
      sha.restowCount === 2);
    check('SHA 港末在船 BOX-3(t0,HAM)、BOX-2(t1,SIN)',
      JSON.stringify(sha.aboardAfterPort.map((b) => [b.boxNo, b.position.tier])) ===
      JSON.stringify([['BOX-2', 1], ['BOX-3', 0]]));

    const sin = sim.portResults[1];
    check('SIN 初始自动卸列顶 BOX-2，无操作、无倒箱',
      JSON.stringify(sin.initialDischarged.map((d) => d.boxNo)) === JSON.stringify(['BOX-2']) &&
      sin.steps.length === 0 && sin.restowCount === 0 &&
      JSON.stringify(sin.aboardAfterPort.map((b) => b.boxNo)) === JSON.stringify(['BOX-3']));
    const ham = sim.portResults[2];
    check('HAM 初始自动卸 BOX-3，港末船空',
      JSON.stringify(ham.initialDischarged.map((d) => d.boxNo)) === JSON.stringify(['BOX-3']) &&
      ham.aboardAfterPort.length === 0);
    check('全程 4 箱卸完、倒箱合计 2 次',
      sim.counts.discharged === 4 && sim.counts.restows === 2);

    // ---- 2. 同内容重试 -> 200 replay，返回原 planId ----
    const replay = await http('POST', plansUrl, goodPlan, 200);
    check('同内容重试 replay=true 且同一 planId',
      replay.body.replay === true && replay.body.planId === good.body.planId);
    const goodPlanId = good.body.planId;

    // ---- 3. 不同内容分别留档（容量不同/操作不同）----
    // 容量 1：SHA 只能暂存 BOX-3（容量占满），露出的列顶是 BOX-2(SIN，非本港)，BOX-1(SHA)
    // 仍被 BOX-2 压住；回放 BOX-3（落回列顶 BOX-2 之上 t2）恢复原状。SHA 港末 BOX-1 受阻 -> 拒绝。
    const cap1 = await http('POST', plansUrl, {
      temporaryCapacity: 1,
      portPlans: [
        {
          port: 'SHA',
          operations: [
            { op: 'stage', boxNo: 'BOX-3' },
            { op: 'replay', boxNo: 'BOX-3' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    });
    check('容量1 无法同时挪开两个压箱：422 restow_plan_rejected / port_boxes_blocked（BOX-1）',
      cap1.status === 422 && cap1.body.error.code === 'restow_plan_rejected' &&
      cap1.body.error.details.reason === 'port_boxes_blocked' &&
      JSON.stringify(cap1.body.error.details.blocked.map((b) => b.boxNo)) === JSON.stringify(['BOX-1']),
      JSON.stringify(cap1.body?.error));

    // 容量不足（容量1 却同帧连续暂存两个）-> 第二次暂存拒绝
    const capOver = await http('POST', plansUrl, {
      temporaryCapacity: 1,
      portPlans: [
        {
          port: 'SHA',
          operations: [
            { op: 'stage', boxNo: 'BOX-3' },
            { op: 'stage', boxNo: 'BOX-2' },
          ],
        },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    });
    check('超容量 422 temporary_capacity_exceeded（相关箱号 BOX-2）',
      capOver.status === 422 && capOver.body.error.details.reason === 'temporary_capacity_exceeded' &&
      capOver.body.error.details.boxNo === 'BOX-2');

    // ---- 4. 各类非法操作 422 ----
    const rejectCase = async (name, portPlans, reason, boxNo) => {
      const r = await http('POST', plansUrl, { temporaryCapacity: 2, portPlans });
      const ok = r.status === 422 && r.body.error.code === 'restow_plan_rejected' &&
        r.body.error.details.reason === reason &&
        (boxNo === undefined || r.body.error.details.boxNo === boxNo);
      check(name, ok, JSON.stringify(r.body?.error));
    };
    const emptyPorts = [
      { port: 'SHA', operations: [] }, { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] },
    ];

    // 暂存非列顶：SHA 开始列顶是 BOX-3，直接暂存 BOX-2
    await rejectCase(
      '暂存非列顶 422 stage_box_not_column_top（BOX-2，列顶 BOX-3）',
      [{ port: 'SHA', operations: [{ op: 'stage', boxNo: 'BOX-2' }] },
        { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] }],
      'stage_box_not_column_top', 'BOX-2',
    );

    // 暂存本港列顶（BOX-4 列2 列顶 SHA 本港，港开始自动卸走）-> 不在船
    await rejectCase(
      '暂存已被自动卸走的本港列顶箱 422 stage_box_not_aboard（BOX-4）',
      [{ port: 'SHA', operations: [{ op: 'stage', boxNo: 'BOX-4' }] },
        { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] }],
      'stage_box_not_aboard', 'BOX-4',
    );

    // 同箱重复暂存（回放后再暂存）
    await rejectCase(
      '同箱重复暂存 422 box_already_staged（BOX-3）',
      [{
        port: 'SHA',
        operations: [
          { op: 'stage', boxNo: 'BOX-3' }, { op: 'replay', boxNo: 'BOX-3' },
          { op: 'stage', boxNo: 'BOX-3' },
        ],
      }, { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] }],
      'box_already_staged', 'BOX-3',
    );

    // 回放未暂存箱
    await rejectCase(
      '回放未暂存箱 422 replay_box_not_staged（BOX-1）',
      [{ port: 'SHA', operations: [{ op: 'replay', boxNo: 'BOX-1' }] },
        { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] }],
      'replay_box_not_staged', 'BOX-1',
    );

    // 港末暂存箱未回放（跨港滞留）
    const leftOver = await http('POST', plansUrl, {
      temporaryCapacity: 2,
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'BOX-3' }, { op: 'stage', boxNo: 'BOX-2' }] },
        { port: 'SIN', operations: [] },
        { port: 'HAM', operations: [] },
      ],
    });
    check('港末暂存箱未回放 422 staged_boxes_left_at_port_end（BOX-2、BOX-3）',
      leftOver.status === 422 &&
      leftOver.body.error.details.reason === 'staged_boxes_left_at_port_end' &&
      JSON.stringify(leftOver.body.error.details.stagedBoxNos) === JSON.stringify(['BOX-3', 'BOX-2']),
      JSON.stringify(leftOver.body?.error));

    // 拒绝不留档：列表仍只有 1 条成功方案
    const listAfterReject = await http('GET', plansUrl, undefined, 200);
    check('所有拒绝均不留档：列表仅 1 条成功方案', listAfterReject.body.plans.length === 1);

    // ---- 5. 结构级 400 ----
    const badPortOrder = await http('POST', plansUrl, {
      temporaryCapacity: 2,
      portPlans: [
        { port: 'SIN', operations: [] }, { port: 'SHA', operations: [] }, { port: 'HAM', operations: [] },
      ],
    });
    check('港序与审查不一致 400 invalid_restow_request / port_order_mismatch',
      badPortOrder.status === 400 && badPortOrder.body.error.code === 'invalid_restow_request' &&
      badPortOrder.body.error.details.issues.some((i) => i.reason === 'port_order_mismatch'));

    const unknownBox = await http('POST', plansUrl, {
      temporaryCapacity: 2,
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'GHOST' }] },
        { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] },
      ],
    });
    check('清单外箱号 400 unknown_box',
      unknownBox.status === 400 &&
      unknownBox.body.error.details.issues.some((i) => i.reason === 'unknown_box'));

    const missingPort = await http('POST', plansUrl, {
      temporaryCapacity: 2,
      portPlans: [{ port: 'SHA', operations: [] }, { port: 'SIN', operations: [] }],
    });
    check('港序缺港 400 port_order_mismatch',
      missingPort.status === 400 &&
      missingPort.body.error.details.issues.some((i) => i.reason === 'port_order_mismatch'));

    const badOp = await http('POST', plansUrl, {
      temporaryCapacity: 2,
      portPlans: [
        { port: 'SHA', operations: [{ op: 'teleport', boxNo: 'BOX-3' }] },
        { port: 'SIN', operations: [] }, { port: 'HAM', operations: [] },
      ],
    });
    check('非法操作类型 -> zod 400 invalid_request_body',
      badOp.status === 400 && badOp.body.error.code === 'invalid_request_body');

    const negCap = await http('POST', plansUrl, {
      temporaryCapacity: -1,
      portPlans: emptyPorts,
    });
    check('负容量 -> zod 400 invalid_request_body',
      negCap.status === 400 && negCap.body.error.code === 'invalid_request_body');

    // ---- 6. 404 ----
    const otherId = '00000000-0000-0000-0000-000000000000';
    const noReview = await http('POST', `${BASE}/discharge-reviews/${otherId}/restow-plans`, {
      temporaryCapacity: 1, portPlans: emptyPorts,
    });
    check('未知审查 404 discharge_review_not_found',
      noReview.status === 404 && noReview.body.error.code === 'discharge_review_not_found');
    const noPlan = await http('GET', `${BASE}/restow-plans/${otherId}`, undefined);
    check('未知方案 404 restow_plan_not_found',
      noPlan.status === 404 && noPlan.body.error.code === 'restow_plan_not_found');

    // ---- 7. 单条查询冻结结果 ----
    const one = await http('GET', `${BASE}/restow-plans/${goodPlanId}`, undefined, 200);
    check('GET 方案返回冻结模拟结果',
      one.body.simulation.counts.restows === 2 && one.body.manifestRevision === 1 &&
      one.body.temporaryCapacity === 2);

    // ---- 8. 冻结不回写：航次改位 + 约束更新 + 签发新清单后，旧方案结果不变 ----
    await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 2 }],
    }, 200);
    // 合法改位（同批交换，最终布局列连续）：BOX-3 -> 列2 t0、BOX-4 -> 列1 t2
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 2,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 2 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 }, 201);
    const frozen = await http('GET', `${BASE}/restow-plans/${goodPlanId}`, undefined, 200);
    check('改位/约束更新/新清单后旧方案不变（仍 2 倒箱、4 卸箱、清单 rev=1）',
      frozen.body.simulation.counts.restows === 2 &&
      frozen.body.simulation.counts.discharged === 4 &&
      frozen.body.manifestRevision === 1);

    // ---- 9. 危险品间距：构造回放后违规被拒（另起航次/清单/审查）----
    // 4 层栈列1(bay1)：A(cat1,SHA,t0)、P(cat5,SIN,t1)、Q(cat5,SIN,t2)、B(cat3,SIN,t3 列顶)；
    // 列3(bay3)：C(cat1,SIN,t0)。cat5 与 cat1/cat3 均相容（不设规则）。
    // 初始 B(1,1,3) 与 C(3,1,0) 距离 5>=3 合规；A(cat1,t0) 与 B(cat3,t3) 距离 3 合规。
    // SHA：暂存 B、Q、P（容量3）露出 A 卸；先回放 B 落 t0 -> B(1,1,0) 与 C(3,1,0) 距离 2<3 拒绝。
    const { body: v2 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-RESTOW-002',
      bays: 3, rows: 1, tiers: 4,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'A', weight: '100', category: '1' },
        { boxNo: 'P', weight: '100', category: '5' },
        { boxNo: 'Q', weight: '100', category: '5' },
        { boxNo: 'B', weight: '100', category: '3' },
        { boxNo: 'C', weight: '100', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    await http('POST', `${BASE}/voyages/${v2.id}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'A', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'P', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'Q', position: { bay: 1, row: 1, tier: 2 } },
        { boxNo: 'B', position: { bay: 1, row: 1, tier: 3 } },
        { boxNo: 'C', position: { bay: 3, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${v2.id}/manifests`, { expectedRevision: 1 }, 201);
    const rev2 = await http('POST', `${BASE}/voyages/${v2.id}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN'],
      items: [
        { boxNo: 'A', dischargePort: 'SHA' },
        { boxNo: 'P', dischargePort: 'SIN' },
        { boxNo: 'Q', dischargePort: 'SIN' },
        { boxNo: 'B', dischargePort: 'SIN' },
        { boxNo: 'C', dischargePort: 'SIN' },
      ],
    }, 201);
    const unsafe = await http('POST', `${BASE}/discharge-reviews/${rev2.body.reviewId}/restow-plans`, {
      temporaryCapacity: 3,
      portPlans: [
        {
          port: 'SHA',
          operations: [
            { op: 'stage', boxNo: 'B' },
            { op: 'stage', boxNo: 'Q' },
            { op: 'stage', boxNo: 'P' },
            { op: 'replay', boxNo: 'B' }, // 落 t0，与 C 距离 2<3
          ],
        },
        { port: 'SIN', operations: [] },
      ],
    });
    check('回放后危险品间距不足 422 safety_constraint_violated（violations 含 B/C）',
      unsafe.status === 422 &&
      unsafe.body.error.details.reason === 'safety_constraint_violated' &&
      unsafe.body.error.details.boxNo === 'B' &&
      unsafe.body.error.details.violations.some(
        (x) => x.reason === 'incompatible_too_close' &&
          [x.boxA, x.boxB].sort().join(',') === ['B', 'C'].sort().join(',')),
      JSON.stringify(unsafe.body?.error));

    // 安全对照：C 放 bay4，B 落 t0 后距离 3 合规；按 B、P、Q 顺序回放，SIN 连锁卸空 -> 成功
    const { body: v3 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-RESTOW-003',
      bays: 4, rows: 1, tiers: 4,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'A', weight: '100', category: '1' },
        { boxNo: 'P', weight: '100', category: '5' },
        { boxNo: 'Q', weight: '100', category: '5' },
        { boxNo: 'B', weight: '100', category: '3' },
        { boxNo: 'C', weight: '100', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    await http('POST', `${BASE}/voyages/${v3.id}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'A', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'P', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'Q', position: { bay: 1, row: 1, tier: 2 } },
        { boxNo: 'B', position: { bay: 1, row: 1, tier: 3 } },
        { boxNo: 'C', position: { bay: 4, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${v3.id}/manifests`, { expectedRevision: 1 }, 201);
    const rev3 = await http('POST', `${BASE}/voyages/${v3.id}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN'],
      items: [
        { boxNo: 'A', dischargePort: 'SHA' },
        { boxNo: 'P', dischargePort: 'SIN' },
        { boxNo: 'Q', dischargePort: 'SIN' },
        { boxNo: 'B', dischargePort: 'SIN' },
        { boxNo: 'C', dischargePort: 'SIN' },
      ],
    }, 201);
    const safe = await http('POST', `${BASE}/discharge-reviews/${rev3.body.reviewId}/restow-plans`, {
      temporaryCapacity: 3,
      portPlans: [
        {
          port: 'SHA',
          operations: [
            { op: 'stage', boxNo: 'B' },
            { op: 'stage', boxNo: 'Q' },
            { op: 'stage', boxNo: 'P' },
            { op: 'replay', boxNo: 'B' },
            { op: 'replay', boxNo: 'P' },
            { op: 'replay', boxNo: 'Q' },
          ],
        },
        { port: 'SIN', operations: [] },
      ],
    }, 201);
    check('间距足够时同方案成功 201（5 箱卸完、倒箱 3，SIN 连锁卸 B/P/Q/C）',
      safe.body.simulation.counts.discharged === 5 &&
      safe.body.simulation.counts.restows === 3);

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
