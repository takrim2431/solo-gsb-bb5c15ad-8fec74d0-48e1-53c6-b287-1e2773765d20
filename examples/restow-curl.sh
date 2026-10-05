#!/usr/bin/env bash
# 逐港倒箱作业方案 —— curl 调用示例
#
# 调度员针对【已留档的港序卸货审查】提交：非负临时堆位容量 + 每港按序的
# 暂存（stash）/回放（restore）操作（港序须与审查一致）。服务以该审查对应清单的
# 冻结箱位及当时安全约束为基准逐港模拟：每港开始及每步后反复卸走可及的本港箱；
# 暂存仅限当前列顶且属后续港的箱（同箱至多一次、容量不得超限、每次暂存计一次倒箱、
# 暂存箱不计入船上安全约束）；回放只能放回原列当前栈顶空位；暂存箱不得跨港滞留；
# 任一步违反列承重/危险品间距或港末仍有本港箱受阻即整份拒绝且不留档。
# 成功方案冻结留档，同审查同内容重试幂等返回原结果。
#
# 前置：无。本脚本自包含：登记航次 -> 配载 -> 签发清单 -> 卸货审查（不可行）-> 倒箱方案。
#
# 用法: BASE=http://localhost:3000 bash examples/restow-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次 + 配载 rev1 + 签发清单 + 不可行卸货审查
#    列 (bay=1,row=1) 自底向上：BOX-1(tier0) / BOX-2(tier1) / BOX-3(tier2，列顶)
#    列 (bay=2,row=1)：BOX-4(tier0，列顶)
say "0) 准备：登记航次 + 配载 + 签发清单（rev=1）+ 卸货审查（不倒箱不可行）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-RESTOW-'"$(date +%s)"'",
  "bays": 2, "rows": 1, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "500", "category": "1" },
    { "boxNo": "BOX-3", "weight": "500", "category": "1" },
    { "boxNo": "BOX-4", "weight": "500", "category": "1" }
  ]
}')
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 2 } },
    { "boxNo": "BOX-4", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null
echo "已签发清单 rev=1"

# 审查：BOX-1(SHA) 被 BOX-2(SIN)、BOX-3(HAM) 压住 -> feasibleWithoutRestow=false
REVIEW_JSON=$(curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SHA" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "HAM" },
    { "boxNo": "BOX-4", "dischargePort": "SHA" }
  ]
}')
RID=$(echo "$REVIEW_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$RID（feasibleWithoutRestow=false）"
PLANS_URL="$API/discharge-reviews/$RID/restow-plans"

# 1. 可行倒箱方案：SHA 港暂存 BOX-3、BOX-2（容量 2），BOX-1/BOX-4 自动卸走，
#    再回放 BOX-3、BOX-2 回原列栈顶空位；SIN/HAM 无需操作即可逐港卸空
say "1) 提交可行倒箱方案（capacity=2，SHA 两暂存两回放）-> 201"
OK_JSON=$(curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SHA", "operations": [
      { "action": "stash",   "boxNo": "BOX-3" },
      { "action": "stash",   "boxNo": "BOX-2" },
      { "action": "restore", "boxNo": "BOX-3" },
      { "action": "restore", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}')
echo "$OK_JSON" | jq_or_cat
PLAN_ID=$(echo "$OK_JSON" | sed -n 's/.*"planId":"\([^"]*\)".*/\1/p' | head -1)
echo "planId=$PLAN_ID"

# 2. 同审查同内容重试 -> 200 replay:true（返回首次冻结结果，不新建方案）
say "2) 同审查同内容重试 -> 200 replay:true"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SHA", "operations": [
      { "action": "stash",   "boxNo": "BOX-3" },
      { "action": "stash",   "boxNo": "BOX-2" },
      { "action": "restore", "boxNo": "BOX-3" },
      { "action": "restore", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}' | jq_or_cat

# 3. 不同内容（容量 3）-> 201 分别留档
say "3) 不同内容（capacity=3）-> 201 分别留档"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 3,
  "ports": [
    { "port": "SHA", "operations": [
      { "action": "stash",   "boxNo": "BOX-3" },
      { "action": "stash",   "boxNo": "BOX-2" },
      { "action": "restore", "boxNo": "BOX-3" },
      { "action": "restore", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}' | jq_or_cat

# 4. 拒绝场景（均不留档）
say "4a) 港序与审查不一致 -> 400 invalid_restow_plan / port_order_mismatch"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SIN", "operations": [] },
    { "port": "SHA", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "4b) 暂存非列顶箱（BOX-2 上方有 BOX-3）-> 400 box_not_column_top"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SHA", "operations": [ { "action": "stash", "boxNo": "BOX-2" } ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "4c) 容量超限（capacity=1 连暂存两箱）-> 400 capacity_exceeded"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 1,
  "ports": [
    { "port": "SHA", "operations": [
      { "action": "stash", "boxNo": "BOX-3" },
      { "action": "stash", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "4d) 暂存箱跨港滞留（只暂存不回放）-> 400 stash_lingering_across_port"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SHA", "operations": [ { "action": "stash", "boxNo": "BOX-3" } ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "4e) 港末仍有本港箱受阻（不做任何倒箱）-> 422 port_boxes_blocked"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "capacity": 2,
  "ports": [
    { "port": "SHA", "operations": [] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 5. 危险品间距：回放降低层高导致违反 -> 422 restow_safety_violation
say "5) 另一航次（1类/3类最小距离 2）：回放后间距不足 -> 422 restow_safety_violation"
VOYAGE2_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-RESTOW-DG-'"$(date +%s)"'",
  "bays": 2, "rows": 1, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "X", "weight": "500", "category": "5" },
    { "boxNo": "B", "weight": "500", "category": "3" },
    { "boxNo": "A", "weight": "500", "category": "1" }
  ],
  "incompatRules": [ { "categoryA": "1", "categoryB": "3", "minDistance": 2 } ]
}')
VID2=$(echo "$VOYAGE2_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -sS -X POST "$API/voyages/$VID2/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "X", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "A", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID2/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null
REVIEW2_JSON=$(curl -sS -X POST "$API/voyages/$VID2/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "X", "dischargePort": "SHA" },
    { "boxNo": "B", "dischargePort": "SIN" },
    { "boxNo": "A", "dischargePort": "HAM" }
  ]
}')
RID2=$(echo "$REVIEW2_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
# 暂存 B 后 X 卸走，回放 B 落到 (1,1,0)，与 A(2,1,0) 距离 1 < 2 -> 违反
curl -sS -X POST "$API/discharge-reviews/$RID2/restow-plans" -H 'content-type: application/json' -d '{
  "capacity": 1,
  "ports": [
    { "port": "SHA", "operations": [
      { "action": "stash",   "boxNo": "B" },
      { "action": "restore", "boxNo": "B" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 6. 查询：单份方案 / 按审查 / 按航次
say "6a) 取单份方案冻结结果"
curl -sS "$API/restow-plans/$PLAN_ID" | jq_or_cat

say "6b) 按审查列出方案（拒绝的不留档，仅 2 份成功方案）"
curl -sS "$PLANS_URL" | jq_or_cat

say "6c) 按航次列出方案"
curl -sS "$API/voyages/$VID/restow-plans" | jq_or_cat

# 7. 冻结：航次改位 + 约束更新 + 签发新清单后，已冻结方案结果不变
say "7) 航次改位 + 约束更新 + 签发 rev=3 新清单后，再查方案 -> 结果不变"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-1", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 1 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 2,
  "defaultColumnWeightLimit": "8000"
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 3 }' >/dev/null
curl -sS "$API/restow-plans/$PLAN_ID" | jq_or_cat
echo "（方案仍记录 rev=1 清单冻结箱位与当时约束下的模拟结果，后续演进不回写）"
