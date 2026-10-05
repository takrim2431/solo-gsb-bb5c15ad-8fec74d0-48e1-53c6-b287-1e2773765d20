/**
 * 领域模型与配载规则校验（纯函数）。
 *
 * 坐标系约定（三维舱位）：
 *   bay  舱/贝：从 1 开始，1..bays
 *   row  列号：从 1 开始，1..rows（承重上限按 bay+row 维度的“列”配置）
 *   tier 层：自底向上从 0 开始，0..tiers-1，底层必须为 tier=0
 *
 * 两个箱位之间的距离为三维曼哈顿距离：|Δbay| + |Δrow| + |Δtier|。
 */

export interface Position {
  bay: number;
  row: number;
  tier: number;
}

export interface BoxInfo {
  boxNo: string;
  /** 重量（千克），十进制字符串，避免浮点误差 */
  weight: string;
  /** 危险品类别，例如 "1.1" / "3" / "8" */
  category: string;
}

export interface Placement {
  boxNo: string;
  position: Position;
}

export interface Move {
  boxNo: string;
  /** null 表示该箱暂留空（撤位） */
  position: Position | null;
}

export interface Geometry {
  bays: number;
  rows: number;
  tiers: number;
}

export type Violation =
  | {
      reason: 'box_duplicated';
      message: string;
      boxNo: string;
      positions: Position[];
    }
  | {
      reason: 'position_collision';
      message: string;
      position: Position;
      boxNos: string[];
    }
  | {
      reason: 'column_not_continuous';
      message: string;
      bay: number;
      row: number;
      occupiedTiers: number[];
      missingTiers: number[];
      boxNos: string[];
    }
  | {
      reason: 'column_overweight';
      message: string;
      bay: number;
      row: number;
      totalWeight: string;
      weightLimit: string;
      boxNos: string[];
    }
  | {
      reason: 'incompatible_too_close';
      message: string;
      boxA: string;
      boxB: string;
      categoryA: string;
      categoryB: string;
      positionA: Position;
      positionB: Position;
      distance: number;
      minDistance: number;
    };

export type RequestIssue =
  | { reason: 'unknown_box'; message: string; boxNo: string }
  | {
      reason: 'invalid_coordinates';
      message: string;
      boxNo: string;
      position: Position | null;
    }
  | {
      reason: 'duplicate_box_in_batch';
      message: string;
      boxNo: string;
      occurrences: number;
    };

/** 重量统一换算为毫克级整数（1 kg = 1_000_000），精确比较 */
export function weightToMicro(weight: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(weight)) {
    throw new Error(`无效重量: ${weight}`);
  }
  const [intPart, fracPart = ''] = weight.split('.');
  const frac = (fracPart + '000000').slice(0, 6);
  return BigInt(intPart!) * 1_000_000n + BigInt(frac === '' ? '0' : frac);
}

export function microToWeight(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) return whole.toString(10);
  return `${whole}.${frac.toString(10).padStart(6, '0').replace(/0+$/, '')}`;
}

export function positionKey(p: Position): string {
  return `${p.bay}/${p.row}/${p.tier}`;
}

export function columnKey(bay: number, row: number): string {
  return `${bay}/${row}`;
}

/** 不相容类别对归一化为有序键，与登记顺序无关 */
export function ruleKey(catA: string, catB: string): string {
  return catA <= catB ? `${catA}|${catB}` : `${catB}|${catA}`;
}

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a.bay - b.bay) + Math.abs(a.row - b.row) + Math.abs(a.tier - b.tier);
}

export function positionInBounds(p: Position, g: Geometry): boolean {
  return (
    Number.isInteger(p.bay) &&
    Number.isInteger(p.row) &&
    Number.isInteger(p.tier) &&
    p.bay >= 1 &&
    p.bay <= g.bays &&
    p.row >= 1 &&
    p.row <= g.rows &&
    p.tier >= 0 &&
    p.tier < g.tiers
  );
}

