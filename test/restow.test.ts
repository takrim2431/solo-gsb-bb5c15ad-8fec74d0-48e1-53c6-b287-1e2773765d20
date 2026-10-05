import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxInfo, Geometry, Placement, Position, columnKey, weightToMicro } from '../src/domain';
import {
  RestowPortPlan,
  SimulateRestowInput,
  simulateRestowPlan,
  validateRestowPlanInput,
} from '../src/restow';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

const GEOMETRY: Geometry = { bays: 3, rows: 2, tiers: 3 };
const NO_RULES = new Map<string, number>();
const NO_COLUMN_LIMITS = new Map<string, bigint>();
const DEFAULT_LIMIT = weightToMicro('10000');

/** 以 {箱号: [bay,row,tier]} 构造冻结箱位 */
function placementsOf(m: Record<string, [number, number, number]>): Placement[] {
  return Object.entries(m).map(([boxNo, [bay, row, tier]]) => ({
    boxNo,
    position: { bay, row, tier },
  }));
}

function itemsOf(m: Record<string, string>) {
  return Object.entries(m).map(([boxNo, dischargePort]) => ({ boxNo, dischargePort }));
}

/** 构造箱档案：{箱号: 类别}（重量一律 500） */
function boxesOf(m: Record<string, string>): BoxInfo[] {
  return Object.entries(m).map(([boxNo, category]) => ({ boxNo, weight: '500', category }));
}

function planOf(m: Record<string, Array<[string, string]>>): RestowPortPlan[] {
  return Object.entries(m).map(([port, ops]) => ({
    port,
    operations: ops.map(([action, boxNo]) => ({ action: action as 'stash' | 'restore', boxNo })),
  }));
}

function simulate(
  overrides: Partial<SimulateRestowInput> &
    Pick<SimulateRestowInput, 'ports' | 'items' | 'placements' | 'plan'>,
) {
  return simulateRestowPlan({
    capacity: 2,
    geometry: GEOMETRY,
    boxes: [],
    columnLimits: NO_COLUMN_LIMITS,
    defaultColumnLimit: DEFAULT_LIMIT,
    rules: NO_RULES,
    ...overrides,
  });
}

test('暂存后续港压舱箱再回放：不可行审查变为可行，回放落点随下层卸空下降', () => {
  // 列 (1,1)：A(SHA) t0 被 B(SIN) t1 压住；不倒箱时 A 受阻
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    plan: planOf({ SHA: [['stash', 'B'], ['restore', 'B']], SIN: [] }),
  });
  assert.ok(r.ok);
  const [sha, sin] = r.simulation.portResults;
  // SHA：暂存 B 后 A 被自动卸走；回放 B 落到原列当前栈顶空位 tier0
  assert.deepEqual(sha!.discharged.map((d) => d.boxNo), ['A']);
  assert.equal(sha!.restows, 1);
  assert.deepEqual(sha!.placements, [{ boxNo: 'B', position: pos(1, 1, 0) }]);
  // SIN：港开始 B 即列顶被卸（卸下位置为回放后的 tier0）
  assert.deepEqual(sin!.discharged, [{ boxNo: 'B', position: pos(1, 1, 0) }]);
  assert.equal(sin!.restows, 0);
  assert.deepEqual(sin!.placements, []);
  assert.deepEqual(r.simulation.counts, { totalBoxes: 2, discharged: 2, restows: 1 });
});

test('每步后反复卸走可及本港箱：暂存列顶后续港箱后连锁卸出下层全部本港箱', () => {
  // 列 (1,1) 自底向上：A(SHA)、B(SHA)、C(SIN)
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SHA', C: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [1, 1, 2] }),
    plan: planOf({ SHA: [['stash', 'C'], ['restore', 'C']], SIN: [] }),
  });
  assert.ok(r.ok);
  const sha = r.simulation.portResults[0]!;
  assert.deepEqual(sha.discharged.map((d) => d.boxNo), ['A', 'B']);
  assert.equal(sha.restows, 1);
  assert.deepEqual(sha.placements, [{ boxNo: 'C', position: pos(1, 1, 0) }]);
  assert.deepEqual(r.simulation.counts, { totalBoxes: 3, discharged: 3, restows: 1 });
});

