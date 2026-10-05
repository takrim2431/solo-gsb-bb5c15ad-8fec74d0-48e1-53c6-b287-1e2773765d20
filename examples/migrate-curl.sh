#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 试排方案迁移（航次修订号前进后的 rebase）curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/migrate-curl.sh
#
# 演示：登记 -> 正式配位 -> 建立试排方案并在方案内调整 ->
#       正式航次继续前进导致发布冲突 409 ->
#       提交方案ID/所见方案修订号/所见航次修订号迁移：
#         · 仅一方改动采用该方位置、双方改到同位置视为一致、撤位按空位置合并
#         · 迁移成功后换来源修订号+约束快照、方案修订号 +1，旧方案布局可追溯
#         · 冲突箱 / 当前约束复验失败 / 所见版本过期 -> 拒绝且方案保持原状
#       迁移后按现有规则发布。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jqid() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-MIG-$(date +%s)（3x3x2，默认承重 10000，无类别约束）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-MIG-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" }
  ],
  "incompatRules": []
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | jqid id)
echo "voyageId=$VID"

say "2) 正式配位（航次 revision 0 -> 1）：B1@(1,1,0) B2@(3,3,0) B3@(2,2,0)"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}' >/dev/null
echo "航次当前修订号=1"

say "3) 从 rev=1 建立试排方案，并在方案内调整：B2 -> (2,3,0)（方案修订号 0->1）"
PLAN_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "方案-待迁移" }')
PID=$(echo "$PLAN_JSON" | jqid planId)
echo "planId=$PID"
curl -sS -X POST "$API/plans/$PID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [ { "boxNo": "B2", "position": { "bay": 2, "row": 3, "tier": 0 } } ]
}'; echo

say "4) 正式航次继续前进（revision 1 -> 2）：B3 -> (3,2,0)，与方案改动互不相关"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [ { "boxNo": "B3", "position": { "bay": 3, "row": 2, "tier": 0 } } ]
}' >/dev/null
echo "航次当前修订号=2"

say "5) 直接发布 -> 409 publish_conflict（航次 2 ≠ 方案来源 1），方案保留"
curl -sS -X POST "$API/plans/$PID/publish"; echo

say "6) 迁移：提交方案ID（路径）+ 所见方案修订号 planRevision=1 + 所见航次修订号 voyageRevision=2"
echo "   合并结果：B2 取方案位置 (2,3,0)，B3 追航次位置 (3,2,0)，B1 不变"
curl -sS -X POST "$API/plans/$PID/migrate" -H 'content-type: application/json' -d '{
  "planRevision": 1,
  "voyageRevision": 2
}'; echo

say "7) 查询方案：来源修订号已更新为 2、方案修订号=2、约束快照换成当前航次版本"
curl -sS "$API/plans/$PID"; echo

say "8) 来源修订号现在等于航次当前修订号 -> 按现有规则发布成功（写入航次修订号 3）"
curl -sS -X POST "$API/plans/$PID/publish"; echo

say "9) 冲突演示：另建方案，方案与航次把同一箱改到不同位置 -> 409 migration_conflict（方案保持原状）"
PLAN2_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "方案-冲突" }')
PID2=$(echo "$PLAN2_JSON" | jqid planId)
# 基于当前 rev=3：方案把 B1 撤位（空位置）
curl -sS -X POST "$API/plans/$PID2/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [ { "boxNo": "B1", "position": null } ]
}' >/dev/null
# 航次 rev=4：B1 -> (1,2,0)（方案撤位 vs 航次移动，目标不同）
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 3,
  "moves": [ { "boxNo": "B1", "position": { "bay": 1, "row": 2, "tier": 0 } } ]
}' >/dev/null
curl -sS -X POST "$API/plans/$PID2/migrate" -H 'content-type: application/json' -d '{
  "planRevision": 1,
  "voyageRevision": 4
}'; echo
echo "（冲突明细 details.conflicts[] 给出箱号、planPosition 与 voyagePosition；撤位一方位置为 null）"

say "10) 过期演示：所见方案修订号或航次修订号过期 -> 409 stale_revision（方案不变）"
curl -sS -X POST "$API/plans/$PID2/migrate" -H 'content-type: application/json' -d '{
  "planRevision": 0,
  "voyageRevision": 4
}'; echo