/**
 * 校验一批整箱调整请求本身是否合法（不涉及布局规则）：
 * 未知箱、无效坐标、同批重复出现同一箱号。
 */
export function checkMoves(moves: Move[], geometry: Geometry, knownBoxes: Set<string>): RequestIssue[] {
  const issues: RequestIssue[] = [];
  const seen = new Map<string, number>();

  for (const move of moves) {
    seen.set(move.boxNo, (seen.get(move.boxNo) ?? 0) + 1);
    if (!knownBoxes.has(move.boxNo)) {
      issues.push({
        reason: 'unknown_box',
        message: `未知箱号: ${move.boxNo}`,
        boxNo: move.boxNo,
      });
    }
    if (move.position !== null && !positionInBounds(move.position, geometry)) {
      issues.push({
        reason: 'invalid_coordinates',
        message: `箱 ${move.boxNo} 的坐标超出舱位范围 (bay 1..${geometry.bays}, row 1..${geometry.rows}, tier 0..${geometry.tiers - 1})`,
        boxNo: move.boxNo,
        position: move.position,
      });
    }
  }

  for (const [boxNo, occurrences] of seen) {
    if (occurrences > 1) {
      issues.push({
        reason: 'duplicate_box_in_batch',
        message: `同一批调整中箱号 ${boxNo} 出现了 ${occurrences} 次，每批每箱至多一条指令`,
        boxNo,
        occurrences,
      });
    }
  }

  return issues.sort((a, b) => a.reason.localeCompare(b.reason) || a.boxNo.localeCompare(b.boxNo));
}

export interface ValidateLayoutInput {
  geometry: Geometry;
  boxes: BoxInfo[];
  /** 最终布局：每个已配位箱一条 */
  placements: Placement[];
  /** 列承重上限（毫克），key = columnKey(bay,row)；未配置的列使用 defaultColumnLimit */
  columnLimits: Map<string, bigint>;
  defaultColumnLimit: bigint;
  /** 不相容类别对：归一化类别键 -> 最小曼哈顿距离（正整数） */
  rules: Map<string, number>;
}

/**
 * 按最终布局一次性校验全部配载规则。
 * 返回所有违反项（空数组表示通过）：
 *  1. 一箱至多一位
 *  2. 一位至多一箱
 *  3. 各列自底向上连续占用（tier 0 起，不允许悬空）
 *  4. 列总重量不超上限
 *  5. 不相容类别箱对曼哈顿距离达到要求
 */
