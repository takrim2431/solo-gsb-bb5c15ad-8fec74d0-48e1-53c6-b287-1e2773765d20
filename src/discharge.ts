/**
 * 按港序卸货模拟（纯函数）。
 *
 * 调度员对【已签发并冻结的装载清单】提交有序、不重复的卸港列表与每箱卸港，
 * 服务按清单冻结箱位逐港模拟，判定能否不倒箱（restow）卸完全部箱：
 *
 *  - 同一 (bay,row) 构成垂直堆叠的一列；只有列顶（上方已空）的箱可直接卸走；
 *  - 每港反复卸走“列顶且卸港为本港”的箱，直到全船再无可卸箱（本港作业结束）；
 *  - 被后续港箱压住的本港箱留船；后续港【不回补】此前漏卸的箱——
 *    一旦箱的卸港已过而箱仍在船，即成为逾港未卸箱（over-carried），
 *    它还可能在后续港压住本该卸下的箱（阻挡关系 relation='earlier'）。
 *
 * 模拟不改变任何数据；审查结论由 service 层随请求一并冻结留档。
 */

import { Placement, Position, columnKey } from './domain';

/** 清单内每箱申报的卸港（箱号必须与冻结清单完全一致） */
export interface DischargeItem {
  boxNo: string;
  dischargePort: string;
}

/* ---------- 请求级校验 ---------- */

export type DischargeRequestIssue =
  | { reason: 'empty_port_order'; message: string }
  | {
      reason: 'duplicate_port_in_order';
      message: string;
      port: string;
      occurrences: number;
    }
  | {
      reason: 'duplicate_box_in_request';
      message: string;
      boxNo: string;
      occurrences: number;
    }
  | { reason: 'unknown_box_for_manifest'; message: string; boxNo: string }
  | { reason: 'manifest_box_missing'; message: string; boxNo: string }
  | {
      reason: 'unknown_discharge_port';
      message: string;
      boxNo: string;
      dischargePort: string;
    };

export interface ValidateDischargeInput {
  /** 有序卸港列表（已 trim；非空、不重复才合法） */
  ports: string[];
  /** 清单内每个箱的卸港（箱号集合必须与冻结清单完全一致） */
  items: DischargeItem[];
  /** 冻结清单箱号 */
  manifestBoxNos: string[];
}

/**
 * 校验卸货审查请求本身是否合法（不做模拟）：
 *  - 港序为空（空列表或空港名）；
 *  - 港序列表中存在重复港；
 *  - 同一箱号在请求中出现多次；
 *  - 请求箱号多于清单（清单外箱）/ 少于清单（缺漏箱）；
 *  - 某箱申报卸港不在港序列表中。
 * 问题一次性全部返回（按原因码、箱号/港名排序），任一存在即拒绝模拟。
 */
export function validateDischargeReviewInput(
  input: ValidateDischargeInput,
): DischargeRequestIssue[] {
  const issues: DischargeRequestIssue[] = [];
  const ports = input.ports;
  const items = input.items;

  // 港序为空
  if (ports.length === 0) {
    issues.push({
      reason: 'empty_port_order',
      message: '卸港列表为空：必须提交至少一个有序且不重复的卸港',
    });
  }

  // 港序重复
  const portCounts = new Map<string, number>();
  for (const p of ports) portCounts.set(p, (portCounts.get(p) ?? 0) + 1);
  for (const [port, occurrences] of [...portCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (occurrences > 1) {
      issues.push({
        reason: 'duplicate_port_in_order',
        message: `卸港 ${port} 在港序列表中出现了 ${occurrences} 次，港序必须有序且不重复`,
        port,
        occurrences,
      });
    }
  }

  // 同箱号重复申报
  const itemCounts = new Map<string, number>();
  for (const it of items) itemCounts.set(it.boxNo, (itemCounts.get(it.boxNo) ?? 0) + 1);
  for (const [boxNo, occurrences] of [...itemCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (occurrences > 1) {
      issues.push({
        reason: 'duplicate_box_in_request',
        message: `箱号 ${boxNo} 在卸港申报中出现了 ${occurrences} 次，每箱至多申报一条`,
        boxNo,
        occurrences,
      });
    }
  }

  // 箱号必须与冻结清单【完全一致】：不多（清单外箱）、不少（缺漏箱）
  const manifestSet = new Set(input.manifestBoxNos);
  const requestUniqueBoxes = new Set(items.map((it) => it.boxNo));
  for (const boxNo of [...requestUniqueBoxes].sort((a, b) => a.localeCompare(b))) {
    if (!manifestSet.has(boxNo)) {
      issues.push({
        reason: 'unknown_box_for_manifest',
        message: `箱号 ${boxNo} 不在该冻结清单中：申报箱号必须与清单完全一致，不允许多余箱`,
        boxNo,
      });
    }
  }
  const manifestSorted = [...input.manifestBoxNos].sort((a, b) => a.localeCompare(b));
  for (const boxNo of manifestSorted) {
    if (!requestUniqueBoxes.has(boxNo)) {
      issues.push({
        reason: 'manifest_box_missing',
        message: `清单箱 ${boxNo} 缺少卸港申报：每个清单箱都必须给出卸港，不允许缺漏`,
        boxNo,
      });
    }
  }

  // 卸港必须出现在港序列表中
  const portSet = new Set(ports);
  for (const it of [...items].sort((a, b) => a.boxNo.localeCompare(b.boxNo))) {
    if (!portSet.has(it.dischargePort)) {
      issues.push({
        reason: 'unknown_discharge_port',
        message: `箱 ${it.boxNo} 的卸港 ${it.dischargePort} 不在提交的卸港列表中`,
        boxNo: it.boxNo,
        dischargePort: it.dischargePort,
      });
    }
  }

  return issues.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) ||
      (('boxNo' in a ? a.boxNo : '')).localeCompare('boxNo' in b ? b.boxNo : '') ||
      (('port' in a ? a.port : '')).localeCompare('port' in b ? b.port : ''),
  );
}

