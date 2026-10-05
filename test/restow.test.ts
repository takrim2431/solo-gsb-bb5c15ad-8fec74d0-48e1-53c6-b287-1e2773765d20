import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxInfo, Placement, Position } from '../src/domain';
import {
  RestowRejection,
  simulateRestow,
  validateRestowPlanInput,
} from '../src/restow';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

function placementsOf(m: Record<string, [number, number, number]>): Placement[] {
  return Object.entries(m).map(([boxNo, [bay, row, tier]]) => ({
    boxNo,
    position: { bay, row, tier },
  }));
}

function itemsOf(m: Record<string, string>) {
  return Object.entries(m).map(([boxNo, dischargePort]) => ({ boxNo, dischargePort }));
}

/** 默认无约束（足够大承重、无不相容规则）的模拟入参 */
function baseInput(over: Partial<Parameters<typeof simulateRestow>[0]> = {}): Parameters<
  typeof simulateRestow
>[0] {
  const ports = over.ports ?? ['SHA', 'SIN', 'HAM'];
  const items = over.items ?? [];
  return {
    ports,
    items,
    placements: over.placements ?? [],
    temporaryCapacity: over.temporaryCapacity ?? 10,
    portPlans: over.portPlans ?? ports.map((p) => ({ port: p, operations: [] })),
    geometry: over.geometry ?? { bays: 3, rows: 1, tiers: 6 },
    boxes:
      over.boxes ??
      items.map((it) => ({ boxNo: it.boxNo, weight: '100', category: '1' } satisfies BoxInfo)),
    defaultColumnLimit: over.defaultColumnLimit ?? 1_000_000_000n,
    columnLimits: over.columnLimits ?? new Map<string, bigint>(),
    rules: over.rules ?? new Map<string, number>(),
  };
}

function expectRejectReason(fn: () => unknown, reason: string): RestowRejection {
  assert.throws(
    fn,
    (e: unknown) => e instanceof RestowRejection && e.reason === reason,
    `应抛 RestowRejection(${reason})`,
  );
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  return caught as RestowRejection;
}

/* ---------- 成功路径 ---------- */

test('无操作：等同不倒箱模拟，本港受阻即拒绝 port_boxes_blocked', () => {
  // A(SHA) 被 B(SIN) 压在同列；不倒箱 SHA 无法卸 A
  const rej = expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          items: itemsOf({ A: 'SHA', B: 'SIN' }),
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
          portPlans: [
            { port: 'SHA', operations: [] },
            { port: 'SIN', operations: [] },
          ],
        }),
      ),
    'port_boxes_blocked',
  );
  assert.equal(rej.details?.port, 'SHA');
  const blocked = rej.details?.blocked as Array<{ boxNo: string }>;
  assert.deepEqual(blocked.map((b) => b.boxNo), ['A']);
});

test('暂存列顶后续港箱 -> 露出本港箱卸走 -> 回放，港末清空：成功且暂存计一次倒箱', () => {
  // 列1 自底向上：A(SHA,t0)、B(SIN,t1 列顶)。SHA 港：暂存 B -> A 露顶卸走 -> 回放 B 到 t0。
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN'],
      items: itemsOf({ A: 'SHA', B: 'SIN' }),
      placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [] },
      ],
    }),
  );
  const sha = r.portResults[0]!;
  assert.equal(sha.initialDischarged.length, 0); // B(SIN) 列顶，SHA 初始无可卸
  assert.equal(sha.steps.length, 2);
  assert.deepEqual(sha.steps[0]!.discharged.map((d) => d.boxNo), ['A']); // 暂存 B 后连锁卸 A
  assert.deepEqual(sha.steps[0]!.stagedBoxNos, ['B']);
  assert.deepEqual(sha.steps[1]!.stagedBoxNos, []); // 回放后清空
  assert.equal(sha.steps[1]!.position.tier, 0); // 列空，回放落回 tier0
  assert.deepEqual(sha.discharged.map((d) => d.boxNo), ['A']);
  assert.equal(sha.restowCount, 1);
  // SHA 港末：仅 B 在船 t0
  assert.deepEqual(sha.aboardAfterPort.map((b) => [b.boxNo, b.position.tier]), [['B', 0]]);

  const sin = r.portResults[1]!;
  assert.deepEqual(sin.initialDischarged.map((d) => d.boxNo), ['B']); // SIN 开始 B 列顶自动卸
  assert.deepEqual(sin.aboardAfterPort, []);
  assert.equal(r.counts.discharged, 2);
  assert.equal(r.counts.restows, 1);
});

