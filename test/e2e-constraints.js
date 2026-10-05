/* eslint-disable no-console */
// 端到端验证：安全约束变更（乐观修订号 + 全量替换 + 受理前复验当前布局）
//   - 携带所见 baseRevision；过期 -> 409 返回当前修订号
//   - 提交整套默认列承重/按列覆盖/不相容类别对；未列出即撤销；舱位尺寸与箱档案不变
//   - 受理前按新约束复验当前完整布局；违反 -> 422（箱号/位置/原因），规则与修订号不变
//   - 受理后修订号 +1，布局原样继承；历史布局展示当时生效约束
//   - 旧清单 / 在办核对以冻结清单为基准；后续调整与签发使用新约束
// 运行: node test/e2e-constraints.js
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
    databaseDir: path.join('/tmp', 'pgdata-e2e-cstr'),
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
    // ---- 登记：3 bay x 3 row x 2 tier；默认 10000；(1,1) 覆盖 1200；规则 1-3 距离 3 ----
    const createBody = {
      voyageNo: 'V-CSTR-001',
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
    };
    const { body: voyage } = await http('POST', `${BASE}/voyages`, createBody, 201);
    const vid = voyage.id;
    check('登记 revision=0', voyage.revision === 0);

    // ---- 布局 rev=0 -> 1（满足登记约束）----
    // B1(1)@(1,1,0) B4(1)@(1,1,1) 列重 800 <= 1200
    // B2(3)@(3,3,0)；B1(1)@(1,1,0) 距离 |2|+|2|=4 >= 3
    // B3(5)@(2,2,0) 相容
    const place = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
        { boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } },
      ],
    }, 200);
    check('布局接受 revision=1', place.body.revision === 1);

    const posOf = (layout, boxNo) => layout.placements.find((p) => p.boxNo === boxNo).position;

    // ---- 1. 合法约束变更：默认 9000、覆盖改 (2,2)=9999、删 1-3 规则、新增 1-5 距离 2 ----
    // 当前布局在新约束下：列 (2,2) 仅 B3=400<=9999；B1(1)@(1,1) 与 B3(5)@(2,2) 距离 2 达标。
    const okUpdate = {
      baseRevision: 1,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [{ bay: 2, row: 2, weightLimit: '9999' }],
      incompatRules: [{ categoryA: '1', categoryB: '5', minDistance: 2 }],
    };
    const ok = await http('POST', `${BASE}/voyages/${vid}/constraints`, okUpdate);
    check('合法约束变更 200 revision=2', ok.status === 200 && ok.body.revision === 2,
      JSON.stringify(ok.body));
    check('布局原样继承（4 箱位置不变）',
      ok.body.layout.placements.length === 4 &&
      posOf(ok.body.layout, 'B1').tier === 0 && posOf(ok.body.layout, 'B1').bay === 1 &&
      posOf(ok.body.layout, 'B2').bay === 3,
      JSON.stringify(ok.body.layout.placements));
    check('响应标记 constraintsChanged/layoutInherited',
      ok.body.constraintsChanged === true && ok.body.layoutInherited === true);
    check('新默认列承重生效', ok.body.layout.defaultColumnWeightLimit === '9000');
    check('旧覆盖 (1,1) 已撤销，仅剩 (2,2)',
      ok.body.layout.columnWeightLimits.length === 1 &&
      ok.body.layout.columnWeightLimits[0].bay === 2 &&
      ok.body.layout.columnWeightLimits[0].row === 2);
    check('旧类别对 1-3 撤销，仅剩 1-5 距离 2',
      ok.body.layout.incompatRules.length === 1 &&
      ok.body.layout.incompatRules[0].categoryA === '1' &&
      ok.body.layout.incompatRules[0].categoryB === '5' &&
      ok.body.layout.incompatRules[0].minDistance === 2);
    check('舱位尺寸不变',
      ok.body.layout.geometry.bays === 3 &&
      ok.body.layout.geometry.rows === 3 &&
      ok.body.layout.geometry.tiers === 2);
    check('箱档案不变（重量/类别）',
      ok.body.layout.boxes.find((b) => b.boxNo === 'B1').weight === '500' &&
      ok.body.layout.boxes.find((b) => b.boxNo === 'B2').category === '3');

    // ---- 2. 历史布局 rev=1 仍展示当时生效的旧约束（rev=0 同样）----
    const lay1 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=1`, undefined, 200)).body;
    check('历史 rev=1 默认承重仍是旧值 10000', lay1.defaultColumnWeightLimit === '10000');
    check('历史 rev=1 覆盖仍是 (1,1)=1200',
      lay1.columnWeightLimits.length === 1 &&
      lay1.columnWeightLimits[0].bay === 1 && lay1.columnWeightLimits[0].row === 1 &&
      lay1.columnWeightLimits[0].weightLimit === '1200');
    check('历史 rev=1 规则仍是 1-3 距离 3',
      lay1.incompatRules.length === 1 &&
      lay1.incompatRules[0].categoryA === '1' && lay1.incompatRules[0].categoryB === '3');
    const lay0 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=0`, undefined, 200)).body;
    check('历史 rev=0 同样展示登记时约束',
      lay0.defaultColumnWeightLimit === '10000' && lay0.incompatRules[0].categoryB === '3');
    const cur = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('当前布局展示新约束（默认 9000 / 规则 1-5）',
      cur.revision === 2 && cur.defaultColumnWeightLimit === '9000' &&
      cur.incompatRules[0].categoryB === '5');

    // ---- 3. 复验失败：新覆盖 (1,1)=700 -> 列重 500+300=800 超限；422，修订号/规则不变 ----
    const overweight = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '700' }],
      incompatRules: [{ categoryA: '1', categoryB: '5', minDistance: 2 }],
    });
    check('超重复验失败 422', overweight.status === 422 &&
      overweight.body.error.code === 'validation_failed');
    const ow = overweight.body.error.details.violations.find((x) => x.reason === 'column_overweight');
    check('超重定位：列 (1,1) totalWeight=800 limit=700 含 B1/B4',
      ow && ow.bay === 1 && ow.row === 1 && ow.totalWeight === '800' && ow.weightLimit === '700' &&
      ow.boxNos.includes('B1') && ow.boxNos.includes('B4'), JSON.stringify(ow));
    const afterReject = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('拒绝后修订号仍 2、规则与布局不变',
      afterReject.revision === 2 &&
      afterReject.columnWeightLimits[0].bay === 2 &&
      afterReject.incompatRules[0].categoryB === '5');

    // ---- 4. 复验失败：新增 3-5 距离 3 -> B2(3)@3,3 与 B3(5)@2,2 距离 2 < 3 ----
    const tooclose = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [{ bay: 2, row: 2, weightLimit: '9999' }],
      incompatRules: [
        { categoryA: '1', categoryB: '5', minDistance: 2 },
        { categoryA: '3', categoryB: '5', minDistance: 3 },
      ],
    });
    check('不相容复验失败 422 incompatible_too_close', tooclose.status === 422 &&
      tooclose.body.error.details.violations.some((x) =>
        x.reason === 'incompatible_too_close' && x.boxA === 'B2' && x.boxB === 'B3' &&
        x.distance === 2 && x.minDistance === 3));

    // ---- 5. 过期修订号 -> 409，返回当前修订号 ----
    const stale = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      ...okUpdate, baseRevision: 1,
    });
    check('过期 baseRevision 409 stale_revision 且返回当前 2',
      stale.status === 409 && stale.body.error.code === 'stale_revision' &&
      stale.body.error.details.currentRevision === 2 &&
      stale.body.error.details.expectedRevision === 1, JSON.stringify(stale.body));

    // ---- 6. 请求级校验沿用登记：非正重量 / 越界列坐标 / 重复类别对 / 重复列覆盖 ----
    const negWeight = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '0',
      columnWeightLimits: [],
      incompatRules: [],
    });
    check('默认承重非正 -> 400', negWeight.status === 400);

    const badCoord = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [{ bay: 9, row: 1, weightLimit: '100' }],
      incompatRules: [],
    });
    check('覆盖列坐标越界 -> 400 invalid_column_limit',
      badCoord.status === 400 && badCoord.body.error.code === 'invalid_column_limit');

    const dupRule = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [],
      incompatRules: [
        { categoryA: '1', categoryB: '5', minDistance: 2 },
        { categoryA: '5', categoryB: '1', minDistance: 4 },
      ],
    });
    check('重复类别对（含顺序反转）-> 400 duplicate_incompat_rule',
      dupRule.status === 400 && dupRule.body.error.code === 'duplicate_incompat_rule');

    const dupCol = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [
        { bay: 1, row: 1, weightLimit: '100' },
        { bay: 1, row: 1, weightLimit: '200' },
      ],
      incompatRules: [],
    });
    check('重复列覆盖 -> 400 duplicate_column_limit',
      dupCol.status === 400 && dupCol.body.error.code === 'duplicate_column_limit');

    // ---- 7. 空集全量替换：清空全部覆盖与类别对（当前布局仍合法）rev 2 -> 3 ----
    const cleared = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '9000',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200);
    check('清空覆盖与类别对 revision=3', cleared.body.revision === 3 &&
      cleared.body.layout.columnWeightLimits.length === 0 &&
      cleared.body.layout.incompatRules.length === 0);
    check('清空后布局仍 4 箱继承', cleared.body.layout.placements.length === 4);

    // ---- 8. 后续“调整”使用新约束（已无 1-3 规则）：B2 可贴近 B1 ----
    // 把 B2 移到 (1,2,0)：旧规则下距 B1=1 会违规，新约束无规则 -> 合法
    const moveUnderNew = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 3,
      moves: [{ boxNo: 'B2', position: { bay: 1, row: 2, tier: 0 } }],
    }, 200);
    check('新约束下调整：无 1-3 规则，贴近合法 revision=4',
      moveUnderNew.body.revision === 4 &&
      moveUnderNew.body.layout.incompatRules.length === 0);

    // 但新约束默认列承重 9000：把 B3(400) 叠到 (1,1) 列已有 800 -> 1200 <= 9000 合法；
    // 改用覆盖制造超重验证调整仍受新默认约束：先设一个小默认承重会影响所有列，
    // 这里直接验证默认 9000 生效（列重 800 不超限已在上面通过）。
    // 再把约束默认承重调到 700：当前 (1,1)=800 立即冲突 -> 复验拒绝。
    const tighten = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 4,
      defaultColumnWeightLimit: '700',
      columnWeightLimits: [],
      incompatRules: [],
    });
    check('收紧默认承重致当前布局超重 -> 422（修订号仍 4）',
      tighten.status === 422 &&
      tighten.body.error.details.violations.some((x) => x.reason === 'column_overweight'));
    const still4 = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('收紧失败后航次当前修订号仍 4、默认承重仍 9000',
      still4.revision === 4 && still4.defaultColumnWeightLimit === '9000');

    // ---- 9. 签发：rev=4 全配位，按当前（新）约束复验通过，冻结清单 ----
    const manifest = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 4 });
    check('签发成功 201 current=true 4 箱',
      manifest.status === 201 && manifest.body.current === true && manifest.body.boxCount === 4,
      JSON.stringify(manifest.body));

    // ---- 10. 旧清单冻结：约束变更不影响已签发清单内容与 current 标记 ----
    // 当前布局合法地再变约束（默认 9000 不变，仅加一个不冲突规则；先确认不冲突）。
    // 当前位置：B1@1,1,0 B4@1,1,1 B2@1,2,0 B3@2,2,0；加 1-3 距离 3 => B1-B2 距离 1 冲突，
    // 故加一条不影响当前布局的相容规则不可得；改为仅改默认承重为 9500（不冲突）-> rev5
    const afterIssue = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 4,
      defaultColumnWeightLimit: '9500',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200);
    check('签发后约束变更 revision=5、布局继承', afterIssue.body.revision === 5);

    const frozen = (await http('GET', `${BASE}/voyages/${vid}/manifests/4`, undefined, 200)).body;
    check('旧清单 rev=4 内容冻结且 current=false',
      frozen.current === false && frozen.boxCount === 4 &&
      frozen.items.find((i) => i.boxNo === 'B2').position.bay === 1 &&
      frozen.items.find((i) => i.boxNo === 'B2').position.row === 2);
    const manifests = (await http('GET', `${BASE}/voyages/${vid}/manifests`, undefined, 200)).body;
    check('清单列表中旧清单 current=false',
      manifests.length === 1 && manifests[0].revision === 4 && manifests[0].current === false);

    // ---- 11. 在办核对以冻结清单为基准，约束变更不影响 ----
    const job = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 4 }, 201);
    check('以冻结清单 rev=4 开启核对作业', job.body.job.manifestRevision === 4);
    const jobId = job.body.job.jobId;
    // B2 在冻结清单中位于 (1,2,0)（约束变更后的布局），核对基准应以此为准
    check('作业应装明细取自冻结清单 B2@(1,2,0)',
      job.body.expected.find((e) => e.boxNo === 'B2').position.row === 2);
    const status = (await http('GET', `${BASE}/check-jobs/${jobId}`, undefined, 200)).body;
    check('核对状态 open 且应装 4 箱', status.status === 'open' && status.counts.expected === 4);

    // 再做一次约束变更（rev5 -> 6，不冲突）不影响在办作业基准
    await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 5,
      defaultColumnWeightLimit: '9600',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200);
    const status2 = (await http('GET', `${BASE}/check-jobs/${jobId}`, undefined, 200)).body;
    check('约束再变更后在办核对基准不变（应装 4、B2 仍 (1,2,0)）',
      status2.counts.expected === 4 &&
      status2.details.expected.find((e) => e.boxNo === 'B2').position.row === 2);

    // 上报全部与冻结清单一致后可结案（使用冻结布局坐标）
    const report = async (n, boxNo, p) =>
      http('POST', `${BASE}/check-jobs/${jobId}/reports`, { reportNo: `R${n}`, boxNo, position: p }, 201);
    await report(1, 'B1', { bay: 1, row: 1, tier: 0 });
    await report(2, 'B4', { bay: 1, row: 1, tier: 1 });
    await report(3, 'B2', { bay: 1, row: 2, tier: 0 });
    await report(4, 'B3', { bay: 2, row: 2, tier: 0 });
    const close = await http('POST', `${BASE}/check-jobs/${jobId}/close`, undefined, 201);
    check('按冻结清单核对一致可结案 frozen=true',
      close.body.closed === true && close.body.status.frozen === true);

    // ---- 12. 并发：两个同 baseRevision 约束变更只有一个成功 ----
    // 先让当前布局可被两种变更都接受：默认承重给大值，无覆盖无规则。
    await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 6,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200); // -> rev 7
    const payload = {
      baseRevision: 7,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [],
      incompatRules: [],
    };
    const [c1, c2] = await Promise.all([
      http('POST', `${BASE}/voyages/${vid}/constraints`, payload),
      http('POST', `${BASE}/voyages/${vid}/constraints`, payload),
    ]);
    const s = [c1.status, c2.status].sort();
    check('并发同修订号约束变更：一个 200 一个 409', s[0] === 200 && s[1] === 409,
      JSON.stringify([c1.status, c2.status]));
    const finalVoyage = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('并发后修订号恰好 +1 为 8', finalVoyage.revision === 8, JSON.stringify(finalVoyage.revision));

    // 未知航次
    const nf = await http('POST', `${BASE}/voyages/00000000-0000-0000-0000-000000000000/constraints`, {
      baseRevision: 0, defaultColumnWeightLimit: '1', columnWeightLimits: [], incompatRules: [],
    });
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
