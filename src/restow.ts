/**
 * 逐港倒箱作业方案模拟（纯函数）。
 *
 * 调度员对【已留档的港序卸货审查】提交逐港倒箱作业方案：非负的临时堆位容量与
 * 每港按序的暂存（stage）/回放（replay）操作。服务以该审查对应清单的【冻结箱位】
 * 及该清单修订号【当时的安全约束】为基准逐港模拟：
 *
 *  - 每港开始及每步操作后，反复卸走“列顶（同列上方已空）且属于本港”的可及本港箱，
 *    直到再无可卸箱；
 *  - 只能【暂存】当前列顶且属于【后续港】的箱（暂存到临时堆位，不计入船上安全约束）；
 *  - 只能【回放】暂存箱到其【原列】当前栈顶空位（自底向上连续，目标位由栈高唯一确定）；
 *  - 同箱不得重复暂存；临时堆位容量不得超限；暂存箱【不得跨港滞留】（港末必须全部回放）；
 *  - 任一步后若回放导致列承重超限或危险品间距不足，立即拒绝整份方案；
 *  - 某港结束仍有本港箱受阻（应在本港卸却仍在船），拒绝整份方案；
 *  - 每次暂存计一次倒箱（restow），回放不计；暂存箱不计入船上安全约束。
 *
 * 非法操作 / 安全违反 / 港末受阻均以 RestowRejection 抛出（结构化原因与相关箱号），
 * 由 service 层转换为 422；模拟本身不做任何 I/O，成功结果由 service 冻结留档。
 */

import {
  BoxInfo,
  Placement,
  Position,
  Violation,
  columnKey,
  validateLayout,
} from './domain';

/* ---------- 请求模型 ---------- */

export type RestowOperationKind = 'stage' | 'replay';

/** 单步倒箱操作：stage=暂存列顶后续港箱（给箱号）；replay=回放暂存箱（给箱号） */
export interface RestowOperation {
  op: RestowOperationKind;
  boxNo: string;
}

/** 单港作业：港名 + 按序操作（可为空数组，表示该港不做倒箱） */
export interface RestowPortPlan {
  port: string;
  operations: RestowOperation[];
}

/* ---------- 拒绝（结构化） ---------- */

/**
 * 模拟拒绝原因：
 *  - box_not_found                  操作箱号不在清单内；
 *  - stage_box_not_aboard           暂存箱已不在船（已卸走/已暂存/从未在船）；
 *  - stage_box_not_column_top       暂存箱不是所在列的当前列顶；
 *  - stage_box_not_later_port       暂存箱不属于【后续港】（本港箱/此前港箱不可暂存）；
 *  - box_already_staged             同一箱重复暂存；
 *  - temporary_capacity_exceeded    暂存导致临时堆位超容量；
 *  - replay_box_not_staged          回放箱当前不在临时堆位；
 *  - replay_target_not_stack_top    回放目标不是原列当前栈顶空位（悬空/越界，正常不应发生）；
 *  - safety_constraint_violated     任一步后列承重或危险品间距违反（含 violations 明细）；
 *  - port_boxes_blocked             港末仍有本港箱受阻（含 blocked 明细与阻挡箱）；
 *  - staged_boxes_left_at_port_end  港末仍有暂存箱未回放（暂存箱不得跨港滞留）。
 */
export type RestowRejectReason =
  | 'box_not_found'
  | 'stage_box_not_aboard'
  | 'stage_box_not_column_top'
  | 'stage_box_not_later_port'
  | 'box_already_staged'
  | 'temporary_capacity_exceeded'
  | 'replay_box_not_staged'
  | 'replay_target_not_stack_top'
  | 'safety_constraint_violated'
  | 'port_boxes_blocked'
  | 'staged_boxes_left_at_port_end';

export interface RestowBlockedBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
  blockers: Array<{ boxNo: string; position: Position; dischargePort: string; relation: 'earlier' | 'same' | 'later' }>;
}

export class RestowRejection extends Error {
  constructor(
    public readonly reason: RestowRejectReason,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RestowRejection';
  }
}

/* ---------- 结果模型 ---------- */

