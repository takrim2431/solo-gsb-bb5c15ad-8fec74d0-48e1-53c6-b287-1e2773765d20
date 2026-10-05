/**
 * 靠泊窗口预订 —— 纯函数（无 I/O）。
 *
 * 港口调度员依据【已留档的卸货审查】预订靠泊窗口：
 *  - 提交带时区的起止时刻（ISO 8601，必须含时区偏移或 Z），起点必须严格早于终点；
 *  - 仅当审查中该卸港【确有实际卸箱且无受阻箱】时才受理（受阻箱是“该港卸不下来的箱”，
 *    有受阻说明该港无法完成卸货，不受理）；
 *  - 提交内容（港/泊位/起止/提交号）的一致性比较用于“同号同内容重试”幂等；
 *  - 改期内容（新泊位/起止/调整号）的一致性比较用于“同调整号同内容重试”幂等。
 *
 * 具体的留档读取、冻结与并发互斥由 berth-service 编排。
 */

import { DischargeSimulation, PortDischargeResult } from './discharge';

/* ---------- 带时区时刻 ---------- */

/**
 * ISO 8601 带时区日期时间：
 *   YYYY-MM-DD[T或空格]HH:mm[:ss[.fff]] 后跟 Z（UTC）或 ±HH:mm（必填时区）。
 * 拒绝“无时区”的本地时刻，避免预订时刻含义不明。
 */
const TIMEZONED_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export type TimeWindowIssue =
  | { reason: 'unparsable_time'; message: string; field: 'startAt' | 'endAt'; value: string }
  | { reason: 'start_not_before_end'; message: string; startAt: string; endAt: string };

/**
 * 解析并校验预订窗口：
 *  - 两端都必须是合法的带时区时刻（字符串形态 + Date 可解析，双重把关排除 13 月之类）；
 *  - 起点必须严格早于终点（相等即拒绝；首尾相接指“本窗口 end == 另一窗口 start”，由区间互斥处理）。
 * 问题一次性全部返回；无问题时返回换算好的绝对时刻 Date（用于入库与比较）。
 */
export function parseTimeWindow(input: {
  startAt: string;
  endAt: string;
}): { issues: TimeWindowIssue[]; start?: Date; end?: Date } {
  const issues: TimeWindowIssue[] = [];

  const parseOne = (raw: string, field: 'startAt' | 'endAt'): Date | null => {
    if (!TIMEZONED_INSTANT_RE.test(raw)) {
      issues.push({
        reason: 'unparsable_time',
        message: `${field === 'startAt' ? '起始' : '结束'}时刻非法或缺少时区：${raw}（要求 ISO 8601 带时区，如 2026-10-05T08:00:00+08:00）`,
        field,
        value: raw,
      });
      return null;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      issues.push({
        reason: 'unparsable_time',
        message: `${field === 'startAt' ? '起始' : '结束'}时刻无法解析：${raw}`,
        field,
        value: raw,
      });
      return null;
    }
    return d;
  };

  const start = parseOne(input.startAt, 'startAt');
  const end = parseOne(input.endAt, 'endAt');

  if (start && end && start.getTime() >= end.getTime()) {
    issues.push({
      reason: 'start_not_before_end',
      message: `起始时刻必须严格早于结束时刻：${input.startAt} 不早于 ${input.endAt}`,
      startAt: input.startAt,
      endAt: input.endAt,
    });
    return { issues };
  }

  if (issues.length > 0 || !start || !end) return { issues };
  return { issues, start, end };
}

/* ---------- 卸港是否可受理（该港有实际卸箱且无受阻箱） ---------- */

export interface PortAcceptance {
  /** 该港是否在审查港序中存在 */
  known: boolean;
  /** 该港实际卸下的箱数（列顶模拟中本港真正离船的箱） */
  dischargedCount: number;
  /** 该港受阻留船的箱数（应在本港卸却卸不下来） */
  blockedCount: number;
  /** 受理：港存在、有实际卸箱且无受阻箱 */
  acceptable: boolean;
}

/**
 * 依据已冻结的卸货模拟结果判断某卸港能否受理靠泊预订：
 *  - 港不在审查港序中 -> known:false（未知卸港）；
 *  - 实际卸箱数必须 > 0（“仅该港有实际卸箱”）；
 *  - 受阻箱数必须为 0（“且无受阻箱”）。
 */
export function evaluatePort(simulation: DischargeSimulation, port: string): PortAcceptance {
  const result: PortDischargeResult | undefined = simulation.portResults.find(
    (p) => p.port === port,
  );
  if (!result) {
    return { known: false, dischargedCount: 0, blockedCount: 0, acceptable: false };
  }
  const dischargedCount = result.discharged.length;
  const blockedCount = result.blocked.length;
  return {
    known: true,
    dischargedCount,
    blockedCount,
    acceptable: dischargedCount > 0 && blockedCount === 0,
  };
}

/* ---------- 提交内容一致性（同号重试幂等） ---------- */

/** 一次靠泊窗口预订的业务内容（提交号是幂等键，不参与内容比较） */
export interface BerthBookingContent {
  dischargePort: string;
  berth: string;
  /** 绝对起始时刻（毫秒） */
  startMs: number;
  /** 绝对结束时刻（毫秒） */
  endMs: number;
}

/**
 * 判断同提交号的重试是否与首次受理内容一致。
 * 时刻按【绝对瞬间】比较（不同时区写法指向同一时刻即相同），港/泊位按精确文本比较。
 */
export function sameBookingContent(a: BerthBookingContent, b: BerthBookingContent): boolean {
  return (
    a.dischargePort === b.dischargePort &&
    a.berth === b.berth &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs
  );
}

/* ---------- 改期内容一致性（同调整号重试幂等） ---------- */

/**
 * 一次靠泊预订改期的业务内容（调整号是幂等键，不参与内容比较）。
 * 审查/卸港/冻结快照继承自原预订，不属于改期内容。
 */
export interface BerthAdjustmentContent {
  berth: string;
  /** 绝对起始时刻（毫秒） */
  startMs: number;
  /** 绝对结束时刻（毫秒） */
  endMs: number;
}

/**
 * 判断同调整号的重试是否与首次受理内容一致。
 * 时刻按【绝对瞬间】比较（不同时区写法指向同一时刻即相同），泊位按精确文本比较。
 */
export function sameAdjustmentContent(
  a: BerthAdjustmentContent,
  b: BerthAdjustmentContent,
): boolean {
  return a.berth === b.berth && a.startMs === b.startMs && a.endMs === b.endMs;
}
