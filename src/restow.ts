/**
 * 逐港倒箱作业方案 —— 纯函数（无 I/O）。
 *
 * 针对【已留档的港序卸货审查】，调度员提交：非负的临时堆位容量 + 每港按序的
 * 暂存（stash）/回放（restore）操作（港序须与审查一致）。模拟以该审查对应清单的
 * 冻结箱位及当时（清单修订号）安全约束为基准：
 *
 *  - 每港开始及每步操作后，反复卸走“列顶（同列上方已空）且卸港为本港”的箱；
 *  - 暂存：只能暂存【当前列顶且属于后续港】的箱；同箱全程至多暂存一次；
 *    同时在暂存中的箱数不得超过临时堆位容量；每次暂存计一次倒箱；
 *  - 回放：只能把暂存箱放回【原列当前栈顶空位】（下层箱已卸走时落点层随之下降）；
 *  - 暂存箱不计入船上安全约束（列承重 / 危险品间距），每步后对船上布局复验这两项；
 *  - 暂存箱不得跨港滞留（每港结束时暂存必须为空）；
 *  - 某港结束时仍有本港箱在船（受阻）即整体不可行。
 *
 * 任一违反即拒绝整份方案（返回失败原因与相关箱号），模拟不改变任何数据；
 * 成功结果由 service 层随提交内容一并冻结留档。
 */

import {
  BoxInfo,
  Geometry,
  Placement,
  Position,
  Violation,
  columnKey,
  validateLayout,
} from './domain';
import { DischargeItem } from './discharge';

/* ---------- 操作与方案 ---------- */

/** 暂存（stash，计一次倒箱）或回放（restore，放回原列栈顶空位） */
export type RestowAction = 'stash' | 'restore';

export interface RestowOperation {
  action: RestowAction;
  boxNo: string;
}

/** 某一港的按序操作列表（港序须与审查一致） */
export interface RestowPortPlan {
  port: string;
  operations: RestowOperation[];
}

/* ---------- 请求级校验：港序须与审查一致 ---------- */

export type RestowRequestIssue = {
  reason: 'port_order_mismatch';
  message: string;
  expectedPorts: string[];
  providedPorts: string[];
};

/**
 * 校验倒箱方案的港序与审查港序完全一致（同长度、同顺序）。
 * 不一致时一次性返回期望与实际的港序列表。
 */
export function validateRestowPlanInput(input: {
  reviewPorts: string[];
  plan: RestowPortPlan[];
}): RestowRequestIssue[] {
  const expected = input.reviewPorts;
  const provided = input.plan.map((p) => p.port);
  const same =
    expected.length === provided.length && expected.every((p, i) => p === provided[i]);
  if (same) return [];
  return [
    {
      reason: 'port_order_mismatch',
      message: `倒箱方案的港序必须与审查一致：审查港序为 [${expected.join(', ')}]，提交为 [${provided.join(', ')}]`,
      expectedPorts: [...expected],
      providedPorts: provided,
    },
  ];
}

/* ---------- 模拟失败：非法操作 / 安全约束违反 / 港末受阻 ---------- */

/** 非法操作（方案本身不合法 -> 400）；opIndex 为本港内第几个操作（1 起），港末检查无操作序号 */
export type RestowOpIssue =
  | {
      reason: 'box_not_aboard';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
    }
  | {
      reason: 'box_already_stashed';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
    }
  | {
      reason: 'box_already_restowed';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
    }
  | {
      reason: 'box_not_column_top';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
      position: Position;
    }
  | {
      reason: 'box_not_later_port';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
      dischargePort: string;
    }
  | {
      reason: 'capacity_exceeded';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
      capacity: number;
      stashedBoxNos: string[];
    }
  | {
      reason: 'box_not_stashed';
      message: string;
      port: string;
      portIndex: number;
      opIndex: number;
      boxNo: string;
    }
  | {
      reason: 'stash_lingering_across_port';
      message: string;
      port: string;
      portIndex: number;
      boxNos: string[];
    };

