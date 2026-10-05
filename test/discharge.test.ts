import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, Position } from '../src/domain';
import {
  simulateDischarge,
  validateDischargeReviewInput,
} from '../src/discharge';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

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

test('全部箱各自列顶、逐港卸空：全程无倒箱可行', () => {
  const r = simulateDischarge({
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ A: 'SHA', B: 'SIN', C: 'HAM' }),
    placements: placementsOf({
      A: [1, 1, 0],
      B: [2, 1, 0],
      C: [3, 1, 0],
    }),
  });
  assert.equal(r.feasibleWithoutRestow, true);
  assert.deepEqual(
    r.portResults.map((p) => p.discharged.map((d) => d.boxNo)),
    [['A'], ['B'], ['C']],
  );
  assert.deepEqual(r.portResults.map((p) => p.blocked), [[], [], []]);
  assert.deepEqual(r.overCarried, []);
  assert.deepEqual(r.counts, {
    totalBoxes: 3,
    discharged: 3,
    blockedAtOwnPort: 0,
    overCarried: 0,
  });
});

test('同港箱叠放：列顶本港箱卸走后连锁卸出下层全部本港箱', () => {
  // 同列自底向上：C(SIN) 底、A(SHA) 中、B(SHA) 列顶
  const r = simulateDischarge({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SHA', C: 'SIN' }),
    placements: placementsOf({
      C: [1, 1, 0],
      A: [1, 1, 1],
      B: [1, 1, 2],
    }),
  });
  assert.equal(r.feasibleWithoutRestow, true);
  assert.deepEqual(r.portResults[0]!.discharged.map((d) => d.boxNo), ['A', 'B']);
  assert.deepEqual(r.portResults[0]!.blocked, []);
  assert.deepEqual(r.portResults[1]!.discharged.map((d) => d.boxNo), ['C']);
});

test('被后续港箱压住的本港箱留船，后续港不回补：本港受阻、最终逾港', () => {
  // 列1：A(SHA) tier0 在下，B(SIN) tier1 在上 —— A 被压
  // 列2：C(SHA) tier0 单列顶，SHA 正常卸
  const r = simulateDischarge({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN', C: 'SHA' }),
    placements: placementsOf({
      A: [1, 1, 0],
      B: [1, 1, 1],
      C: [2, 1, 0],
    }),
  });
  assert.equal(r.feasibleWithoutRestow, false);

  const sha = r.portResults[0]!;
  assert.deepEqual(sha.discharged.map((d) => d.boxNo), ['C']);
  assert.equal(sha.blocked.length, 1);
  assert.equal(sha.blocked[0]!.boxNo, 'A');
  assert.deepEqual(sha.blocked[0]!.blockers, [
    { boxNo: 'B', position: pos(1, 1, 1), dischargePort: 'SIN', relation: 'later' },
  ]);

  // SIN 港：B 成为列顶卸走；不回补此前漏卸的 A
  const sin = r.portResults[1]!;
  assert.deepEqual(sin.discharged.map((d) => d.boxNo), ['B']);
  assert.deepEqual(sin.blocked, []);

  assert.deepEqual(r.overCarried.map((b) => b.boxNo), ['A']);
  assert.equal(r.overCarried[0]!.dischargePort, 'SHA');
  assert.equal(r.overCarried[0]!.dischargePortIndex, 1);
  assert.deepEqual(r.counts, {
    totalBoxes: 3,
    discharged: 2,
    blockedAtOwnPort: 1,
    overCarried: 1,
  });
});

test('阻挡箱自近而远全部列出，关系区分 same / later', () => {
  // 同列自底向上：A(SHA)、B(SHA)、C(SIN) 列顶 —— SHA 港 A、B 均受阻
  const r = simulateDischarge({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SHA', C: 'SIN' }),
    placements: placementsOf({
      A: [1, 1, 0],
      B: [1, 1, 1],
      C: [1, 1, 2],
    }),
  });
  assert.equal(r.feasibleWithoutRestow, false);

  const blockedA = r.portResults[0]!.blocked.find((b) => b.boxNo === 'A')!;
  assert.deepEqual(
    blockedA.blockers.map((b) => [b.boxNo, b.relation]),
    [
      ['B', 'same'],
      ['C', 'later'],
    ],
  );
  const blockedB = r.portResults[0]!.blocked.find((b) => b.boxNo === 'B')!;
  assert.deepEqual(blockedB.blockers.map((b) => [b.boxNo, b.relation]), [['C', 'later']]);

  // SIN 港 C 卸走，A、B 露顶但 SIN 不回补 -> 全部逾港
  assert.deepEqual(r.portResults[1]!.discharged.map((d) => d.boxNo), ['C']);
  assert.deepEqual(r.overCarried.map((b) => b.boxNo), ['A', 'B']);
});