export interface RestowStepResult {
  /** 1 起的操作序号（港内） */
  seq: number;
  op: RestowOperationKind;
  boxNo: string;
  /** stage：被暂存箱原船位；replay：回放落位 */
  position: Position;
  /** 该步后临时堆位中的箱号（按暂存先后） */
  stagedBoxNos: string[];
  /** 该步连锁自动卸走的本港箱（列顶+本港反复扫描），按箱号排序 */
  discharged: Array<{ boxNo: string; position: Position }>;
}

export interface RestowPortResult {
  port: string;
  /** 1 起的港序序号（与审查港序一致） */
  portIndex: number;
  /** 本港开始（任何操作之前）自动卸走的本港箱，按箱号排序 */
  initialDischarged: Array<{ boxNo: string; position: Position }>;
  /** 按序操作结果（每步含其后连锁卸箱） */
  steps: RestowStepResult[];
  /** 本港实际卸走的全部箱（初始 + 各步连锁，按箱号排序） */
  discharged: Array<{ boxNo: string; position: Position }>;
  /** 本港倒箱次数（= 暂存次数） */
  restowCount: number;
  /** 本港结束后仍在船的箱位（不含暂存箱；暂存箱港末必为空），按箱号排序 */
  aboardAfterPort: Array<{ boxNo: string; position: Position }>;
}

export interface RestowSimulation {
  ports: string[];
  temporaryCapacity: number;
  portResults: RestowPortResult[];
  counts: {
    totalBoxes: number;
    /** 全程实际卸下的箱数（每箱至多一次） */
    discharged: number;
    /** 全程倒箱次数（暂存次数合计） */
    restows: number;
  };
}

/* ---------- 模拟输入 ---------- */

export interface SimulateRestowInput {
  /** 审查港序（已校验：方案港序与之完全一致） */
  ports: string[];
  /** 每箱卸港（取自审查冻结请求） */
  items: Array<{ boxNo: string; dischargePort: string }>;
  /** 清单冻结箱位 */
  placements: Placement[];
  /** 非负临时堆位容量 */
  temporaryCapacity: number;
  /** 每港按序作业（港序须与 ports 一致） */
  portPlans: RestowPortPlan[];
  /** 该清单修订号当时的安全约束（承重/间距） */
  geometry: { bays: number; rows: number; tiers: number };
  boxes: BoxInfo[];
  defaultColumnLimit: bigint;
  columnLimits: Map<string, bigint>;
  rules: Map<string, number>;
}

/* ---------- 内部状态 ---------- */

interface AboardBox {
  boxNo: string;
  position: Position;
  dischargePort: string;
}

interface StagedBox {
  boxNo: string;
  /** 原船位（据此确定原列与回放落位） */
  origin: Position;
  dischargePort: string;
}

/* ---------- 主模拟 ---------- */

/**
 * 逐港倒箱模拟。任何非法操作、安全违反、港末受阻均抛 RestowRejection（不返回部分结果）；
 * 全部港成功完成时返回冻结用模拟结果。
 */
