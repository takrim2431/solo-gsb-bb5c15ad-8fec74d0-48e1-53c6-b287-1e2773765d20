/* eslint-disable no-console */
// 端到端验证：航次修订号前进后的试排方案迁移（rebase / 三方合并）
//   - 仅一方改动采用该方位置；双方改到同一位置视为一致；目标不同 -> 409 migration_conflict，方案保持原状
//   - 撤位按空位置参与比较
//   - 用当前航次约束复验合并布局：违反 -> 422 validation_failed，不迁移
//   - 成功：原子换来源修订号+约束快照、保存新布局、推进方案修订号；旧方案布局仍可追溯；可再迁移/发布
//   - 所见方案修订号过期 / 所见航次修订号过期 / 方案已发布 -> 409 拒绝
//   - 迁移不改变正式布局、清单与核对作业；并发迁移严格串行
// 运行: node test/e2e-migrate.js
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
    databaseDir: path.join('/tmp', 'pgdata-e2e-migrate'),
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

  const posOf = (layout, boxNo) => layout.placements.find((p) => p.boxNo === boxNo)?.position ?? null;

  try {
    // ---- 登记：3x3x2；默认 10000；规则 1-3 距离 3；5 箱 ----
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-MIG-001',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'B1', weight: '500', category: '1' },
        { boxNo: 'B2', weight: '600', category: '3' },
        { boxNo: 'B3', weight: '400', category: '5' },
        { boxNo: 'B4', weight: '300', category: '1' },
        { boxNo: 'B5', weight: '200', category: '9' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    const vid = voyage.id;

    // 正式布局 rev=1：B1@(1,1,0) B4@(1,1,1) B2@(3,3,0) B3@(2,2,0) B5@(3,1,0)
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
        { boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } },
        { boxNo: 'B5', position: { bay: 3, row: 1, tier: 0 } },
      ],
    }, 200);

    // ---- 1. 从 rev=1 建立方案P；方案仅移动 B2 -> (2,3,0)（距 B1 = |1|+2=3 达标），方案修订号=1 ----
    const created = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '迁移方案P' }, 201)).body;
    const pid = created.planId;
    await http('POST', `${BASE}/plans/${pid}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B2', position: { bay: 2, row: 3, tier: 0 } }],
    }, 200);

    // ---- 2. 正式航次前进 rev 1->2：仅移动 B3 -> (3,2,0)，并撤位 B5 ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'B3', position: { bay: 3, row: 2, tier: 0 } },
        { boxNo: 'B5', position: null },
      ],
    }, 200);
    const formalBefore = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('迁移前正式布局：B3@(3,2,0)、B5 已撤位',
      posOf(formalBefore, 'B3').bay === 3 && posOf(formalBefore, 'B5') === null);

    // ---- 3. 发布冲突（航次 2 ≠ 来源 1），方案保留 ----
    const conflictPub = await http('POST', `${BASE}/plans/${pid}/publish`, undefined);
    check('发布冲突 409 publish_conflict',
      conflictPub.status === 409 && conflictPub.body.error.code === 'publish_conflict');

    // ---- 4. 过期所见版本拒绝迁移 ----
    const stalePlan = await http('POST', `${BASE}/plans/${pid}/migrate`, {
      planRevision: 0, voyageRevision: 2,
    });
    check('所见方案修订号过期 -> 409 stale_revision(scope=plan, current=1)',
      stalePlan.status === 409 && stalePlan.body.error.code === 'stale_revision' &&
      stalePlan.body.error.details.scope === 'plan' &&
      stalePlan.body.error.details.currentRevision === 1 &&
      stalePlan.body.error.details.expectedRevision === 0, JSON.stringify(stalePlan.body));

    const staleVoyage = await http('POST', `${BASE}/plans/${pid}/migrate`, {
      planRevision: 1, voyageRevision: 1,
    });
    check('所见航次修订号过期 -> 409 stale_revision(scope=voyage, current=2)',
      staleVoyage.status === 409 && staleVoyage.body.error.code === 'stale_revision' &&
      staleVoyage.body.error.details.scope === 'voyage' &&
      staleVoyage.body.error.details.currentRevision === 2, JSON.stringify(staleVoyage.body));

    // 过期拒绝不改变方案
    const planUntouched = (await http('GET', `${BASE}/plans/${pid}`, undefined, 200)).body;
    check('过期拒绝后方案不变（source=1、planRev=1、B2 仍在 (2,3,0)）',
      planUntouched.sourceRevision === 1 && planUntouched.planRevision === 1 &&
      posOf(planUntouched, 'B2').bay === 2);

    // ---- 5. 无前进可迁移：航次仍等于来源 -> 409 migration_not_needed（用来源即当前的新方案）----
    const planCurrent = (await http('POST', `${BASE}/voyages/${vid}/plans`, undefined, 201)).body;
    const noNeed = await http('POST', `${BASE}/plans/${planCurrent.planId}/migrate`, {
      planRevision: 0, voyageRevision: 2,
    });
    check('来源修订号==当前修订号 -> 409 migration_not_needed',
      noNeed.status === 409 && noNeed.body.error.code === 'migration_not_needed' &&
      noNeed.body.error.details.sourceRevision === 2 &&
      noNeed.body.error.details.currentRevision === 2, JSON.stringify(noNeed.body));

    // ---- 6. 成功迁移：B2 取方案位置，B3/B5 追航次，其余不变 ----
    const mig = await http('POST', `${BASE}/plans/${pid}/migrate`, {
      planRevision: 1, voyageRevision: 2,
    }, 200);
    check('迁移成功 200：来源 1->2、方案修订号 1->2',
      mig.body.migrated === true &&
      mig.body.previousSourceRevision === 1 && mig.body.sourceRevision === 2 &&
      mig.body.previousPlanRevision === 1 && mig.body.planRevision === 2 &&
      mig.body.voyageRevision === 2, JSON.stringify(mig.body));
    check('合并统计：B2 方案方/B3、B5 航次方/其余不变',
      mig.body.merge.planOnly === 1 && mig.body.merge.voyageOnly === 2 &&
      mig.body.merge.unchanged === 2 && mig.body.merge.bothSame === 0 &&
      mig.body.merge.totalBoxes === 5 && mig.body.merge.conflictCount === 0,
      JSON.stringify(mig.body.merge));
    check('合并布局：B2@(2,3,0)（方案）、B3@(3,2,0)（航次）、B5 撤位（航次）、B1/B4 不变',
      posOf(mig.body.plan, 'B2').row === 3 && posOf(mig.body.plan, 'B2').bay === 2 &&
      posOf(mig.body.plan, 'B3').bay === 3 && posOf(mig.body.plan, 'B3').row === 2 &&
      posOf(mig.body.plan, 'B5') === null &&
      posOf(mig.body.plan, 'B1').bay === 1 && posOf(mig.body.plan, 'B4').tier === 1 &&
      mig.body.plan.unplacedBoxNos.includes('B5'));
    check('迁移后方案视图：sourceRevision=2、planRevision=2、仍 open',
      mig.body.plan.sourceRevision === 2 && mig.body.plan.planRevision === 2 &&
      mig.body.plan.status === 'open');

    // 再次 GET 确认已落库
    const planAfter = (await http('GET', `${BASE}/plans/${pid}`, undefined, 200)).body;
    check('迁移持久化：sourceRevision=2、planRevision=2、约束快照已换',
      planAfter.sourceRevision === 2 && planAfter.planRevision === 2 &&
      planAfter.incompatRules.length === 1 &&
      planAfter.incompatRules[0].minDistance === 3);

    // ---- 7. 旧方案布局仍可追溯（plan_placements 历史 rev=0/1 保留）----
    const hist = await pool.query(
      `SELECT rev, count(*)::int AS n FROM plan_placements WHERE plan_id=$1 GROUP BY rev ORDER BY rev`,
      [pid],
    );
    const byRev = Object.fromEntries(hist.rows.map((r) => [Number(r.rev), r.n]));
    check('旧方案修订号布局留痕：rev=0（5箱）、rev=1（5箱）、rev=2（4箱，B5撤位）',
      byRev[0] === 5 && byRev[1] === 5 && byRev[2] === 4, JSON.stringify(byRev));

    // ---- 8. 迁移不改变正式布局/修订号 ----
    const formalAfter = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('迁移后航次修订号仍为 2（未触碰正式航次）', formalAfter.revision === 2);
    const layoutAfter = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('迁移后正式布局 B2 仍为 rev=2 原值 (3,3,0)，方案改动未泄漏',
      posOf(layoutAfter, 'B2').bay === 3 && posOf(layoutAfter, 'B2').row === 3);

    // ---- 9. 迁移后可直接发布（source==当前）-> 写入 rev=3 ----
    const pub = await http('POST', `${BASE}/plans/${pid}/publish`, undefined, 201);
    check('迁移后发布成功 201：写入航次修订号 3，发布布局=合并布局',
      pub.body.voyageRevision === 3 && pub.body.sourceRevision === 2 &&
      pub.body.planRevision === 2 &&
      posOf(pub.body.layout, 'B2').bay === 2 && posOf(pub.body.layout, 'B2').row === 3 &&
      posOf(pub.body.layout, 'B3').bay === 3 && posOf(pub.body.layout, 'B5') === null &&
      pub.body.layout.placements.length === 4, JSON.stringify(pub.body));

    // 已发布方案再迁移 -> 409 plan_published
    const migratePublished = await http('POST', `${BASE}/plans/${pid}/migrate`, {
      planRevision: 2, voyageRevision: 3,
    });
    check('已发布方案迁移 -> 409 plan_published',
      migratePublished.status === 409 && migratePublished.body.error.code === 'plan_published');

    // 清单/核对照常（迁移+发布不影响既有流程）
    const manifest = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 });
    check('发布后 rev=3 仍有 B5 未配位 -> 422 unplaced_boxes',
      manifest.status === 422 && manifest.body.error.code === 'unplaced_boxes' &&
      manifest.body.error.details.unplacedBoxNos.includes('B5'));

    // ---- 10. 迁移冲突（双方改动目标不同）：方案保持原状 ----
    // 当前航次 rev=3（方案P发布结果）。新建航次场景独立验证冲突：
    // 建立第二个航次专门演示逐箱冲突与撤位冲突
    const { body: v2 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-MIG-002',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'C1', weight: '500', category: '5' },
        { boxNo: 'C2', weight: '500', category: '5' },
      ],
    }, 201);
    const v2id = v2.id;
    await http('POST', `${BASE}/voyages/${v2id}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'C1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'C2', position: { bay: 3, row: 3, tier: 0 } },
      ],
    }, 200);
    const planX = (await http('POST', `${BASE}/voyages/${v2id}/plans`, { label: '冲突方案X' }, 201)).body;
    // 方案：C1 -> (2,1,0)，C2 撤位
    await http('POST', `${BASE}/plans/${planX.planId}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'C1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'C2', position: null },
      ],
    }, 200);
    // 航次前进：C1 -> (2,2,0)（与方案 (2,1,0) 冲突），C2 -> (2,3,0)（与方案撤位冲突）
    await http('POST', `${BASE}/voyages/${v2id}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'C1', position: { bay: 2, row: 2, tier: 0 } },
        { boxNo: 'C2', position: { bay: 2, row: 3, tier: 0 } },
      ],
    }, 200);
    const migConflict = await http('POST', `${BASE}/plans/${planX.planId}/migrate`, {
      planRevision: 1, voyageRevision: 2,
    });
    check('迁移冲突 409 migration_conflict：返回冲突箱及双方位置（含撤位空位置）',
      migConflict.status === 409 && migConflict.body.error.code === 'migration_conflict' &&
      migConflict.body.error.details.conflictCount === 2, JSON.stringify(migConflict.body));
    const c1c = migConflict.body.error.details.conflicts.find((c) => c.boxNo === 'C1');
    const c2c = migConflict.body.error.details.conflicts.find((c) => c.boxNo === 'C2');
    check('C1 冲突位置：方案(2,1,0) vs 航次(2,2,0)',
      c1c.planPosition.row === 1 && c1c.voyagePosition.row === 2, JSON.stringify(c1c));
    check('C2 冲突位置：方案撤位 null vs 航次(2,3,0)',
      c2c.planPosition === null && c2c.voyagePosition.bay === 2 && c2c.voyagePosition.row === 3,
      JSON.stringify(c2c));
    const planXKept = (await http('GET', `${BASE}/plans/${planX.planId}`, undefined, 200)).body;
    check('冲突后方案保持原状（source=1、planRev=1、C2 仍撤位、C1@(2,1,0)）',
      planXKept.sourceRevision === 1 && planXKept.planRevision === 1 &&
      posOf(planXKept, 'C1').row === 1 && posOf(planXKept, 'C2') === null,
      JSON.stringify(planXKept));

    // 调度员在方案内解决冲突：C1 跟航次 (2,2,0)、C2 复位到 (3,3,0) 之外的新合法位 (1,3,0)
    await http('POST', `${BASE}/plans/${planX.planId}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'C1', position: { bay: 2, row: 2, tier: 0 } },
        { boxNo: 'C2', position: { bay: 1, row: 3, tier: 0 } },
      ],
    }, 200);
    // 现在 C1 双方改到同位置（bothSame）；C2 方案 (1,3,0) 与基线 (3,3,0) 不同、
    // 航次 (2,3,0) 也与基线不同 -> 仍冲突。改为 C2 也认同航次位置解决：
    const stillConflict = await http('POST', `${BASE}/plans/${planX.planId}/migrate`, {
      planRevision: 2, voyageRevision: 2,
    });
    check('C2 仍冲突（方案(1,3,0)/航次(2,3,0)）-> 409，方案不变',
      stillConflict.status === 409 && stillConflict.body.error.code === 'migration_conflict' &&
      stillConflict.body.error.details.conflictCount === 1 &&
      stillConflict.body.error.details.conflicts[0].boxNo === 'C2');
    await http('POST', `${BASE}/plans/${planX.planId}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'C2', position: { bay: 2, row: 3, tier: 0 } }],
    }, 200);
    const migOk = await http('POST', `${BASE}/plans/${planX.planId}/migrate`, {
      planRevision: 3, voyageRevision: 2,
    }, 200);
    check('解决冲突后迁移成功：两箱均 bothSame，方案来源 1->2、修订号 3->4',
      migOk.body.sourceRevision === 2 && migOk.body.planRevision === 4 &&
      migOk.body.merge.bothSame === 2 && migOk.body.merge.conflictCount === 0,
      JSON.stringify(migOk.body.merge));

    // ---- 11. 连续两次迁移（第二次以新来源修订号为基线）----
    // 方案X 当前 source=2、planRev=4、布局=航次 rev=2。航次再前进 rev 2->3（C1 撤位）
    await http('POST', `${BASE}/voyages/${v2id}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'C1', position: null }],
    }, 200);
    // 方案内先做一个独立改动：C2 -> (1,3,0)（仅方案方相对新基线的改动）
    await http('POST', `${BASE}/plans/${planX.planId}/moves`, {
      baseRevision: 4,
      moves: [{ boxNo: 'C2', position: { bay: 1, row: 3, tier: 0 } }],
    }, 200);
    const mig2 = await http('POST', `${BASE}/plans/${planX.planId}/migrate`, {
      planRevision: 5, voyageRevision: 3,
    }, 200);
    check('二次迁移以新来源(2)为基线：C1 追航次撤位(voyageOnly)、C2 保留方案改动(planOnly)',
      mig2.body.previousSourceRevision === 2 && mig2.body.sourceRevision === 3 &&
      mig2.body.merge.voyageOnly === 1 && mig2.body.merge.planOnly === 1 &&
      posOf(mig2.body.plan, 'C1') === null &&
      posOf(mig2.body.plan, 'C2').bay === 1 && posOf(mig2.body.plan, 'C2').row === 3,
      JSON.stringify(mig2.body.merge));

    // ---- 12. 当前航次约束复验失败 -> 422，不迁移 ----
    // 2x1x1（bay 两列、单列单层）；默认承重 1000；D1/D2 各 600。
    const { body: v3 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-MIG-003',
      bays: 2, rows: 1, tiers: 1,
      defaultColumnWeightLimit: '1000',
      boxes: [
        { boxNo: 'D1', weight: '600', category: '5' },
        { boxNo: 'D2', weight: '600', category: '5' },
      ],
    }, 201);
    const v3id = v3.id;
    // rev=1：D1@(1,1,0)、D2@(2,1,0)（分两列，各 600，合规）
    await http('POST', `${BASE}/voyages/${v3id}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'D1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'D2', position: { bay: 2, row: 1, tier: 0 } },
      ],
    }, 200);
    const planW = (await http('POST', `${BASE}/voyages/${v3id}/plans`, { label: '复验失败方案W' }, 201)).body;
    // 方案（旧约束 1000 下合法）：撤 D1、把 D2 移到 (1,1,0) -> 方案最终仅 D2@(1,1,0)=600
    await http('POST', `${BASE}/plans/${planW.planId}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'D1', position: null },
        { boxNo: 'D2', position: { bay: 1, row: 1, tier: 0 } },
      ],
    }, 200);
    // 航次 rev=2：撤 D1（正式布局仅 D2@(2,1,0)）
    await http('POST', `${BASE}/voyages/${v3id}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'D1', position: null }],
    }, 200);
    // 航次 rev=3：把 (1,1) 列承重覆盖收紧到 500（不影响正式布局的 D2@(2,1,0)，可受理）
    await http('POST', `${BASE}/voyages/${v3id}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '1000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '500' }],
      incompatRules: [],
    }, 200);
    // 合并：D1 双方都撤位(bothSame)、D2 仅方案移动到 (1,1,0)(planOnly)；
    //       按当前航次约束复验 (1,1) 列 D2=600 > 500 -> 422 column_overweight
    const mig422 = await http('POST', `${BASE}/plans/${planW.planId}/migrate`, {
      planRevision: 1, voyageRevision: 3,
    });
    check('合并布局违反当前航次约束 -> 422 validation_failed(column_overweight)',
      mig422.status === 422 && mig422.body.error.code === 'validation_failed' &&
      mig422.body.error.details.violations.some((x) =>
        x.reason === 'column_overweight' && x.bay === 1 && x.row === 1 &&
        x.totalWeight === '600' && x.weightLimit === '500'), JSON.stringify(mig422.body));
    const planWKept = (await http('GET', `${BASE}/plans/${planW.planId}`, undefined, 200)).body;
    check('422 后不迁移：方案仍 source=1、planRev=1、约束快照仍旧（无 (1,1)=500 覆盖）',
      planWKept.sourceRevision === 1 && planWKept.planRevision === 1 &&
      planWKept.columnWeightLimits.length === 0 &&
      posOf(planWKept, 'D2').bay === 1 && posOf(planWKept, 'D1') === null,
      JSON.stringify(planWKept));
    const v3Now = (await http('GET', `${BASE}/voyages/${v3id}`, undefined, 200)).body;
    check('422 后航次修订号仍为 3（正式航次未受影响）', v3Now.revision === 3);

    // ---- 13. 并发：同一方案两个相同所见版本的迁移只有一个成功（行锁串行）----
    const { body: v4 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-MIG-004',
      bays: 2, rows: 1, tiers: 1,
      defaultColumnWeightLimit: '1000',
      boxes: [{ boxNo: 'E1', weight: '600', category: '5' }],
    }, 201);
    const v4id = v4.id;
    await http('POST', `${BASE}/voyages/${v4id}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'E1', position: { bay: 1, row: 1, tier: 0 } }],
    }, 200); // rev=1
    const planQ = (await http('POST', `${BASE}/voyages/${v4id}/plans`, undefined, 201)).body;
    await http('POST', `${BASE}/voyages/${v4id}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'E1', position: null }],
    }, 200); // rev=2：撤 E1
    const [q1, q2] = await Promise.all([
      http('POST', `${BASE}/plans/${planQ.planId}/migrate`, { planRevision: 0, voyageRevision: 2 }),
      http('POST', `${BASE}/plans/${planQ.planId}/migrate`, { planRevision: 0, voyageRevision: 2 }),
    ]);
    const qs = [q1.status, q2.status].sort();
    check('并发同所见版本迁移：一个 200 一个 409 stale_revision',
      qs[0] === 200 && qs[1] === 409,
      JSON.stringify([q1.status, q2.status, q1.body?.error?.code, q2.body?.error?.code]));
    const winner = q1.status === 200 ? q1.body : q2.body;
    check('成功迁移：source 1->2、planRev 0->1、合并为空布局（追航次撤位）',
      winner.sourceRevision === 2 && winner.planRevision === 1 &&
      winner.merge.voyageOnly === 1 && winner.plan.placements.length === 0,
      JSON.stringify(winner));
    const planQNow = (await http('GET', `${BASE}/plans/${planQ.planId}`, undefined, 200)).body;
    check('并发后方案修订号恰好 +1 为 1、来源=2',
      planQNow.planRevision === 1 && planQNow.sourceRevision === 2);

    // ---- 14. 非法请求体 / 未知方案 ----
    const badBody = await http('POST', `${BASE}/plans/${planQ.planId}/migrate`, {
      planRevision: '1', voyageRevision: 2,
    });
    check('请求体非法（planRevision 非整数）-> 400 invalid_request_body',
      badBody.status === 400 && badBody.body.error.code === 'invalid_request_body');
    const nf = await http('POST', `${BASE}/plans/00000000-0000-0000-0000-000000000000/migrate`, {
      planRevision: 0, voyageRevision: 1,
    });
    check('未知方案迁移 -> 404 plan_not_found',
      nf.status === 404 && nf.body.error.code === 'plan_not_found');
    const badId = await http('POST', `${BASE}/plans/not-a-uuid/migrate`, {
      planRevision: 0, voyageRevision: 1,
    });
    check('非法方案 ID -> 400 invalid_plan_id',
      badId.status === 400 && badId.body.error.code === 'invalid_plan_id');

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
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main();