test('漏港箱在后续港成为阻挡箱：阻挡关系标 earlier', () => {
  // 同列自底向上：S(SIN,0) 底、A(SHA,1) 中、B(SIN,2) 列顶
  // SHA 港：列顶 B(SIN) 非本港，A 受阻 [B later]，A 漏港；
  // SIN 港：B 列顶先卸 -> 列顶变 A(SHA，已逾港) 非本港，
  //         底层 S 被 A 压住无法卸：S 的阻挡箱 A 即 earlier（逾港未卸箱）。
  const r = simulateDischarge({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ S: 'SIN', A: 'SHA', B: 'SIN' }),
    placements: placementsOf({
      S: [1, 1, 0],
      A: [1, 1, 1],
      B: [1, 1, 2],
    }),
  });
  assert.equal(r.feasibleWithoutRestow, false);

  const sin = r.portResults[1]!;
  assert.deepEqual(sin.discharged.map((d) => d.boxNo), ['B']);
  const blockedS = sin.blocked.find((b) => b.boxNo === 'S')!;
  assert.deepEqual(
    blockedS.blockers.map((x) => [x.boxNo, x.relation]),
    [['A', 'earlier']],
  );
  assert.deepEqual(r.overCarried.map((b) => b.boxNo), ['A', 'S']);
});

test('跨列互不影响；无箱停靠的港结果为空但仍占港序', () => {
  const r = simulateDischarge({
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ A: 'SHA', B: 'HAM' }),
    placements: placementsOf({ A: [1, 1, 0], B: [1, 2, 0] }),
  });
  assert.equal(r.portResults.length, 3);
  assert.equal(r.portResults[1]!.port, 'SIN');
  assert.deepEqual(r.portResults[1]!.discharged, []);
  assert.deepEqual(r.portResults[1]!.blocked, []);
  assert.equal(r.feasibleWithoutRestow, true);
});

/* ---------- 请求级校验 ---------- */

test('校验：空港序列表拒绝', () => {
  const issues = validateDischargeReviewInput({
    ports: [],
    items: itemsOf({ A: 'SHA' }),
    manifestBoxNos: ['A'],
  });
  assert.ok(issues.some((i) => i.reason === 'empty_port_order'));
});

test('校验：重复港序拒绝并给出港名与次数', () => {
  const issues = validateDischargeReviewInput({
    ports: ['SHA', 'SIN', 'SHA'],
    items: itemsOf({ A: 'SHA' }),
    manifestBoxNos: ['A'],
  });
  const dup = issues.find((i) => i.reason === 'duplicate_port_in_order');
  assert.ok(dup);
  if (dup?.reason === 'duplicate_port_in_order') {
    assert.equal(dup.port, 'SHA');
    assert.equal(dup.occurrences, 2);
  }
});

test('校验：同箱重复申报 / 清单外箱 / 缺漏箱 / 卸港不在列表，一次性返回', () => {
  const issues = validateDischargeReviewInput({
    ports: ['SHA', 'SIN'],
    items: [
      { boxNo: 'A', dischargePort: 'SHA' },
      { boxNo: 'A', dischargePort: 'SIN' }, // 重复箱号
      { boxNo: 'X', dischargePort: 'SHA' }, // 清单外（多余箱）
      { boxNo: 'Y', dischargePort: 'HAM' }, // 申报了未知港
    ],
    manifestBoxNos: ['A', 'Y', 'Z'], // Z 缺漏申报
  });
  const reasons = issues.map((i) => i.reason);
  assert.ok(reasons.includes('duplicate_box_in_request'));
  assert.ok(reasons.includes('unknown_box_for_manifest'));
  assert.ok(reasons.includes('manifest_box_missing'));
  assert.ok(reasons.includes('unknown_discharge_port'));
});

test('校验：箱号与清单完全一致、港序合法时通过（与排序无关）', () => {
  const issues = validateDischargeReviewInput({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ A: 'SHA', B: 'SIN' }),
    manifestBoxNos: ['B', 'A'],
  });
  assert.deepEqual(issues, []);
});

test('空清单（0 箱）：空申报合法，逐港全空、全程无倒箱可行', () => {
  const issues = validateDischargeReviewInput({
    ports: ['SHA', 'SIN'],
    items: [],
    manifestBoxNos: [],
  });
  assert.deepEqual(issues, []);
  const r = simulateDischarge({ ports: ['SHA', 'SIN'], items: [], placements: [] });
  assert.equal(r.feasibleWithoutRestow, true);
  assert.equal(r.portResults.length, 2);
  assert.deepEqual(r.overCarried, []);
  assert.deepEqual(r.counts, { totalBoxes: 0, discharged: 0, blockedAtOwnPort: 0, overCarried: 0 });
});
