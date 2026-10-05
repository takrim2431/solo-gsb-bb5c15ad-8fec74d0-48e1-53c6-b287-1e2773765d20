/**
 * 调用示例（Node 18+ 内置 fetch，无需额外依赖）：
 *   BASE=http://localhost:3000 npx tsx examples/demo.ts
 *
 * 演示完整流程：登记 -> 违规被拒 -> 合法整批 -> 交换 -> 撤位/复位 ->
 *               签发冻结 -> 后续调整 -> 过期修订号冲突 -> 旧清单保留。
 */

const BASE = process.env.BASE ?? 'http://localhost:3000';
const API = `${BASE}/api`;

function log(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, body: json };
}

async function main(): Promise<void> {
  // 1. 登记航次
  const created = await call('POST', '/voyages', {
    voyageNo: `V-DEMO-${Date.now()}`,
    bays: 3,
    rows: 2,
    tiers: 3,
    defaultColumnWeightLimit: '10000',
    columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
    boxes: [
      { boxNo: 'BOX-1', weight: '500', category: '1' },
      { boxNo: 'BOX-2', weight: '600', category: '3' },
      { boxNo: 'BOX-3', weight: '400', category: '5' },
      { boxNo: 'BOX-4', weight: '300.25', category: '1' },
    ],
    incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
  });
  log('登记航次', created.body);
  const vid = (created.body as { id: string }).id;

  // 2. 违规整批：距离不足 -> 422，修订号不变
  const bad = await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 0,
    moves: [
      { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
      { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } },
    ],
  });
  log(`违规尝试 HTTP ${bad.status}（整批拒绝，含箱号/舱位/原因）`, bad.body);

  // 3. 合法整批 -> rev 1
  const ok = await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 0,
    moves: [
      { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
      { boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 } },
      { boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } },
      { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 1 } },
    ],
  });
  log('合法整批，新修订号', (ok.body as { revision: number }).revision);

  // 4. 同批交换（同列上下互换，携带 rev=1）-> rev 2
  const swapped = await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 1,
    moves: [
      { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 1 } },
      { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
    ],
  });
  log('同批交换', swapped.body);

  // 5. 过期修订号 -> 409
  const stale = await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 1,
    moves: [{ boxNo: 'BOX-3', position: null }],
  });
  log(`过期修订号 HTTP ${stale.status}`, stale.body);

  // 6. 撤位（rev=2 -> 3）
  await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 2,
    moves: [{ boxNo: 'BOX-3', position: null }],
  });

  // 7. 未全配位签发 -> 422
  const issueFail = await call('POST', `/voyages/${vid}/manifests`, { expectedRevision: 3 });
  log(`未全配位签发 HTTP ${issueFail.status}`, issueFail.body);

  // 8. 复位（rev=3 -> 4）
  await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 3,
    moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 2, tier: 0 } }],
  });

  // 9. 签发冻结 rev=4
  const manifest = await call('POST', `/voyages/${vid}/manifests`, { expectedRevision: 4 });
  log('签发装载清单（冻结 rev=4）', manifest.body);

  // 10. 后续调整 -> rev=5
  await call('POST', `/voyages/${vid}/moves`, {
    baseRevision: 4,
    moves: [{ boxNo: 'BOX-3', position: { bay: 2, row: 1, tier: 0 } }],
  });

  // 11. 清单列表：旧清单保留 current=false
  const manifests = await call('GET', `/voyages/${vid}/manifests`);
  log('清单列表（旧清单保留）', manifests.body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
