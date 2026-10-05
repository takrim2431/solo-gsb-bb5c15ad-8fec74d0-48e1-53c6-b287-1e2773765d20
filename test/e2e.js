/* eslint-disable no-console */
// 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: node test/e2e.js
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
    databaseDir: path.join('/tmp', 'pgdata-e2e'),
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
    // ---- 1. 登记航次 ----
    const createBody = {
      voyageNo: 'V-E2E-001',
      bays: 4, rows: 2, tiers: 3,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      boxes: [
        { boxNo: 'BOX-1', weight: '500', category: '1' },
        { boxNo: 'BOX-2', weight: '600', category: '3' },
        { boxNo: 'BOX-3', weight: '400', category: '5' },
        { boxNo: 'BOX-4', weight: '300.5', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    };
    const { body: voyage } = await http('POST', `${BASE}/voyages`, createBody, 201);
    check('航次创建返回 revision=0', voyage.revision === 0);
    const vid = voyage.id;

    // 重复航次号
    const dup = await http('POST', `${BASE}/voyages`, createBody);
    check('重复航次号 400', dup.status === 400 && dup.body.error.code === 'voyage_no_exists');

    // 非法重量
    const badWeight = await http('POST', `${BASE}/voyages`, { ...createBody, voyageNo: 'V-X', defaultColumnWeightLimit: '-1' });
    check('非法重量 400', badWeight.status === 400);

    // ---- 2. 初始布局 ----
    let layout = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('初始无配位，4 个箱未配位', layout.placements.length === 0 && layout.unplacedBoxNos.length === 4);

    // ---- 3. 请求级错误 ----
    const unknownBox = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'GHOST', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('未知箱 400 unknown_box', unknownBox.status === 400 &&
      unknownBox.body.error.details.issues.some((i) => i.reason === 'unknown_box'));

    const badCoord = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'BOX-1', position: { bay: 9, row: 1, tier: 0 } }],
    });
    check('无效坐标 400 invalid_coordinates', badCoord.status === 400 &&
      badCoord.body.error.details.issues.some((i) => i.reason === 'invalid_coordinates'));

    const dupInBatch = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
      ],
    });
    check('同批重复箱号 400', dupInBatch.status === 400 &&
      dupInBatch.body.error.details.issues.some((i) => i.reason === 'duplicate_box_in_batch'));

    const stale = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 42,
      moves: [{ boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('过期修订号 409 stale_revision', stale.status === 409 && stale.body.error.code === 'stale_revision');

    // ---- 4. 不相容距离不足 -> 整批拒绝，布局不变 ----
    const tooClose = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }, // cat 1
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } }, // cat 3, 距离 1 < 3
      ],
    });
    check('不相容过近 422', tooClose.status === 422 && tooClose.body.error.code === 'validation_failed');
    const v0 = tooClose.body.error.details.violations[0];
    check('违反含两箱箱号与舱位', v0.boxA === 'BOX-1' && v0.boxB === 'BOX-2' && v0.distance === 1 && v0.minDistance === 3);
    layout = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('拒绝后修订号与布局不变', layout.revision === 0 && layout.placements.length === 0);

    // ---- 5. 列超重 -> 拒绝（列 1/1 上限 1200，500+600 中 600 是 cat3，换合法距离测试）----
    const overweight = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }, // 500
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 1 } }, // 300.5 => 800.5 ok
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 2 } }, // 400 => 1200.5 > 1200
      ],
    });
    check('列超重 422 column_overweight', overweight.status === 422 &&
      overweight.body.error.details.violations.some((x) => x.reason === 'column_overweight' && x.totalWeight === '1200.5'));

    // ---- 6. 悬空 -> 拒绝 ----
    const floating = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'BOX-3', position: { bay: 3, row: 2, tier: 1 } }],
    });
    check('悬空堆箱 422 column_not_continuous', floating.status === 422 &&
      floating.body.error.details.violations.some((x) => x.reason === 'column_not_continuous'));

    // ---- 7. 合法第一批：rev 0 -> 1 ----
    const r1 = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 4, row: 2, tier: 0 } }, // cat3 距 BOX1: |3|+1 = 4 >= 3
      ],
    }, 200);
    check('合法批次接受 revision=1', r1.body.revision === 1);

    // ---- 8. 同批交换：rev1 中 1->(1,1,0) 2->(4,2,0)，交换到对方位置（仅算最终布局）----
    const exchange = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 4, row: 2, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 0 } },
      ],
    }, 200);
    check('同批交换接受 revision=2', exchange.body.revision === 2);
    const p1 = exchange.body.layout.placements.find((p) => p.boxNo === 'BOX-1').position;
    check('交换后 BOX-1 在原 BOX-2 位', p1.bay === 4 && p1.row === 2 && p1.tier === 0);

    // ---- 9. 撤位（留空）----
    const unplace = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'BOX-1', position: null }],
    }, 200);
    check('撤位接受 revision=3', unplace.body.revision === 3 &&
      unplace.body.layout.unplacedBoxNos.includes('BOX-1'));

    // 历史修订号可查
    const oldLayout = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=1`, undefined, 200)).body;
    check('历史布局 rev=1 可查', oldLayout.revision === 1 && oldLayout.current === false);

    // ---- 10. 未全部配位不能签发 ----
    const issueFail = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 });
    check('未全配位签发 422 unplaced_boxes', issueFail.status === 422 &&
      issueFail.body.error.code === 'unplaced_boxes');

    // 过期修订号签发
    const issueStale = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 });
    check('过期修订号签发 409', issueStale.status === 409);

    // 全部配位: rev 3 -> 4
    const finalize = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 3,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } }, // cat1 距 BOX2(cat3 @1,1,0)=1 <3? 太近
      ],
    });
    check('最终配位距离不足仍拒绝', finalize.status === 422);

    const finalize2 = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 3,
      moves: [
        // BOX-2 当前在 (1,1,0) cat3; BOX-3 未放; BOX-4 未放; BOX-1 未放
        { boxNo: 'BOX-2', position: { bay: 4, row: 1, tier: 0 } }, // cat3
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }, // cat1 距 |3|=3 ok
        { boxNo: 'BOX-4', position: { bay: 2, row: 1, tier: 0 } }, // cat1 距 cat3: |2|=2 <3 太近
      ],
    });
    check('三箱中一对太近整批拒绝', finalize2.status === 422 &&
      finalize2.body.error.details.violations.every((x) => x.reason === 'incompatible_too_close'));

    const finalize3 = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 3,
      moves: [
        { boxNo: 'BOX-2', position: { bay: 4, row: 1, tier: 0 } }, // cat3
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }, // cat1 d=3 ok
        { boxNo: 'BOX-4', position: { bay: 1, row: 2, tier: 0 } }, // cat1 距 cat3: 3+1=4 ok
        { boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } }, // cat5 相容
      ],
    }, 200);
    check('全部配位 revision=4', finalize3.body.revision === 4 &&
      finalize3.body.layout.unplacedBoxNos.length === 0);

    // ---- 11. 签发冻结 rev=4 ----
    const manifest = (await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 4 })).body;
    check('签发成功 4 箱 current=true', manifest.boxCount === 4 && manifest.current === true);

    // 幂等重复签发
    const again = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 4 });
    check('同修订号重复签发幂等 200', again.status === 200);

    // ---- 12. 签发后调整 -> rev5，旧清单保留且 current=false ----
    const adjust = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 4,
      moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } }], // 原位不变的空操作批
    }, 200);
    check('签发后调整生成 revision=5', adjust.body.revision === 5);

    const manifests = (await http('GET', `${BASE}/voyages/${vid}/manifests`, undefined, 200)).body;
    check('旧清单保留且标记 current=false', manifests.length === 1 &&
      manifests[0].revision === 4 && manifests[0].current === false);

    const oldManifest = (await http('GET', `${BASE}/voyages/${vid}/manifests/4`, undefined, 200)).body;
    check('旧清单内容冻结仍可取', oldManifest.boxCount === 4 && oldManifest.items.length === 4 &&
      oldManifest.current === false);

    // 不能拿旧修订号签发
    const staleIssue = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 4 });
    check('当前已到 rev5，持 rev4 签发被拒 409', staleIssue.status === 409);

    // ---- 13. 并发：两批同 baseRevision 只有一个成功 ----
    const payload = {
      baseRevision: 5,
      moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } }],
    };
    const [c1, c2] = await Promise.all([
      http('POST', `${BASE}/voyages/${vid}/moves`, payload),
      http('POST', `${BASE}/voyages/${vid}/moves`, payload),
    ]);
    const statuses = [c1.status, c2.status].sort();
    check('并发同修订号：一个 200 一个 409', statuses[0] === 200 && statuses[1] === 409,
      JSON.stringify(statuses));

    // ---- 14. 并发：调整与签发交错，当前清单永不指向过期布局 ----
    // 当前 rev=6。同时：签发(6) 与 调整(6->7)
    const [issue, move] = await Promise.all([
      http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 6 }),
      http('POST', `${BASE}/voyages/${vid}/moves`, {
        baseRevision: 6,
        moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } }],
      }),
    ]);
    check('并发签发+调整：状态为 (201/200, 200)', [200, 201].includes(issue.status) && move.status === 200,
      `issue=${issue.status} move=${move.status}`);
    const after = (await http('GET', `${BASE}/voyages/${vid}/manifests`, undefined, 200)).body;
    if (issue.status === 200 || issue.status === 201) {
      // 若签发成功，它必冻结 rev6；随后 rev7 成为当前，清单 current 应为 false
      const rev6 = after.find((m) => m.revision === 6);
      check('并发后 rev6 清单存在且不被误标为当前（当前=rev7）',
        !!rev6 && rev6.current === false, JSON.stringify(after.map((m) => ({ r: m.revision, c: m.current }))));
    }
    const currentRev = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body.revision;
    check('当前修订号为 7', currentRev === 7);
    // 任何 current=true 的清单必须冻结在当前修订号
    check('不存在指向过期布局的当前清单',
      after.every((m) => (m.current ? m.revision === currentRev : true)));

    // 404
    const nf = await http('GET', `${BASE}/voyages/00000000-0000-0000-0000-000000000000/layout`);
    check('未知航次 404', nf.status === 404);

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