export function validateLayout(input: ValidateLayoutInput): Violation[] {
  const { geometry, boxes, placements, columnLimits, defaultColumnLimit, rules } = input;
  const violations: Violation[] = [];

  const boxMap = new Map(boxes.map((b) => [b.boxNo, b]));

  // ---- 1. 一箱至多一位（同一箱在最终布局中重复出现）----
  const byBox = new Map<string, Position[]>();
  for (const pl of placements) {
    const list = byBox.get(pl.boxNo) ?? [];
    list.push(pl.position);
    byBox.set(pl.boxNo, list);
  }
  for (const [boxNo, positions] of [...byBox.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (positions.length > 1) {
      violations.push({
        reason: 'box_duplicated',
        message: `箱 ${boxNo} 在最终布局中占用了 ${positions.length} 个位置，一箱至多一位`,
        boxNo,
        positions: positions.sort(comparePosition),
      });
    }
  }

  // 越界坐标（防御性检查，正常路径上已被 checkMoves 拦截）
  for (const pl of placements) {
    if (!positionInBounds(pl.position, geometry)) {
      violations.push({
        reason: 'position_collision',
        message: `箱 ${pl.boxNo} 的坐标超出舱位范围`,
        position: pl.position,
        boxNos: [pl.boxNo],
      });
    }
  }

  // ---- 2. 一位至多一箱 ----
  const byPosition = new Map<string, { position: Position; boxNos: string[] }>();
  for (const pl of placements) {
    const key = positionKey(pl.position);
    const entry = byPosition.get(key) ?? { position: pl.position, boxNos: [] };
    entry.boxNos.push(pl.boxNo);
    byPosition.set(key, entry);
  }
  for (const entry of [...byPosition.values()].sort(
    (a, b) => positionKey(a.position).localeCompare(positionKey(b.position)),
  )) {
    if (entry.boxNos.length > 1) {
      violations.push({
        reason: 'position_collision',
        message: `舱位 (bay=${entry.position.bay}, row=${entry.position.row}, tier=${entry.position.tier}) 同时被 ${entry.boxNos.length} 个箱占用，一位至多一箱`,
        position: entry.position,
        boxNos: [...entry.boxNos].sort(),
      });
    }
  }

  // ---- 按列聚合 ----
  const columns = new Map<string, { bay: number; row: number; tiers: Map<number, string> }>();
  for (const pl of placements) {
    const key = columnKey(pl.position.bay, pl.position.row);
    const col = columns.get(key) ?? { bay: pl.position.bay, row: pl.position.row, tiers: new Map() };
    col.tiers.set(pl.position.tier, pl.boxNo);
    columns.set(key, col);
  }

  for (const col of [...columns.values()].sort(
    (a, b) => a.bay - b.bay || a.row - b.row,
  )) {
    const occupiedTiers = [...col.tiers.keys()].sort((x, y) => x - y);

    // ---- 3. 自底向上连续：必须恰好占据 0..k-1 ----
    const missingTiers: number[] = [];
    for (let t = 0; t < occupiedTiers.length; t++) {
      if (!col.tiers.has(t)) missingTiers.push(t);
    }
    const boxNos = occupiedTiers.map((t) => col.tiers.get(t)!).sort();
    if (missingTiers.length > 0) {
      violations.push({
        reason: 'column_not_continuous',
        message: `列 (bay=${col.bay}, row=${col.row}) 未自底向上连续占用，底层起空缺层 tier=${missingTiers.join(', ')}，不允许悬空堆箱`,
        bay: col.bay,
        row: col.row,
        occupiedTiers,
        missingTiers,
        boxNos,
      });
    }

    // ---- 4. 列总重量不超上限 ----
    let total = 0n;
    for (const boxNo of col.tiers.values()) {
      const info = boxMap.get(boxNo);
      if (info) total += weightToMicro(info.weight);
    }
    const limit = columnLimits.get(columnKey(col.bay, col.row)) ?? defaultColumnLimit;
    if (total > limit) {
      violations.push({
        reason: 'column_overweight',
        message: `列 (bay=${col.bay}, row=${col.row}) 总重量 ${microToWeight(total)}kg 超过承重上限 ${microToWeight(limit)}kg`,
        bay: col.bay,
        row: col.row,
        totalWeight: microToWeight(total),
        weightLimit: microToWeight(limit),
        boxNos: [...col.tiers.values()].sort(),
      });
    }
  }

  // ---- 5. 不相容类别对距离 ----
  const placed: Placement[] = placements.filter((pl) => boxMap.has(pl.boxNo));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      const boxA = boxMap.get(a.boxNo)!;
      const boxB = boxMap.get(b.boxNo)!;
      const required = rules.get(ruleKey(boxA.category, boxB.category));
      if (required === undefined) continue; // 未设定即相容
      const distance = manhattan(a.position, b.position);
      if (distance < required) {
        violations.push({
          reason: 'incompatible_too_close',
          message: `不相容类别箱 ${a.boxNo}(${boxA.category}类) 与 ${b.boxNo}(${boxB.category}类) 曼哈顿距离为 ${distance}，要求至少 ${required}`,
          boxA: a.boxNo,
          boxB: b.boxNo,
          categoryA: boxA.category,
          categoryB: boxB.category,
          positionA: a.position,
          positionB: b.position,
          distance,
          minDistance: required,
        });
      }
    }
  }

  return violations;
}

function comparePosition(a: Position, b: Position): number {
  return a.bay - b.bay || a.row - b.row || a.tier - b.tier;
}

