import { z } from 'zod';

const weightString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '必须为非负十进制数字（单位 kg）')
  .refine((s) => Number(s) > 0, '必须为正数');

const positiveInt = z.number().int('必须为整数').positive('必须为正整数');
const nonNegativeInt = z.number().int('必须为整数').min(0, '必须为非负整数');

export const positionSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  tier: nonNegativeInt,
});

const moveInputSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空'),
  position: positionSchema.nullable(),
});

const columnLimitSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  weightLimit: weightString,
});

const boxSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
  weight: weightString,
  category: z.string().trim().min(1, '危险品类别不能为空').max(16),
});

const ruleSchema = z.object({
  categoryA: z.string().trim().min(1).max(16),
  categoryB: z.string().trim().min(1).max(16),
  minDistance: positiveInt,
});

const createVoyageInput = z.object({
  voyageNo: z.string().trim().min(1, '航次号不能为空').max(64),
  bays: positiveInt,
  rows: positiveInt,
  tiers: positiveInt,
  defaultColumnWeightLimit: weightString,
  columnWeightLimits: z.array(columnLimitSchema).optional(),
  boxes: z.array(boxSchema).optional(),
  incompatRules: z.array(ruleSchema).optional(),
});

export const createVoyageSchema = createVoyageInput.transform((d) => ({
  voyageNo: d.voyageNo,
  bays: d.bays,
  rows: d.rows,
  tiers: d.tiers,
  defaultColumnWeightLimit: d.defaultColumnWeightLimit,
  columnWeightLimits: d.columnWeightLimits ?? [],
  boxes: d.boxes ?? [],
  incompatRules: d.incompatRules ?? [],
}));

const applyMovesInput = z.object({
  baseRevision: nonNegativeInt,
  moves: z.array(moveInputSchema).optional(),
});

export const applyMovesSchema = applyMovesInput.transform((d) => ({
  baseRevision: d.baseRevision,
  moves: d.moves ?? [],
}));

/**
 * 安全约束整批变更：携带所见 baseRevision，提交整套
 * 默认列承重 / 按列覆盖限额 / 不相容类别对（全量替换：未列出即撤销）。
 * 正数、列坐标、类别对唯一性的业务规则在 service 层沿用登记校验。
 */
export const updateConstraintsSchema = z
  .object({
    baseRevision: nonNegativeInt,
    defaultColumnWeightLimit: weightString,
    columnWeightLimits: z.array(columnLimitSchema).optional(),
    incompatRules: z.array(ruleSchema).optional(),
  })
  .transform((d) => ({
    baseRevision: d.baseRevision,
    defaultColumnWeightLimit: d.defaultColumnWeightLimit,
    columnWeightLimits: d.columnWeightLimits ?? [],
    incompatRules: d.incompatRules ?? [],
  }));

export const issueManifestSchema = z.object({
  expectedRevision: nonNegativeInt,
});

// ---- 试排方案 ----

/**
 * 建立试排方案：从航次当前修订号派生独立工作区（以当前布局为初值、固定当前约束快照）。
 * 请求体可整体省略；label 仅用于区分同一航次下的多个方案。
 */
export const createPlanSchema = z
  .object({
    label: z.string().trim().min(1, '方案名不能为空').max(64).optional(),
  })
  .nullish()
  .transform((d) => ({ label: d?.label ?? null }));

/**
 * 方案内整批调整：与正式航次整批调整同构（baseRevision 为方案修订号）。
 * 直接复用 applyMovesSchema。
 */

/**
 * 方案迁移（航次修订号前进后的 rebase）：
 * 提交方案 ID（路径参数）、所见方案修订号 planRevision 与所见航次修订号 voyageRevision。
 * 服务以方案来源修订号布局为共同基线逐箱三方合并；过期/已发布/冲突/复验失败均不改变方案。
 */
export const migratePlanSchema = z.object({
  planRevision: nonNegativeInt,
  voyageRevision: nonNegativeInt,
});

// ---- 现场装船核对 ----

export const openCheckJobSchema = z.object({
  /** 作为核对基准的已签发清单修订号 */
  manifestRevision: nonNegativeInt,
});

