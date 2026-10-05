#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 试排方案 curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/plans-curl.sh
#
# 演示：登记 -> 正式配位 -> 从当前修订号建立两个独立试排方案 ->
#       方案内整批调整（合法/违规 422/过期 409）-> 查询方案（布局/约束/版本）->
#       正式航次前进后发布冲突 409（方案保留）-> 从新修订号建方案并发布 201 ->
#       方案只读/重复发布幂等 -> 正式签发与核对照常。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jqid() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-PLAN-$(date +%s)（3x3x2，默认承重 10000，(1,1) 覆盖 1200，类别 1-3 距离 3）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-PLAN-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" },
    { "boxNo": "B4", "weight": "300", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | jqid id)
echo "voyageId=$VID"

say "2) 正式配位（航次 revision 0 -> 1）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B4", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}' >/dev/null
echo "航次当前修订号=1"

say "3) 从当前修订号建立两个相互独立的试排方案（以 rev=1 布局为初值、固定当时约束）"
PLAN_A_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "方案A-加密堆存" }')
echo "$PLAN_A_JSON"
PA=$(echo "$PLAN_A_JSON" | jqid planId)
PLAN_B_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{}')
echo "$PLAN_B_JSON"
PB=$(echo "$PLAN_B_JSON" | jqid planId)
echo "planA=$PA  planB=$PB"

say "4) 方案A 内整批调整（携带方案修订号 baseRevision=0）：B3 -> (2,1,0)"
curl -sS -X POST "$API/plans/$PA/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B3", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}'; echo

say "5) 方案A 违规调整 -> 422（B2 贴近 B1 距离不足；方案不变）"
curl -sS -X POST "$API/plans/$PA/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "B2", "position": { "bay": 1, "row": 2, "tier": 0 } }
  ]
}'; echo

say "6) 方案A 过期方案修订号 -> 409 stale_revision（返回方案当前修订号）"
curl -sS -X POST "$API/plans/$PA/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B3", "position": { "bay": 3, "row": 1, "tier": 0 } }
  ]
}'; echo

say "7) 方案B 独立调整（与方案A 互不影响）：B2 -> (3,2,0)"
curl -sS -X POST "$API/plans/$PB/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B2", "position": { "bay": 3, "row": 2, "tier": 0 } }
  ]
}' >/dev/null
echo "方案B 已调整"

say "8) 查询方案A：当前试排布局 + 固定约束 + 版本（来源修订号/方案修订号/状态）"
curl -sS "$API/plans/$PA"; echo

say "9) 航次方案列表"
curl -sS "$API/voyages/$VID/plans"; echo

say "10) 正式航次不受试排影响（修订号仍为 1，布局原样）"
curl -sS "$API/voyages/$VID/layout"; echo

say "11) 正式航次继续前进（revision 1 -> 2）：B3 -> (3,1,0)"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "B3", "position": { "bay": 3, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
echo "航次当前修订号=2"

say "12) 发布方案A -> 409 publish_conflict（航次 2 ≠ 来源 1），方案保留可继续调整"
curl -sS -X POST "$API/plans/$PA/publish"; echo

say "13) 从最新修订号 rev=2 建立方案C 并调整：B2 -> (2,3,0)"
PLAN_C_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "方案C-发布候选" }')
echo "$PLAN_C_JSON"
PC=$(echo "$PLAN_C_JSON" | jqid planId)
curl -sS -X POST "$API/plans/$PC/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B2", "position": { "bay": 2, "row": 3, "tier": 0 } }
  ]
}' >/dev/null
echo "方案C 已调整（方案修订号=1）"

say "14) 发布方案C -> 201：方案布局原子写入航次修订号 3 并继承方案约束"
curl -sS -X POST "$API/plans/$PC/publish"; echo

say "15) 发布后方案C 只读：继续调整 -> 409 plan_published"
curl -sS -X POST "$API/plans/$PC/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "B1", "position": null }
  ]
}'; echo

say "16) 重复发布方案C -> 200 replay：返回首次发布结果，不产生新修订号"
curl -sS -X POST "$API/plans/$PC/publish"; echo

say "17) 航次当前布局（rev=3）即发布的方案布局"
curl -sS "$API/voyages/$VID/layout"; echo

say "18) 正式流程不受影响：按 rev=3 签发清单并开启核对作业"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 3
}'; echo
curl -sS -X POST "$API/voyages/$VID/check-jobs" -H 'content-type: application/json' -d '{
  "manifestRevision": 3
}'; echo

say "19) 历史布局冻结：rev=1 仍是发布前的正式布局"
curl -sS "$API/voyages/$VID/layout?rev=1"; echo