test('多箱依次暂存再按可行顺序回放：倒箱次数按暂存计，逐港给出操作后箱位', () => {
  // 列 (1,1)：A(SHA) t0、B(SIN) t1、C(HAM) t2
  // SHA：暂存 C、暂存 B（A 被自动卸走）-> 回放 C(t0)、回放 B(t1)，SIN 才能卸 B
  const r = simulate({
    capacity: 2,
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ A: 'SHA', B: 'SIN', C: 'HAM' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [1, 1, 2] }),
    plan: planOf({
      SHA: [['stash', 'C'], ['stash', 'B'], ['restore', 'C'], ['restore', 'B']],
      SIN: [],
      HAM: [],
    }),
  });
  assert.ok(r.ok);
  const [sha, sin, ham] = r.simulation.portResults;
  assert.deepEqual(sha!.discharged.map((d) => d.boxNo), ['A']);
  assert.equal(sha!.restows, 2);
  assert.deepEqual(sha!.placements, [
    { boxNo: 'B', position: pos(1, 1, 1) },
    { boxNo: 'C', position: pos(1, 1, 0) },
  ]);
  assert.deepEqual(sin!.discharged, [{ boxNo: 'B', position: pos(1, 1, 1) }]);
  assert.deepEqual(sin!.placements, [{ boxNo: 'C', position: pos(1, 1, 0) }]);
  assert.deepEqual(ham!.discharged, [{ boxNo: 'C', position: pos(1, 1, 0) }]);
  assert.deepEqual(ham!.placements, []);
  assert.deepEqual(r.simulation.counts, { totalBoxes: 3, discharged: 3, restows: 2 });
});

test('容量 0 且全程无需倒箱：成功；容量 0 却暂存：capacity_exceeded', () => {
  const ok = simulate({
    capacity: 0,
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [2, 1, 0] }),
    plan: planOf({ SHA: [], SIN: [] }),
  });
  assert.ok(ok.ok);
  assert.equal(ok.simulation.counts.restows, 0);

  const full = simulate({
    capacity: 0,
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    plan: planOf({ SHA: [['stash', 'B']], SIN: [] }),
  });
  assert.ok(!full.ok);
  assert.equal(full.failure.kind, 'illegal_operation');
  if (full.failure.kind === 'illegal_operation') {
    assert.equal(full.failure.issue.reason, 'capacity_exceeded');
  }
});