export type RestowFailure =
  | { kind: 'illegal_operation'; issue: RestowOpIssue }
  | {
      kind: 'safety_violation';
      port: string;
      portIndex: number;
      /** 触发违反的步骤：港开始卸货后为 null，否则为本港第几个操作（1 起） */
      opIndex: number | null;
      action: RestowAction | null;
      boxNo: string | null;
      violations: Violation[];
    }
  | {
      kind: 'port_blocked';
      port: string;
      portIndex: number;
      /** 港末仍在船的本港箱（受阻），含同列上方仍在船的阻挡箱（自近而远） */
      blocked: Array<{
        boxNo: string;
        position: Position;
        dischargePort: string;
        blockers: Array<{ boxNo: string; position: Position; dischargePort: string }>;
      }>;
    };

/* ---------- 模拟成功结果 ---------- */

export interface RestowPortResult {
  port: string;
  /** 1 起的港序序号 */
  portIndex: number;
  /** 本港实际卸走的箱（按箱号排序；箱位为卸下时所在位置） */
  discharged: Array<{ boxNo: string; position: Position }>;
  /** 本港暂存次数（每次暂存计一次倒箱） */
  restows: number;
  /** 本港作业结束后仍在船的箱位（操作后箱位，按箱号排序） */
  placements: Placement[];
}

export interface RestowSimulation {
  ports: string[];
  portResults: RestowPortResult[];
  counts: {
    totalBoxes: number;
    /** 全程实际卸下的箱数（每箱至多一次） */
    discharged: number;
    /** 全程倒箱次数（= 暂存次数） */
    restows: number;
  };
}

export interface SimulateRestowInput {
  /** 审查港序（有序、不重复） */
  ports: string[];
  /** 审查申报的每箱卸港（箱号与冻结清单一致） */
  items: DischargeItem[];
  /** 清单冻结箱位：每个清单箱一条 */
  placements: Placement[];
  /** 非负临时堆位容量（同时在暂存中的箱数上限） */
  capacity: number;
  /** 每港按序的暂存/回放操作（港序已与审查一致） */
  plan: RestowPortPlan[];
  /** 舱位尺寸与箱档案（登记后不可变更） */
  geometry: Geometry;
  boxes: BoxInfo[];
  /** 清单修订号当时生效的安全约束（列承重 + 不相容类别对） */
  columnLimits: Map<string, bigint>;
  defaultColumnLimit: bigint;
  rules: Map<string, number>;
}

export type SimulateRestowOutput =
  | { ok: true; simulation: RestowSimulation }
  | { ok: false; failure: RestowFailure };

interface AboardBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
}

/**
 * 逐港模拟倒箱作业方案。
 *
 * 状态机上任一非法操作、任一步船上安全约束（列承重/危险品间距）违反、
 * 暂存箱跨港滞留或港末本港箱受阻，都立即返回失败（不留档由 service 层保证）；
 * 全部港次走完且每港结束时本港箱卸空、暂存为空，即成功。
 */