/** 两位置是否同一（null 表示撤位/未配位的空位置） */
export function samePosition(a: Position | null, b: Position | null): boolean {
  if (a === null || b === null) return a === b;
  return a.bay === b.bay && a.row === b.row && a.tier === b.tier;
}

/** 方案迁移的逐箱合并冲突：双方都改动且目标不同（撤位按空位置参与比较） */
export interface MergeConflict {
  boxNo: string;
  /** 方案方位置（null=撤位/未配位） */
  planPosition: Position | null;
  /** 航次方（当前正式布局）位置（null=撤位/未配位） */
  voyagePosition: Position | null;
}

export interface ThreeWayMergeInput {
  /** 全部箱号（箱档案登记后不可变，方案与正式航次共用同一份） */
  boxNos: string[];
  /** 共同基线：方案来源修订号的正式布局（每个已配位箱一条） */
  base: Placement[];
  /** 一方：方案当前试排布局 */
  plan: Placement[];
  /** 另一方：航次当前修订号的正式布局 */
  voyage: Placement[];
}

export interface ThreeWayMergeResult {
  /** 合并后的完整布局（仅已配位箱） */
  placements: Placement[];
  /** 目标不同的冲突箱（双方都改动）；非空表示方案保持原状、不迁移 */
  conflicts: MergeConflict[];
  /** 合并统计 */
  stats: {
    totalBoxes: number;
    unchanged: number;
    /** 仅方案方改动（含撤位） */
    planOnly: number;
    /** 仅航次方改动（含撤位），合并后采用航次位置 */
    voyageOnly: number;
    /** 双方改动到同一位置（含双方撤位），视为一致 */
    bothSame: number;
    /** 双方改动且目标不同的冲突箱数 */
    conflicts: number;
  };
}

function placementMap(placements: Placement[]): Map<string, Position> {
  return new Map(placements.map((p) => [p.boxNo, p.position]));
}

/**
 * 航次修订号前进后的方案迁移：以方案来源修订号的正式布局为共同基线逐箱三方合并。
 * 对每个箱（base/plan/voyage 中缺失即视为空位置=撤位）：
 *  - 仅一方相对基线改动（含撤位）：采用该方位置；
 *  - 双方改动到同一位置（含双方都撤位）：视为一致，采用该位置；
 *  - 双方都改动且目标不同：记为冲突箱（返回双方位置），整体不迁移、方案保持原状；
 *  - 双方都未改动（含相对基线的一致值）：沿用基线位置。
 */
export function threeWayMerge(input: ThreeWayMergeInput): ThreeWayMergeResult {
  const base = placementMap(input.base);
  const plan = placementMap(input.plan);
  const voyage = placementMap(input.voyage);

  const merged: Placement[] = [];
  const conflicts: MergeConflict[] = [];
  const stats = {
    totalBoxes: input.boxNos.length,
    unchanged: 0,
    planOnly: 0,
    voyageOnly: 0,
    bothSame: 0,
    conflicts: 0,
  };

  for (const boxNo of [...input.boxNos].sort((a, b) => a.localeCompare(b))) {
    const bp = base.get(boxNo) ?? null;
    const pp = plan.get(boxNo) ?? null;
    const vp = voyage.get(boxNo) ?? null;
    const planChanged = !samePosition(pp, bp);
    const voyageChanged = !samePosition(vp, bp);

    if (planChanged && voyageChanged) {
      if (samePosition(pp, vp)) {
        stats.bothSame++;
        if (pp !== null) merged.push({ boxNo, position: pp });
      } else {
        stats.conflicts++;
        conflicts.push({ boxNo, planPosition: pp, voyagePosition: vp });
      }
    } else if (planChanged) {
      stats.planOnly++;
      if (pp !== null) merged.push({ boxNo, position: pp });
    } else if (voyageChanged) {
      stats.voyageOnly++;
      if (vp !== null) merged.push({ boxNo, position: vp });
    } else {
      stats.unchanged++;
      if (bp !== null) merged.push({ boxNo, position: bp });
    }
  }

  return { placements: merged, conflicts, stats };
}