test('暂存容量超限：capacity_exceeded 并给出当前暂存箱号', () => {
  // 列 (1,1)：A(SHA) t0、B(SIN) t1、C(SIN) t2；容量 1，连暂存两箱
  const r = simulate({
    capacity: 1,
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [1, 1, 2] }),
    plan: planOf({ SHA: [['stash', 'C'], ['stash', 'B']], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (r.failure.kind === 'illegal_operation' && r.failure.issue.reason === 'capacity_exceeded') {
    assert.equal(r.failure.issue.boxNo, 'B');
    assert.equal(r.failure.issue.capacity, 1);
    assert.deepEqual(r.failure.issue.stashedBoxNos, ['C']);
    assert.equal(r.failure.issue.opIndex, 2);
  } else {
    assert.fail('应为 capacity_exceeded');
  }
});

test('同箱不得重复暂存：回放后再次暂存同箱 -> box_already_restowed', () => {
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    plan: planOf({ SHA: [['stash', 'B'], ['restore', 'B'], ['stash', 'B']], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (r.failure.kind === 'illegal_operation') {
    assert.equal(r.failure.issue.reason, 'box_already_restowed');
    assert.equal(r.failure.issue.boxNo, 'B');
  }
});

test('暂存非列顶箱 -> box_not_column_top（给出箱位）', () => {
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    plan: planOf({ SHA: [['stash', 'A']], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (r.failure.kind === 'illegal_operation' && r.failure.issue.reason === 'box_not_column_top') {
    assert.equal(r.failure.issue.boxNo, 'A');
    assert.deepEqual(r.failure.issue.position, pos(1, 1, 0));
  } else {
    assert.fail('应为 box_not_column_top');
  }
});

test('暂存非后续港箱 -> box_not_later_port（防御：卸港不在港序中的箱不得暂存）', () => {
  // 生产路径上该检查不可达（本港箱到顶即卸、此前港箱不会滞留），
  // 纯函数层防御性覆盖：卸港不在港序列表中的列顶箱不得暂存。
  const r = simulate({
    ports: ['SHA'],
    items: itemsOf({ A: 'SHA', B: 'ZZZ' }),
    placements: placementsOf({ A: [1, 1, 0], B: [2, 1, 0] }),
    plan: planOf({ SHA: [['stash', 'B']] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (r.failure.kind === 'illegal_operation' && r.failure.issue.reason === 'box_not_later_port') {
    assert.equal(r.failure.issue.boxNo, 'B');
    assert.equal(r.failure.issue.dischargePort, 'ZZZ');
  } else {
    assert.fail('应为 box_not_later_port');
  }
});

test('回放未暂存的箱 -> box_not_stashed', () => {
  const r = simulate({
    ports: ['SHA'],
    items: itemsOf({ A: 'SHA' }),
    placements: placementsOf({ A: [1, 1, 0] }),
    plan: planOf({ SHA: [['restore', 'A']] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (r.failure.kind === 'illegal_operation') {
    assert.equal(r.failure.issue.reason, 'box_not_stashed');
    assert.equal(r.failure.issue.boxNo, 'A');
  }
});

test('暂存未知箱 / 已卸走箱 -> box_not_aboard', () => {
  const unknown = simulate({
    ports: ['SHA'],
    items: itemsOf({ A: 'SHA' }),
    placements: placementsOf({ A: [1, 1, 0] }),
    plan: planOf({ SHA: [['stash', 'GHOST']] }),
  });
  assert.ok(!unknown.ok);
  assert.equal(unknown.failure.kind, 'illegal_operation');
  if (unknown.failure.kind === 'illegal_operation') {
    assert.equal(unknown.failure.issue.reason, 'box_not_aboard');
  }

  // A 在港开始即被自动卸走，之后再暂存 -> box_not_aboard
  const gone = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [2, 1, 0] }),
    plan: planOf({ SHA: [['stash', 'A']], SIN: [] }),
  });
  assert.ok(!gone.ok);
  assert.equal(gone.failure.kind, 'illegal_operation');
  if (gone.failure.kind === 'illegal_operation') {
    assert.equal(gone.failure.issue.reason, 'box_not_aboard');
    assert.equal(gone.failure.issue.boxNo, 'A');
  }
});

test('暂存箱跨港滞留：港结束未回放 -> stash_lingering_across_port', () => {
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    plan: planOf({ SHA: [['stash', 'B']], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'illegal_operation');
  if (
    r.failure.kind === 'illegal_operation' &&
    r.failure.issue.reason === 'stash_lingering_across_port'
  ) {
    assert.equal(r.failure.issue.port, 'SHA');
    assert.deepEqual(r.failure.issue.boxNos, ['B']);
  } else {
    assert.fail('应为 stash_lingering_across_port');
  }
});

test('港结束仍有本港箱受阻 -> port_blocked（含阻挡箱自近而远）', () => {
  // 列 (1,1)：A(SHA) t0、B(SHA) t1、C(SIN) t2；SHA 无任何操作
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SHA', C: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [1, 1, 2] }),
    plan: planOf({ SHA: [], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'port_blocked');
  if (r.failure.kind === 'port_blocked') {
    assert.equal(r.failure.port, 'SHA');
    assert.deepEqual(
      r.failure.blocked.map((b) => b.boxNo),
      ['A', 'B'],
    );
    assert.deepEqual(
      r.failure.blocked[0]!.blockers.map((b) => b.boxNo),
      ['B', 'C'],
    );
    assert.deepEqual(
      r.failure.blocked[1]!.blockers.map((b) => b.boxNo),
      ['C'],
    );
  }
});

test('回放降低层高导致危险品间距违反 -> safety_violation（暂存箱不计入船上约束）', () => {
  // 列 (1,1)：X(SHA,5类) t0、B(SIN,3类) t1；列 (2,1)：A(HAM,1类) t0
  // 规则：1类-3类 最小距离 2。初始 B(1,1,1) 与 A(2,1,0) 距离 2 合法；
  // 暂存 B 后 X 卸走，回放 B 落到 (1,1,0)，与 A 距离 1 < 2 -> 违反。
  const r = simulate({
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ X: 'SHA', B: 'SIN', A: 'HAM' }),
    placements: placementsOf({ X: [1, 1, 0], B: [1, 1, 1], A: [2, 1, 0] }),
    boxes: boxesOf({ X: '5', B: '3', A: '1' }),
    rules: new Map([['1|3', 2]]),
    plan: planOf({ SHA: [['stash', 'B'], ['restore', 'B']], SIN: [], HAM: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'safety_violation');
  if (r.failure.kind === 'safety_violation') {
    // 违反发生在第 2 步（回放）之后：第 1 步暂存时 B 不计入船上约束，不违反
    assert.equal(r.failure.opIndex, 2);
    assert.equal(r.failure.action, 'restore');
    assert.equal(r.failure.boxNo, 'B');
    assert.equal(r.failure.violations.length, 1);
    const v = r.failure.violations[0]!;
    assert.equal(v.reason, 'incompatible_too_close');
    if (v.reason === 'incompatible_too_close') {
      assert.deepEqual([v.boxA, v.boxB].sort(), ['A', 'B']);
      assert.equal(v.distance, 1);
      assert.equal(v.minDistance, 2);
    }
  }
});

test('回放不降低层高时安全约束保持合法：成功', () => {
  // 同上布局，但列 (2,1) 的 A 改为 5 类（与 3 类相容） -> 回放后无违反
  const r = simulate({
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ X: 'SHA', B: 'SIN', A: 'HAM' }),
    placements: placementsOf({ X: [1, 1, 0], B: [1, 1, 1], A: [2, 1, 0] }),
    boxes: boxesOf({ X: '5', B: '3', A: '5' }),
    rules: new Map([['1|3', 2]]),
    plan: planOf({ SHA: [['stash', 'B'], ['restore', 'B']], SIN: [], HAM: [] }),
  });
  assert.ok(r.ok);
  assert.equal(r.simulation.counts.restows, 1);
  assert.equal(r.simulation.counts.discharged, 3);
});

test('列承重防御性复验：初始布局超限时港开始即 safety_violation(column_overweight)', () => {
  // 生产中清单签发时已按当时约束复验，初始布局必合法，此检查为防御性兜底。
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
    boxes: boxesOf({ A: '1', B: '1' }),
    columnLimits: new Map([[columnKey(1, 1), weightToMicro('900')]]),
    plan: planOf({ SHA: [], SIN: [] }),
  });
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, 'safety_violation');
  if (r.failure.kind === 'safety_violation') {
    assert.equal(r.failure.opIndex, null);
    assert.equal(r.failure.violations[0]!.reason, 'column_overweight');
  }
});

test('港序一致性校验：缺港 / 顺序不同 / 多港 -> port_order_mismatch', () => {
  const reviewPorts = ['SHA', 'SIN'];
  assert.deepEqual(
    validateRestowPlanInput({ reviewPorts, plan: planOf({ SHA: [], SIN: [] }) }),
    [],
  );
  for (const plan of [
    planOf({ SHA: [] }),
    planOf({ SIN: [], SHA: [] }),
    planOf({ SHA: [], SIN: [], HAM: [] }),
  ]) {
    const issues = validateRestowPlanInput({ reviewPorts, plan });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.reason, 'port_order_mismatch');
    assert.deepEqual(issues[0]!.expectedPorts, ['SHA', 'SIN']);
  }
});

test('空清单（0 箱）：空操作方案成功，逐港全空', () => {
  const r = simulate({
    ports: ['SHA', 'SIN'],
    items: [],
    placements: [],
    plan: planOf({ SHA: [], SIN: [] }),
  });
  assert.ok(r.ok);
  assert.equal(r.simulation.portResults.length, 2);
  assert.deepEqual(r.simulation.counts, { totalBoxes: 0, discharged: 0, restows: 0 });
});
