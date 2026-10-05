import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckReportContent,
  ExpectedItem,
  Position,
  evaluateCheck,
  latestStates,
  reportInBounds,
  sameReportContent,
} from '../src/check';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });
const g = { bays: 3, rows: 2, tiers: 3 };

const expected: ExpectedItem[] = [
  { boxNo: 'BOX-1', position: pos(1, 1, 0) },
  { boxNo: 'BOX-2', position: pos(2, 1, 0) },
  { boxNo: 'BOX-3', position: pos(3, 1, 0) },
];

function report(seq: number, boxNo: string, position: Position | null): CheckReportContent & { seq: number } {
  return { seq, boxNo, revoked: position === null, position };
}

test('reportInBounds: 撤销恒合法，坐标越界被拒', () => {
  assert.equal(reportInBounds({ boxNo: 'X', revoked: true, position: null }, g), true);
  assert.equal(reportInBounds({ boxNo: 'X', revoked: false, position: pos(1, 1, 0) }, g), true);
  assert.equal(reportInBounds({ boxNo: 'X', revoked: false, position: pos(4, 1, 0) }, g), false);
  assert.equal(reportInBounds({ boxNo: 'X', revoked: false, position: pos(1, 3, 0) }, g), false);
  assert.equal(reportInBounds({ boxNo: 'X', revoked: false, position: pos(1, 1, 3) }, g), false);
  assert.equal(reportInBounds({ boxNo: 'X', revoked: false, position: pos(0, 1, 0) }, g), false);
});

test('latestStates: 以箱号最后一条（seq 最大）上报为准', () => {
  const states = latestStates([
    report(1, 'BOX-1', pos(2, 1, 0)), // 先错位上报
    report(2, 'BOX-2', null), // 撤销 => 未装
    report(3, 'BOX-1', pos(1, 1, 0)), // 后纠正
  ]);
  const b1 = states.find((s) => s.boxNo === 'BOX-1')!;
  const b2 = states.find((s) => s.boxNo === 'BOX-2')!;
  assert.deepEqual(b1.position, pos(1, 1, 0));
  assert.equal(b2.position, null);
});

test('全部一致：应装 3、已核对 3，可结案', () => {
  const states = latestStates([
    report(1, 'BOX-1', pos(1, 1, 0)),
    report(2, 'BOX-2', pos(2, 1, 0)),
    report(3, 'BOX-3', pos(3, 1, 0)),
  ]);
  const r = evaluateCheck(expected, states);
  assert.equal(r.counts.checked, 3);
  assert.equal(r.counts.missing, 0);
  assert.equal(r.counts.misplaced, 0);
  assert.equal(r.counts.extra, 0);
  assert.equal(r.closeable, true);
});

test('未上报=缺失；撤销=未装仍算缺失', () => {
  const states = latestStates([
    report(1, 'BOX-1', pos(1, 1, 0)),
    report(2, 'BOX-2', null),
  ]);
  const r = evaluateCheck(expected, states);
  assert.equal(r.checked.length, 1);
  assert.equal(r.missing.length, 2);
  const byNo = new Map(r.missing.map((m) => [m.boxNo, m.reason]));
  assert.equal(byNo.get('BOX-2'), 'revoked');
  assert.equal(byNo.get('BOX-3'), 'none');
  assert.equal(r.closeable, false);
});

test('坐标不一致=错位', () => {
  const states = latestStates([
    report(1, 'BOX-1', pos(1, 1, 0)),
    report(2, 'BOX-2', pos(2, 2, 0)),
    report(3, 'BOX-3', pos(3, 1, 0)),
  ]);
  const r = evaluateCheck(expected, states);
  assert.equal(r.misplaced.length, 1);
  assert.equal(r.misplaced[0]!.boxNo, 'BOX-2');
  assert.deepEqual(r.misplaced[0]!.actualPosition, pos(2, 2, 0));
  assert.equal(r.counts.checked, 2);
  assert.equal(r.closeable, false);
});

test('清单外箱：实装计入差异；撤销则消失', () => {
  const placed = latestStates([report(1, 'GHOST', pos(1, 2, 0))]);
  const r1 = evaluateCheck(expected, placed);
  assert.equal(r1.extra.length, 1);
  assert.equal(r1.extra[0]!.boxNo, 'GHOST');
  assert.equal(r1.closeable, false);

  const revoked = latestStates([
    report(1, 'GHOST', pos(1, 2, 0)),
    report(2, 'GHOST', null),
  ]);
  const r2 = evaluateCheck(expected, revoked);
  assert.equal(r2.extra.length, 0);
});

test('sameReportContent: 位置/撤销与箱号逐项比较', () => {
  assert.equal(
    sameReportContent(
      { boxNo: 'B', revoked: false, position: pos(1, 1, 0) },
      { boxNo: 'B', revoked: false, position: pos(1, 1, 0) },
    ),
    true,
  );
  assert.equal(
    sameReportContent(
      { boxNo: 'B', revoked: false, position: pos(1, 1, 0) },
      { boxNo: 'B', revoked: false, position: pos(1, 1, 1) },
    ),
    false,
  );
  assert.equal(
    sameReportContent(
      { boxNo: 'B', revoked: true, position: null },
      { boxNo: 'B', revoked: true, position: null },
    ),
    true,
  );
  assert.equal(
    sameReportContent(
      { boxNo: 'B', revoked: false, position: pos(1, 1, 0) },
      { boxNo: 'C', revoked: false, position: pos(1, 1, 0) },
    ),
    false,
  );
});