export function simulateRestowPlan(input: SimulateRestowInput): SimulateRestowOutput {
  const { ports, items, placements, capacity, plan } = input;

  const portIndexOf = new Map<string, number>();
  ports.forEach((p, i) => portIndexOf.set(p, i + 1));

  const positionByBox = new Map(placements.map((p) => [p.boxNo, p.position]));
  const aboard = new Map<string, AboardBox>();
  for (const it of items) {
    const position = positionByBox.get(it.boxNo);
    if (position) {
      aboard.set(it.boxNo, { boxNo: it.boxNo, position, dischargePort: it.dischargePort });
    }
  }

  // 列 -> 该列仍在船的箱号集合（箱在船时列不变，仅回放可能改变层号）
  const columns = new Map<string, { bay: number; row: number; boxNos: Set<string> }>();
  const ensureColumn = (bay: number, row: number) => {
    const key = columnKey(bay, row);
    let col = columns.get(key);
    if (!col) {
      col = { bay, row, boxNos: new Set<string>() };
      columns.set(key, col);
    }
    return col;
  };
  for (const box of aboard.values()) {
    ensureColumn(box.position.bay, box.position.row).boxNos.add(box.boxNo);
  }
  const orderedColumns = () =>
    [...columns.values()].sort((a, b) => a.bay - b.bay || a.row - b.row);

  /** 取某列当前仍在船的最高层箱；列空返回 null */
  const topBoxOf = (col: { boxNos: Set<string> }): AboardBox | null => {
    let top: AboardBox | null = null;
    for (const boxNo of col.boxNos) {
      const box = aboard.get(boxNo);
      if (box && (!top || box.position.tier > top.position.tier)) top = box;
    }
    return top;
  };

  // 暂存中的箱：箱号 -> 原列坐标与卸港（回放只能放回原列当前栈顶空位）
  const stashed = new Map<string, { boxNo: string; bay: number; row: number; dischargePort: string }>();
  /** 全程曾被暂存过的箱（同箱不得重复暂存） */
  const stashedEver = new Set<string>();
  let restowCount = 0;

  /** 反复卸走“列顶且属于本港”的箱，卸下记录追加到 sink */
  const sweepDischarge = (port: string, sink: Array<{ boxNo: string; position: Position }>) => {
    let progress = true;
    while (progress) {
      progress = false;
      for (const col of orderedColumns()) {
        const top = topBoxOf(col);
        if (top && top.dischargePort === port) {
          aboard.delete(top.boxNo);
          col.boxNos.delete(top.boxNo);
          sink.push({ boxNo: top.boxNo, position: top.position });
          progress = true;
        }
      }
    }
  };

  /** 船上安全约束复验（暂存箱不计入）：仅列承重与危险品间距 */
  const checkSafety = (): Violation[] => {
    const current: Placement[] = [...aboard.values()].map((b) => ({
      boxNo: b.boxNo,
      position: b.position,
    }));
    return validateLayout({
      geometry: input.geometry,
      boxes: input.boxes,
      placements: current,
      columnLimits: input.columnLimits,
      defaultColumnLimit: input.defaultColumnLimit,
      rules: input.rules,
    }).filter((v) => v.reason === 'column_overweight' || v.reason === 'incompatible_too_close');
  };

  const illegal = (issue: RestowOpIssue): SimulateRestowOutput => ({
    ok: false,
    failure: { kind: 'illegal_operation', issue },
  });

  const portResults: RestowPortResult[] = [];
  let totalDischarged = 0;

  for (let i = 0; i < ports.length; i++) {
    const port = ports[i]!;
    const portIndex = i + 1;
    const operations = plan[i]!.operations; // 港序一致性已在 service 层校验
    const discharged: Array<{ boxNo: string; position: Position }> = [];
    let restowsThisPort = 0;

    // 每港开始：反复卸走可及的本港箱，随后复验船上安全约束
    sweepDischarge(port, discharged);
    const startViolations = checkSafety();
    if (startViolations.length > 0) {
      return {
        ok: false,
        failure: {
          kind: 'safety_violation',
          port,
          portIndex,
          opIndex: null,
          action: null,
          boxNo: null,
          violations: startViolations,
        },
      };
    }

    for (let opIdx = 0; opIdx < operations.length; opIdx++) {
      const op = operations[opIdx]!;
      const opIndex = opIdx + 1;

      if (op.action === 'stash') {
        if (stashed.has(op.boxNo)) {
          return illegal({
            reason: 'box_already_stashed',
            message: `箱 ${op.boxNo} 已在临时堆位中，不能重复暂存`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
          });
        }
        const box = aboard.get(op.boxNo);
        if (!box) {
          return illegal({
            reason: 'box_not_aboard',
            message: `箱 ${op.boxNo} 不在船上（未知箱或已卸走），无法暂存`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
          });
        }
        if (stashedEver.has(op.boxNo)) {
          return illegal({
            reason: 'box_already_restowed',
            message: `箱 ${op.boxNo} 曾被暂存过，同箱不得重复暂存`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
          });
        }
        const col = ensureColumn(box.position.bay, box.position.row);
        const top = topBoxOf(col);
        if (!top || top.boxNo !== op.boxNo) {
          return illegal({
            reason: 'box_not_column_top',
            message: `箱 ${op.boxNo} 不在列 (bay=${box.position.bay}, row=${box.position.row}) 的列顶，只能暂存当前列顶的箱`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
            position: box.position,
          });
        }
        const boxPortIndex = portIndexOf.get(box.dischargePort) ?? 0;
        if (boxPortIndex <= portIndex) {
          return illegal({
            reason: 'box_not_later_port',
            message: `箱 ${op.boxNo} 的卸港为 ${box.dischargePort}，不属于后续港，只能暂存后续港的箱`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
            dischargePort: box.dischargePort,
          });
        }
        if (stashed.size >= capacity) {
          return illegal({
            reason: 'capacity_exceeded',
            message: `临时堆位容量 ${capacity} 已满（当前暂存 ${stashed.size} 箱），无法再暂存箱 ${op.boxNo}`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
            capacity,
            stashedBoxNos: [...stashed.keys()].sort((a, b) => a.localeCompare(b)),
          });
        }
        // 暂存：离船入临时堆位（不计入船上安全约束），计一次倒箱
        aboard.delete(op.boxNo);
        col.boxNos.delete(op.boxNo);
        stashed.set(op.boxNo, {
          boxNo: op.boxNo,
          bay: box.position.bay,
          row: box.position.row,
          dischargePort: box.dischargePort,
        });
        stashedEver.add(op.boxNo);
        restowCount++;
        restowsThisPort++;
      } else {
        // 回放：只能把暂存箱放到原列当前栈顶空位
        const st = stashed.get(op.boxNo);
        if (!st) {
          return illegal({
            reason: 'box_not_stashed',
            message: `箱 ${op.boxNo} 不在临时堆位中，无法回放`,
            port,
            portIndex,
            opIndex,
            boxNo: op.boxNo,
          });
        }
        const col = ensureColumn(st.bay, st.row);
        const position: Position = { bay: st.bay, row: st.row, tier: col.boxNos.size };
        aboard.set(op.boxNo, { boxNo: op.boxNo, position, dischargePort: st.dischargePort });
        col.boxNos.add(op.boxNo);
        stashed.delete(op.boxNo);
      }

      // 每步操作后：反复卸走可及的本港箱，随后复验船上安全约束（暂存箱不计入）
      sweepDischarge(port, discharged);
      const violations = checkSafety();
      if (violations.length > 0) {
        return {
          ok: false,
          failure: {
            kind: 'safety_violation',
            port,
            portIndex,
            opIndex,
            action: op.action,
            boxNo: op.boxNo,
            violations,
          },
        };
      }
    }

    // 港结束：暂存箱不得跨港滞留
    if (stashed.size > 0) {
      return illegal({
        reason: 'stash_lingering_across_port',
        message: `港 ${port} 结束时仍有 ${stashed.size} 箱滞留临时堆位，暂存箱不得跨港滞留`,
        port,
        portIndex,
        boxNos: [...stashed.keys()].sort((a, b) => a.localeCompare(b)),
      });
    }

    // 港结束：仍有本港箱在船 -> 受阻，整份方案不可行
    const blockedBoxes = [...aboard.values()].filter((b) => b.dischargePort === port);
    if (blockedBoxes.length > 0) {
      const blocked = blockedBoxes
        .map((b) => {
          const above = [...aboard.values()]
            .filter(
              (o) =>
                o.position.bay === b.position.bay &&
                o.position.row === b.position.row &&
                o.position.tier > b.position.tier,
            )
            .sort((x, y) => x.position.tier - y.position.tier || x.boxNo.localeCompare(y.boxNo))
            .map((o) => ({ boxNo: o.boxNo, position: o.position, dischargePort: o.dischargePort }));
          return { boxNo: b.boxNo, position: b.position, dischargePort: b.dischargePort, blockers: above };
        })
        .sort((a, b) => a.boxNo.localeCompare(b.boxNo));
      return { ok: false, failure: { kind: 'port_blocked', port, portIndex, blocked } };
    }

    discharged.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    const placementsNow: Placement[] = [...aboard.values()]
      .map((b) => ({ boxNo: b.boxNo, position: b.position }))
      .sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    totalDischarged += discharged.length;
    portResults.push({
      port,
      portIndex,
      discharged,
      restows: restowsThisPort,
      placements: placementsNow,
    });
  }

  return {
    ok: true,
    simulation: {
      ports: [...ports],
      portResults,
      counts: {
        totalBoxes: items.length,
        discharged: totalDischarged,
        restows: restowCount,
      },
    },
  };
}