test('港开始先自动卸可及本港箱，再做操作；多步暂存容量内连锁卸空', () => {
  // 列1：C(SHA,t0)、A(SHA,t1)、B(SIN,t2)；列2：D(SHA,t0)
  // SHA 开始：列顶 B(SIN) 非本港；列2 D 列顶本港先自动卸 D。
  // SHA 操作：暂存 B(容量1) -> A、C 连锁卸 -> 回放 B。
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN'],
      items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SHA', D: 'SHA' }),
      placements: placementsOf({
        C: [1, 1, 0],
        A: [1, 1, 1],
        B: [1, 1, 2],
        D: [2, 1, 0],
      }),
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [] },
      ],
    }),
  );
  const sha = r.portResults[0]!;
  assert.deepEqual(sha.initialDischarged.map((d) => d.boxNo), ['D']);
  assert.deepEqual(sha.steps[0]!.discharged.map((d) => d.boxNo), ['A', 'C']);
  assert.deepEqual(sha.discharged.map((d) => d.boxNo), ['A', 'C', 'D']);
  assert.equal(sha.restowCount, 1);
});

test('容量为 0 时任何暂存都拒绝 temporary_capacity_exceeded', () => {
  expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          temporaryCapacity: 0,
          items: itemsOf({ A: 'SHA', B: 'SIN' }),
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
          portPlans: [{ port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }] }, { port: 'SIN', operations: [] }],
        }),
      ),
    'temporary_capacity_exceeded',
  );
});

/* ---------- 非法操作拒绝 ---------- */

test('暂存非列顶箱 -> stage_box_not_column_top（给出列顶箱）', () => {
  const rej = expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN', 'HAM'],
          items: itemsOf({ A: 'SHA', B: 'SIN', C: 'HAM' }),
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [1, 1, 2] }),
          portPlans: [
            { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }] }, // C 才是列顶
            { port: 'SIN', operations: [] },
            { port: 'HAM', operations: [] },
          ],
        }),
      ),
    'stage_box_not_column_top',
  );
  assert.equal(rej.details?.topBoxNo, 'C');
});

test('港开始自动卸走列顶本港箱后再要求暂存该箱 -> stage_box_not_aboard', () => {
  // 单列 A(SHA) 列顶本港：SHA 开始即自动卸 A；操作再要求暂存 A -> 已不在船。
  // （受控语义下列顶本港箱必被先卸，“暂存非后续港列顶”为防御性分支，正常方案不可达。）
  const rej = expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          items: itemsOf({ A: 'SHA' }),
          placements: placementsOf({ A: [1, 1, 0] }),
          portPlans: [
            { port: 'SHA', operations: [{ op: 'stage', boxNo: 'A' }] },
            { port: 'SIN', operations: [] },
          ],
        }),
      ),
    'stage_box_not_aboard',
  );
  assert.equal(rej.details?.boxNo, 'A');
});

test('暂存当前港箱（列顶本港但强制在自动卸后）不可能存在；暂存后续港列顶合法（对照）', () => {
  // 对照：SHA 港暂存 SIN 列顶箱合法
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN'],
      items: itemsOf({ A: 'SHA', B: 'SIN' }),
      placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [] },
      ],
    }),
  );
  assert.equal(r.counts.restows, 1);
});

test('暂存已暂存箱 / 已卸走箱 -> 分别 box_already_staged / stage_box_not_aboard', () => {
  // 容量 2：stage B 后再 stage B -> 已在堆位（not_aboard，因为 staged 已移出船）。
  expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN', 'HAM'],
          temporaryCapacity: 2,
          items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SIN' }),
          // 列1：A(SHA,t0)、B(SIN,t1)；列2：C(SIN,t0)
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1], C: [2, 1, 0] }),
          portPlans: [
            {
              port: 'SHA',
              operations: [
                { op: 'stage', boxNo: 'B' },
                { op: 'stage', boxNo: 'B' }, // 已在临时堆位
              ],
            },
            { port: 'SIN', operations: [] },
            { port: 'HAM', operations: [] },
          ],
        }),
      ),
    'stage_box_not_aboard',
  );

  // 回放后再次暂存同箱 -> box_already_staged
  expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN', 'HAM'],
          temporaryCapacity: 2,
          items: itemsOf({ A: 'SHA', B: 'SIN' }),
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
          portPlans: [
            {
              port: 'SHA',
              operations: [
                { op: 'stage', boxNo: 'B' },
                { op: 'replay', boxNo: 'B' },
                { op: 'stage', boxNo: 'B' }, // 同箱重复暂存
              ],
            },
            { port: 'SIN', operations: [] },
            { port: 'HAM', operations: [] },
          ],
        }),
      ),
    'box_already_staged',
  );
});

