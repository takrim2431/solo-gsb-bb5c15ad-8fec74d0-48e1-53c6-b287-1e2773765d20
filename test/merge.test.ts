import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, Position, threeWayMerge } from '../src/domain';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

/** 以 {箱号: 位置或 null} 构造合并输入与期望 */
type P = Record<string, Position | null>;
const asPlacements = (m: P): Placement[] =>
  Object.entries(m)
    .filter(([, p]) => p !== null)
    .map(([boxNo, position]) => ({ boxNo, position: position as Position }));

function run(base: P, plan: P, voyage: P, boxNos = [...new Set([...Object.keys(base), ...Object.keys(plan), ...Object.keys(voyage)])].sort()) {
  return threeWayMerge({
    boxNos,
    base: asPlacements(base),
    plan: asPlacements(plan),
    voyage: asPlacements(voyage),
  });
}

/** 把合并结果转成 {箱号: 位置或 null} 便于断言 */
function toMap(placements: Placement[]): P {
  const out: P = {};
  for (const { boxNo, position } of placements) out[boxNo] = position;
  return out;
}

test('双方都未改动：沿用基线位置', () => {
  const base = { A: pos(1, 1, 0) };
  const r = run(base, { A: pos(1, 1, 0) }, { A: pos(1, 1, 0) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), { A: pos(1, 1, 0) });
  assert.equal(r.stats.unchanged, 1);
});

test('仅方案方移动：采用方案位置', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: pos(2, 1, 0) }, { A: pos(1, 1, 0) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), { A: pos(2, 1, 0) });
  assert.equal(r.stats.planOnly, 1);
});

test('仅航次方移动：采用航次位置（追上正式布局）', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: pos(1, 1, 0) }, { A: pos(3, 2, 1) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), { A: pos(3, 2, 1) });
  assert.equal(r.stats.voyageOnly, 1);
});

test('双方移动到同一位置：视为一致（bothSame）', () => {
  const same = pos(2, 2, 0);
  const r = run({ A: pos(1, 1, 0) }, { A: same }, { A: same });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), { A: same });
  assert.equal(r.stats.bothSame, 1);
});

test('双方移动到不同位置：冲突箱带双方位置，方案不产出该箱', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: pos(2, 1, 0) }, { A: pos(3, 1, 0) });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], {
    boxNo: 'A',
    planPosition: pos(2, 1, 0),
    voyagePosition: pos(3, 1, 0),
  });
  assert.equal(r.stats.conflicts, 1);
  // 冲突箱不进入合并布局（调用方应整体拒绝、方案保持原状）
  assert.deepEqual(r.placements, []);
});

test('撤位按空位置：仅方案撤位 -> 合并撤位', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: null }, { A: pos(1, 1, 0) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), {});
  assert.equal(r.stats.planOnly, 1);
});

test('撤位按空位置：仅航次撤位 -> 合并采用航次的撤位', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: pos(1, 1, 0) }, { A: null });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), {});
  assert.equal(r.stats.voyageOnly, 1);
});

test('双方都撤位：视为一致（空位置相同）', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: null }, { A: null });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), {});
  assert.equal(r.stats.bothSame, 1);
});

test('一方撤位另一方移动到不同位置：目标不同，冲突（含空位置）', () => {
  const r = run({ A: pos(1, 1, 0) }, { A: null }, { A: pos(2, 2, 0) });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], {
    boxNo: 'A',
    planPosition: null,
    voyagePosition: pos(2, 2, 0),
  });
});

test('基线为空（未配位）：仅方案配位 -> 采用方案；仅航次配位 -> 采用航次', () => {
  const planPut = run({ A: null }, { A: pos(1, 1, 0) }, { A: null });
  assert.deepEqual(toMap(planPut.placements), { A: pos(1, 1, 0) });
  assert.equal(planPut.stats.planOnly, 1);

  const voyagePut = run({ A: null }, { A: null }, { A: pos(1, 1, 0) });
  assert.deepEqual(toMap(voyagePut.placements), { A: pos(1, 1, 0) });
  assert.equal(voyagePut.stats.voyageOnly, 1);

  // 基线为空，双方配到不同位置 -> 冲突
  const bothPut = run({ A: null }, { A: pos(1, 1, 0) }, { A: pos(2, 1, 0) });
  assert.equal(bothPut.conflicts.length, 1);
});

test('多箱混合：无冲突逐箱合并，统计分类正确', () => {
  const r = run(
    {
      A: pos(1, 1, 0), // 双方不动
      B: pos(1, 2, 0), // 仅方案移动
      C: pos(2, 1, 0), // 仅航次移动
      D: pos(2, 2, 0), // 双方移到同位置
      E: pos(3, 1, 0), // 双方撤位
      F: null,         // 基线空，不动
    },
    {
      A: pos(1, 1, 0),
      B: pos(1, 3, 0),
      C: pos(2, 1, 0),
      D: pos(2, 2, 1),
      E: null,
      F: null,
    },
    {
      A: pos(1, 1, 0),
      B: pos(1, 2, 0),
      C: pos(2, 3, 0),
      D: pos(2, 2, 1),
      E: null,
      F: null,
    },
  );
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(toMap(r.placements), {
    A: pos(1, 1, 0),
    B: pos(1, 3, 0),
    C: pos(2, 3, 0),
    D: pos(2, 2, 1),
  });
  assert.deepEqual(r.stats, {
    totalBoxes: 6,
    unchanged: 2,
    planOnly: 1,
    voyageOnly: 1,
    bothSame: 2,
    conflicts: 0,
  });
});
