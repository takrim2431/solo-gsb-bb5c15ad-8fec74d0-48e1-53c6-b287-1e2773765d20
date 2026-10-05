/* eslint-disable no-console */
// 港序卸货审查 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-discharge.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30199;
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
    databaseDir: path.join('/tmp', 'pgdata-e2e-discharge'),
    user: 'stowage',
    password: 'stowage',
    port: 54399,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54399/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：登记航次（2 bay × 1 row × 3 tier）+ 配载 rev1 + 签发 rev1 ----
    // 列 (bay=1,row=1) 自底向上：BOX-1(tier0)、BOX-2(tier1)、BOX-3(tier2)
    // 列 (bay=2,row=1)：BOX-4(tier0)
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-DISCHARGE-001',
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

    const reviewUrl = `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`;

    // ---- 1. 可全程不倒箱：列顶先卸、连锁卸空 ----
    // 列1：BOX-3=SHA 列顶；BOX-2、BOX-1=SIN；列2：BOX-4=HAM
    const okBody = {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [
        { boxNo: 'BOX-1', dischargePort: 'SIN' },
        { boxNo: 'BOX-2', dischargePort: 'SIN' },
        { boxNo: 'BOX-3', dischargePort: 'SHA' },
        { boxNo: 'BOX-4', dischargePort: 'HAM' },
      ],
    };
    const ok = await http('POST', reviewUrl, okBody, 201);
    check('可行方案 201 且 replay=false', ok.body.replay === false && !!ok.body.reviewId);
    const sim = ok.body.simulation;
    check('feasibleWithoutRestow=true', sim.feasibleWithoutRestow === true);
    check(
      'SHA 仅卸列顶 BOX-3',
      JSON.stringify(sim.portResults[0].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-3']),
    );
    check(
      'SIN 连锁卸下 BOX-1、BOX-2（按箱号排序）',
      JSON.stringify(sim.portResults[1].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-1', 'BOX-2']),
    );
    check(
      'HAM 卸 BOX-4',
      JSON.stringify(sim.portResults[2].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-4']),
    );
    check('全程无受阻、无逾港', sim.counts.blockedAtOwnPort === 0 && sim.counts.overCarried === 0);

    // ---- 2. 同内容重复提交 -> 200 replay，返回首次结果 ----
    const replay = await http('POST', reviewUrl, okBody, 200);
    check('同内容重复提交 replay=true 且同一 reviewId',
      replay.body.replay === true && replay.body.reviewId === ok.body.reviewId);

    // ---- 3. 不可行：BOX-1(SHA) 被 BOX-2(SIN)、BOX-3(HAM) 压住 ----
    const bad = await http('POST', reviewUrl, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [
        { boxNo: 'BOX-1', dischargePort: 'SHA' },
        { boxNo: 'BOX-2', dischargePort: 'SIN' },
        { boxNo: 'BOX-3', dischargePort: 'HAM' },
        { boxNo: 'BOX-4', dischargePort: 'SHA' },
      ],
    }, 201);
    const bsim = bad.body.simulation;
    check('不可行方案 feasibleWithoutRestow=false', bsim.feasibleWithoutRestow === false);
    const sha = bsim.portResults[0];
    check('SHA 实际卸 BOX-4（另一列列顶）',
      JSON.stringify(sha.discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-4']));
    check('SHA 受阻箱 BOX-1',
      sha.blocked.length === 1 && sha.blocked[0].boxNo === 'BOX-1');
    check(
      '阻挡箱自近而远：BOX-2(SIN,later,t1)、BOX-3(HAM,later,t2)',
      sha.blocked[0].blockers.length === 2 &&
        sha.blocked[0].blockers[0].boxNo === 'BOX-2' &&
        sha.blocked[0].blockers[0].dischargePort === 'SIN' &&
        sha.blocked[0].blockers[0].relation === 'later' &&
        sha.blocked[0].blockers[0].position.tier === 1 &&
        sha.blocked[0].blockers[1].boxNo === 'BOX-3' &&
        sha.blocked[0].blockers[1].dischargePort === 'HAM' &&
        sha.blocked[0].blockers[1].relation === 'later' &&
        sha.blocked[0].blockers[1].position.tier === 2,
      JSON.stringify(sha.blocked[0].blockers),
    );
    // SIN：BOX-3(HAM) 压 BOX-2 -> BOX-2 受阻 [BOX-3 later]
    const sin = bsim.portResults[1];
    check('SIN 无可卸且 BOX-2 受阻',
      sin.discharged.length === 0 && sin.blocked.length === 1 && sin.blocked[0].boxNo === 'BOX-2');
    // HAM：BOX-3 卸走后不回补 BOX-1/BOX-2
    const ham = bsim.portResults[2];
    check('HAM 仅卸 BOX-3，不回补此前漏卸箱',
      JSON.stringify(ham.discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-3']));
    check(
      '最终逾港未卸 BOX-1、BOX-2（含应卸港序号）',
      JSON.stringify(bsim.overCarried.map((b) => [b.boxNo, b.dischargePortIndex])) ===
        JSON.stringify([['BOX-1', 1], ['BOX-2', 2]]),
    );
    check('计数一致',
      bsim.counts.totalBoxes === 4 && bsim.counts.discharged === 2 &&
      bsim.counts.blockedAtOwnPort === 2 && bsim.counts.overCarried === 2);

    // 两次审查均独立留档
    const listAll = await http('GET', `${BASE}/voyages/${vid}/discharge-reviews`, undefined, 200);
    check('列表含 2 条审查', listAll.body.reviews.length === 2);
    const byRev = await http(
      'GET',
      `${BASE}/voyages/${vid}/discharge-reviews?manifestRevision=1`,
      undefined,
      200,
    );
    check('按清单修订号过滤仍为 2 条', byRev.body.reviews.length === 2);

    // GET 单条取冻结结果
    const one = await http('GET', `${BASE}/discharge-reviews/${bad.body.reviewId}`, undefined, 200);
    check('GET 审查返回冻结模拟结果',
      one.body.simulation.feasibleWithoutRestow === false &&
      one.body.manifestRevision === 1);

    // ---- 4. 审查结果不可变：签发新清单（rev2 调整布局）后，旧审查仍是原结论 ----
    // rev2 两列均连续：列1 BOX-4(t0)、BOX-3(t1)；列2 BOX-1(t0)、BOX-2(t1)
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 }, 201);
    const oldOne = await http('GET', `${BASE}/discharge-reviews/${bad.body.reviewId}`, undefined, 200);
    check('航次调整并签发新清单后，旧审查结论不变（仍 false、仍 2 逾港）',
      oldOne.body.simulation.feasibleWithoutRestow === false &&
      oldOne.body.simulation.overCarried.length === 2,
      JSON.stringify(oldOne.body.simulation.counts));
    // 列表里两条旧审查仍在
    const listAfter = await http('GET', `${BASE}/voyages/${vid}/discharge-reviews`, undefined, 200);
    check('新清单签发后旧审查仍可列出（2 条）', listAfter.body.reviews.length === 2);

    // ---- 5. 请求级拒绝（400）----
    const emptyPorts = await http('POST', reviewUrl, {
      ports: [],
      items: [{ boxNo: 'BOX-1', dischargePort: 'SHA' }],
    });
    check('空港序：zod 400 invalid_request_body',
      emptyPorts.status === 400 && emptyPorts.body.error.code === 'invalid_request_body');

    const dupPort = await http('POST', reviewUrl, {
      ports: ['SHA', 'SHA'],
      items: okBody.items,
    }, 400);
    check('重复港序 400 invalid_discharge_request',
      dupPort.body.error.code === 'invalid_discharge_request' &&
      dupPort.body.error.details.issues.some((i) => i.reason === 'duplicate_port_in_order'));

    const missingBox = await http('POST', reviewUrl, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: okBody.items.filter((i) => i.boxNo !== 'BOX-1'),
    }, 400);
    check('箱号缺漏 400 manifest_box_missing',
      missingBox.body.error.details.issues.some((i) => i.reason === 'manifest_box_missing'));

    const extraBox = await http('POST', reviewUrl, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [...okBody.items, { boxNo: 'GHOST', dischargePort: 'SHA' }],
    }, 400);
    check('多余箱号 400 unknown_box_for_manifest',
      extraBox.body.error.details.issues.some((i) => i.reason === 'unknown_box_for_manifest'));

    const unknownPort = await http('POST', reviewUrl, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: okBody.items.map((i) => (i.boxNo === 'BOX-1' ? { ...i, dischargePort: 'XXX' } : i)),
    }, 400);
    check('卸港不在列表 400 unknown_discharge_port',
      unknownPort.body.error.details.issues.some((i) => i.reason === 'unknown_discharge_port'));

    const dupBox = await http('POST', reviewUrl, {
      ports: ['SHA', 'SIN', 'HAM'],
      items: [...okBody.items, { boxNo: 'BOX-1', dischargePort: 'HAM' }],
    }, 400);
    check('同箱重复申报 400 duplicate_box_in_request',
      dupBox.body.error.details.issues.some((i) => i.reason === 'duplicate_box_in_request'));

    // ---- 6. 404 ----
    const otherVid = '00000000-0000-0000-0000-000000000000';
    const noVoyage = await http(
      'POST',
      `${BASE}/voyages/${otherVid}/manifests/1/discharge-reviews`,
      okBody,
    );
    check('未知航次 404 voyage_not_found',
      noVoyage.status === 404 && noVoyage.body.error.code === 'voyage_not_found');

    const noManifest = await http('POST', reviewUrl.replace('/manifests/1/', '/manifests/99/'), okBody);
    check('未知清单 404 manifest_not_found',
      noManifest.status === 404 && noManifest.body.error.code === 'manifest_not_found');

    const noReview = await http('GET', `${BASE}/discharge-reviews/${otherVid}`, undefined);
    check('未知审查 404 discharge_review_not_found',
      noReview.status === 404 && noReview.body.error.code === 'discharge_review_not_found');

    // ---- 7. 新清单可独立审查，与旧审查互不影响 ----
    // rev2 布局：列1 BOX-4(SHA,t0)、BOX-3(HAM,t1)；列2 BOX-1(SHA,t0)、BOX-2(SIN,t1)
    // SHA：列2 列顶 BOX-2(SIN) 非本港，BOX-1 受阻；列1 列顶 BOX-3(HAM) 非本港，BOX-4 受阻。
    // SIN：BOX-2 卸（不回补 BOX-1）。HAM：BOX-3 卸（不回补 BOX-4）。最终 BOX-1、BOX-4 逾港。
    const newReview = await http(
      'POST',
      `${BASE}/voyages/${vid}/manifests/2/discharge-reviews`,
      {
        ports: ['SHA', 'SIN', 'HAM'],
        items: [
          { boxNo: 'BOX-1', dischargePort: 'SHA' },
          { boxNo: 'BOX-2', dischargePort: 'SIN' },
          { boxNo: 'BOX-3', dischargePort: 'HAM' },
          { boxNo: 'BOX-4', dischargePort: 'SHA' },
        ],
      },
      201,
    );
    const nsim = newReview.body.simulation;
    check('rev2 新清单独立审查：SHA 无可卸，BOX-1 被 BOX-2(SIN)、BOX-4 被 BOX-3(HAM) 压住',
      nsim.feasibleWithoutRestow === false &&
      nsim.portResults[0].discharged.length === 0 &&
      nsim.portResults[0].blocked.length === 2 &&
      JSON.stringify(nsim.portResults[0].blocked.map((b) => b.boxNo)) === JSON.stringify(['BOX-1', 'BOX-4']) &&
      nsim.portResults[0].blocked[0].blockers[0].boxNo === 'BOX-2' &&
      nsim.portResults[0].blocked[1].blockers[0].boxNo === 'BOX-3');
    check('rev2 审查后：SIN 卸 BOX-2、HAM 卸 BOX-3，最终 BOX-1、BOX-4 逾港',
      JSON.stringify(nsim.portResults[1].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-2']) &&
      JSON.stringify(nsim.portResults[2].discharged.map((d) => d.boxNo)) === JSON.stringify(['BOX-3']) &&
      JSON.stringify(nsim.overCarried.map((b) => b.boxNo)) === JSON.stringify(['BOX-1', 'BOX-4']));
    const finalList = await http('GET', `${BASE}/voyages/${vid}/discharge-reviews`, undefined, 200);
    check('列表最终含 3 条审查（旧审查不被覆盖）', finalList.body.reviews.length === 3);

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