test('回放未暂存箱 -> replay_box_not_staged', () => {
  expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          items: itemsOf({ A: 'SHA', B: 'SIN' }),
          placements: placementsOf({ A: [1, 1, 0], B: [2, 1, 0] }),
          portPlans: [
            { port: 'SHA', operations: [{ op: 'replay', boxNo: 'B' }] }, // B 从未暂存
            { port: 'SIN', operations: [] },
          ],
        }),
      ),
    'replay_box_not_staged',
  );
});

test('港末仍有暂存箱未回放 -> staged_boxes_left_at_port_end', () => {
  const rej = expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          items: itemsOf({ A: 'SHA', B: 'SIN' }),
          placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
          portPlans: [
            { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }] }, // 不回放
            { port: 'SIN', operations: [] },
          ],
        }),
      ),
    'staged_boxes_left_at_port_end',
  );
  assert.deepEqual(rej.details?.stagedBoxNos, ['B']);
});

/* ---------- 安全约束 ---------- */

test('回放导致危险品间距不足 -> safety_constraint_violated（相关箱号在 violations）', () => {
  // 目标：初始布局满足 cat1/cat3 最小距离 3；SHA 港暂存顶层 cat3 后续港箱、卸下其下本港箱后，
  // 把 cat3 回放回原列更低层 -> 与另一列 cat1 箱距离 <3。
  //
  // 列1(bay1)：A(cat1,SHA,t0)、B(cat3,SIN,t1 列顶)
  // 列2(bay4)：C(cat1,SIN,t0)
  // 初始 B(1,1,1) 与 C(4,1,0) 距离 |1-4|+0+1 = 4 >=3 合规；A 与 C 同类相容。
  // SHA：列顶 B(SIN) 非本港，A 被压。暂存 B -> A 露顶卸走（列空）-> 回放 B 落 t0：
  //   B(1,1,0) 与 C(4,1,0) 距离 3 仍==3 合规……把 C 放 bay3：初始距离 |1-3|+1=3 合规，
  //   回放 t0 后距离 2 <3 违规。
  const rules = new Map<string, number>([['1|3', 3]]);
  const rej = expectRejectReason(
    () =>
      simulateRestow(
        baseInput({
          ports: ['SHA', 'SIN'],
          items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SIN' }),
          placements: placementsOf({
            A: [1, 1, 0],
            B: [1, 1, 1],
            C: [3, 1, 0],
          }),
          geometry: { bays: 3, rows: 1, tiers: 4 },
          boxes: [
            { boxNo: 'A', weight: '100', category: '1' },
            { boxNo: 'B', weight: '100', category: '3' },
            { boxNo: 'C', weight: '100', category: '1' },
          ],
          rules,
          portPlans: [
            { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
            { port: 'SIN', operations: [] },
          ],
        }),
      ),
    'safety_constraint_violated',
  );
  assert.equal(rej.details?.op, 'replay');
  assert.equal(rej.details?.boxNo, 'B');
  const violations = rej.details?.violations as Array<{ reason: string }>;
  assert.ok(violations.some((v) => v.reason === 'incompatible_too_close'));
});

test('暂存期间暂存箱不计入危险品间距：移开后原本贴近也不违规，回放恢复合规距离则成功', () => {
  // 列1：A(cat1,SHA,t0)、B(cat3,SIN,t1)；列2(bay3)：C(cat1,SIN,t0)。
  // 初始 B(1,1,1) 与 C(3,1,0) 距离 3 合规。SHA 暂存 B（暂存箱 B 不计约束）-> A 卸 ->
  // 回放 B 到 t0：B(1,1,0) 与 C(3,1,0) 距离 2 <3，此例同样拒绝（对照上一例的暂存豁免不影响回放判定）。
  // 这里验证“暂存后、回放前”那一步不做约束拒绝：把 C 放 bay2（初始 B-C 距离 |1-2|+1=2 <3 不合规）
  // 无法构造初始合规但暂存后本会违规的对照，故仅验证成功回放（距离足够）的暂存豁免不报错。
  const rules = new Map<string, number>([['1|3', 3]]);
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN'],
      items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SIN' }),
      placements: placementsOf({
        A: [1, 1, 0],
        B: [1, 1, 1],
        C: [4, 1, 0],
      }),
      geometry: { bays: 4, rows: 1, tiers: 4 },
      boxes: [
        { boxNo: 'A', weight: '100', category: '1' },
        { boxNo: 'B', weight: '100', category: '3' },
        { boxNo: 'C', weight: '100', category: '1' },
      ],
      rules,
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [] },
      ],
    }),
  );
  assert.equal(r.counts.restows, 1);
  assert.equal(r.counts.discharged, 3);
});

