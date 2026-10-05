/**
 * 现场装船核对领域逻辑（纯函数）。
 *
 * 核对作业以某修订号的【已签发冻结清单】为基准。现场每次上报一个箱：
 *   - 实装位置（三维坐标）或撤销标记（表示未装）；
 *   - 携带唯一上报号（幂等键，存储在 service 层）。
 * 以【箱号最后一条上报】确定该箱当前实装状态；从未上报过的清单箱为“缺失”。
 */

import { Geometry, Position, positionInBounds, positionKey } from './domain';

/** 冻结清单中应装的一箱 */
export interface ExpectedItem {
  boxNo: string;
  position: Position;
}

/** 箱号最后一条上报所确定的当前实装状态 */
export interface CheckedState {
  boxNo: string;
  /** null 表示该箱最后一条上报是撤销（当前未装） */
  position: Position | null;
}

/** 一次上报的归一化内容：撤销 或 实装位置二选一 */
export interface CheckReportContent {
  boxNo: string;
  /** true 表示撤销（未装）；此时 position 必须为 null */
  revoked: boolean;
  position: Position | null;
}

/** 已核对：清单箱，当前实装坐标与冻结清单坐标一致（撤销不算已核对） */
export interface CheckedDetail {
  boxNo: string;
  expectedPosition: Position;
  actualPosition: Position;
}

/** 缺失：清单箱尚无有效实装——从未上报，或最后一条上报为撤销 */
export interface MissingDetail {
  boxNo: string;
  expectedPosition: Position;
  /** none=从未上报；revoked=最后一条上报为撤销 */
  reason: 'none' | 'revoked';
}

/** 错位：清单箱当前实装坐标与其冻结清单坐标不一致 */
export interface MisplacedDetail {
  boxNo: string;
  expectedPosition: Position;
  actualPosition: Position;
}

/** 清单外箱：上报箱号不在冻结清单中；当前已装（最后一条上报非撤销）才算差异 */
export interface ExtraDetail {
  boxNo: string;
  actualPosition: Position;
}

/** 应装明细：冻结清单中每箱的计划位置（与清单顺序一致，按箱号排序） */
export interface ExpectedDetail extends ExpectedItem {}

export interface CheckEvaluation {
  expected: ExpectedDetail[];
  checked: CheckedDetail[];
  missing: MissingDetail[];
  misplaced: MisplacedDetail[];
  extra: ExtraDetail[];
  counts: {
    expected: number;
    checked: number;
    missing: number;
    misplaced: number;
    extra: number;
  };
  /** 所有清单箱当前坐标与冻结清单一致且无清单外箱 */
  closeable: boolean;
}

function samePosition(a: Position, b: Position): boolean {
  return a.bay === b.bay && a.row === b.row && a.tier === b.tier;
}

/**
 * 校验上报坐标是否在航次舱位范围内。撤销上报天然合法；
 * 位置上报要求整数且不越界。
 */
export function reportInBounds(content: CheckReportContent, geometry: Geometry): boolean {
  if (content.revoked) return true;
  const p = content.position;
  if (!p) return false;
  return positionInBounds(p, geometry);
}

/**
 * 以“箱号最后一条上报”汇总当前实装状态。
 * 输入 reports 顺序无关；同箱号取 seq 最大者。
 */
export function latestStates(
  reports: Array<CheckReportContent & { seq: number }>,
): CheckedState[] {
  const latest = new Map<string, { seq: number; position: Position | null }>();
  for (const r of reports) {
    const cur = latest.get(r.boxNo);
    if (!cur || r.seq > cur.seq) {
      latest.set(r.boxNo, { seq: r.seq, position: r.revoked ? null : r.position });
    }
  }
  return [...latest.entries()]
    .map(([boxNo, v]) => ({ boxNo, position: v.position }))
    .sort((a, b) => a.boxNo.localeCompare(b.boxNo));
}

/**
 * 计算当前核对明细：应装 / 已核对 / 缺失 / 错位 / 清单外箱。
 *
 * 判定规则：
 *  - 清单箱有最后上报且位置与清单一致 → 已核对；
 *  - 清单箱有最后上报但位置与清单不一致 → 错位（撤销位置不存在，不构成错位）；
 *  - 清单箱无上报，或最后上报为撤销 → 缺失；
 *  - 非清单箱最后上报为实装 → 清单外箱；最后上报为撤销则不出现在任何明细。
 */
export function evaluateCheck(
  expectedItems: ExpectedItem[],
  states: CheckedState[],
): CheckEvaluation {
  const expected = [...expectedItems].sort((a, b) => a.boxNo.localeCompare(b.boxNo));
  const expectedMap = new Map(expected.map((e) => [e.boxNo, e]));

  const checked: CheckedDetail[] = [];
  const missing: MissingDetail[] = [];
  const misplaced: MisplacedDetail[] = [];
  const extra: ExtraDetail[] = [];

  for (const e of expected) {
    const state = states.find((s) => s.boxNo === e.boxNo);
    if (!state) {
      missing.push({ boxNo: e.boxNo, expectedPosition: e.position, reason: 'none' });
    } else if (state.position === null) {
      missing.push({ boxNo: e.boxNo, expectedPosition: e.position, reason: 'revoked' });
    } else if (samePosition(state.position, e.position)) {
      checked.push({
        boxNo: e.boxNo,
        expectedPosition: e.position,
        actualPosition: state.position,
      });
    } else {
      misplaced.push({
        boxNo: e.boxNo,
        expectedPosition: e.position,
        actualPosition: state.position,
      });
    }
  }

  for (const s of states) {
    if (!expectedMap.has(s.boxNo) && s.position !== null) {
      extra.push({ boxNo: s.boxNo, actualPosition: s.position });
    }
  }
  extra.sort((a, b) => a.boxNo.localeCompare(b.boxNo));

  const closeable =
    missing.length === 0 && misplaced.length === 0 && extra.length === 0;

  return {
    expected,
    checked,
    missing,
    misplaced,
    extra,
    counts: {
      expected: expected.length,
      checked: checked.length,
      missing: missing.length,
      misplaced: misplaced.length,
      extra: extra.length,
    },
    closeable,
  };
}

/** 上报内容是否相同（用于相同上报号重试的幂等/冲突判定） */
export function sameReportContent(a: CheckReportContent, b: CheckReportContent): boolean {
  if (a.boxNo !== b.boxNo || a.revoked !== b.revoked) return false;
  if (a.revoked && b.revoked) return true;
  if (!a.position || !b.position) return false;
  return positionKey(a.position) === positionKey(b.position);
}