export function simulateRestow(input: SimulateRestowInput): RestowSimulation {
  const {
    ports,
    items,
    placements,
    temporaryCapacity,
    portPlans,
    geometry,
    boxes,
    defaultColumnLimit,
    columnLimits,
    rules,
  } = input;

  const portIndexOf = new Map<string, number>();
  ports.forEach((p, i) => portIndexOf.set(p, i + 1));

  const boxInfoByNo = new Map(boxes.map((b) => [b.boxNo, b]));
  const dischargePortByBox = new Map(items.map((it) => [it.boxNo, it.dischargePort]));
  const frozenPositionByBox = new Map(placements.map((p) => [p.boxNo, p.position]));

  // 在船箱（key=箱号）；暂存箱从此处移除（不计船上安全约束），回放时放回
  const aboard = new Map<string, AboardBox>();
  for (const it of items) {
    const position = frozenPositionByBox.get(it.boxNo);
    if (position) aboard.set(it.boxNo, { boxNo: it.boxNo, position, dischargePort: it.dischargePort });
  }

  // 列 -> 当前在船箱号集合（暂存箱被移出，回放后重新加入）
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
  const ensureColumn = (bay: number, row: number) => {
    const key = columnKey(bay, row);
    let col = columns.get(key);
    if (!col) {
      col = { bay, row, boxNos: new Set<string>() };
      columns.set(key, col);
    }
    return col;
  };

  // 临时堆位（有序，按暂存先后）
  const staged: StagedBox[] = [];
  // 已暂存过的箱（同箱全程不得重复暂存，即使已回放）
  const everStaged = new Set<string>();

  let totalDischarged = 0;
  let totalRestows = 0;
  const portResults: RestowPortResult[] = [];

  /** 取某列当前仍在船的最高层箱；列空返回 null */
  const topBoxOf = (col: { boxNos: Set<string> }): AboardBox | null => {
    let top: AboardBox | null = null;
    for (const boxNo of col.boxNos) {
      const box = aboard.get(boxNo);
      if (box && (!top || box.position.tier > top.position.tier)) top = box;
    }
    return top;
  };

  /** 反复卸走“列顶且属于本港”的箱，返回本轮卸下的箱（按扫描完成后按箱号排序） */
  const autoDischarge = (port: string): AboardBox[] => {
    const out: AboardBox[] = [];
    const orderedColumns = [...columns.values()].sort(
      (a, b) => a.bay - b.bay || a.row - b.row,
    );
    let progress = true;
    while (progress) {
      progress = false;
      for (const col of orderedColumns) {
        const top = topBoxOf(col);
        if (top && top.dischargePort === port) {
          aboard.delete(top.boxNo);
          col.boxNos.delete(top.boxNo);
          out.push(top);
          progress = true;
        }
      }
    }
    return out.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
  };

  /** 当前在船箱位（用于安全校验/快照） */
  const currentAboardPlacements = (): Placement[] =>
    [...aboard.values()].map((b) => ({ boxNo: b.boxNo, position: b.position }));

  /**
   * 回放后安全复验：列承重 + 危险品间距（暂存箱已排除在 aboard 外，天然不计）。
   * 连续/碰撞/悬空由受控操作（放回栈顶空位）保证，不在此重复判为业务拒绝。
   */
  const checkSafety = (port: string, seq: number, replayedBoxNo: string): void => {
    // 先用统一校验器（含全部五项），仅把承重/间距两类安全违反作为拒绝；
    // 连续性/碰撞在受控回放下不可能出现，若出现属内部不变量被破坏。
    const violations = validateLayout({
      geometry,
      boxes,
      placements: currentAboardPlacements(),
      columnLimits,
      defaultColumnLimit,
      rules,
    });
    const safety = violations.filter(
      (v): v is Violation => v.reason === 'column_overweight' || v.reason === 'incompatible_too_close',
    );
    if (safety.length > 0) {
      throw new RestowRejection(
        'safety_constraint_violated',
        `港 ${port} 第 ${seq} 步回放箱 ${replayedBoxNo} 后违反${
          safety.some((v) => v.reason === 'column_overweight') ? '列承重' : ''
        }${safety.some((v) => v.reason === 'incompatible_too_close') ? '危险品间距' : ''}安全约束，整份方案已拒绝`,
        {
          port,
          portIndex: portIndexOf.get(port),
          seq,
          op: 'replay',
          boxNo: replayedBoxNo,
          violations: safety,
        },
      );
    }
  };

  /** 港末：找出仍在船的本港箱及其同列上方阻挡箱（自近而远，关系 earlier/same/later） */
  const blockedAtPortEnd = (port: string, portIdx: number): RestowBlockedBox[] => {
    const blocked: RestowBlockedBox[] = [];
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
          const otherIdx = portIndexOf.get(b.dischargePort) ?? portIdx;
          const relation =
            otherIdx < portIdx ? 'earlier' : otherIdx === portIdx ? 'same' : 'later';
          return {
            boxNo: b.boxNo,
            position: b.position,
            dischargePort: b.dischargePort,
            relation,
          };
        }),
      });
    }
    return blocked.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
  };

  /* ---- 逐港执行 ---- */
  portPlans.forEach((plan, pIndex) => {
    const port = plan.port;
    const portIdx = pIndex + 1;

    // 港开始：先自动卸走可及本港箱
    const initialDischarged = autoDischarge(port);
    totalDischarged += initialDischarged.length;

    const dischargedAll: AboardBox[] = [...initialDischarged];
    const steps: RestowStepResult[] = [];
    let portRestows = 0;

    plan.operations.forEach((op, opIdx) => {
      const seq = opIdx + 1;
      const boxNo = op.boxNo;

      if (op.op === 'stage') {
        // 箱必须在清单内
        if (!dischargePortByBox.has(boxNo)) {
          throw new RestowRejection(
            'box_not_found',
            `港 ${port} 第 ${seq} 步暂存箱 ${boxNo} 不在该审查对应清单内`,
            { port, portIndex: portIdx, seq, op: 'stage', boxNo },
          );
        }
        const box = aboard.get(boxNo);
        // 必须仍在船（未卸、未暂存）
        if (!box) {
          const isStagedNow = staged.some((s) => s.boxNo === boxNo);
          throw new RestowRejection(
            'stage_box_not_aboard',
            `港 ${port} 第 ${seq} 步要求暂存箱 ${boxNo}，但该箱当前不在船（${
              isStagedNow ? '已在临时堆位' : '已卸走或不在船'
            }），无法暂存`,
            { port, portIndex: portIdx, seq, op: 'stage', boxNo, staged: isStagedNow },
          );
        }
        // 同箱不得重复暂存
        if (everStaged.has(boxNo)) {
          throw new RestowRejection(
            'box_already_staged',
            `港 ${port} 第 ${seq} 步要求再次暂存箱 ${boxNo}，同一箱不得重复暂存`,
            { port, portIndex: portIdx, seq, op: 'stage', boxNo },
          );
        }
        // 必须是所在列当前列顶
        const col = ensureColumn(box.position.bay, box.position.row);
        const top = topBoxOf(col);
        if (!top || top.boxNo !== boxNo) {
          throw new RestowRejection(
            'stage_box_not_column_top',
            `港 ${port} 第 ${seq} 步要求暂存箱 ${boxNo}，但它不是列 (bay=${box.position.bay}, row=${box.position.row}) 的当前列顶${
              top ? `（列顶为 ${top.boxNo}）` : ''
            }，只能暂存列顶箱`,
            {
              port,
              portIndex: portIdx,
              seq,
              op: 'stage',
              boxNo,
              position: box.position,
              topBoxNo: top?.boxNo ?? null,
            },
          );
        }
        // 必须属于后续港
        const boxPortIdx = portIndexOf.get(box.dischargePort);
        if (boxPortIdx === undefined || boxPortIdx <= portIdx) {
          throw new RestowRejection(
            'stage_box_not_later_port',
            `港 ${port} 第 ${seq} 步要求暂存箱 ${boxNo}（卸港 ${box.dischargePort}），只能暂存属于后续港的列顶箱`,
            {
              port,
              portIndex: portIdx,
              seq,
              op: 'stage',
              boxNo,
              dischargePort: box.dischargePort,
              dischargePortIndex: boxPortIdx ?? null,
            },
          );
        }
        // 容量
        if (staged.length >= temporaryCapacity) {
          throw new RestowRejection(
            'temporary_capacity_exceeded',
            `港 ${port} 第 ${seq} 步暂存箱 ${boxNo} 将使临时堆位达到 ${staged.length + 1}，超过容量 ${temporaryCapacity}`,
            {
              port,
              portIndex: portIdx,
              seq,
              op: 'stage',
              boxNo,
              temporaryCapacity,
              stagedCount: staged.length,
            },
          );
        }

        // 执行暂存：从船与列移除，进入临时堆位
        aboard.delete(boxNo);
        col.boxNos.delete(boxNo);
        staged.push({ boxNo, origin: box.position, dischargePort: box.dischargePort });
        everStaged.add(boxNo);
        portRestows += 1;
        totalRestows += 1;

        // 暂存后连锁自动卸箱（露出的本港列顶）
        const discharged = autoDischarge(port);
        totalDischarged += discharged.length;
        dischargedAll.push(...discharged);

        steps.push({
          seq,
          op: 'stage',
          boxNo,
          position: box.position,
          stagedBoxNos: staged.map((s) => s.boxNo),
          discharged: discharged.map((b) => ({ boxNo: b.boxNo, position: b.position })),
        });
        return;
      }

      // ---- replay ----
      if (!dischargePortByBox.has(boxNo)) {
        throw new RestowRejection(
          'box_not_found',
          `港 ${port} 第 ${seq} 步回放箱 ${boxNo} 不在该审查对应清单内`,
          { port, portIndex: portIdx, seq, op: 'replay', boxNo },
        );
      }
      const stagedIndex = staged.findIndex((s) => s.boxNo === boxNo);
      if (stagedIndex < 0) {
        // 已在船却试图回放 / 从未暂存
        const alreadyAboard = aboard.has(boxNo);
        throw new RestowRejection(
          'replay_box_not_staged',
          `港 ${port} 第 ${seq} 步要求回放箱 ${boxNo}，但该箱当前不在临时堆位（${
            alreadyAboard ? '已在船' : everStaged.has(boxNo) ? '此前已回放' : '从未暂存'
          }），只能回放暂存箱`,
          { port, portIndex: portIdx, seq, op: 'replay', boxNo, aboard: alreadyAboard },
        );
      }
      const stb = staged[stagedIndex]!;

      // 目标位 = 原列当前栈顶空位（自底向上连续）：列空为 tier 0，否则最高层 +1
      const col = ensureColumn(stb.origin.bay, stb.origin.row);
      const top = topBoxOf(col);
      const targetTier = top ? top.position.tier + 1 : 0;
      if (targetTier >= geometry.tiers) {
        throw new RestowRejection(
          'replay_target_not_stack_top',
          `港 ${port} 第 ${seq} 步回放箱 ${boxNo} 到原列 (bay=${stb.origin.bay}, row=${stb.origin.row}) 时栈顶空位 tier=${targetTier} 超出舱位层数 ${geometry.tiers}，无法回放`,
          {
            port,
            portIndex: portIdx,
            seq,
            op: 'replay',
            boxNo,
            origin: stb.origin,
            targetTier,
          },
        );
      }
      const target: Position = { bay: stb.origin.bay, row: stb.origin.row, tier: targetTier };

      // 执行回放：放回原列栈顶空位
      const replayedBox: AboardBox = {
        boxNo: stb.boxNo,
        position: target,
        dischargePort: stb.dischargePort,
      };
      aboard.set(boxNo, replayedBox);
      col.boxNos.add(boxNo);
      staged.splice(stagedIndex, 1);

      // 回放后安全复验（列承重 / 危险品间距）；回放不会使本港箱变可卸（放回的是后续港箱）
      checkSafety(port, seq, boxNo);
      const discharged = autoDischarge(port);
      totalDischarged += discharged.length;
      dischargedAll.push(...discharged);

      steps.push({
        seq,
        op: 'replay',
        boxNo,
        position: target,
        stagedBoxNos: staged.map((s) => s.boxNo),
        discharged: discharged.map((b) => ({ boxNo: b.boxNo, position: b.position })),
      });
    });

    // 港末：暂存箱不得跨港滞留
    if (staged.length > 0) {
      throw new RestowRejection(
        'staged_boxes_left_at_port_end',
        `港 ${port} 结束时仍有 ${staged.length} 个暂存箱未回放（${staged
          .map((s) => s.boxNo)
          .join('、')}），暂存箱不得跨港滞留，整份方案已拒绝`,
        {
          port,
          portIndex: portIdx,
          stagedBoxNos: staged.map((s) => s.boxNo),
        },
      );
    }

    // 港末：本港箱不得仍受阻
    const blocked = blockedAtPortEnd(port, portIdx);
    if (blocked.length > 0) {
      throw new RestowRejection(
        'port_boxes_blocked',
        `港 ${port} 结束时仍有 ${blocked.length} 个本港箱受阻未卸（${blocked
          .map((b) => b.boxNo)
          .join('、')}），整份方案已拒绝`,
        { port, portIndex: portIdx, blocked },
      );
    }

    dischargedAll.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    const aboardAfterPort = [...aboard.values()]
      .map((b) => ({ boxNo: b.boxNo, position: b.position }))
      .sort((a, b) => a.boxNo.localeCompare(b.boxNo));

    portResults.push({
      port,
      portIndex: portIdx,
      initialDischarged: initialDischarged.map((b) => ({ boxNo: b.boxNo, position: b.position })),
      steps,
      discharged: dischargedAll.map((b) => ({ boxNo: b.boxNo, position: b.position })),
      restowCount: portRestows,
      aboardAfterPort,
    });
  });

  return {
    ports: [...ports],
    temporaryCapacity,
    portResults,
    counts: {
      totalBoxes: items.length,
      discharged: totalDischarged,
      restows: totalRestows,
    },
  };
}

