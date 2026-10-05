import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePort,
  parseTimeWindow,
  sameAdjustmentContent,
  sameBookingContent,
} from '../src/berthing';
import { DischargeSimulation } from '../src/discharge';

function simulation(
  ports: Array<{ port: string; discharged: number; blocked: number }>,
): DischargeSimulation {
  return {
    ports: ports.map((p) => p.port),
    portResults: ports.map((p, i) => ({
      port: p.port,
      portIndex: i + 1,
      discharged: Array.from({ length: p.discharged }, (_, k) => ({
        boxNo: `D${i}-${k}`,
        position: { bay: 1, row: 1, tier: k },
      })),
      blocked: Array.from({ length: p.blocked }, (_, k) => ({
        boxNo: `B${i}-${k}`,
        position: { bay: 1, row: 1, tier: k },
        dischargePort: p.port,
        blockers: [],
      })),
    })),
    overCarried: [],
    feasibleWithoutRestow: ports.every((p) => p.blocked === 0),
    counts: {
      totalBoxes: 0,
      discharged: ports.reduce((s, p) => s + p.discharged, 0),
      blockedAtOwnPort: ports.reduce((s, p) => s + p.blocked, 0),
      overCarried: 0,
    },
  };
}

/* ---------- parseTimeWindow ---------- */

test('合法窗口：Z 与偏移均可，解析为绝对时刻', () => {
  const r = parseTimeWindow({
    startAt: '2026-10-05T08:00:00Z',
    endAt: '2026-10-05T18:00:00+08:00',
  });
  assert.deepEqual(r.issues, []);
  assert.ok(r.start && r.end);
  // end 18:00+08 = 10:00Z，晚于 08:00Z
  assert.equal(r.end!.getTime() - r.start!.getTime(), 2 * 3600_000);
});

test('不同时区写法指向同一绝对时刻仍可正确比较', () => {
  const r = parseTimeWindow({
    startAt: '2026-10-05 08:00:00+00:00',
    endAt: '2026-10-05T16:00:00+08:00',
  });
  // 08:00Z == 16:00+08 => 起点不早于终点
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0]!.reason, 'start_not_before_end');
});

test('起点等于终点被拒绝', () => {
  const r = parseTimeWindow({
    startAt: '2026-10-05T08:00:00Z',
    endAt: '2026-10-05T08:00:00Z',
  });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0]!.reason, 'start_not_before_end');
  assert.equal(r.start, undefined);
});

test('起点晚于终点被拒绝', () => {
  const r = parseTimeWindow({
    startAt: '2026-10-06T08:00:00Z',
    endAt: '2026-10-05T08:00:00Z',
  });
  assert.equal(r.issues[0]!.reason, 'start_not_before_end');
});

test('缺少时区的本地时刻被拒绝', () => {
  const r = parseTimeWindow({
    startAt: '2026-10-05T08:00:00',
    endAt: '2026-10-05T09:00:00',
  });
  assert.equal(r.issues.length, 2);
  assert.ok(r.issues.every((i) => i.reason === 'unparsable_time'));
});

test('形态合法但日期不存在（13 月）被拒绝', () => {
  const r = parseTimeWindow({
    startAt: '2026-13-05T08:00:00Z',
    endAt: '2026-13-05T09:00:00Z',
  });
  assert.equal(r.issues.length, 2);
  assert.ok(r.issues.every((i) => i.reason === 'unparsable_time'));
});

/* ---------- evaluatePort ---------- */

test('有实际卸箱且无受阻：受理', () => {
  const sim = simulation([
    { port: 'SHA', discharged: 1, blocked: 0 },
    { port: 'SIN', discharged: 2, blocked: 0 },
  ]);
  const a = evaluatePort(sim, 'SIN');
  assert.deepEqual(a, { known: true, dischargedCount: 2, blockedCount: 0, acceptable: true });
});

test('有受阻箱：不受理', () => {
  const sim = simulation([
    { port: 'SHA', discharged: 0, blocked: 2 },
    { port: 'SIN', discharged: 1, blocked: 0 },
  ]);
  const a = evaluatePort(sim, 'SHA');
  assert.equal(a.known, true);
  assert.equal(a.acceptable, false);
  assert.equal(a.dischargedCount, 0);
  assert.equal(a.blockedCount, 2);
});

test('既有实际卸箱又有受阻箱：仍不受理', () => {
  const sim = simulation([{ port: 'SHA', discharged: 1, blocked: 1 }]);
  assert.equal(evaluatePort(sim, 'SHA').acceptable, false);
});

test('港不在审查港序中：未知', () => {
  const sim = simulation([{ port: 'SHA', discharged: 1, blocked: 0 }]);
  const a = evaluatePort(sim, 'XXX');
  assert.deepEqual(a, { known: false, dischargedCount: 0, blockedCount: 0, acceptable: false });
});

/* ---------- sameBookingContent ---------- */

test('同内容（不同时区写法、同一绝对时刻）判为一致', () => {
  assert.equal(
    sameBookingContent(
      { dischargePort: 'SIN', berth: 'B-1', startMs: Date.parse('2026-10-05T08:00:00Z'), endMs: Date.parse('2026-10-05T09:00:00Z') },
      { dischargePort: 'SIN', berth: 'B-1', startMs: Date.parse('2026-10-05T16:00:00+08:00'), endMs: Date.parse('2026-10-05T17:00:00+08:00') },
    ),
    true,
  );
});

test('改泊位/改时刻/改港任一不同即冲突', () => {
  const base = { dischargePort: 'SIN', berth: 'B-1', startMs: 0, endMs: 1000 };
  assert.equal(sameBookingContent(base, { ...base, berth: 'B-2' }), false);
  assert.equal(sameBookingContent(base, { ...base, endMs: 2000 }), false);
  assert.equal(sameBookingContent(base, { ...base, dischargePort: 'SHA' }), false);
});

/* ---------- sameAdjustmentContent ---------- */

test('改期同内容（不同时区写法、同一绝对时刻）判为一致', () => {
  assert.equal(
    sameAdjustmentContent(
      { berth: 'B-1', startMs: Date.parse('2026-10-05T08:00:00Z'), endMs: Date.parse('2026-10-05T09:00:00Z') },
      { berth: 'B-1', startMs: Date.parse('2026-10-05T16:00:00+08:00'), endMs: Date.parse('2026-10-05T17:00:00+08:00') },
    ),
    true,
  );
});

test('改期改泊位/改起止任一不同即冲突', () => {
  const base = { berth: 'B-1', startMs: 0, endMs: 1000 };
  assert.equal(sameAdjustmentContent(base, { ...base, berth: 'B-2' }), false);
  assert.equal(sameAdjustmentContent(base, { ...base, startMs: 500 }), false);
  assert.equal(sameAdjustmentContent(base, { ...base, endMs: 2000 }), false);
});

test('改期内容不含港/审查：只比较泊位与起止绝对时刻', () => {
  // 非法时刻解析为 NaN 时与任何已存内容都不一致（NaN !== NaN）
  const stored = { berth: 'B-1', startMs: 1000, endMs: 2000 };
  assert.equal(sameAdjustmentContent(stored, { berth: 'B-1', startMs: NaN, endMs: 2000 }), false);
});