/* ---------- 逐港卸货模拟 ---------- */

/** 仍在船的阻挡箱：位于受阻箱同列上方 */
export interface BlockerBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
  /**
   * 阻挡箱卸港相对【当前作业港】的次序：
   *  - later   ：后续港箱（典型“被后续港箱压住”）；
   *  - same    ：同为当前港箱（其本身也是受阻箱，取走上层箱后可连锁卸）；
   *  - earlier ：此前港次的逾港未卸箱（漏卸后压住后续港的箱）。
   */
  relation: 'earlier' | 'same' | 'later';
}

/** 单港模拟结果 */
export interface PortDischargeResult {
  port: string;
  /** 1 起的港序序号 */
  portIndex: number;
  /** 本港实际卸走的箱（按箱号排序） */
  discharged: Array<{ boxNo: string; position: Position }>;
  /** 本港受阻留船的箱（按箱号排序），含同列上方全部仍在船阻挡箱（自近而远） */
  blocked: Array<{
    boxNo: string;
    position: Position;
    dischargePort: string;
    blockers: BlockerBox[];
  }>;
}

/** 最终逾港未卸箱：全部港次走完后仍在船的箱（其卸港已过） */
export interface OverCarriedBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
  /** 该箱本应在第几港卸下（1 起） */
  dischargePortIndex: number;
}

export interface DischargeSimulation {
  ports: string[];
  portResults: PortDischargeResult[];
  overCarried: OverCarriedBox[];
  /** 全程无倒箱可行：全部箱都在其卸港当港卸空（最终无逾港未卸箱） */
  feasibleWithoutRestow: boolean;
  counts: {
    totalBoxes: number;
    /** 全程实际卸下的箱数（每箱至多一次） */
    discharged: number;
    /** 在本港受阻的总箱次（= 最终逾港未卸箱数） */
    blockedAtOwnPort: number;
    overCarried: number;
  };
}

export interface SimulateDischargeInput {
  /** 已校验：非空、无重复的有序卸港列表 */
  ports: string[];
  /** 已校验：与清单一致、卸港均在列表中的每箱申报 */
  items: DischargeItem[];
  /** 清单冻结箱位：每个清单箱一条 */
  placements: Placement[];
}

interface AboardBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
}

/**
 * 按冻结箱位逐港模拟卸货（不倒箱前提）。
 *
 * 每港对全船反复扫描：只要某列的列顶箱（该列仍在船的最高层）属于本港即卸走，
 * 直到一轮扫描无任何箱可卸。随后记录本港仍在船的本港箱为受阻箱，
 * 其阻挡箱为同列上方所有仍在船箱（自近而远，含 later/same/earlier 三种关系）。
 * 后续港不回补此前漏卸箱；全部港次走完后仍在船的箱即逾港未卸箱。
 */