/**
 * 单次核对上报：
 *   position 非 null  → 实装位置（坐标需在舱位范围内）
 *   position 为 null  → 撤销标记（该箱未装）
 * 每次上报必须携带全作业唯一的 reportNo（幂等键）。
 */
export const checkReportSchema = z.object({
  reportNo: z.string().trim().min(1, '上报号不能为空').max(64),
  boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
  position: positionSchema.nullable(),
});

// ---- 港序卸货审查 ----

/**
 * 靠泊窗口预订（依据已留档卸货审查）：
 *  - reviewId：审查 ID（路径外亦可校验；这里随体提交）；
 *  - dischargePort/berth：审查内卸港与泊位（港是否可卸由业务层按冻结模拟结果判定）；
 *  - startAt/endAt：带时区时刻，具体形态（必须含时区）与起点早于终点由业务层校验，
 *    给出 invalid_time_window 的明确错误；
 *  - submissionNo：同一审查内唯一的提交号（同号同内容重试幂等）。
 */
export const createBerthBookingSchema = z
  .object({
    reviewId: z.string().trim().min(1, '卸货审查 ID 不能为空'),
    dischargePort: z.string().trim().min(1, '卸港不能为空').max(64),
    berth: z.string().trim().min(1, '泊位不能为空').max(64),
    startAt: z.string().trim().min(1, '起始时刻不能为空'),
    endAt: z.string().trim().min(1, '结束时刻不能为空'),
    submissionNo: z.string().trim().min(1, '提交号不能为空').max(64),
  })
  .transform((d) => ({ ...d }));

/**
 * 靠泊预订改期（调整已生效的预订）：
 *  - 原预订 ID 走路径参数；体提交新泊位、带时区起止时刻与调整号；
 *  - 审查/卸港/冻结快照继承自原预订，不在请求体内；
 *  - 时刻形态（必须含时区）与起点早于终点由业务层校验，给出 invalid_time_window 的明确错误；
 *  - adjustmentNo：同一原预订内唯一的调整号（同号同内容重试幂等）。
 */
export const adjustBerthBookingSchema = z
  .object({
    berth: z.string().trim().min(1, '泊位不能为空').max(64),
    startAt: z.string().trim().min(1, '起始时刻不能为空'),
    endAt: z.string().trim().min(1, '结束时刻不能为空'),
    adjustmentNo: z.string().trim().min(1, '调整号不能为空').max(64),
  })
  .transform((d) => ({ ...d }));

/**
 * 对已签发冻结清单提交卸货审查：
 *  - ports：有序卸港列表（业务层再查空/重复；空数组直接非法）；
 *  - items：清单内每个箱的卸港（箱号集合必须与清单完全一致，业务层校验）。
 */
export const createDischargeReviewSchema = z
  .object({
    ports: z
      .array(z.string().trim().min(1, '卸港名不能为空').max(64))
      .min(1, '卸港列表不能为空：必须提交至少一个有序且不重复的卸港'),
    // items 允许空数组：空清单（0 箱）提交空申报时，与清单“完全一致”由业务层判定
    items: z.array(
      z.object({
        boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
        dischargePort: z.string().trim().min(1, '卸港不能为空').max(64),
      }),
    ),
  })
  .transform((d) => ({ ports: d.ports, items: d.items }));

// ---- 逐港倒箱作业方案（依据已留档卸货审查）----

/**
 * 逐港倒箱作业方案：
 *  - temporaryCapacity：非负的临时堆位容量（0 表示不允许暂存）；
 *  - portPlans：每港一段按序作业，港序必须与审查完全一致（业务层校验）；
 *  - 每步 op 只能是 stage（暂存列顶后续港箱）/ replay（回放暂存箱到原列栈顶空位），
 *    boxNo 为操作箱号；动态合法性（列顶/后续港/容量/重复暂存/安全/受阻）在模拟中逐港判定。
 */
export const createRestowPlanSchema = z
  .object({
    temporaryCapacity: nonNegativeInt,
    portPlans: z.array(
      z.object({
        port: z.string().trim().min(1, '卸港不能为空').max(64),
        operations: z
          .array(
            z.object({
              op: z.enum(['stage', 'replay']),
              boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
            }),
          )
          .default([]),
      }),
    ),
  })
  .transform((d) => ({ temporaryCapacity: d.temporaryCapacity, portPlans: d.portPlans }));