/* ---------- 请求级（结构性）校验：与模拟解耦，400 前一次性收集 ---------- */

export type RestowRequestIssue =
  | { reason: 'port_order_mismatch'; message: string; expected: string[]; actual: string[] }
  | { reason: 'unknown_port'; message: string; port: string }
  | { reason: 'duplicate_port_in_plan'; message: string; port: string }
  | { reason: 'unknown_box'; message: string; port: string | null; seq: number | null; boxNo: string }
  | { reason: 'unknown_operation'; message: string; port: string; seq: number; op: string };

export interface ValidateRestowPlanInput {
  /** 审查冻结港序 */
  reviewPorts: string[];
  /** 清单全部箱号 */
  manifestBoxNos: string[];
  temporaryCapacity: number;
  portPlans: RestowPortPlan[];
}

/**
 * 校验倒箱方案请求本身（结构层面）：
 *  - 方案港序必须与审查【完全一致】（同序、同集合、不重不漏）；
 *  - 操作类型只能是 stage/replay；
 *  - 操作箱号必须在清单内。
 * 容量非负、operations 为数组等由 zod 保证；动态语义（列顶/后续港/容量/安全/受阻）
 * 在 simulateRestow 中逐港判定并以 RestowRejection（422）拒绝。
 */
export function validateRestowPlanInput(input: ValidateRestowPlanInput): RestowRequestIssue[] {
  const issues: RestowRequestIssue[] = [];
  const { reviewPorts, portPlans, manifestBoxNos } = input;
  const manifestSet = new Set(manifestBoxNos);

  const actualPorts = portPlans.map((p) => p.port);

  // 港序必须与审查完全一致
  if (actualPorts.length !== reviewPorts.length || actualPorts.some((p, i) => p !== reviewPorts[i])) {
    issues.push({
      reason: 'port_order_mismatch',
      message: '倒箱方案的港序必须与审查港序完全一致（同序、不重、不漏）',
      expected: reviewPorts,
      actual: actualPorts,
    });
  }

  // 方案内港重复 / 未知港（即使顺序不一致也照样收集，方便一次报全）
  const seenPort = new Set<string>();
  for (const p of portPlans) {
    if (seenPort.has(p.port)) {
      issues.push({
        reason: 'duplicate_port_in_plan',
        message: `倒箱方案中卸港 ${p.port} 重复出现，每港至多一段作业`,
        port: p.port,
      });
    }
    seenPort.add(p.port);
    if (!reviewPorts.includes(p.port)) {
      issues.push({
        reason: 'unknown_port',
        message: `卸港 ${p.port} 不在审查港序列表中`,
        port: p.port,
      });
    }
  }

  // 操作类型与箱号
  portPlans.forEach((p) => {
    p.operations.forEach((op, i) => {
      if (op.op !== 'stage' && op.op !== 'replay') {
        issues.push({
          reason: 'unknown_operation',
          message: `港 ${p.port} 第 ${i + 1} 步操作类型 ${String(op.op)} 非法，只能是 stage 或 replay`,
          port: p.port,
          seq: i + 1,
          op: String(op.op),
        });
      }
      if (!manifestSet.has(op.boxNo)) {
        issues.push({
          reason: 'unknown_box',
          message: `港 ${p.port} 第 ${i + 1} 步箱号 ${op.boxNo} 不在该审查对应清单内`,
          port: p.port,
          seq: i + 1,
          boxNo: op.boxNo,
        });
      }
    });
  });

  return issues;
}