export function simulateDischarge(input: SimulateDischargeInput): DischargeSimulation {
  const { ports, items, placements } = input;

  const portIndexOf = new Map<string, number>();
  ports.forEach((p, i) => portIndexOf.set(p, i + 1));

  const positionByBox = new Map(placements.map((p) => [p.boxNo, p.position]));
  const aboard = new Map<string, AboardBox>();
  for (const it of items) {
    const position = positionByBox.get(it.boxNo);
    if (position) {
      aboard.set(it.boxNo, {
        boxNo: it.boxNo,
        position,
        dischargePort: it.dischargePort,
      });
    }
  }

  // 列 -> 该列全部箱位（箱位来自已签发清单，列内自底向上连续；此处不依赖该性质）
  const columns = new Map<string, { bay: number; row: number; boxNos: Set<string> }>();
  for (const box of aboard.values()) {
    const key = columnKey(box.position.bay, box.position.row);
    const col = columns.get(key) ?? {
      bay: box.position.bay,
      row: box.position.row,
      boxNos: new Set<string>(),
    };
    col.boxNos.add(box.boxNo);
    columns.set(key, col);
  }
  const orderedColumns = [...columns.values()].sort(
    (a, b) => a.bay - b.bay || a.row - b.row,
  );

  /** 取某列当前仍在船的最高层箱；列空返回 null */
  const topBoxOf = (col: { boxNos: Set<string> }): AboardBox | null => {
    let top: AboardBox | null = null;
    for (const boxNo of col.boxNos) {
      const box = aboard.get(boxNo);
      if (box && (!top || box.position.tier > top.position.tier)) top = box;
    }
    return top;
  };

  const portResults: PortDischargeResult[] = [];
  let totalDischarged = 0;
  let totalBlocked = 0;

  ports.forEach((port, i) => {
    const discharged: AboardBox[] = [];

    // 反复卸走“列顶且属于本港”的箱，直到全船再无可卸箱
    let progress = true;
    while (progress) {
      progress = false;
      for (const col of orderedColumns) {
        const top = topBoxOf(col);
        if (top && top.dischargePort === port) {
          aboard.delete(top.boxNo);
          col.boxNos.delete(top.boxNo);
          discharged.push(top);
          progress = true;
        }
      }
    }

    // 本港箱仍在船 => 受阻；列出同列上方全部仍在船阻挡箱（自近而远）
    const blocked: PortDischargeResult['blocked'] = [];
    for (const box of [...aboard.values()]) {
      if (box.dischargePort !== port) continue;
      const above: AboardBox[] = [];
      for (const other of aboard.values()) {
        if (
          other.position.bay === box.position.bay &&
          other.position.row === box.position.row &&
          other.position.tier > box.position.tier
        ) {
          above.push(other);
        }
      }
      above.sort((a, b) => a.position.tier - b.position.tier || a.boxNo.localeCompare(b.boxNo));
      blocked.push({
        boxNo: box.boxNo,
        position: box.position,
        dischargePort: box.dischargePort,
        blockers: above.map((b) => {
          const otherIdx = portIndexOf.get(b.dischargePort) ?? i + 1;
          const relation: BlockerBox['relation'] =
            otherIdx < i + 1 ? 'earlier' : otherIdx === i + 1 ? 'same' : 'later';
          return {
            boxNo: b.boxNo,
            position: b.position,
            dischargePort: b.dischargePort,
            relation,
          };
        }),
      });
    }
    blocked.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    discharged.sort((a, b) => a.boxNo.localeCompare(b.boxNo));

    totalDischarged += discharged.length;
    totalBlocked += blocked.length;
    portResults.push({
      port,
      portIndex: i + 1,
      discharged: discharged.map((b) => ({ boxNo: b.boxNo, position: b.position })),
      blocked,
    });
  });

  // 全部港次走完仍在船 => 逾港未卸（后续港不回补）
  const overCarried: OverCarriedBox[] = [...aboard.values()]
    .map((b) => ({
      boxNo: b.boxNo,
      position: b.position,
      dischargePort: b.dischargePort,
      dischargePortIndex: portIndexOf.get(b.dischargePort) ?? 0,
    }))
    .sort((a, b) => a.boxNo.localeCompare(b.boxNo));

  return {
    ports: [...ports],
    portResults,
    overCarried,
    feasibleWithoutRestow: overCarried.length === 0,
    counts: {
      totalBoxes: items.length,
      discharged: totalDischarged,
      blockedAtOwnPort: totalBlocked,
      overCarried: overCarried.length,
    },
  };
}