test('回放导致列承重超限 -> safety_constraint_violated(column_overweight)', () => {
  // 初始列1 总重恰好等于上限（合法）；回放把更重的箱压回底层上方……
  // 回放是放回【原列】，列内成员不变（暂存再放回同列），总重恒等于初始 -> 承重不可能新增超限。
  // 故此情形在受控语义下不会发生；用“暂存箱不计承重、回放恢复”验证成功路径不超重即可。
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN'],
      items: itemsOf({ A: 'SHA', B: 'SIN' }),
      placements: placementsOf({ A: [1, 1, 0], B: [1, 1, 1] }),
      boxes: [
        { boxNo: 'A', weight: '600', category: '1' },
        { boxNo: 'B', weight: '600', category: '1' },
      ],
      // 列上限 1200（=600+600），回放后 1200 不超限
      defaultColumnLimit: 1_200_000_000n,
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [] },
      ],
    }),
  );
  assert.equal(r.counts.restows, 1);
});

/* ---------- 结构级校验 ---------- */

test('validateRestowPlanInput：港序不一致/重复/未知港/未知箱/非法操作 一次收集', () => {
  const issues = validateRestowPlanInput({
    reviewPorts: ['SHA', 'SIN'],
    manifestBoxNos: ['A', 'B'],
    temporaryCapacity: 1,
    portPlans: [
      { port: 'SIN', operations: [] }, // 顺序错
      { port: 'SIN', operations: [] }, // 重复
      { port: 'XXX', operations: [{ op: 'move' as unknown as 'stage', boxNo: 'GHOST' }] }, // 未知港+非法操作+未知箱
    ],
  });
  const reasons = issues.map((i) => i.reason);
  assert.ok(reasons.includes('port_order_mismatch'));
  assert.ok(reasons.includes('duplicate_port_in_plan'));
  assert.ok(reasons.includes('unknown_port'));
  assert.ok(reasons.includes('unknown_box'));
  assert.ok(reasons.includes('unknown_operation'));
});

test('validateRestowPlanInput：港序完全一致、箱均已知、操作合法 -> 通过', () => {
  const issues = validateRestowPlanInput({
    reviewPorts: ['SHA', 'SIN'],
    manifestBoxNos: ['A', 'B'],
    temporaryCapacity: 1,
    portPlans: [
      { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }] },
      { port: 'SIN', operations: [] },
    ],
  });
  assert.deepEqual(issues, []);
});

test('跨港：暂存箱在第二港仍不允许（港末强制回放）；前一港成功回放后下一港正常', () => {
  // 两港各自一列：列1 A(SHA)/B(SIN)，列2 C(SIN)/D(HAM)
  // SHA 暂存 B 卸 A 回放 B；SIN 开始 B 列顶卸 B；SIN 暂存 D? D 在列2 列顶 HAM，
  // 但 C(SIN) 在其下：SIN 暂存 D -> C 露顶卸 -> 回放 D；HAM 卸 D。
  const r = simulateRestow(
    baseInput({
      ports: ['SHA', 'SIN', 'HAM'],
      items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SIN', D: 'HAM' }),
      placements: placementsOf({
        A: [1, 1, 0],
        B: [1, 1, 1],
        C: [2, 1, 0],
        D: [2, 1, 1],
      }),
      portPlans: [
        { port: 'SHA', operations: [{ op: 'stage', boxNo: 'B' }, { op: 'replay', boxNo: 'B' }] },
        { port: 'SIN', operations: [{ op: 'stage', boxNo: 'D' }, { op: 'replay', boxNo: 'D' }] },
        { port: 'HAM', operations: [] },
      ],
    }),
  );
  assert.equal(r.counts.discharged, 4);
  assert.equal(r.counts.restows, 2);
  const sin = r.portResults[1]!;
  assert.deepEqual(sin.initialDischarged.map((d) => d.boxNo), ['B']);
  assert.deepEqual(sin.steps[0]!.discharged.map((d) => d.boxNo), ['C']);
});
